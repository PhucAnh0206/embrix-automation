/**
 * Unit tests for the JEPYP-230 balance-band arithmetic.
 *
 * These encode the numbers the runbook verified by hand over several billing
 * runs. The band maths is the part that costs a whole run when it is wrong —
 * a balance staged 200 CRC off lands in a different event, and the run cannot
 * be repeated for that billing period.
 *
 * No DB, no network. Runs in the `unit` project.
 */

import { test, expect } from '@playwright/test';
import {
  branchFor,
  crossesThreshold,
  expectedMinimum,
  postBalance,
  stageFor,
  stageForThreshold,
  thresholdFor,
  tierForKwh,
  willCrossZero,
  THRESHOLD_BASE,
  THRESHOLD_HIGH,
} from '../../helpers/notification-bands';
import {
  amountAfter,
  isNegativeAmount,
  spanishMonth,
} from '../../test-data/notifications/billing-events.templates';

// Figures measured on jasec-dev and recorded in the runbook.
const X = 2915.10;
const C = 2077.20;

test.describe('postBalance', () => {
  test('the branch reads staged balance + the cycle charge', () => {
    expect(postBalance(-2400, 2319.30)).toBeCloseTo(-80.70, 2);
    expect(postBalance(-500, C)).toBeCloseTo(1577.20, 2);
  });
});

test.describe('branchFor', () => {
  test('post <= -X is the sufficient-credit branch', () => {
    expect(branchFor(-50000, X, C)).toBe('PREPAID_SUFFICIENT_CREDIT');
  });

  test('-X < post <= 0 is the insufficient-credit branch', () => {
    // -3500 + 2077.20 = -1422.80, inside (-2915.10, 0]
    expect(branchFor(-3500, X, C)).toBe('PREPAID_INSUFFICIENT_CREDIT');
  });

  test('crossing zero is neither Event 1 branch', () => {
    // The runbook's trap: -100 and -500 look like small-credit Event 1B
    // candidates but cross zero and produce Events 4+5 instead.
    expect(branchFor(-500, X, C)).toBeNull();
    expect(branchFor(-100, X, C)).toBeNull();
  });

  test('the 1A/1B boundary sits exactly at post = -X', () => {
    const atBoundary = -(X + C);            // post === -X exactly
    expect(branchFor(atBoundary, X, C)).toBe('PREPAID_SUFFICIENT_CREDIT');
    expect(branchFor(atBoundary + 0.01, X, C)).toBe('PREPAID_INSUFFICIENT_CREDIT');
  });
});

test.describe('stageFor', () => {
  test('1A stages below -(X+C) with margin, so a bigger charge cannot downgrade it', () => {
    const staged = stageFor('PREPAID_SUFFICIENT_CREDIT', X, C);
    expect(staged).toBeLessThan(-(X + C));
    expect(branchFor(staged, X, C)).toBe('PREPAID_SUFFICIENT_CREDIT');
    // Still 1A even if the real charge is double what we measured.
    expect(branchFor(staged, X, C * 2)).toBe('PREPAID_SUFFICIENT_CREDIT');
  });

  test('1B stages mid-band and matches the runbook-verified -3500 region', () => {
    const staged = stageFor('PREPAID_INSUFFICIENT_CREDIT', X, C);
    expect(staged).toBeCloseTo(-3534.75, 2);
    expect(branchFor(staged, X, C)).toBe('PREPAID_INSUFFICIENT_CREDIT');
    expect(staged).toBeGreaterThan(-(X + C));
    expect(staged).toBeLessThanOrEqual(-C);
  });

  test('1C stages positive — it is decided by the starting sign, not a band', () => {
    expect(stageFor('PREPAID_OVERAGE', X, C)).toBeGreaterThan(0);
  });

  test('4/5 stages a small credit so the charge crosses zero', () => {
    const staged = stageFor('CREDIT_LIMIT_BREACH', X, C);
    expect(willCrossZero(staged, C)).toBe(true);
  });

  test('refuses events that are not staged by balance alone', () => {
    expect(() => stageFor('INVOICE_READY', X, C)).toThrow();
    expect(() => stageFor('CREDIT_THRESHOLD_BREACH', X, C)).toThrow();
  });
});

test.describe('Event 3 thresholds', () => {
  test('tier boundaries are strictly greater-than', () => {
    expect(tierForKwh(100)).toBe('BASE');
    expect(tierForKwh(280)).toBe('BASE');
    expect(tierForKwh(280.01)).toBe('HIGH');
    expect(tierForKwh(350)).toBe('HIGH');
  });

  test('base tier crosses -2000, high tier crosses -4000', () => {
    expect(thresholdFor('BASE')).toBe(THRESHOLD_BASE);
    expect(thresholdFor('HIGH')).toBe(THRESHOLD_HIGH);
  });

  test('the staged values cross their own tier threshold', () => {
    expect(crossesThreshold(stageForThreshold('BASE'), 2319.30, 'BASE')).toBe(true);
    expect(crossesThreshold(stageForThreshold('HIGH'), 2319.30, 'HIGH')).toBe(true);
  });

  test('base staging survives any charge above 400 up to 2400', () => {
    for (const charge of [401, 1000, 2000, 2319.30, 2400]) {
      expect(crossesThreshold(-2400, charge, 'BASE')).toBe(true);
    }
  });

  test('the lower bound is exclusive — a charge of exactly 400 lands ON -2000', () => {
    // post = -2400 + 400 = -2000, and a crossing requires post > threshold.
    // The runbook's "roughly 400" is a lower bound that does not itself cross.
    expect(crossesThreshold(-2400, 400, 'BASE')).toBe(false);
    expect(crossesThreshold(-2400, 400.01, 'BASE')).toBe(true);
  });

  test('a base-tier account staged at -4400 does NOT cross -2000', () => {
    // The runbook's warning: a typical charge then crosses only -4000, which the
    // base tier does not expect, so it is correctly suppressed and sends
    // nothing — indistinguishable from a broken flag.
    expect(crossesThreshold(-4400, 2319.30, 'BASE')).toBe(false);
  });
});

test.describe('expectedMinimum', () => {
  test('1B/1C use |(-X) - post|', () => {
    // Runbook: post -1180.70 with X 2915.10 rendered 1734.40.
    expect(expectedMinimum('PREPAID_INSUFFICIENT_CREDIT', 2915.10, -1180.70)).toBeCloseTo(1734.40, 2);
  });

  test('4/5 use X + post', () => {
    // Runbook: rendered 4492.30.
    expect(expectedMinimum('CREDIT_LIMIT_BREACH', 2915.10, 1577.20)).toBeCloseTo(4492.30, 2);
    expect(expectedMinimum('SUSPEND_SUBSCRIPTION', 2915.10, 1577.20)).toBeCloseTo(4492.30, 2);
  });

  test('refuses events that render no minimum', () => {
    expect(() => expectedMinimum('PREPAID_SUFFICIENT_CREDIT', X, -5000)).toThrow();
  });
});

test.describe('amountAfter', () => {
  test('reads the amount when it sits on the line after the label', () => {
    const text = 'Saldo actual\n₡ -5.861,40 .\nJunta Administrativa';
    expect(amountAfter(text, 'Saldo actual')).toBe('₡-5.861,40');
  });

  test('reads the minus-before-glyph form used by resume_subscription_v3', () => {
    const text = 'Saldo actual\n- ₡ 1.700,00 .';
    expect(amountAfter(text, 'Saldo actual')).toBe('-₡1.700,00');
  });

  test('reads a positive amount', () => {
    expect(amountAfter('Saldo actual ₡ 4.538,60 .', 'Saldo actual')).toBe('₡4.538,60');
  });

  test('returns empty when the label renders with no figure — this is defect 3.5', () => {
    expect(amountAfter('Saldo actual ₡ .\nPor favor recargue', 'Saldo actual')).toBe('');
  });

  test('returns empty when the label is absent', () => {
    expect(amountAfter('Some other body text', 'Saldo actual')).toBe('');
  });

  test('reads the minimum after a mid-sentence phrase', () => {
    const text = 'Jasec informa que debe realizar recarga mínima de\n₡ 2.553,70\npor cargos fijos';
    expect(amountAfter(text, 'recarga mínima de')).toBe('₡2.553,70');
  });
});

test.describe('isNegativeAmount', () => {
  test('detects the minus on either side of the glyph', () => {
    expect(isNegativeAmount('₡-80,70')).toBe(true);
    expect(isNegativeAmount('-₡1.700,00')).toBe(true);
    expect(isNegativeAmount('₡4.538,60')).toBe(false);
  });
});

test.describe('spanishMonth', () => {
  test('names the CCP month', () => {
    expect(spanishMonth('2026-10-09')).toBe('Octubre');
    expect(spanishMonth('2026-11-04')).toBe('Noviembre');
    expect(spanishMonth('2026-01-31')).toBe('Enero');
    expect(spanishMonth('2026-12-01')).toBe('Diciembre');
  });
});

/**
 * Case 6.2 — the minimum recharge figure must AGREE between the Saldo Agotado
 * (Event 4) and Servicio Suspendido (Event 5) emails.
 *
 * WHY THIS NEEDS ITS OWN CHECK. Each template already asserts its own figure
 * against X + post, so agreement looks like it should follow for free. It does
 * not: `minimumEqualsFormulaCheck` deliberately accepts [x, x*3, x/3] to absorb
 * the unresolved 45-vs-15 kWh basis (report case 6.3). So Event 4 can render on
 * one basis and Event 5 on the other, BOTH pass their own check, and the customer
 * is quoted two different amounts for the same suspension.
 *
 * The live cross-check lives in TS-02 and needs delivered mail — Event 4 has no
 * email_notification row (defect 4.2). These tests pin the comparison itself so
 * the logic is proven without a billing run.
 */
test.describe('case 6.2 — minimum agrees across Events 4 and 5', () => {
  // Mirrors the extraction and comparison used in ts-02 step 5.
  const minIn = (text: string) =>
    amountAfter(text, 'recarga mínima de') || amountAfter(text, 'Monto mínimo a recargar');
  const digitsOnly = (s: string) => s.replace(/[^\d]/g, '');
  const agrees = (a: string, b: string) => digitsOnly(a) === digitsOnly(b);

  const agotado = (amt: string) =>
    `Jasec le informa que ha agotado su saldo y su servicio será suspendido. Monto mínimo a recargar ${amt}.`;
  const suspendido = (amt: string) =>
    `Su servicio ha sido suspendido. Monto mínimo a recargar ${amt}.`;

  test('agrees on the real observed pair (ACT-100382 / ACT-100237, 2026-08-14)', () => {
    const m4 = minIn(agotado('₡4.492,30'))!;
    const m5 = minIn(suspendido('₡4.492,30'))!;
    expect(agrees(m4, m5)).toBe(true);
    expect(digitsOnly(m4)).toBe('449230');
  });

  /**
   * Pins a real quirk rather than assuming it away: when the amount ends the
   * sentence, `amountAfter` absorbs the trailing full stop — "₡4.492,30." — because
   * its pattern accepts `.` as a thousands separator and cannot tell the two apart.
   *
   * Harmless for THIS check because the comparison is digits-only, and that is
   * precisely why it is digits-only rather than string equality. Anything that
   * compares these values as raw strings needs to know.
   */
  test('the extracted amount can carry a trailing full stop', () => {
    expect(minIn(agotado('₡4.492,30'))).toBe('₡4.492,30.');
    expect(minIn('Monto mínimo a recargar ₡4.492,30 para continuar')).toBe('₡4.492,30');
    expect(agrees('₡4.492,30.', '₡4.492,30')).toBe(true);
  });

  test('catches the 3x kWh-basis split that each template would pass on its own', () => {
    // 2915.10 (45 kWh basis) vs 971.70 (15 kWh basis) — exactly 3x apart.
    const m4 = minIn(agotado('₡4.492,30'))!;
    const m5 = minIn(suspendido('₡1.497,43'))!;
    expect(agrees(m4, m5)).toBe(false);
  });

  test('ignores formatting differences in the glyph and spacing', () => {
    expect(agrees('₡4.492,30', '₡ 4.492,30')).toBe(true);
    expect(agrees('₡4.492,30', '4.492,30')).toBe(true);
  });

  test('reports a missing figure rather than treating it as agreement', () => {
    expect(minIn('Monto mínimo a recargar ₡.')).toBeFalsy();
    expect(minIn(suspendido('₡4.492,30'))).toBeTruthy();
  });
});
