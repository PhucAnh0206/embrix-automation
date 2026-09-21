/**
 * Balance-band arithmetic for the JEPYP-230 prepaid notification events.
 *
 * Source of truth: notes/RUNBOOK-QA-all-events.md §1.
 *
 * The prepaid condition branch reads the POST-CHARGE balance. Billing debits the
 * cycle's charges first, then the notification code reads the balance. So the
 * number you stage is NOT the number the branch sees:
 *
 *     post = balance + C
 *
 * Two per-account figures drive everything, and NEITHER is a constant:
 *   C — the account's cycle charge (2,077.20 and 2,319.30 were observed on
 *       neighbouring accounts in the same run).
 *   X — `minimumtopupamount` from `get_correspondence_data`.
 *
 * Pure functions only — no DB, no Playwright. Unit-tested in
 * tests/unit/notification-bands.spec.ts.
 */

/** The seven notification events this suite stages for. */
export type BillingEvent =
  | 'PREPAID_SUFFICIENT_CREDIT'    // 1A
  | 'PREPAID_INSUFFICIENT_CREDIT'  // 1B
  | 'PREPAID_OVERAGE'              // 1C
  | 'CREDIT_THRESHOLD_BREACH'      // 3
  | 'CREDIT_LIMIT_BREACH'          // 4
  | 'SUSPEND_SUBSCRIPTION'         // 5
  | 'RESUME_SUBSCRIPTION'          // 6
  | 'INVOICE_READY';               // 7

/** kWh tier for Event 3. Decides which threshold the balance must cross. */
export type KwhTier = 'BASE' | 'HIGH';

/**
 * Thresholds the balance can cross on the way toward zero.
 *
 * TENANT CONFIG, not physics — override per environment with
 * JASEC_THRESHOLD_BASE / JASEC_THRESHOLD_HIGH. The jasec-dev values are the
 * defaults. Do not assume they carry to another tenant: confirm against the
 * environment before staging, because a wrong threshold means the crossing
 * never happens and the event is correctly suppressed, which is
 * indistinguishable from a broken flag.
 *
 * The 100 / 280 kWh tax boundaries in `tierForKwh` are NOT configurable — those
 * come from ARESEP tariff law, not tenant setup.
 */
/**
 * A tenant's two credit-limit thresholds, as configured on the account's OWN
 * credit profile (`core_config.credit_profiles.valuethreshold`, e.g. "-4000|-2000").
 *
 * PASS THESE IN rather than relying on the module defaults. Staging is derived
 * from the threshold, so a tenant configured with different values would be
 * staged at a balance that never crosses — the run would produce no email and the
 * suite would report a product defect that does not exist. Dev confirmed on
 * 2026-08-14 that production MUST assign a profile carrying thresholds, but not
 * that every tenant carries THESE numbers.
 *
 * Read them with NotificationDbHelper.getAccountThresholds().
 */
export interface Thresholds {
  /** Applies to the <=280 kWh tier. Less negative of the two. */
  base: number;
  /** Applies above 280 kWh. More negative of the two. */
  high: number;
}

/**
 * How far BELOW the threshold to stage.
 *
 * Crossing requires starting at or below the threshold and ending above it, so
 * the staged balance must sit under it by less than the cycle charge. 400 leaves
 * room for any charge above 400 while staying clear of the next band.
 */
const STAGING_MARGIN = 400;

export const THRESHOLD_BASE = Number(process.env.JASEC_THRESHOLD_BASE ?? -2000);
export const THRESHOLD_HIGH = Number(process.env.JASEC_THRESHOLD_HIGH ?? -4000);

/**
 * Fallback when the caller does not supply the account's own thresholds.
 * Confirmed correct for jasec-dev, but treat it as a default, not a fact.
 */
export const DEFAULT_THRESHOLDS: Thresholds = { base: THRESHOLD_BASE, high: THRESHOLD_HIGH };

/**
 * Post-charge balance the branch actually reads.
 *
 * Rounded to cents deliberately. Left unrounded, `-(X + C) + C` lands on
 * -2915.099999999999 instead of -X, and the 1A/1B boundary test flips to the
 * wrong branch on a value that is exactly on the line.
 */
export function postBalance(stagedBalance: number, C: number): number {
  return round2(stagedBalance + C);
}

/**
 * Which Event-1 branch a staged balance will land in, given X and C.
 * Returns null when the balance crosses zero — that trips the credit-limit
 * breach instead (Events 4+5), which is a different code path entirely.
 */
export function branchFor(stagedBalance: number, X: number, C: number): BillingEvent | null {
  const post = postBalance(stagedBalance, C);
  if (post > 0) return null;                       // crosses zero -> 4+5, not an Event 1
  if (post <= -X) return 'PREPAID_SUFFICIENT_CREDIT';
  return 'PREPAID_INSUFFICIENT_CREDIT';            // -X < post <= 0
}

/**
 * Balance to stage so a given event fires.
 *
 * 1A/1B are computed from the account's own X and C. 1C and 4/5 are NOT
 * balance-band decisions — see `alreadyPositive` below.
 */
export function stageFor(event: BillingEvent, X: number, C: number): number {
  switch (event) {
    case 'PREPAID_SUFFICIENT_CREDIT':
      // Need balance <= -(X + C). The margin has to absorb a charge larger than
      // the one we measured, and C varies between neighbouring accounts — so it
      // is scaled to C rather than a flat cushion. A flat 1000 is NOT enough:
      // a charge of 2C then lands post above -X and silently downgrades this to
      // 1B, which reads as a template bug rather than a staging error.
      // The runbook stages -50000 by hand for the same reason.
      return round2(-(X + C) - Math.max(5000, 2 * C));

    case 'PREPAID_INSUFFICIENT_CREDIT':
      // Band is -(X+C) < balance <= -C. Midpoint keeps the most room on both
      // sides: too low lands in 1A, too high crosses zero into 4+5.
      // Runbook verified -3500 for X=2915.10 C=2077.20; midpoint gives -3534.75.
      return round2(-(C + X / 2));

    case 'PREPAID_OVERAGE':
      // Decided by starting sign, not by a band. Must be ALREADY positive.
      return 2500;

    case 'CREDIT_LIMIT_BREACH':
    case 'SUSPEND_SUBSCRIPTION':
      // Small credit, so the charge crosses zero and trips the breach.
      // -100 and -500 both work; -500 verified.
      return -500;

    default:
      throw new Error(`stageFor: ${event} is not staged by balance alone`);
  }
}

/**
 * Balance to stage for Event 3, by tier.
 *
 * Staged just below the target threshold on purpose: it survives any cycle
 * charge between roughly 400 and 2,400 (base) or 400 and 4,400 (high).
 *
 * Do NOT stage a BASE-tier account at -4400. A typical charge then crosses only
 * -4000, which that tier does not expect, so `isThresholdForTier` correctly
 * suppresses it and nothing sends — indistinguishable from a broken flag.
 */
export function stageForThreshold(tier: KwhTier, t: Thresholds = DEFAULT_THRESHOLDS): number {
  return round2(thresholdFor(tier, t) - STAGING_MARGIN);
}

/** Threshold an Event 3 account of this tier is expected to cross. */
export function thresholdFor(tier: KwhTier, t: Thresholds = DEFAULT_THRESHOLDS): number {
  return tier === 'BASE' ? t.base : t.high;
}

/** Tier implied by accumulated kWh. Boundaries are STRICTLY greater-than. */
export function tierForKwh(kwh: number): KwhTier {
  return kwh > 280 ? 'HIGH' : 'BASE';
}

/**
 * Expected `minimumTopupAmount` in the rendered body.
 *
 * Runbook §4: reconcile the amount, never expect a fixed number.
 *   Events 1B/1C : |(-X) - post|
 *   Events 4/5   : X + post
 */
export function expectedMinimum(event: BillingEvent, X: number, post: number): number {
  switch (event) {
    case 'PREPAID_INSUFFICIENT_CREDIT':
    case 'PREPAID_OVERAGE':
      return round2(Math.abs(-X - post));
    case 'CREDIT_LIMIT_BREACH':
    case 'SUSPEND_SUBSCRIPTION':
      return round2(X + post);
    default:
      throw new Error(`expectedMinimum: ${event} does not render a minimum`);
  }
}

/**
 * Does this staged balance cross the tier's threshold?
 *
 * A crossing means the balance moves from at-or-below the threshold to above
 * it. Event 3 fires on the crossing, not on the final value.
 */
export function crossesThreshold(
  stagedBalance: number,
  C: number,
  tier: KwhTier,
  t: Thresholds = DEFAULT_THRESHOLDS,
): boolean {
  const threshold = thresholdFor(tier, t);
  return stagedBalance <= threshold && postBalance(stagedBalance, C) > threshold;
}

/**
 * Guard for the trap in runbook §1: an account CROSSING zero produces Events
 * 4+5 and no Event 1, while an account ALREADY positive produces 1C. Same end
 * balance, different event, decided entirely by where it started.
 */
export function willCrossZero(stagedBalance: number, C: number): boolean {
  return stagedBalance <= 0 && postBalance(stagedBalance, C) > 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
