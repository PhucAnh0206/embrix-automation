/**
 * Several credit-limit breaches in ONE BILL_CHECK run must not freeze it.
 *
 * Why: jasec-preprod, 2026-10-03. Bill Check for Sep 11 froze three seconds after 3-4 accounts hit
 * credit-limit breaches, Kubernetes restarted service-billing after ~2.5 min, the run was marked ERROR
 * and its bills were never made. Huy: 5 billing workers each held a database connection and each breach
 * email needed another one (REQUIRES_NEW) from a pool of only 5. Workaround: pool 5 -> 20 on dev and
 * preprod (prod already 60). An engine fix was announced.
 *
 * WHAT A PASS PROVES - read this before quoting it. With 20 connections and 5 workers, at most 10 are
 * needed, so this run cannot freeze on dev today with or without the engine fix. A PASS confirms the
 * workaround holds under several simultaneous breaches. It does not prove the engine fix.
 *
 * How: seed N fresh prepaid CHECK accounts with ZERO balance on a quiet billing day, move the clock to
 * their bill date, run BILL_CHECK alone. Each account's monthly charge exceeds its credit (limit 0), so
 * each one breaches.
 *   PASS    BILL_CHECK reaches a final status and EVERY seeded account has a result row
 *           (billed, or refused with its credit-limit reason).
 *   FAIL    the run hangs, or any seeded account has no result - which is what the freeze looked like.
 *   BLOCKED fewer than 5 accounts actually breached, so the run did not exercise the problem.
 *
 * MUTATING, dev only: seeds accounts, moves the tenant CCP clock forward (restored afterwards), spends a
 * SCHEDULED job slot on the bill date.
 *
 *   $env:JASEC_BREACH_RUN='true'; npx playwright test --project=jasec-billing-breach --reporter=line
 *   optional: JASEC_BREACH_N (default 8), JASEC_BREACH_BDOM (default 20)
 */
import { test, expect } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { JobScheduleHelper } from '../../../../helpers/job-schedule.helper';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN = String(process.env.JASEC_BREACH_RUN ?? '').trim().toLowerCase() === 'true';
const DEV_ONLY = process.env.TEST_ENV === 'jasec-dev';
const N = Number(process.env.JASEC_BREACH_N ?? 8);
const BDOM = Number(process.env.JASEC_BREACH_BDOM ?? 20);
const MIN_BREACHES = 5; // the old pool size - fewer simultaneous breaches could never have frozen it

test('several credit-limit breaches in one BILL_CHECK run do not freeze it', async ({ request }) => {
  if (blockedIf(!RUN, 'JASEC_BREACH_RUN is not "true" - this seeds accounts and moves the CCP clock')) return;
  if (blockedIf(!DEV_ONLY, `dev only (TEST_ENV=${process.env.TEST_ENV})`)) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access to read the run result')) return;
  test.setTimeout(1_200_000);

  const logger = new TestLogger('ts-11-credit-breach');
  const seed = new PrepaidSeedHelper(logger);
  const db = new DbHelper();
  await db.connect();
  const startClock = await seed.ccpDate();
  try {
    // 1. N zero-balance accounts on a quiet billing day (no top-up = balance 0, credit limit 0).
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const s = uniqueRunSuffix();
      const { accountId } = await seed.seed({
        meter: assertQaMeter(`M-QABRC-${s}`), customerId: `E2EBRC-${s}`, name: `E2EBRC ${s}`, billingDom: BDOM,
      });
      ids.push(accountId);
    }
    console.log(`  seeded ${ids.length} zero-balance accounts on BDOM ${BDOM} at ${startClock}: ${ids.join(', ')}`);

    // 2. Their bill date, once each has a PENDING bill unit (the order completes asynchronously).
    let dates: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await db.query<{ d: string; n: number }>(
        `SELECT (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text AS d, count(*)::int n
           FROM core_engine.billing_profile bp
           JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
          WHERE bp.accountid = ANY($1) GROUP BY 1`, [ids]);
      const ready = r.reduce((a, x) => a + x.n, 0);
      dates = r.map(x => x.d);
      if (ready === ids.length) break;
      await new Promise(res => setTimeout(res, 3_000));
    }
    if (blockedIf(dates.length !== 1, `seeded accounts are not all ready on one bill date (got ${JSON.stringify(dates)})`)) return;
    const billDate = dates[0];

    const others = await db.query<{ n: number }>(
      `SELECT count(DISTINCT bp.accountid)::int n
         FROM core_engine.billing_profile bp
         JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
         JOIN core_engine.payment_profile pp ON pp.accountid = bp.accountid AND pp.paymentmethod = 'CHECK'
        WHERE bp.accountid <> ALL($1)
          AND bp.nextaccountingdate = $2::date - core_engine.get_future_cycle_date(bp.accountid)`, [ids, billDate]);
    console.log(`  bill date ${billDate}; other dev accounts due that day: ${others[0]?.n ?? 0}`);

    // 3. Clock to the bill date (setCcpDate clears a stranded future-order pin first), BILL_CHECK alone.
    await seed.setCcpDate(billDate);
    const jobs = new JobScheduleHelper(request, logger);
    const scheduleId = await jobs.createSchedule({ scheduleDate: billDate, frequency: 'SCHEDULED', jobs: [{ type: 'BILL_CHECK' }] });
    const t0 = Date.now();
    let processError = '';
    // processJobSchedule returns at once with PROCESSING - it does NOT wait for the run. Poll the
    // BILL_CHECK row until it is final, and only then read results or touch the clock: restoring the
    // clock mid-run made the later accounts refuse with "Not yet time for Billing" (JS-100848, 2026-10-05).
    await jobs.processSchedule(scheduleId, 600_000).catch(e => { processError = String((e as Error)?.message ?? e).slice(0, 200); });
    let status = '';
    for (let i = 0; i < 96 && !['COMPLETED', 'ERROR'].includes(status); i++) { // up to 8 min
      await new Promise(res => setTimeout(res, 5_000));
      status = (await db.query<{ s: string }>(
        `SELECT coalesce(status,'') s FROM core_engine.job_schedule_list WHERE id = $1 AND type = 'BILL_CHECK'`, [scheduleId]))[0]?.s ?? '';
    }
    const secs = Math.round((Date.now() - t0) / 1000);

    // 4. What happened, from the database.
    const row = (await db.query<{ jobid: string; status: string; ok: number; err: number }>(
      `SELECT jobid, coalesce(status,'') status, coalesce(countsuccess,0)::int ok, coalesce(counterror,0)::int err
         FROM core_engine.job_schedule_list WHERE id = $1 AND type = 'BILL_CHECK'`, [scheduleId]))[0];
    const results = await db.query<{ accountid: string; r: string; reason: string }>(
      `SELECT accountid, 'billed' r, '' reason FROM core_engine.jobs_success WHERE id = $1 AND accountid = ANY($2)
       UNION ALL
       SELECT accountid, 'refused', coalesce(reason,'') FROM core_engine.jobs_error WHERE id = $1 AND accountid = ANY($2)`,
      [row?.jobid ?? '', ids]);
    const breaches = results.filter(r => /credit limit/i.test(r.reason)).length;
    const missing = ids.filter(id => !results.some(r => r.accountid === id));
    console.log(`  ${scheduleId} BILL_CHECK ${row?.status} in ${secs}s - success ${row?.ok}, error ${row?.err}` +
      `${processError ? ` (process call: ${processError})` : ''}`);
    console.log(`  our ${ids.length}: ${results.filter(r => r.r === 'billed').length} billed, ` +
      `${results.filter(r => r.r === 'refused').length} refused (${breaches} credit-limit), ${missing.length} with NO result`);

    expect(['COMPLETED', 'ERROR'], `BILL_CHECK did not finish (status "${row?.status}") after ${secs}s - the freeze`)
      .toContain(row?.status);
    expect(missing, `seeded accounts with no billing result - their bills were never made (what the freeze looked like): ` +
      missing.join(', ')).toEqual([]);
    blockedIf(breaches < MIN_BREACHES,
      `only ${breaches} account(s) breached their credit limit - at least ${MIN_BREACHES} at once are needed to exercise the freeze`);
    console.log(`  PASS - ${breaches} simultaneous credit-limit breaches, run finished in ${secs}s, every account accounted for`);
  } finally {
    await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
    await db.disconnect();
  }
});
