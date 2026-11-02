import { DbHelper } from './db.helper';
import { checkFirstCycle, expectedFirstCycleEnd } from './first-bill-date.helper';
import { ensureDateFree, reclaimAllowed } from './schedule-slot.helper';

/**
 * Seeding on a usable bill date, for tests that seed an account and bill it (TC-61, 88/89, 147, 149, 153, 154).
 *
 * A date holds one daily run, so the account's FIRST BILL DATE must have no job schedule yet. The first cycle ends on the
 * next billing day after creation (confirmed by JASEC 2026-10-28; first-bill-date.helper), so the bill date of every
 * billing day is predicted. A day whose predicted bill date is free is tried first (one clean run per date); otherwise,
 * on dev / preprod, the earliest day, whose used date is RECLAIMED (schedule-slot.helper ensureDateFree - a re-run bills
 * only accounts not billed yet, verified 2026-10-28). Each seeded account is checked against the prediction
 * (checkFirstCycle, a soft "First bill date mismatch" failure) and billed on the date the system really gave.
 * A date that cannot be reclaimed (a PROCESSING run, another tenant, JASEC_RECLAIM_SLOTS=false) returns null: the caller
 * BLOCKS. The clock is never moved here. The old "try other days / jump the clock a month ahead" fallback is archived in
 * the QA notes (slot-date fallbacks, 2026-10-28).
 */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00Z`);

/** The account's real first bill date, once its PENDING bill unit exists ('' after ~90 s). */
export async function firstBillDate(db: DbHelper, accountId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const d = (await db.query<{ d: string }>(
      `SELECT (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text AS d
         FROM core_engine.billing_profile bp
         JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
        WHERE bp.accountid = $1`, [accountId]))[0]?.d ?? '';
    if (d) return d;
    await new Promise(r => setTimeout(r, 3_000));
  }
  return '';
}

/**
 * Seed with `seed(day)` on a billing day whose bill date is free, or reclaimed. `tries` bounds only seeds that produced
 * no PENDING bill unit (a seeding failure, not a date problem). Returns null (caller: BLOCKED) when no date is usable.
 *
 * `minCycleDays` (default 7): the specs act INSIDE the first cycle (readings the next day, cancel + new service, top-ups)
 * before it is billed, so a billing day whose first cycle is shorter goes last. Without it the earliest reclaimable date
 * gave a 1-day cycle (created 11-11, day 12): ts-06's readings fell into the next cycle and TC-154 had no room to cancel
 * and re-subscribe (preprod 2026-10-28). Passing runs had 6-15 days.
 */
export async function seedOnFreeBillDate(
  db: DbHelper,
  clock: { read: () => Promise<string>; set: (d: string) => Promise<unknown> },
  seed: (day: number) => Promise<string>,
  opts: { tries?: number; minCycleDays?: number; log?: (m: string) => void } = {},
): Promise<{ accountId: string; day: number; billDate: string; seedDate: string } | null> {
  const log = opts.log ?? ((m: string) => console.log(`  ${m}`));
  const tries = opts.tries ?? 3;
  const minCycleDays = opts.minCycleDays ?? 7;
  const seedDate = await clock.read();
  const off = Number((await db.query<{ off: number }>(
    `SELECT (core_engine.get_future_cycle_date(accountid))::int AS off FROM core_engine.billing_profile WHERE status = 'ACTIVE' LIMIT 1`))[0]?.off ?? 0);
  const billOn = (cycleEnd: string) => { const d = utc(cycleEnd); d.setUTCDate(d.getUTCDate() + off); return iso(d); };
  const startDay = utc(seedDate).getUTCDate();
  // Billing days 2-28 (29-31 are refused, 1 is shared by most accounts), not the creation day (TC-62).
  const cand = Array.from({ length: 27 }, (_, i) => i + 2).filter(d => d !== startDay).map(d => {
    const end = expectedFirstCycleEnd(seedDate, d);
    return { d, bill: billOn(end), len: Math.round((utc(end).getTime() - utc(seedDate).getTime()) / 86_400_000) };
  });
  const taken = new Set((await db.query<{ d: string }>(
    `SELECT DISTINCT scheduledate::date::text AS d FROM core_engine.job_schedule WHERE scheduledate::date = ANY($1::date[])`,
    [cand.map(c => c.bill)])).map(x => x.d));
  // A first cycle of at least minCycleDays first; within that, free predicted dates before reclaimable ones (where dates
  // can be reclaimed), earliest first.
  const order = [...cand.filter(c => !taken.has(c.bill)), ...(reclaimAllowed() ? cand.filter(c => taken.has(c.bill)) : [])]
    .sort((a, b) => Number(a.len < minCycleDays) - Number(b.len < minCycleDays)
      || Number(taken.has(a.bill)) - Number(taken.has(b.bill)) || a.bill.localeCompare(b.bill));
  if (!order.length) { log(`every predicted bill date from ${seedDate} is taken and reclaiming is not possible here`); return null; }

  for (const c of order.slice(0, tries)) {
    const accountId = await seed(c.d);
    const billDate = await firstBillDate(db, accountId);
    if (!billDate) { log(`${accountId} (billing day ${c.d}): no PENDING bill unit - trying another day`); continue; }
    await checkFirstCycle(db, accountId, log);
    const slot = await ensureDateFree(db, billDate, { log });
    if (slot.free) {
      log(`billing day ${c.d}: ${accountId} bills on ${billDate} (${slot.reclaimed.length ? 'used, reclaimed' : 'free'})`);
      return { accountId, day: c.d, billDate, seedDate };
    }
    log(`billing day ${c.d}: ${accountId} bills on ${billDate} - ${slot.reason}`);
    return null;
  }
  return null;
}
