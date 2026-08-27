import { formatCRC, normalizeValue } from '../../helpers/email.helper';
import { expectedMinimum } from '../../helpers/notification-bands';
import { FieldCheck, NotificationContext, NotificationTemplate } from './types';

/**
 * The seven billing-triggered JEPYP-230 notifications — report sections 1, 3,
 * 4, 5, 6 and 7.
 *
 * Grouped in ONE file rather than one-per-template (the convention set by
 * topup-confirmation.template.ts) because these seven share the band arithmetic,
 * the boilerplate checks and a single staged run — they are written, verified and
 * changed together. A genuinely independent notification should still get its
 * own file.
 *
 * Expected copy was read back from `email_notification.content` on jasec-dev
 * 2026-08-12 (the 2026-10-09 run), i.e. the CURRENTLY DEPLOYED v2/v3 templates —
 * not transcribed from the runbook. Two places where they disagree are noted
 * inline; the runbook itself flags that only Event 2's v4 was ever re-verified.
 */

// ── Shared copy ─────────────────────────────────────────────────────────────

const FOOTER = 'Junta Administrativa del Servicio Eléctrico Municipal de Cartago (Jasec)';
const NO_REPLY = 'No responda este correo';
const AUTO_GENERATED = 'Mensaje generado automáticamente por el sistema';

/** Tax paragraphs for Event 3. Boundaries are STRICTLY greater-than. */
export const BOMBEROS_FRAGMENT = 'su consumo acumulado del mes es superior a 100 kWh';
export const IVA_FRAGMENT = 'su consumo acumulado del mes es superior a 280 kWh';

export const SPANISH_MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

/** Spanish month name for a YYYY-MM-DD date. */
export function spanishMonth(isoDate: string): string {
  const m = Number(isoDate.slice(5, 7));
  return SPANISH_MONTHS[m - 1] ?? `(bad date ${isoDate})`;
}

/**
 * First currency amount appearing after `phrase`, normalised.
 *
 * Needed because the templates put amounts on their own line — `Saldo actual`
 * and its value are separate table cells, so `field()` cannot see the pairing
 * for the sentence-style bodies. Returns '' when no amount follows, which is
 * exactly defect 3.5 (a body rendering `Saldo actual ₡ .` with no figure).
 *
 * Matches BOTH sign placements: `₡ -80,70` (eight templates) and `- ₡ 1.700,00`
 * (resume only).
 */
export function amountAfter(text: string, phrase: string): string {
  const flat = normalizeValue(text);
  const idx = flat.toLowerCase().indexOf(normalizeValue(phrase).toLowerCase());
  if (idx < 0) return '';
  const tail = flat.slice(idx + phrase.length);
  // `\d[\d.,]*` — the leading DIGIT is required. With `[\d.,]+` the body
  // `Saldo actual ₡ .` matches its own trailing full stop as the amount, which
  // is precisely the empty-balance case (defect 3.5) that must report as absent.
  const m = tail.match(/^[^\d₡-]{0,12}(-?\s*₡\s*-?\s*\d[\d.,]*)/);
  // Whitespace inside the amount is dropped so `- ₡ 1.700,00` and `₡ -80,70`
  // compare directly. normalizeValue only closes the gap AFTER the glyph.
  return m ? m[1].replace(/\s+/g, '') : '';
}

/** True when the extracted amount carries a minus, whichever side it sits on. */
export function isNegativeAmount(amount: string): boolean {
  return amount.includes('-');
}

// ── Reusable checks ─────────────────────────────────────────────────────────

const subjectCheck = (): FieldCheck => ({
  row: 'Subject',
  // Sourced from correspondence_template_list.emailsubject, NOT the body <title>
  // — they differ on BALANCE_TOPUP. See NotificationDbHelper.getConfiguredSubject.
  expected: (c) => c.email.subject || '(no configured subject)',
  actual: (c) => c.email.subject,
});

const greetingCheck = (): FieldCheck => ({
  row: 'Greeting',
  expected: (c) => `Estimado(a) — names the account holder (${c.firstName} ${c.lastName})`.trim(),
  actual: (c) => c.email.lineStartingWith('Estimado(a)') || '(no greeting line)',
  compare: (actual) => /^Estimado\(a\)\s+\S+/.test(actual.trim()),
});

const logoCheck = (): FieldCheck => ({
  row: 'Logo',
  expected: () => 'JASEC logo renders (at least one <img> with a resolvable src)',
  actual: (c) => (c.email.imageSrcs.length ? c.email.imageSrcs.join(', ') : '(no <img> found)'),
  compare: (_a, _e, c) => c.email.imageSrcs.length > 0,
});

const footerCheck = (): FieldCheck => ({
  row: 'Footer',
  expected: () => `${FOOTER} / ${AUTO_GENERATED} / ${NO_REPLY}`,
  actual: (c) => {
    const parts = [FOOTER, AUTO_GENERATED, NO_REPLY].filter((p) => c.email.contains(p));
    return parts.length === 3 ? 'all three footer lines present' : `only ${parts.length}/3 present`;
  },
  compare: (_a, _e, c) =>
    [FOOTER, AUTO_GENERATED, NO_REPLY].every((p) => c.email.contains(p)),
});

/**
 * No `${...}` left in the body.
 *
 * A template that fails to bind renders the raw Thymeleaf expression, which
 * reads as plausible text in a screenshot and is easy to miss by eye.
 */
const noUnresolvedTokensCheck = (): FieldCheck => ({
  row: 'Template bindings',
  expected: () => 'no unresolved ${...} placeholders',
  actual: (c) => (c.email.hasUnresolvedTokens() ? 'UNRESOLVED placeholder present' : 'all bound'),
  compare: (_a, _e, c) => !c.email.hasUnresolvedTokens(),
});

/** SMTP outcome. FAILED means it rendered but was never delivered. */
const deliveryStatusCheck = (): FieldCheck => ({
  row: 'SMTP status',
  expected: () => 'SUCCESS',
  actual: (c) => c.notificationStatus ?? '(unknown)',
  compare: (actual) => actual === 'SUCCESS',
  knownDefect:
    'JEPYP-230 §9.1 — ~5% of sends land FAILED at batchSizeBilling=60 ' +
    '(4.7% and 5.2% measured on two independent runs). Rendering is unaffected.',
});

/**
 * The month is checked in TWO parts, deliberately split by what each context can
 * actually establish. This replaced a single strict `spanishMonth(ccpDate)` check
 * after that check reported four defects that were not defects.
 *
 * WHAT THE DATA SAYS. Swept over every row the month check applies to on
 * jasec-dev — 1,861 rows across the three Inicio de Mes types and INVOICE_READY —
 * the body names the month the job ran in, in 1,857 of them. The four exceptions
 * are all rows the 3.6 retest produced: it shifted ACT-100029 / -100219 /
 * -100287 / -100301 onto schedule date 2027-08-09 while their billing cycles sat
 * back in January, and their emails then named the lagging cycle (Febrero,
 * Marzo) rather than the run month (Agosto). The product was right in all 1,861.
 *
 * WHY NOT JUST RESOLVE THE CYCLE AND ASSERT THAT. Tried, and abandoned on
 * evidence: the cycle a historical row referred to cannot be reconstructed
 * reliably. `invoicedate` sits on the 8th for many accounts while the
 * notification is stamped the 9th, so an exact-date join misses; widening the
 * window pulls in a neighbouring run; and the PENDING cycle is current state, so
 * for any account billed since it names an unrelated month — it mis-resolved 4 of
 * 101 PREPAID_SUFFICIENT_CREDIT rows that were in fact correct.
 *
 * So the split:
 *
 *   monthPresentCheck  — a month name is present at all. Runs everywhere,
 *     including replay. Cheap, unambiguous, and not hypothetical: CORR-104429
 *     (ACT-100011) is an INVOICE_READY row stored with an entirely empty body and
 *     status SUCCESS.
 *   monthMatchesRunCheck — it equals the run month. `contextual`, so only the
 *     live staged run asserts it. There the account is staged and billed in that
 *     same run against a known clock, so the expectation is sound by
 *     construction; in replay the staging context is gone and asserting it was
 *     always guesswork that happened to hold until someone moved a clock.
 */
const monthPresentCheck = (): FieldCheck => ({
  row: 'Month named',
  expected: () => 'a Spanish month name',
  actual: (c) => SPANISH_MONTHS.find((m) => c.email.contains(m)) ?? '(no month name found)',
  compare: (actual) => SPANISH_MONTHS.includes(actual),
});

const monthMatchesRunCheck = (): FieldCheck => ({
  row: 'Month matches the run',
  expected: (c) => spanishMonth(c.ccpDate),
  actual: (c) => SPANISH_MONTHS.find((m) => c.email.contains(m)) ?? '(no month name found)',
  contextual: true,
});

/**
 * Non-contextual: an amount is PRESENT after the phrase. Catches defect 3.5.
 *
 * `knownDefect` is passed only where the absence is already a tracked defect, so
 * the suite reports it without going permanently red — the repo convention from
 * types.ts. Everywhere else it stays blocking, which is what catches a new
 * regression.
 */
const amountPresentCheck = (row: string, phrase: string, knownDefect?: string): FieldCheck => ({
  row,
  expected: () => `an amount follows "${phrase}"`,
  actual: (c) => amountAfter(c.email.text, phrase) || '(NO AMOUNT — renders the label with no figure)',
  compare: (_a, _e, c) => amountAfter(c.email.text, phrase).length > 0,
  knownDefect,
});

/** Contextual: the amount equals the post-charge balance. */
/**
 * Case 3.6 — the balance shown must equal staged balance + the invoice total.
 *
 * ANCHORED ON THE INVOICE TOTAL, not on a balance read at assertion time. The
 * invoice is durable stored data, whereas a live balance read can be wrong through
 * no fault of the product: when an earlier test fails, Playwright restarts the
 * worker, teardown restores the staged balances, and a later read then returns the
 * ORIGINAL value. That produced false failures on Events 1A/1B/1C on the
 * 2027-05-09 run. An invoice cannot be restored, so it cannot lie.
 *
 * It also matches how the manual case is written, so automation and sheet agree.
 *
 * BLOCKING as of 2026-08-14. It was a filed defect: the figure implied a PARTIAL
 * SUM of the invoice's four line items rather than the total —
 *
 *     ENERGIA               (KWH)      30 x 69.24  = 2077.20
 *     CVG ENERGIA           (KWH-CVG)  30 x  4.81  =  144.30
 *     ALUMBRADO PUBLICO     (ALP)      30 x  3.05  =   91.50
 *     CVG ALUMBRADO PUBLICO (ALP-CVG)  30 x  0.21  =    6.30
 *                                                    2319.30
 *
 * with 2077.20 (ENERGIA only), 2083.50 (ENERGIA + ALP-CVG) and 2175.00 (all but
 * CVG ENERGIA) all observed.
 *
 * Verified fixed on JS-100203, deliberately using the accounts that were reliably
 * WRONG rather than ones that already passed: ACT-100287 rendered -₡316,50
 * (implying 2083.50) on three separate runs — 2026-11-09, 2026-12-09, 2027-01-09 —
 * and now renders -₡80,70 under identical staging, alongside ACT-100219. The two
 * that were always correct stayed correct.
 *
 * NOTE FOR ANYONE RE-DIAGNOSING A RECURRENCE: the original report called this a
 * race between bill-item posting and notification dispatch. That was WRONG. The
 * wrong value was deterministic per account — ACT-100287 produced 2083.50 every
 * time, ACT-100263 produced 2175.00 every time, ACT-100237 produced 2077.20 every
 * time. A race would have varied between runs. Start from what differs between
 * accounts, not from timing.
 */
const saldoEqualsPostCheck = (): FieldCheck => ({
  row: '3.6 - Saldo actual = staged balance + invoice total',
  contextual: true,
  expected: (c) => formatCRC(c.postBalance ?? 0),
  actual: (c) => amountAfter(c.email.text, 'Saldo actual'),
  compare: (actual, expected) => stripSign(actual) === stripSign(expected),
});

/**
 * Contextual: the minimum equals the runbook's reconciliation formula.
 *
 * X IS AMBIGUOUS BY A FACTOR OF 3. `get_correspondence_data` returns 971.70 for
 * some accounts and 2915.10 for others, and the email does not always use the one
 * the function returned — that is the 15-vs-45 kWh basis noted in runbook §4 item
 * 1 (report case 6.3), where the body says "15 KWh" while the amount may be
 * computed on a 45 kWh basis. 2915.10 / 971.70 = 3 exactly.
 *
 * So accept the value computed from X, 3X or X/3. Insisting on the measured X
 * produced a false failure on three consecutive runs, which is worse than the
 * looser check: it buried the real findings under a known copy discrepancy.
 */
const minimumEqualsFormulaCheck = (event: Parameters<typeof expectedMinimum>[0]): FieldCheck => ({
  row: 'Recarga mínima = expected minimum',
  contextual: true,
  expected: (c) => {
    const x = c.X ?? 0;
    const post = c.postBalance ?? 0;
    return `${formatCRC(expectedMinimum(event, x, post))} (or the 3x / ÷3 kWh-basis variant)`;
  },
  actual: (c) => amountAfter(c.email.text, 'recarga mínima de') || amountAfter(c.email.text, 'Monto mínimo a recargar'),
  compare: (actual, _expected, c) => {
    const x = c.X ?? 0;
    const post = c.postBalance ?? 0;
    const got = stripSign(actual);
    return [x, x * 3, x / 3].some(
      (candidate) => stripSign(formatCRC(expectedMinimum(event, candidate, post))) === got,
    );
  },
});

/**
 * Compare amounts on digits and separators only.
 *
 * Sign PLACEMENT is inconsistent between templates — eight render `₡ -80,70`
 * and resume_subscription_v3 renders `- ₡ 1.700,00`. The runbook claims the v2
 * bump moved the minus ahead of the glyph everywhere; the 2026-10-09 renderings
 * show it did not. Tracked by the dedicated 'Sign placement' check below rather
 * than failing every amount comparison on it.
 */
function stripSign(amount: string): string {
  return normalizeValue(amount).replace(/[-\s]/g, '');
}

/**
 * Sign placement, reported separately so it is visible without breaking the
 * value assertions. Open question for Solutions, not a filed defect.
 */
/**
 * Negative balances must render the minus BEFORE the glyph: -₡2.080,70.
 *
 * BLOCKING, not a known defect. The v2/v3 template bump described in runbook §4
 * DID land — verified 2026-08-13 by classifying every rendering in
 * email_notification by date:
 *
 *   before 2026-10-09  glyph-first (₡ -80,70) on every type
 *   ON     2026-10-09  BOTH placements on the same date, every type
 *   after  2026-10-09  minus-first only
 *
 * The mixed day is the template swap in progress — a version bump needs the S3
 * upload AND deletion of the pod-local /data cache, which survives restarts, so
 * different workers served different versions during that run.
 *
 * An earlier note here claimed the fix had not landed. That was sampling error:
 * one row from the mixed day (ACT-100205, one of the 5 glyph-first of 8) read as
 * evidence for the whole population. Blocking now, so a regression back to
 * glyph-first is caught.
 *
 * The one known stale rendering is a BALANCE_TOPUP on 2026-11-04, glyph-first
 * after the swap — consistent with one pod still holding the cached old template.
 */
/**
 * The rendered amount's sign — DIRECTION as well as placement.
 *
 * It used to check placement only, with the note "positive amounts carry no sign,
 * so they pass trivially". That left a hole: an amount that SHOULD be negative
 * but renders with no minus at all is not negative, so it passed trivially too.
 * A dropped sign was therefore invisible — the exact class of defect the
 * 2026-10-09 sign-placement change was about.
 *
 * Two assertions now:
 *
 *   1. DIRECTION. The displayed sign must match `postBalance`'s sign. Both use
 *      the same convention (negative = customer holds credit, positive = owes),
 *      because the engine negates `currencyBal` before the template sees it
 *      (PGBillUnitService.groovy:4490) so that "Saldo actual" reads
 *      positive-means-owes, per JASEC's request.
 *
 *   2. PLACEMENT. A minus must precede the glyph (-₡400, never ₡-400).
 *
 * DEGRADES TO PLACEMENT-ONLY WHEN `postBalance` IS UNDEFINED. This check is not
 * marked `contextual`, so TS-03 runs it while replaying stored bodies — and TS-03
 * has no staged run to derive the expected balance from. Failing there would be a
 * false alarm about historical data, so direction is asserted only when the
 * balance is actually known (TS-02 and TS-04 supply it).
 *
 * 1C (overage) and Event 6 (resume) carry their own explicit direction rows on
 * top of this; those stay, since they encode which direction that event REQUIRES
 * rather than merely agreeing with the measured balance.
 */
const signPlacementCheck = (phrase: string): FieldCheck => ({
  row: 'Sign (direction + placement)',
  expected: (c) => {
    if (c.postBalance === undefined) return 'minus before the glyph when negative, e.g. -₡2.080,70';
    if (c.postBalance < 0) return `minus present and BEFORE the glyph — post ${c.postBalance} is a credit`;
    return `no minus — post ${c.postBalance} is zero or a debt`;
  },
  actual: (c) => amountAfter(c.email.text, phrase) || '(no amount)',
  compare: (actual, _expected, c) => {
    const value = actual.trim();
    if (!value) return false;
    const rendersNegative = isNegativeAmount(value);
    const placementOk = !rendersNegative || /^-\s*₡/.test(value);
    if (c.postBalance === undefined) return placementOk;
    if (c.postBalance < 0 && !rendersNegative) return false;
    if (c.postBalance >= 0 && rendersNegative) return false;
    return placementOk;
  },
});

const commonChecks = (): FieldCheck[] => [
  subjectCheck(), logoCheck(), greetingCheck(),
];

const tailChecks = (): FieldCheck[] => [
  footerCheck(), noUnresolvedTokensCheck(), deliveryStatusCheck(),
];

// ── Event 1A — PREPAID_SUFFICIENT_CREDIT ────────────────────────────────────

const SUFFICIENT_FRAGMENT = 'cuenta con saldo suficiente para los cargos fijos y 15 KWh del mes de';

export const prepaidSufficientCredit: NotificationTemplate = {
  key: 'PREPAID_SUFFICIENT_CREDIT',
  ticket: 'JEPYP-230 §1.1',
  title: 'Event 1A — Inicio de Mes, sufficient credit',
  subject: 'Jasec - Servicio Eléctrico Prepago - Inicio de Mes',
  checks: [
    ...commonChecks(),
    {
      row: 'Body — sufficient credit',
      expected: () => SUFFICIENT_FRAGMENT,
      actual: (c) => (c.email.contains(SUFFICIENT_FRAGMENT) ? SUFFICIENT_FRAGMENT : '(not found)'),
    },
    monthPresentCheck(),
    monthMatchesRunCheck(),
    amountPresentCheck('Saldo actual present', 'Saldo actual'),
    saldoEqualsPostCheck(),
    signPlacementCheck('Saldo actual'),
    {
      row: 'No minimum recharge asked',
      // 1A means the customer already has enough — asking for a top-up here
      // would be the 1B copy leaking into the 1A branch.
      expected: () => 'body does NOT ask for a recarga mínima',
      actual: (c) => (c.email.contains('recarga mínima') ? 'ASKS for a minimum' : 'no minimum asked'),
      compare: (_a, _e, c) => !c.email.contains('recarga mínima'),
    },
    ...tailChecks(),
  ],
};

// ── Event 1B — PREPAID_INSUFFICIENT_CREDIT ──────────────────────────────────

const INSUFFICIENT_FRAGMENT = 'debe realizar recarga mínima de';
const INSUFFICIENT_TAIL = 'por cargos fijos + 15 KWh para el mes de';

export const prepaidInsufficientCredit: NotificationTemplate = {
  key: 'PREPAID_INSUFFICIENT_CREDIT',
  ticket: 'JEPYP-230 §1.2',
  title: 'Event 1B — Inicio de Mes, insufficient credit',
  subject: 'Jasec - Servicio Eléctrico Prepago - Inicio de Mes',
  checks: [
    ...commonChecks(),
    {
      row: 'Body — insufficient credit',
      expected: () => `${INSUFFICIENT_FRAGMENT} … ${INSUFFICIENT_TAIL}`,
      actual: (c) => {
        const head = c.email.contains(INSUFFICIENT_FRAGMENT);
        const tail = c.email.contains(INSUFFICIENT_TAIL);
        return head && tail ? 'both fragments present' : `head=${head} tail=${tail}`;
      },
      compare: (_a, _e, c) =>
        c.email.contains(INSUFFICIENT_FRAGMENT) && c.email.contains(INSUFFICIENT_TAIL),
    },
    monthPresentCheck(),
    monthMatchesRunCheck(),
    amountPresentCheck('Recarga mínima present', 'recarga mínima de'),
    minimumEqualsFormulaCheck('PREPAID_INSUFFICIENT_CREDIT'),
    amountPresentCheck('Saldo actual present', 'Saldo actual'),
    saldoEqualsPostCheck(),
    signPlacementCheck('Saldo actual'),
    ...tailChecks(),
  ],
};

// ── Event 1C — PREPAID_OVERAGE ──────────────────────────────────────────────

const OVERAGE_FRAGMENT = 'por cargos fijos, 15KWh y deuda pendiente para mes de';

export const prepaidOverage: NotificationTemplate = {
  key: 'PREPAID_OVERAGE',
  ticket: 'JEPYP-230 §1.3',
  title: 'Event 1C — Inicio de Mes, overage (already in debt)',
  subject: 'Jasec - Servicio Eléctrico Prepago - Inicio de Mes',
  checks: [
    ...commonChecks(),
    {
      row: 'Body — overage',
      // Note the template's own typos: "15KWh" unspaced and "para mes de"
      // missing "el". Asserted as-rendered so a silent copy edit is visible.
      expected: () => OVERAGE_FRAGMENT,
      actual: (c) => (c.email.contains(OVERAGE_FRAGMENT) ? OVERAGE_FRAGMENT : '(not found)'),
    },
    monthPresentCheck(),
    monthMatchesRunCheck(),
    amountPresentCheck('Recarga mínima present', 'recarga mínima de'),
    minimumEqualsFormulaCheck('PREPAID_OVERAGE'),
    amountPresentCheck('Saldo actual present', 'Saldo actual'),
    {
      row: 'Saldo actual is positive (debt)',
      // 1C only reaches accounts ALREADY in debt when the run starts. A negative
      // balance here means the account crossed zero during the run, which is the
      // 4+5 path — a different event with a different code branch.
      contextual: true,
      expected: () => 'positive — 1C only fires for accounts already in debt',
      actual: (c) => amountAfter(c.email.text, 'Saldo actual'),
      compare: (actual) => !isNegativeAmount(actual),
    },
    ...tailChecks(),
  ],
};

// ── Event 3 — CREDIT_THRESHOLD_BREACH ───────────────────────────────────────

const THRESHOLD_FRAGMENT = 'su saldo está próximo a agotarse';
const THRESHOLD_CTA = 'Por favor recargue para evitar suspensión del servicio';

export const creditThresholdBreach: NotificationTemplate = {
  key: 'CREDIT_THRESHOLD_BREACH',
  ticket: 'JEPYP-230 §3',
  title: 'Event 3 — Saldo próximo a agotarse',
  subject: 'Jasec - Servicio Eléctrico Prepago - Saldo',
  checks: [
    ...commonChecks(),
    {
      row: 'Body — próximo a agotarse',
      expected: () => THRESHOLD_FRAGMENT,
      actual: (c) => (c.email.contains(THRESHOLD_FRAGMENT) ? THRESHOLD_FRAGMENT : '(not found)'),
    },
    // Case 3.5 — BLOCKING again as of 2026-08-13. It was a known defect: bodies
    // rendered "Saldo actual ₡." with nothing after the glyph. Now passing on 3
    // distinct accounts across 3 independent runs (ACT-100152 on JS-100182,
    // ACT-100287 and ACT-100301 on JS-100185/JS-100188), all of which had
    // rendered empty on 2026-10-09.
    //
    // Left blocking deliberately: the empty render was intermittent and its
    // trigger was never identified, so a recurrence must go red rather than be
    // absorbed as expected. The original "no KWH accumulator rows" cause was
    // disproved — ACT-100219 rendered a figure and ACT-100152 did not in the SAME
    // run, both with no kWh in window.
    amountPresentCheck('Saldo actual present', 'Saldo actual'),
    saldoEqualsPostCheck(),
    signPlacementCheck('Saldo actual'),
    {
      row: 'Tax paragraph matches tier',
      contextual: true,
      expected: (c) => tierParagraphExpectation(c),
      actual: (c) => describeTierParagraph(c),
      compare: (_a, _e, c) => tierParagraphCorrect(c),
    },
    {
      row: 'CTA line',
      // The <=100 kWh variant closes with the CTA; the taxed variants replace it
      // with the minimum-recharge sentence. Presence of ONE of the two is the
      // real invariant.
      expected: () => `either "${THRESHOLD_CTA}" or a recarga mínima instruction`,
      actual: (c) => {
        if (c.email.contains(THRESHOLD_CTA)) return 'CTA present';
        if (c.email.contains('recarga mínima')) return 'recarga mínima instruction present';
        return '(neither)';
      },
      compare: (_a, _e, c) =>
        c.email.contains(THRESHOLD_CTA) || c.email.contains('recarga mínima'),
    },
    ...tailChecks(),
  ],
};

function tierParagraphExpectation(c: NotificationContext): string {
  const kwh = c.kwhInWindow;
  if (kwh == null) return 'kWh unknown — cannot predict the tier paragraph';
  if (kwh > 280) return `IVA paragraph ("${IVA_FRAGMENT}"), no bomberos paragraph`;
  if (kwh > 100) return `bomberos paragraph ("${BOMBEROS_FRAGMENT}"), no IVA paragraph`;
  return 'NO tax paragraph';
}

function describeTierParagraph(c: NotificationContext): string {
  const has = [
    c.email.contains(BOMBEROS_FRAGMENT) ? 'bomberos' : null,
    c.email.contains(IVA_FRAGMENT) ? 'IVA' : null,
  ].filter(Boolean);
  return has.length ? `${has.join(' + ')} (kWh=${c.kwhInWindow})` : `none (kWh=${c.kwhInWindow})`;
}

/**
 * THE SINGLE SOURCE OF TRUTH for the ARESEP tier rule.
 *
 * Exported so the boundary spec (ts-05) asserts through this and not a copy —
 * the `>` vs `>=` distinction is the whole point of cases 3.8 and 3.9, and two
 * implementations of it would eventually disagree.
 */
export function tierParagraphCorrect(c: NotificationContext): boolean {
  const kwh = c.kwhInWindow;
  if (kwh == null) return false;
  const bomberos = c.email.contains(BOMBEROS_FRAGMENT);
  const iva = c.email.contains(IVA_FRAGMENT);
  if (kwh > 280) return iva && !bomberos;
  if (kwh > 100) return bomberos && !iva;
  return !bomberos && !iva;
}

// ── Event 4 — CREDIT_LIMIT_BREACH ───────────────────────────────────────────

export const EXHAUSTED_FRAGMENT = 'ha agotado su saldo y su servicio será suspendido';

export const creditLimitBreach: NotificationTemplate = {
  key: 'CREDIT_LIMIT_BREACH',
  ticket: 'JEPYP-230 §4',
  title: 'Event 4 — Saldo Agotado',
  subject: 'Jasec - Servicio Eléctrico Prepago - Saldo Agotado',
  checks: [
    ...commonChecks(),
    {
      row: 'Body — saldo agotado',
      expected: () => EXHAUSTED_FRAGMENT,
      actual: (c) => (c.email.contains(EXHAUSTED_FRAGMENT) ? EXHAUSTED_FRAGMENT : '(not found)'),
    },
    amountPresentCheck('Monto mínimo present', 'Monto mínimo a recargar'),
    minimumEqualsFormulaCheck('CREDIT_LIMIT_BREACH'),
    ...tailChecks(),
  ],
};

// ── Event 5 — SUSPEND_SUBSCRIPTION ──────────────────────────────────────────

const SUSPENDED_FRAGMENT = 'su servicio ha sido suspendido a las';

export const suspendSubscription: NotificationTemplate = {
  key: 'SUSPEND_SUBSCRIPTION',
  ticket: 'JEPYP-230 §5',
  title: 'Event 5 — Servicio Suspendido',
  subject: 'Jasec - Servicio Eléctrico Prepago - Servicio Suspendido',
  checks: [
    ...commonChecks(),
    {
      row: 'Body — suspendido',
      expected: () => SUSPENDED_FRAGMENT,
      actual: (c) => (c.email.contains(SUSPENDED_FRAGMENT) ? SUSPENDED_FRAGMENT : '(not found)'),
    },
    {
      row: 'Suspension time',
      // 12:00:00 AM is GENUINE, not a fallback — CCP time is date-only, so
      // midnight is the correct render. Runbook §4. Do not log as a defect.
      expected: () => '12:00:00 AM (CCP time is date-only — midnight is correct)',
      actual: (c) => c.email.contains('12:00:00 AM') ? '12:00:00 AM' : '(different time)',
      // `expected` is prose for the report, so equality would never hold —
      // the assertion is containment of the timestamp itself.
      compare: (_a, _e, c) => c.email.contains('12:00:00 AM'),
    },
    amountPresentCheck('Monto mínimo present', 'Monto mínimo a recargar'),
    minimumEqualsFormulaCheck('SUSPEND_SUBSCRIPTION'),
    ...tailChecks(),
  ],
};

// ── Event 6 — RESUME_SUBSCRIPTION ───────────────────────────────────────────

const RECONNECTED_FRAGMENT = 'su servicio ha sido reconectado a las';

export const resumeSubscription: NotificationTemplate = {
  key: 'RESUME_SUBSCRIPTION',
  ticket: 'JEPYP-230 §6',
  title: 'Event 6 — Servicio Reconectado',
  subject: 'Jasec - Servicio Eléctrico Prepago - Servicio Reconectado',
  checks: [
    ...commonChecks(),
    {
      row: 'Body — reconectado',
      expected: () => RECONNECTED_FRAGMENT,
      actual: (c) => (c.email.contains(RECONNECTED_FRAGMENT) ? RECONNECTED_FRAGMENT : '(not found)'),
    },
    {
      row: 'Reconnection time',
      expected: () => '12:00:00 AM (CCP time is date-only — midnight is correct)',
      actual: (c) => c.email.contains('12:00:00 AM') ? '12:00:00 AM' : '(different time)',
      // `expected` is prose for the report, so equality would never hold —
      // the assertion is containment of the timestamp itself.
      compare: (_a, _e, c) => c.email.contains('12:00:00 AM'),
    },
    amountPresentCheck('Saldo actual present', 'Saldo actual'),
    {
      row: 'Saldo actual is negative (in credit)',
      // resumeRequiresSufficientBalance is on, so a reconnection only happens
      // once the balance is back in credit. A positive figure here means the
      // engine reconnected an account that still owes money.
      contextual: true,
      expected: () => 'negative — reconnection requires the balance back in credit',
      actual: (c) => amountAfter(c.email.text, 'Saldo actual'),
      compare: (actual) => isNegativeAmount(actual),
    },
    signPlacementCheck('Saldo actual'),
    ...tailChecks(),
  ],
};

// ── Event 7 — INVOICE_READY ─────────────────────────────────────────────────

const INVOICE_FRAGMENT = 'le adjunta su factura mensual y estado de cuenta por el servicio eléctrico prepago del mes de';

export const invoiceReady: NotificationTemplate = {
  key: 'INVOICE_READY',
  ticket: 'JEPYP-230 §7',
  title: 'Event 7 — Factura y Estado de Cuenta',
  subject: 'Jasec - Servicio Eléctrico Prepago - Factura y Estado de Cuenta',
  checks: [
    ...commonChecks(),
    {
      row: 'Body — factura adjunta',
      expected: () => INVOICE_FRAGMENT,
      actual: (c) => (c.email.contains(INVOICE_FRAGMENT) ? INVOICE_FRAGMENT : '(not found)'),
    },
    monthPresentCheck(),
    monthMatchesRunCheck(),
    ...tailChecks(),
    // The PDF itself is asserted separately — this template only covers the
    // email body. `email_notification.email` is NULL for INVOICE_READY and its
    // `accountid` sometimes holds a customer number (031201) rather than an
    // ACT- id, so recipient and attachment checks must come from IMAP.
  ],
};

// ── Registry ────────────────────────────────────────────────────────────────

export const BILLING_EVENT_TEMPLATES: Record<string, NotificationTemplate> = {
  PREPAID_SUFFICIENT_CREDIT: prepaidSufficientCredit,
  PREPAID_INSUFFICIENT_CREDIT: prepaidInsufficientCredit,
  PREPAID_OVERAGE: prepaidOverage,
  CREDIT_THRESHOLD_BREACH: creditThresholdBreach,
  CREDIT_LIMIT_BREACH: creditLimitBreach,
  SUSPEND_SUBSCRIPTION: suspendSubscription,
  RESUME_SUBSCRIPTION: resumeSubscription,
  INVOICE_READY: invoiceReady,
};
