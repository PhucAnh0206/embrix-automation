import { expect, test } from '@playwright/test';
import { DbHelper } from './db.helper';

/**
 * Where a NEW account's first billing cycle ends - PREDICTED, then compared with what the system stored (N4, 2026-10-28).
 *
 * Until now the billing specs READ the first bill date after seeding and billed on it, so a wrong date could never fail
 * anything. That hid N4 for two weeks: dev 10-20 / day 9 -> 12-09 (retro L4, 10-12), "not predictable across
 * environments" (free-billing-day.helper.ts, 10-19), preprod ACT-100222-236 / ACT-100244, and prod's first customer
 * ACT-100000 (10-27 / day 10 -> 12-10, November skipped). Most accounts follow the rule below (preprod 10-28: 642 of
 * 663; the probe ACT-100924-929, API and Core UI; the same-day, next-day, Dec->Jan and into-February cases all hold).
 *
 * CONFIRMED by Luis (JASEC business, 2026-10-28): the first cycle ends on the NEXT billing day strictly after creation
 * (created on the billing day itself -> next month), with no proration and the full minimum charged; prepaid accounts
 * default to billing day 1. If the rule ever changes, change THIS function only.
 * Billing days are 1-28 only (verified 10-28): the API refuses 29-31 ("Only Billing Day of Month 1 to 28 is
 * supported", UNSUPPORTED_BDOM), so a month never lacks the billing day. The clamp below to the month's last day is a
 * guard for that, not a product behaviour we have seen.
 *
 * A mismatch is a SOFT failure ("First bill date mismatch") and the caller keeps billing on the date the system gave: billing on the
 * predicted date would find nothing to bill and turn every later check red for one cause.
 */
export function expectedFirstCycleEnd(created: string, billingDay: number): string {
  const [y, m, d] = created.slice(0, 10).split('-').map(Number);
  const on = (yy: number, mm: number) => {                   // mm 1-based; may be 13 -> next year
    const yr = yy + Math.floor((mm - 1) / 12), mo = ((mm - 1) % 12) + 1;
    const last = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
    return `${yr}-${String(mo).padStart(2, '0')}-${String(Math.min(billingDay, last)).padStart(2, '0')}`;
  };
  const thisMonth = on(y, m);
  return thisMonth > `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` ? thisMonth : on(y, m + 1);
}

export interface FirstCycle { accountId: string; created: string; billingDay: number; expected: string; actual: string; ok: boolean }

/**
 * Read the account's creation date, billing day and stored first cycle end (billing_profile.nextbilldate, which the
 * first PENDING bill unit ends on), compare with the prediction and report. Returns null when the profile is not there
 * yet (~60 s), which is reported too - it is not silently skipped.
 */
export async function checkFirstCycle(db: DbHelper, accountId: string, log: (m: string) => void = (m) => console.log(`  ${m}`)): Promise<FirstCycle | null> {
  let row: { created: string; day: number; next: string | null } | undefined;
  for (let i = 0; i < 20; i++) {
    row = (await db.query<{ created: string; day: number; next: string | null }>(
      `SELECT a.createddate::date::text AS created, bp.billingdom AS day, bp.nextbilldate::date::text AS next
         FROM core_engine.account a JOIN core_engine.billing_profile bp ON bp.accountid = a.id AND bp.id = 'PRIMARY'
        WHERE a.id = $1`, [accountId]))[0];
    if (row?.next) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (!row?.next) {
    expect.soft(row?.next ?? null, `First bill date missing - ${accountId}: no first bill date stored after 60 s, so the first billing cycle could not be checked`).not.toBeNull();
    return null;
  }
  const expected = expectedFirstCycleEnd(row.created, Number(row.day));
  const r: FirstCycle = { accountId, created: row.created, billingDay: Number(row.day), expected, actual: row.next, ok: row.next === expected };
  log(`first cycle ${accountId}: created ${r.created}, billing day ${r.billingDay} -> ends ${r.actual} ` +
    (r.ok ? '(as predicted)' : `(FIRST BILL DATE MISMATCH: predicted ${expected})`));
  test.info().annotations.push({ type: r.ok ? 'first-bill-date' : 'first-bill-date-mismatch', description:
    `${accountId}: created ${r.created}, billing day ${r.billingDay}, first cycle ends ${r.actual}, predicted ${expected}` });
  expect.soft(r.actual, `First bill date mismatch (rule confirmed by JASEC 2026-10-28) - ${accountId} ` +
    `created ${r.created} with billing day ${r.billingDay}: the first billing cycle should end on the next billing day ` +
    `${expected}, the system set ${r.actual}`).toBe(expected);
  return r;
}
