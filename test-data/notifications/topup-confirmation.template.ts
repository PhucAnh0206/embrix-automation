import { NotificationTemplate } from './types';
import { formatCRC, expectedKwh, valuesMatch, KWH_DIVISOR } from '../../helpers/email.helper';

/**
 * Strip the minus sign and any spacing around the currency glyph, so
 * "- ₡ 5.000,00" and "₡5.000,00" compare equal.
 *
 * Needed because the sign sits on EITHER side of the glyph depending on template
 * version ("₡-400" before 2026-10-09, "-₡400" after), and spacing varies too.
 */
function dropSign(value: string): string {
  return value.replace(/-/g, '').replace(/\s+/g, '');
}

/**
 * JEPYP-49 — Notification: Top Up Confirmation.
 *
 * Field expectations come from the template table in JEPYP-230's description,
 * plus the two overrides Tri Do recorded in comment 34418:
 *   • ID Referencia de Pago — hardcoded to PLATAFORMA (no paymentSourceId is
 *     sent on top-up)
 *   • ID Transacción — new field, not in the parent spec, equal to the
 *     transaction reference
 *
 * Known open defects are marked with `knownDefect` so the suite reports them
 * without failing the run. Remove the property once the fix ships.
 */

/**
 * paymentSource Embrix records for a Self Care → PlaceToPay card top-up.
 *
 * Observed as CREDIT_CARD on ACT-100527. Adjust here (not in the check) if the
 * value differs for the channel your run uses — the JASEC payment application
 * and POS-API are expected to send different values.
 */
export const EXPECTED_PAYMENT_SOURCE = 'CREDIT_CARD';

/** Static copy, quoted from the JEPYP-230 spec table. */
const INTRO_LINE = 'Jasec le informa que su recarga se realizó exitosamente.';
const CLOSING_LINE = 'Muchas gracias por utilizar nuestros servicios.';
const FOOTER_ENTITY = 'Junta Administrativa del Servicio Eléctrico Municipal de Cartago (Jasec)';
const FOOTER_AUTO = 'Mensaje generado automáticamente por el sistema';

export const topUpConfirmationTemplate: NotificationTemplate = {
  key: 'TOPUP_CONFIRMATION',
  ticket: 'JEPYP-49',
  title: 'Notification — Top Up Confirmation',
  subject: 'Jasec - Servicio Eléctrico Prepago - Recarga',

  checks: [
    {
      row: 'Delivery',
      contextual: true,
      expected: (c) => `Email received at ${c.recipient} after a successful top-up`,
      // `deliverySeconds` is absent when the body came from the stored
      // email_notification row rather than the mailbox, so say so instead of
      // printing "after undefineds" and implying a measurement we do not have.
      actual: (c) => (c.deliverySeconds === undefined
        ? `Body read from the stored notification row — mailbox delivery not observed`
        : `Received at ${c.email.to || c.recipient} after ${c.deliverySeconds}s`),
      // Delivery itself is asserted in the spec, which knows whether IMAP saw the
      // message. This row only reports which source the body came from.
      compare: () => true,
    },
    {
      row: 'Subject',
      expected: () => 'Jasec - Servicio Eléctrico Prepago - Recarga',
      actual: (c) => c.email.subject,
    },
    {
      row: 'Logo',
      expected: () => 'JASEC logo renders (at least one <img> with a resolvable src)',
      actual: (c) => (c.email.imageSrcs.length ? c.email.imageSrcs.join(', ') : '(no <img> found)'),
      // Presence of the image tag only. Whether it visually renders in a given
      // client is a manual check — automation can't see that.
      compare: (_a, _e, c) => c.email.imageSrcs.some((src) => src.trim().length > 0),
    },
    {
      row: 'Greeting',
      expected: (c) => `Estimado(a) ${c.lastName} ${c.firstName}`,
      actual: (c) => c.email.lineStartingWith('Estimado(a)'),
    },
    {
      row: 'Intro line',
      expected: () => INTRO_LINE,
      actual: (c) => (c.email.contains(INTRO_LINE) ? INTRO_LINE : '(not found)'),
      compare: (_a, _e, c) => c.email.contains(INTRO_LINE),
    },
    {
      row: 'Número de Servicio',
      expected: (c) => c.accountId,
      actual: (c) => c.email.field('Número de Servicio'),
    },
    {
      row: 'Fecha y Hora',
      expected: (c) => `${c.ccpDate} HH:mm:ss — actual date AND time of the top-up`,
      actual: (c) => c.email.field('Fecha y Hora'),
      compare: (actual, _e, c) => {
        const match = actual.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
        if (!match) return false;
        const [, datePart, timePart] = match;
        // 00:00:00 on every transaction is the defect: two top-ups minutes
        // apart rendered an identical timestamp, so this is not the real
        // transaction time. ARESEP requires date AND time on the receipt.
        return datePart === c.ccpDate && timePart !== '00:00:00';
      },
      knownDefect: 'JEPYP-49 — renders 00:00:00; identical across separate top-ups',
    },
    {
      row: 'Monto Recarga',
      contextual: true,
      expected: (c) => formatCRC(c.topUpAmount ?? 0),
      actual: (c) => c.email.field('Monto Recarga'),
    },
    {
      row: 'Medio de Pago',
      contextual: true,
      expected: (c) => c.paymentSource ?? EXPECTED_PAYMENT_SOURCE,
      actual: (c) => c.email.field('Medio de Pago'),
    },
    {
      row: 'ID Referencia de Pago',
      expected: () => 'PLATAFORMA (hardcoded)',
      actual: (c) => c.email.field('ID Referencia de Pago'),
      compare: (actual) => valuesMatch(actual, 'PLATAFORMA'),
    },
    {
      row: 'ID Transacción',
      // THREE formats exist, one per payment channel — observed on jasec-dev
      // 2026-08-13. Asserting only the first made this check flip pass/fail
      // depending on which channel produced the most recent receipt:
      //   TU-<acct>-<hex12>       Pay Now, card on file     (Medio: CREDIT_CARD)
      //   TOPUP-<acct>-<epochms>  Pay With PlaceToPay       (Medio: CREDIT_CARD)
      //   <digits>                cash channel, e.g. 990013 (Medio: EFECTIVO)
      // The invariant worth holding is that a reference is present and, for the
      // two account-scoped formats, that it carries THIS account's id.
      expected: (c) =>
        `TU-${c.accountId}-<hex>, TOPUP-${c.accountId}-<epoch>, or a numeric cash receipt`,
      actual: (c) => c.email.field('ID Transacción'),
      compare: (actual, _e, c) => {
        const v = actual.trim();
        if (!v) return false;
        if (new RegExp(`^TU-${c.accountId}-\\S+$`).test(v)) return true;
        if (new RegExp(`^TOPUP-${c.accountId}-[0-9]+$`).test(v)) return true;
        return /^[0-9]+$/.test(v);
      },
    },
    {
      row: 'Descripción',
      contextual: true,
      expected: (c) => `Embrix Top Up ${c.topUpAmount}`,
      actual: (c) => c.email.field('Descripción'),
    },
    {
      row: 'Saldo Actual',
      // Compared IGNORING THE SIGN, and the comparison is now actually
      // implemented — it used to say this in a comment while falling through to
      // valuesMatch(), which is exact. That silently broke when the sign-placement
      // fix landed (2026-10-09): the body renders credit SIGNED as "- ₡ 5.000,00"
      // whereas formatCRC(-5000) yields "₡5.000,00", so the check failed on every
      // real run. It went unnoticed because TS-01 was dying earlier at
      // waitForEmail. Verified against the stored body of CORR-104064.
      //
      // Ignoring the sign is the right call HERE, not laziness: the sign
      // convention is case 2.2's job, and it is only observable on a DEBT
      // balance, which this happy-path top-up cannot produce.
      contextual: true,
      expected: (c) => formatCRC(c.balanceAfter ?? 0),
      actual: (c) => c.email.field('Saldo Actual'),
      compare: (actual, expected) => valuesMatch(dropSign(actual), dropSign(expected)),
    },
    {
      row: 'Saldo Actual sign',
      /**
       * The sign is asserted SEPARATELY from the amount, because the amount check
       * above deliberately ignores it.
       *
       * Without this row a sign flip would pass silently — which is exactly the
       * class of defect the 2026-10-09 sign-placement work was about. The
       * billing-event templates have had a blocking `signPlacementCheck` all
       * along; this template had nothing, so it was the weak spot in the suite.
       *
       * TWO THINGS ARE CHECKED, and the first is the one placement alone misses:
       *
       *   1. PRESENCE. The displayed sign must match `balanceAfter`'s sign.
       *      Both use the same convention — negative = customer holds credit,
       *      positive = customer owes. The engine negates `currencyBal` before
       *      the template sees it (PGBillUnitService.groovy:4490) precisely so
       *      that "Saldo actual" reads positive-means-owes, per JASEC's request.
       *      So a customer with ₡5.000 credit must render "- ₡ 5.000,00", and one
       *      in debt must render no minus at all.
       *
       *   2. PLACEMENT. When a minus is present it must precede the glyph
       *      (-₡400, never ₡-400). That is the 2026-10-09 template change.
       *
       * Verified against the stored body of CORR-104064 (balanceAfter -5000,
       * renders "- ₡ 5.000,00"): passes as written, and fails if either the sign
       * is dropped or `balanceAfter` is flipped positive.
       */
      contextual: true,
      expected: (c) => {
        const balance = c.balanceAfter ?? 0;
        if (balance < 0) return 'minus present, BEFORE the glyph (-₡5.000,00) — customer holds credit';
        if (balance > 0) return 'no minus — customer owes (JASEC renders positive = owes)';
        return 'no minus — zero balance';
      },
      actual: (c) => c.email.field('Saldo Actual') || '(no value)',
      compare: (actual, _expected, c) => {
        const value = actual.trim();
        if (!value) return false;
        const rendersNegative = value.includes('-');
        const balance = c.balanceAfter ?? 0;
        // Presence must agree with the balance's own sign.
        if (balance < 0 && !rendersNegative) return false;
        if (balance >= 0 && rendersNegative) return false;
        // Placement, only meaningful when a minus is actually there.
        return !rendersNegative || /^-\s*₡/.test(value);
      },
    },
    {
      row: 'Saldo kWh Aproximados',
      contextual: true,
      expected: (c) => `${expectedKwh(c.balanceAfter ?? 0)}  (floor(balance ÷ ${KWH_DIVISOR}))`,
      actual: (c) => c.email.field('Saldo kWh Aproximados'),
      compare: (actual, _e, c) => actual.trim() === String(expectedKwh(c.balanceAfter ?? 0)),
      // NOTE: this asserts the code matches the formula dev confirmed. It does
      // NOT validate the formula against the T-RP tariff — ₡123.067/kWh is 37%
      // above the ₡89.903 maximum legal kWh price. That stays a separate,
      // open spec question and cannot be settled by a test.
    },
    {
      row: 'Closing line',
      expected: () => CLOSING_LINE,
      actual: (c) => (c.email.contains(CLOSING_LINE) ? CLOSING_LINE : '(not found)'),
      compare: (_a, _e, c) => c.email.contains(CLOSING_LINE),
    },
    {
      row: 'Footer',
      expected: () => `${FOOTER_ENTITY} + ${FOOTER_AUTO}`,
      actual: (c) => {
        const parts: string[] = [];
        if (c.email.contains(FOOTER_ENTITY)) parts.push(FOOTER_ENTITY);
        if (c.email.contains(FOOTER_AUTO)) parts.push(FOOTER_AUTO);
        return parts.length ? parts.join(' + ') : '(not found)';
      },
      compare: (_a, _e, c) => c.email.contains(FOOTER_ENTITY) && c.email.contains(FOOTER_AUTO),
    },
    {
      row: 'Template integrity',
      expected: () => 'No unresolved ${...} tokens in the body',
      actual: (c) => (c.email.hasUnresolvedTokens() ? 'Unresolved token(s) present' : 'None'),
      compare: (_a, _e, c) => !c.email.hasUnresolvedTokens(),
    },
  ],
};
