/**
 * SEEDING, not a test of the product. Creates fresh prepaid accounts that the live notification
 * runs (ts-02 billing events, ts-05 tier boundaries) can stage on - so they no longer depend on
 * whatever accounts happen to be due on a date (preprod 2026-10-08: the only usable date also
 * billed a UAT account, ACT-100282, so both specs were correctly BLOCKED).
 *
 * Each account:
 *   - is on the Prepaid Energy Profile (the seeder's default) - with JASEC_WARN_PROFILE=prepaid
 *     the warning cases then prove a PREPAID customer is warned (JEPYP-319 Q1);
 *   - has the monitored mailbox as its contact, EXACTLY (the specs' pools match it exactly; ts-02
 *     plus-addresses the ones it stages and restores them);
 *   - pays by CHECK (the seeder's default), so BILL_CHECK bills it;
 *   - is created ON its billing day (BDOM = clock day), so the first cycle is one full month and
 *     the bill is the full fixed charge (TC-59 rule);
 *   - gets JASEC_COHORT_TOPUP credit (default 5,000) so its bill goes through and the account
 *     moves on to the next cycle - set 0 to leave it at zero.
 *
 * No billing and no clock move. It prints the bill date to pass to the specs:
 *   ts-05: JEPYP230_TIER_DATE=<bill date>       ts-02: JEPYP230_SCHEDULE_DATE=<bill date>
 *
 *   $env:JASEC_SEED_RUN='true'; npx playwright test --project=jasec-seed seed-notification-cohort
 *   optional: JASEC_COHORT_N (default 8), JASEC_COHORT_TOPUP (default 5000)
 *
 * dev, preprod and prod build 2 only; never the final customer build.
 */
import { test, expect } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import { EmailHelper } from '../../../../helpers/email.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN_ENABLED = String(process.env.JASEC_SEED_RUN ?? '').trim().toLowerCase() === 'true';
const ALLOWED_ENV = ['jasec-dev', 'jasec-preprod', 'jasec'].includes(process.env.TEST_ENV ?? '');
const N = Number(process.env.JASEC_COHORT_N ?? 8);
const TOPUP = Number(process.env.JASEC_COHORT_TOPUP ?? 5000);

test('seed a notification cohort on its own billing day', async () => {
  if (blockedIf(!RUN_ENABLED, 'JASEC_SEED_RUN is not "true" - this creates accounts')) return;
  if (blockedIf(!ALLOWED_ENV, `dev / preprod / prod build 2 only (TEST_ENV=${process.env.TEST_ENV})`)) return;
  if (blockedIf(!(N > 0) || !(TOPUP >= 0), 'JASEC_COHORT_N must be > 0 and JASEC_COHORT_TOPUP >= 0')) return;
  test.setTimeout(600_000);

  const logger = new TestLogger('seed-notification-cohort');
  const seed = new PrepaidSeedHelper(logger);
  const db = new DbHelper();
  await db.connect();
  try {
    const today = await seed.ccpDate();
    const day = Number(today.slice(8, 10));
    if (blockedIf(day > 28, `the clock is on day ${day}; billing days are 1-28 only`)) return;
    const email = EmailHelper.recipient();

    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const s = uniqueRunSuffix();
      const { accountId } = await seed.seed({
        meter: assertQaMeter(`M-QANOT-${s}`), customerId: `E2ENOT-${s}`, name: `E2ENOT ${s}`, billingDom: day, email,
      });
      ids.push(accountId);
    }
    if (TOPUP > 0) for (const id of ids) await seed.topUp(id, TOPUP);

    // The bill date, once every account has its PENDING bill unit (the order completes asynchronously).
    let rows: Array<{ accountid: string; d: string; profile: string; s: string; e: string }> = [];
    for (let i = 0; i < 30; i++) {
      rows = await db.query(
        `SELECT bp.accountid, (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text d,
                coalesce(sub.creditprofilename, '') profile, bu.startdate::date::text s, bu.enddate::date::text e
           FROM core_engine.billing_profile bp
           JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
           LEFT JOIN core_engine.subscription sub ON sub.accountid = bp.accountid AND sub.status = 'ACTIVE'
          WHERE bp.accountid = ANY($1)`, [ids]);
      if (rows.length === ids.length) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    for (const r of rows) console.log(`  ${r.accountid}: cycle ${r.s} -> ${r.e}, bill date ${r.d}, profile ${r.profile}`);
    const dates = [...new Set(rows.map((r) => r.d))];
    expect(rows.length, `accounts without a PENDING bill unit: ${ids.filter((id) => !rows.some((r) => r.accountid === id)).join(', ')}`)
      .toBe(ids.length);
    expect(dates.length, `the accounts do not share one bill date: ${dates.join(', ')}`).toBe(1);
    expect(rows.filter((r) => r.profile !== 'Prepaid Energy Profile').map((r) => r.accountid), 'not on the Prepaid Energy Profile')
      .toEqual([]);
    console.log(`\n  COHORT ${ids.join(', ')} | credit ${TOPUP} each | bill date ${dates[0]}\n`);
    test.info().annotations.push({ type: 'cohort', description: `${ids.join(',')} bill ${dates[0]}` });
  } finally {
    await db.disconnect();
  }
});
