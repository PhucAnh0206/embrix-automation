/**
 * The tenant CCP clock on test tenants (Anh, 2026-11-02): nothing puts it back at the end, so a case can start on ANY
 * date - the shared fixture's 2026-07-15 reset, or a date far ahead left by a billing case. A case that depends on the
 * date must pick a suitable one itself, FORWARD from wherever the clock is, instead of failing on the clock it found.
 */

/**
 * Put the clock back at the end of a test? Only on prod (live and locked - nothing is run there) or when
 * JASEC_CLOCK_RESTORE=true for a one-off. Moves a test needs (to a bill date, one clock day per status change, the
 * fixture's reset at the START of a test) are not affected - only the restore at the end.
 */
export const CLOCK_RESTORE = (process.env.TEST_ENV ?? '').trim() === 'jasec'
  || String(process.env.JASEC_CLOCK_RESTORE ?? '').trim().toLowerCase() === 'true';

/** Prod runs on the real clock: never move it there. */
const CLOCK_FIXED = (process.env.TEST_ENV ?? '').trim() === 'jasec';

type Clock = { ccpDate(): Promise<string>; setCcpDate(date: string): Promise<unknown> };
type Db = { query<T>(sql: string, params?: unknown[]): Promise<T[]> };

/** `YYYY-MM-DD` plus `n` days. */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first day of the month after `iso`. */
export function firstOfNextMonth(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** Move the clock to `target` if that is AHEAD of it; never back. Returns the clock date it is on afterwards. */
export async function clockForward(clock: Clock, target: string, why = ''): Promise<string> {
  const now = (await clock.ccpDate()).slice(0, 10);
  if (CLOCK_FIXED || !(target > now)) return now;
  await clock.setCcpDate(target);
  console.log(`  clock ${now} -> ${target}${why ? ` (${why})` : ''}`);
  return target;
}

/**
 * The latest date anything of the account carries: an order, a service-history row (cut / reconnect), a meter reading
 * or a transaction. '' when the account has none.
 */
export async function accountLatestDate(db: Db, accountId: string): Promise<string> {
  const r = await db.query<{ d: string | null }>(
    `SELECT greatest(
        (SELECT max(createddate)::date FROM core_oms."order" WHERE accountid = $1),
        (SELECT max(a.effectivedate)::date FROM core_engine.service_unit_aud a
           JOIN core_engine.service_unit su ON su.id = a.id WHERE su.accountid = $1),
        (SELECT max(latestreadingdate)::date FROM core_usage.service_usage_readings WHERE accountid = $1),
        (SELECT max(startdate)::date FROM core_engine.transaction_unit WHERE accountid = $1)
      )::text AS d`, [accountId]);
  return r[0]?.d ?? '';
}

/**
 * A case that continues from an account made earlier (another run, a night half, a seeding step): move the clock
 * forward to the day after the account's latest date, so what the case does next is dated after everything the
 * account already has - whatever date the clock was left on. Returns the clock date.
 */
export async function clockPastAccount(db: Db, clock: Clock, accountId: string): Promise<string> {
  const latest = await accountLatestDate(db, accountId);
  if (!latest) return (await clock.ccpDate()).slice(0, 10);
  return clockForward(clock, addDays(latest, 1), `after ${accountId}'s latest date ${latest}`);
}
