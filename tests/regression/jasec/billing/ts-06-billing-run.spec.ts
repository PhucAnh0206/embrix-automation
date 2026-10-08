/**
 * Run a billing cycle through the Core UI Daily Schedule screen.
 *
 * WHY THIS EXISTS. Every billing run in the JASEC suite goes over GraphQL
 * (`JobScheduleHelper.createSchedule` + `processSchedule`) — see
 * `notification/ts-02-billing-events.spec.ts:694`, `notification/ts-05-tier-boundaries.spec.ts:396`
 * and `payment/explore-03-prove-bill-from-root.spec.ts:502`. The UI can do it
 * too, which we only established on 2026-08-28, and nothing exercised that path.
 * This spec covers it. THE GRAPHQL PATH IS UNCHANGED and remains the one the
 * suite depends on — this is an addition, not a replacement, so if the screen
 * regresses the regression suite still bills.
 *
 * The page object was already there and unused by JASEC
 * (`pages/operations-hub/jobs-management/daily-schedule.page.ts`, written for the
 * CoopeG suite), so this wires up existing code rather than adding any.
 *
 * IRREVERSIBLE. It moves the tenant CCP clock, spends a `job_schedule` slot, and
 * actually bills real accounts on the tenant, which advances their cycle. Gated
 * behind JASEC_BILL_RUN=true and it refuses to start without an explicit date.
 *
 * THREE RULES THAT DECIDE WHETHER THIS DOES ANYTHING AT ALL:
 *
 *  1. The schedule date must EXACTLY equal an account's own next billing date,
 *     which is `billing_profile.nextaccountingdate + get_future_cycle_date(account)`.
 *     On JASEC that offset is per environment (the cycle-end delay in
 *     core_config.future_cycle_list_config): 8 days on prod and dev, so a BDOM-1
 *     account bills on the 9th and a BDOM-10 account on the 18th; 1 day on preprod,
 *     so BDOM-1 bills on the 2nd. The code computes it - never assume a fixed
 *     offset. Pick any other date and the run completes
 *     successfully having billed nobody — which reads exactly like a broken
 *     screen. Observed for real on 2026-08-28: a schedule on that date ran with
 *     BILL_CHECK and INVOICE_CHECK both COMPLETED and produced no invoice,
 *     because no account on the tenant has a required date of the 28th.
 *
 *  2. CCP time must equal the schedule date, or the Process button stays
 *     disabled. This is why setCcpTime happens before the UI work.
 *
 *  3. Job order is BILL_CHECK then INVOICE_CHECK. The UI's DAILY template
 *     already sequences the whole chain, so unlike the GraphQL path we do not
 *     choose the jobs — CANCEL_SUBSCRIPTION, CRDR_NOTES, CREDIT_LIMIT_ACTIONS and
 *     EBS_EXTRACT run too (the collection jobs were removed from DAILY on
 *     2026-10-05: prepaid has no collections flow). A non-billing job in that
 *     chain reporting ERROR is not this test failing.
 *     We assert on BILL_CHECK / INVOICE_CHECK and on the invoice, never on the
 *     schedule's overall status.
 *
 * USAGE
 *
 *   $env:JASEC_BILL_RUN='true'; $env:JASEC_BILL_DATE='2026-10-18'; npx playwright test --project=jasec-billing-run --reporter=line
 *
 * Add --headed to watch it happen. To find a safe date first — one with few
 * eligible accounts and a free slot — run the query in `pickDateHint` below.
 */

import { test, expect } from '../../../../fixtures/page-factory';
import { DbHelper } from '../../../../helpers/db.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';
import { AgentScreens, uiAmount } from '../../../../helpers/agent-screens.helper';
import * as fs from 'fs';
import * as path from 'path';

/** The invoices this run produced, for TC-143 (billing/ts-13) to judge. Same path there. */
const BILLING_RUN_FILE = path.resolve(__dirname, '../../../../artifacts/billing-run-invoices.json');

/**
 * Accounts a schedule on `date` will actually bill. Conditions mirror
 * NotificationDbHelper.findEligibleAccounts — every one is load-bearing.
 *
 * NOTE THE PAYMENT-METHOD FILTER. core_engine.insert_jobs splits billing four
 * ways by payment method, and each variant selects ONLY its own:
 *
 *   BILL              paymentmethod != 'NON_PAYING'
 *   BILL_CC           paymentmethod  = 'CREDIT_CARD'
 *   BILL_CHECK        paymentmethod  = 'CHECK'
 *   BILL_NON_PAYING   paymentmethod  = 'NON_PAYING'
 *
 * The billed payment methods are READ from the tenant's DAILY template
 * (dailyBilledMethods, since 2026-10-05): dev has BILL_CHECK only; preprod also has
 * BILL_CC + INVOICE_CC (the JEPYP-326 fix). Without this filter the spec would announce a CREDIT_CARD
 * account as "will be billed", the chain would correctly skip it, and the run
 * would fail with "no eligible account gained an invoice" — a false failure
 * against a healthy screen. JASEC is genuinely mixed: on 2026-08-29 dev held 631
 * CHECK and 283 CREDIT_CARD prepaid accounts, preprod 84 and 38.
 *
 */
/**
 * Payment methods the tenant's DAILY template actually bills, read from its own config
 * (BILL_CHECK -> CHECK, BILL_CC -> CREDIT_CARD, BILL_NON_PAYING -> NON_PAYING). It was
 * hard-coded to CHECK, which built JEPYP-326 into the expectation: a CREDIT_CARD account
 * never billed was never counted as a miss, and a fix adding BILL_CC would be misjudged.
 */
async function dailyBilledMethods(db: DbHelper): Promise<string[]> {
  const r = await db.query<{ jobname: string }>(
    `SELECT DISTINCT jobname FROM core_config.config_job_list WHERE id LIKE '%-JOB-DAILY' AND jobname LIKE 'BILL%'`);
  const map: Record<string, string> = { BILL_CHECK: 'CHECK', BILL_CC: 'CREDIT_CARD', BILL_NON_PAYING: 'NON_PAYING' };
  return [...new Set(r.map(x => map[x.jobname]).filter(Boolean))];
}

const ELIGIBLE_SQL = `
  SELECT a.id AS accountid, bp.billingdom
    FROM core_engine.account a
    JOIN core_engine.billing_profile bp ON bp.accountid = a.id
    JOIN core_engine.bill_unit bu       ON bu.accountid = a.id AND bu.status = 'PENDING'
    JOIN core_engine.payment_profile pp ON pp.accountid = a.id
    JOIN core_engine.subscription s     ON s.accountid = a.id AND s.status = 'ACTIVE'
   WHERE a.accountcategory = 'PREPAID'
     AND a.status = 'ACTIVE'
     AND pp.paymentmethod = ANY($2)
     AND bp.nextaccountingdate + core_engine.get_future_cycle_date(a.id) = $1::date
   GROUP BY a.id, bp.billingdom
   ORDER BY a.id`;

/** Same date, but the accounts BILL_CHECK cannot touch. Logged, not asserted:
 *  they are excluded by design and it is worth saying so out loud. */
const EXCLUDED_BY_PAYMENT_METHOD_SQL = `
  SELECT pp.paymentmethod, count(*)::int AS n
    FROM core_engine.account a
    JOIN core_engine.billing_profile bp ON bp.accountid = a.id
    JOIN core_engine.bill_unit bu       ON bu.accountid = a.id AND bu.status = 'PENDING'
    JOIN core_engine.payment_profile pp ON pp.accountid = a.id
    JOIN core_engine.subscription s     ON s.accountid = a.id AND s.status = 'ACTIVE'
   WHERE a.accountcategory = 'PREPAID'
     AND a.status = 'ACTIVE'
     AND pp.paymentmethod <> ALL($2)
     AND bp.nextaccountingdate + core_engine.get_future_cycle_date(a.id) = $1::date
   GROUP BY pp.paymentmethod
   ORDER BY pp.paymentmethod`;

const INVOICE_COUNT_SQL = `
  SELECT count(*)::int AS n FROM core_engine.invoice_unit WHERE accountid = $1`;

/**
 * Stale BILL_CHECK work rows, and the schedules on our date — read BEFORE any
 * clean-up, so the clean-up only removes what was proven idle.
 *
 * WHY NOT A BARE DELETE. This used to be `DELETE ... WHERE type='BILL_CHECK'`,
 * tenant-wide, plus a delete of every schedule on the date. `core_engine.jobs`
 * has no link to a schedule, so that also destroyed the in-flight work of any
 * OTHER billing run on the tenant (cron or a colleague). BILL_CHECK rows only
 * exist while a run is working — on jasec-dev there are none at rest — so a row
 * that does not change across LIVENESS_WINDOW_MS belongs to a run that died,
 * and one that does belongs to a live run we must not touch.
 */
const BILL_CHECK_JOBS_SQL = `
  SELECT id, status FROM core_engine.jobs WHERE type = 'BILL_CHECK' ORDER BY id`;

const SCHEDULES_ON_DATE_SQL = `
  SELECT js.id, js.status, js.schedulefrequency, js.userid, l.type, l.status AS liststatus,
         l.countsuccess, l.counterror
    FROM core_engine.job_schedule js
    LEFT JOIN core_engine.job_schedule_list l ON l.id = js.id
   WHERE js.scheduledate = $1::date
   ORDER BY js.id, l.index`;

/** Delete exactly the rows that were vetted as idle, never ones created since. */
const CLEAR_STALE_BILL_CHECK_SQL = `
  DELETE FROM core_engine.jobs
   WHERE type = 'BILL_CHECK' AND id = ANY($1::varchar[])
  RETURNING id`;

/** How long a leftover must stay unchanged to count as abandoned. */
const LIVENESS_WINDOW_MS = 20_000;

/** The invoice this run produced for one account, newest first. */
const NEWEST_INVOICE_SQL = `
  SELECT id, billunitid, total::float8 AS total, due::float8 AS due,
         to_char(invoicedate,'YYYY-MM-DD') AS invoicedate,
         to_char(duedate,'YYYY-MM-DD')     AS duedate
    FROM core_engine.invoice_unit
   WHERE accountid = $1
   ORDER BY id DESC
   LIMIT 1`;

/**
 * Invoice lines. JASEC prepaid renders four:
 *   ENERGIA (KWH), CVG ENERGIA (KWH-CVG),
 *   ALUMBRADO PUBLICO (ALP), CVG ALUMBRADO PUBLICO (ALP-CVG)
 * `name` is pipe-composite ("ENERGIA|KWH|30|0"), so match on the leading token.
 */
const INVOICE_LINES_SQL = `
  SELECT name, quantity::float8 AS quantity, unitprice::float8 AS unitprice,
         amount::float8 AS amount, gross::float8 AS gross, taxcode
    FROM core_engine.invoice_summary
   WHERE id = $1
   ORDER BY name`;

/**
 * Tax rows key off BILLUNITID, not the invoice id. Two types on this tenant:
 *   MAIN_TAX       rate 0.1300  = IVA 13%
 *   ADDITIONAL_TAX rate 0.0175  = BOM (bomberos) 1.75%
 */
const INVOICE_TAXES_SQL = `
  SELECT taxtype, taxcode, taxrate::float8 AS taxrate,
         sum(taxableamount)::float8 AS taxableamount,
         sum(amount)::float8        AS amount
    FROM core_engine.invoice_tax_detail
   WHERE billunitid = $1
   GROUP BY taxtype, taxcode, taxrate
   ORDER BY taxtype`;

/** CRC balance. Inverted sign: > 0 = debt, < 0 = credit. */
const CRC_BALANCE_SQL = `
  SELECT bub.amount::float8 AS amount
    FROM core_engine.balance_unit bu
    JOIN core_engine.balance_unit_balances bub
      ON bub.id = bu.id AND bub.currencyid = 'CRC'
   WHERE bu.accountid = $1`;

/**
 * kWh accumulated in the cycle the INVOICE covers - keyed on the bill unit's own
 * period, not on the schedule date.
 *
 * Keying on the schedule date is wrong and was the first version of this: billing
 * on the 9th settles the cycle that ENDED on the 1st, so the schedule date falls
 * OUTSIDE the accumulator window and the lookup returns 0. That would report every
 * account as having consumed nothing, and would then assert that tax correctly did
 * not apply - passing for entirely the wrong reason.
 */
const CYCLE_KWH_SQL = `
  SELECT coalesce(sum(bua.amount), 0)::float8 AS kwh
    FROM core_engine.balance_unit bu
    JOIN core_engine.balance_unit_accumulators bua
      ON bua.id = bu.id AND bua.accumulatorid = 'KWH'
    JOIN core_engine.bill_unit bx ON bx.id = $2
   WHERE bu.accountid = $1
     AND bua.startdate::date < bx.enddate::date
     AND bua.enddate::date   > bx.startdate::date`;

/** The PENDING bill unit - the one this run is about to settle. Used to read the
 *  cycle's kWh BEFORE billing, since the invoice does not exist yet. */
const PENDING_BILL_UNIT_SQL = `
  SELECT id FROM core_engine.bill_unit
   WHERE accountid = $1 AND status = 'PENDING'
   ORDER BY id DESC LIMIT 1`;

/** The period a bill unit covers, for reporting alongside the kWh. */
const BILL_PERIOD_SQL = `
  SELECT to_char(startdate,'YYYY-MM-DD') AS startdate,
         to_char(enddate,'YYYY-MM-DD')   AS enddate
    FROM core_engine.bill_unit WHERE id = $1`;

/**
 * Top-ups registered IN THE BILLED CYCLE, so the balance arithmetic can account
 * for them.
 *
 * The period filter is NOT optional, and this query was wrong without it until
 * 2026-09-08: it summed the account's WHOLE top-up history while the comment
 * claimed "in the cycle". Harmless only because every account these runs seed has
 * zero top-ups, so it always read 0 - it would have started lying the moment an
 * account with history was billed, and JEPYP-47 makes the monthly invoice a
 * CONSOLIDATED SUMMARY OF TOP-UPS, which makes this figure load-bearing rather
 * than informational.
 */
const CYCLE_TOPUPS_SQL = `
  SELECT count(*)::int AS n, coalesce(sum(amount), 0)::float8 AS total
    FROM core_engine.subscription_topup t
   WHERE t.accountid = $1
     AND t.createddate >= $2::date
     AND t.createddate <  $3::date`;

/** Live tax thresholds. Never hardcode these - config-preflight.sh guards them. */
const TAX_THRESHOLDS_SQL = `
  SELECT name, accumulatorid,
         minaccumulatorthreshold::float8 AS minthreshold,
         maxaccumulatorthreshold::float8 AS maxthreshold
    FROM core_config.config_tax_product_taxes
   WHERE minaccumulatorthreshold IS NOT NULL`;

/**
 * Why an eligible account was NOT billed.
 *
 * Under Option A a prepaid charge larger than the account's balance is REFUSED,
 * not billed: BILL_CHECK writes a jobs_error saying
 * "Credit Limit 0 for the Currency CRC exceeded by amount X" and the chain
 * reports ERROR. That is correct product behaviour, so an account that gains no
 * invoice for this reason is an expected outcome, not a test failure.
 */
const BILL_REFUSAL_SQL = `
  SELECT l.type, e.reason
    FROM core_engine.jobs_error e
    JOIN core_engine.job_schedule_list l ON l.jobid = e.id
    JOIN core_engine.job_schedule j      ON j.id = l.id
   WHERE j.scheduledate = $1::date
     AND l.type IN ('BILL_CHECK', 'INVOICE_CHECK')
     AND e.accountid = $2
   ORDER BY e.index DESC`;
// SCOPED TO THIS RUN'S DATE (2026-10-05). It used to take the account's latest BILL_CHECK
// error EVER, so an old refusal from an earlier run could "explain" today's missing invoice.
// INVOICE_CHECK errors are read too ("Bill total and invoice total not matched", tracker item 9).

const JOB_CHILDREN_SQL = `
  SELECT l.type, l.status
    FROM core_engine.job_schedule_list l
    JOIN core_engine.job_schedule j ON j.id = l.id
   WHERE j.scheduledate = $1::date
   ORDER BY l.type`;

/**
 * How to choose a date. Lowest eligible-account count with a free slot is the
 * least disruptive, because billing is irreversible for every account it touches:
 *
 *   SELECT to_char(t.req,'YYYY-MM-DD'), count(*) AS eligible,
 *          (SELECT string_agg(js.schedulefrequency||':'||js.status, ',')
 *             FROM core_engine.job_schedule js WHERE js.scheduledate = t.req) AS slots
 *     FROM ( <ELIGIBLE_SQL without the date filter, selecting the computed date as req> ) t
 *    GROUP BY t.req ORDER BY count(*) ASC;
 */
const pickDateHint = true;

test.describe('Billing via the Core UI Daily Schedule', () => {
  const date = (process.env.JASEC_BILL_DATE ?? '').trim();
  const enabled = process.env.JASEC_BILL_RUN === 'true';
  const maxAccounts = Number(process.env.JASEC_BILL_MAX_ACCOUNTS ?? '5');

  test.skip(
    !enabled,
    'Set JASEC_BILL_RUN=true to run. This moves the CCP clock, spends a job_schedule slot and bills real accounts.',
  );

  test('a schedule created and processed in the UI produces an invoice', async ({
    page,
    billsPage,
    dailySchedulePage,
    jobScheduleDbHelper,
    serverHelper,
    testLogger,
  }) => {
    // The UI chain runs every daily job for the whole tenant, not just our
    // account, so allow well past a single account's billing time.
    test.setTimeout(1_800_000);

    expect(pickDateHint, 'sanity: module loaded').toBe(true);

    expect(
      /^\d{4}-\d{2}-\d{2}$/.test(date),
      'Set JASEC_BILL_DATE to the target schedule date, formatted YYYY-MM-DD. ' +
      'It must equal some account\'s nextaccountingdate + get_future_cycle_date, ' +
      'or the run bills nobody. See the header comment.',
    ).toBe(true);

    const db = new DbHelper();
    await db.connect();

    try {
      // ── 1. Who will this bill, and is that an acceptable blast radius? ──
      const methods = await dailyBilledMethods(db);
      testLogger.log(`DAILY template bills payment method(s): ${methods.join(', ') || 'NONE'}`);
      const eligible = await db.query(ELIGIBLE_SQL, [date, methods]);
      // Cap the list. A bulk date resolves to ~200 accounts and printing them all
      // buries the count, which is the number that actually matters here.
      const shown = eligible
        .slice(0, 10)
        .map((r: any) => `${r.accountid}(BDOM ${r.billingdom})`)
        .join(', ');
      testLogger.log(
        `${date}: ${eligible.length} ${methods.join('/')} account(s) will be billed — ` +
        `${shown || 'NONE'}${eligible.length > 10 ? ` ... +${eligible.length - 10} more` : ''}`,
      );

      // Say what the chain will skip, so a low count is never a mystery.
      const excluded = await db.query(EXCLUDED_BY_PAYMENT_METHOD_SQL, [date, methods]);
      if (excluded.length) {
        testLogger.log(
          `${date}: NOT billed by this chain (no DAILY billing job for these payment methods - JEPYP-326) — ` +
          excluded.map((r: any) => `${r.paymentmethod}=${r.n}`).join(', '),
        );
      }

      expect(
        eligible.length,
        `No ${methods.join('/')} account has a required billing date of ${date}, so this run would ` +
        `complete having billed nobody and prove nothing. Pick a date equal to ` +
        `some account's nextaccountingdate + offset. Note the chain bills ${methods.join('/')} ` +
        `accounts only` +
        (excluded.length
          ? `, and ${excluded.map((r: any) => `${r.n} ${r.paymentmethod}`).join(' + ')} ` +
            `account(s) on this date are excluded for that reason.`
          : `.`),
      ).toBeGreaterThan(0);

      expect(
        eligible.length,
        `${eligible.length} accounts would be billed on ${date}, over the limit of ` +
        `${maxAccounts}. Billing is irreversible per account. Raise ` +
        `JASEC_BILL_MAX_ACCOUNTS deliberately if that is really what you want.`,
      ).toBeLessThanOrEqual(maxAccounts);

      // ── 2. Before state, per account ──
      // Balance and cycle kWh are captured too, so the invoice can be reconciled
      // against what the account actually consumed rather than merely counted.
      const before = new Map<string, number>();
      const balanceBefore = new Map<string, number | null>();
      const kwhBefore = new Map<string, number>();
      for (const row of eligible) {
        const r = await db.query(INVOICE_COUNT_SQL, [row.accountid]);
        before.set(row.accountid, Number(r[0]?.n ?? 0));

        const b = await db.query(CRC_BALANCE_SQL, [row.accountid]);
        balanceBefore.set(row.accountid, b.length ? Number(b[0].amount) : null);

        const pend = await db.query(PENDING_BILL_UNIT_SQL, [row.accountid]);
        const pendId = pend[0]?.id;
        const k = pendId
          ? await db.query(CYCLE_KWH_SQL, [row.accountid, pendId])
          : [];
        kwhBefore.set(row.accountid, Number(k[0]?.kwh ?? 0));
      }
      testLogger.data('invoice_unit rows BEFORE', Object.fromEntries(before));
      testLogger.data('CRC balance BEFORE', Object.fromEntries(balanceBefore));
      testLogger.data('cycle kWh BEFORE', Object.fromEntries(kwhBefore));

      // A SCHEDULED run on the same date (another case's, e.g. TC-142) is not ours to clear,
      // and the Daily Schedule screen then shows THAT finished schedule after Create, so
      // Process never enables (prod 2026-10-06, 2026-12-18 held TC-142's JS-100197). Refuse - BEFORE the clock moves,
      // so a refusal leaves the tenant untouched.
      const otherKind = [...new Set((await db.query(SCHEDULES_ON_DATE_SQL, [date]))
        .filter((s: any) => s.schedulefrequency && s.schedulefrequency !== 'DAILY')
        .map((s: any) => `${s.id} (${s.schedulefrequency}, ${s.status})`))];
      if (blockedIf(otherKind.length > 0,
        `${date} already holds ${otherKind.join(', ')} from another run - the Daily Schedule screen ` +
        `would show that schedule instead of a new DAILY one. Pick a billing date with no schedule.`)) return;

      // ── 3. The clock. Process stays disabled unless CCP equals the date. ──
      await serverHelper.setCcpTime(date);
      const ccp = await serverHelper.getCcpTime();
      expect(ccp, `CCP did not take: wanted ${date}, got ${ccp}`).toBe(date);
      testLogger.log(`CCP set to ${ccp}`);

      // ── 4. The UI path ──
      // navigateToHome FIRST. navigateViaNav starts by hovering the top nav, so
      // without a page load it waits 5s against about:blank and fails with
      // "waiting for getByRole('button', { name: /Operations Hub/i })" — which
      // reads like a missing menu rather than a missing navigation.
      await page.navigateToHome();
      await dailySchedulePage.navigateViaNav();
      await dailySchedulePage.inputJobCalendar(date);

      // Is anything on this tenant still WORKING? Read both clean-up targets,
      // and if either holds something that could be live — a BILL_CHECK work
      // row, or a PROCESSING schedule on our date — read them again after a
      // pause. Anything that moved belongs to a run in flight: BLOCKED, and
      // nothing is deleted. Anything that did not is a dead run's leftover.
      const snapshot = async () => ({
        jobs: await db.query(BILL_CHECK_JOBS_SQL),
        schedules: await db.query(SCHEDULES_ON_DATE_SQL, [date]),
      });
      const first = await snapshot();
      if (first.jobs.length || first.schedules.some((s: any) => s.status === 'PROCESSING')) {
        testLogger.log(
          `${first.jobs.length} BILL_CHECK work row(s), schedules on ${date}: ` +
          `${[...new Set(first.schedules.map((s: any) => `${s.id}:${s.status}`))].join(', ') || 'none'} ` +
          `— checking for activity over ${LIVENESS_WINDOW_MS / 1000}s before clearing`,
        );
        await new Promise((r) => setTimeout(r, LIVENESS_WINDOW_MS));
        const second = await snapshot();
        const moved = JSON.stringify(first) !== JSON.stringify(second);
        if (blockedIf(moved,
          `another billing run is in flight on this tenant (BILL_CHECK work rows or a ` +
          `schedule on ${date} changed within ${LIVENESS_WINDOW_MS / 1000}s). Clearing them ` +
          `would destroy that run. Wait for it to finish and re-run.`)) return;
      }
      const vettedScheduleIds = [...new Set(first.schedules.map((s: any) => String(s.id)))];
      const vettedJobIds = first.jobs.map((j: any) => String(j.id));

      // A spent or errored schedule on this date occupies the DAILY slot and
      // there is only one, so clear it first. This is the same two ordered
      // deletes the CoopeG suite uses (children, then parent) — restricted to
      // the schedules vetted above.
      await dailySchedulePage.clearExistingJobSchedule(jobScheduleDbHelper, date, testLogger, vettedScheduleIds);

      // Second, separate wipe — different table, different failure. Stale
      // BILL_CHECK rows in core_engine.jobs collide on batch ids with a new run,
      // and they are left behind by a run that died midway: precisely when you
      // re-run. Only the rows vetted as idle above are removed.
      if (vettedJobIds.length) {
        const staleJobs = await db.query(CLEAR_STALE_BILL_CHECK_SQL, [vettedJobIds]);
        testLogger.log(`cleared ${staleJobs.length} stale BILL_CHECK row(s) from core_engine.jobs`);
      }

      await dailySchedulePage.clickCreateJobSchedule();
      testLogger.log('Create Job Schedule clicked');

      // Confirm the schedule actually rendered before pressing Process, so a
      // failure here says "the schedule was not created" rather than surfacing
      // later as a disabled button.
      expect(
        await dailySchedulePage.isJobListVisible(),
        `No job cards appeared after Create Job Schedule on ${date}. The schedule ` +
        `was not created — check whether a schedule already occupies the DAILY slot.`,
      ).toBe(true);

      // Process is enabled only while the UI's clock equals the schedule date. On a
      // frozen-clock tenant the API clock was seen reverting to an earlier date
      // mid-run with no setCcpTime from us (prod, 2026-10-02) - test-environment
      // friction, not what this case tests. Re-set the clock and reload ONCE, then
      // proceed; a second disabled button still fails as before.
      const processBtn = page.getByRole('button', { name: 'Process', exact: true });
      // WAIT for it to enable - `isEnabled()` does not wait, it answers at once. On prod
      // (2026-10-06) Process enabled a moment after Create, the instant check read
      // "disabled", and the reload below threw the unsaved schedule away (no DAILY
      // schedule in the DB, then "Process not visible"). Reload only if it is still
      // disabled after a real wait.
      const enabledSoon = await expect(processBtn).toBeEnabled({ timeout: 20_000 }).then(() => true, () => false);
      if (!enabledSoon) {
        testLogger.log(`Process disabled - re-setting CCP to ${date} and reloading once`);
        await serverHelper.setCcpTime(date);
        expect(await serverHelper.getCcpTime(), `CCP did not re-take ${date}`).toBe(date);
        await page.reload();
        await dailySchedulePage.inputJobCalendar(date);
      }
      await dailySchedulePage.clickProcess();
      await dailySchedulePage.confirmProcess();
      testLogger.log('Process confirmed — waiting for the chain to finish');

      const finished = await dailySchedulePage.waitForAllJobsCompleted(testLogger, 40);
      testLogger.log(`all jobs settled: ${finished}`);

      // ── 5. Did the two jobs that matter actually run? ──
      /**
       * READ THE SCREEN FIRST. The chain's status is on the Job Schedule page as
       * one `.card` per job ("BILL_CHECK Status: Completed"), so an operator can
       * see the outcome without a database. Asserting the UI as well as the
       * tables means a run that LOOKS fine on screen but failed underneath — or
       * the reverse — is caught rather than passing on the half we happen to
       * read. Verified read-only against the live screen on 2026-09-11: all nine
       * jobs parse (see explore-02-ui-surface S3c).
       *
       * The database read below stays the AUTHORITY: it is per-run and
       * date-scoped, where the cards show the schedule's current state. These are
       * soft so a UI-only wobble cannot fail a billing run that actually worked.
       */
      const uiStatuses = await dailySchedulePage.jobStatuses().catch(() => ({} as Record<string, string>));
      testLogger.data(
        'job chain (as rendered)',
        Object.entries(uiStatuses).map(([k, v]) => `${k}=${v}`).join(' | ') || '(none parsed)',
      );
      expect
        .soft(Object.keys(uiStatuses).length, 'the Job Schedule screen showed at least one job card')
        .toBeGreaterThan(0);
      if (uiStatuses['INVOICE_CHECK']) {
        expect
          .soft(uiStatuses['INVOICE_CHECK'], 'INVOICE_CHECK as shown on screen')
          .toBe('COMPLETED');
      }

      const children = await db.query(JOB_CHILDREN_SQL, [date]);
      testLogger.data(
        'job chain',
        children.map((c: any) => `${c.type}=${c.status}`).join(' | '),
      );

      const statusOf = (type: string) =>
        children.find((c: any) => c.type === type)?.status ?? '(absent)';

      // Disagreement between the screen and the tables is itself a finding, so
      // report it explicitly rather than letting one source quietly win.
      for (const [job, uiStatus] of Object.entries(uiStatuses)) {
        const dbStatus = statusOf(job);
        if (dbStatus !== '(absent)' && dbStatus.toUpperCase() !== uiStatus) {
          testLogger.log(
            `job ${job}: screen says ${uiStatus} but the run row says ${dbStatus} `
            + '(cards show the schedule, the row shows this run — not necessarily a defect)',
          );
        }
      }

      // BILL_CHECK is REPORTED, not asserted. It reports ERROR whenever any
      // account in the run is refused for insufficient credit - correct Option A
      // behaviour, and unrelated to whether the screen worked. The outcome that
      // matters is the invoice, checked below.
      testLogger.log(`BILL_CHECK status: ${statusOf('BILL_CHECK')}`);

      expect(
        statusOf('INVOICE_CHECK'),
        `INVOICE_CHECK did not complete — without it there is no PDF and no due ` +
        `date even when charges exist. Chain: ${children.map((c: any) => c.type + '=' + c.status).join(', ')}`,
      ).toBe('COMPLETED');

      // ── 6. The point of the whole exercise: an invoice exists. ──
      const after = new Map<string, number>();
      for (const row of eligible) {
        const r = await db.query(INVOICE_COUNT_SQL, [row.accountid]);
        after.set(row.accountid, Number(r[0]?.n ?? 0));
      }
      testLogger.data('invoice_unit rows AFTER', Object.fromEntries(after));

      const gained = eligible.filter(
        (row: any) => (after.get(row.accountid) ?? 0) > (before.get(row.accountid) ?? 0),
      );

      // Record the invoices this run produced, BEFORE any assertion below can stop the test:
      // TC-143 (billing/ts-13) judges whether they were settled from the balance. Kept out of
      // this case on purpose - an unsettled invoice is TC-143's failure, not TC-140's.
      const produced: { accountId: string; invoiceId: string }[] = [];
      for (const row of gained) {
        const inv = (await db.query(NEWEST_INVOICE_SQL, [row.accountid]))[0];
        if (inv) produced.push({ accountId: row.accountid, invoiceId: inv.id });
      }
      fs.mkdirSync(path.dirname(BILLING_RUN_FILE), { recursive: true });
      fs.writeFileSync(BILLING_RUN_FILE, JSON.stringify(
        { tenant: process.env.TEST_ENV, date, recordedAt: new Date().toISOString(), invoices: produced }, null, 2));
      testLogger.log(`recorded ${produced.length} invoice(s) for TC-143: ${produced.map(p => p.invoiceId).join(', ') || 'none'}`);

      // Separate "refused for insufficient credit" (expected) from "silently not
      // billed" (a real problem) before deciding this run failed.
      const notBilled = eligible.filter(
        (row: any) => (after.get(row.accountid) ?? 0) <= (before.get(row.accountid) ?? 0),
      );
      const unexplained: string[] = [];
      for (const row of notBilled) {
        const why = await db.query(BILL_REFUSAL_SQL, [date, row.accountid]);
        const refusal = why.find((w: any) => w.type === 'BILL_CHECK' && /credit limit/i.test(w.reason ?? ''));
        const reason = (refusal?.reason ?? why.map((w: any) => `${w.type}: ${w.reason}`).join(' | ')) || undefined;
        if (refusal) {
          // A refused bill is rolled back (bill unit stays PENDING, total 0), so the charge it
          // tried is not stored - the balance is logged as the evidence to compare by eye.
          testLogger.log(
            `${row.accountid}: not billed, and correctly so - ${refusal.reason}. Under Option A ` +
            `a charge above the balance is refused rather than billed. Balance before the run: ` +
            `${balanceBefore.get(row.accountid) ?? 'unknown'} (negative = credit).`,
          );
        } else {
          // A SUSPENDED service has INACTIVE price units, and with ratewheninactive=false
          // (JASEC: no cycle fee while suspended) there is nothing to bill - so no bill
          // and no jobs_error row is the correct outcome, not silence. Seen on prod
          // 2026-10-02: ACT-100029 / ACT-100032, suspended by the provisioning cases.
          // Only when EVERY price unit is inactive and no offer rates when inactive.
          const inactive = await db.query<{ active: number; rating: number }>(
            `SELECT (SELECT count(*)::int FROM core_engine.price_unit
                      WHERE accountid = $1 AND status = 'ACTIVE') AS active,
                    (SELECT count(*)::int FROM core_pricing.price_offer
                      WHERE ratewheninactive IS TRUE) AS rating`,
            [row.accountid],
          );
          if (inactive[0]?.active === 0 && inactive[0]?.rating === 0) {
            testLogger.log(
              `${row.accountid}: not billed, and correctly so - no ACTIVE price unit (service ` +
              `suspended) and no price offer rates while inactive, so there is no charge.`,
            );
          } else {
            unexplained.push(`${row.accountid}${reason ? ` (${reason})` : ' (no jobs_error row)'}`);
          }
        }
      }

      expect(
        unexplained.length,
        `Account(s) were eligible, were not billed, and nothing explains why: ` +
        `${unexplained.join('; ')}. A credit-limit refusal would be expected; ` +
        `silence is not.`,
      ).toBe(0);

      // A credit-limit refusal on an account that WAS invoiced in the same run contradicts
      // itself: the run says it could not charge, then billed anyway. Adrian's report,
      // 2026-10-03 (tracker item 9): "Credit Limit 0 ... exceeded by 80.10" on ALP-MIN-TRUEUP
      // although the bill held the top-up, and "the error does not stop invoicing". Soft, so
      // the reconciliation below still runs.
      const contradictions: string[] = [];
      for (const row of gained) {
        const why = await db.query(BILL_REFUSAL_SQL, [date, row.accountid]);
        const bad = why.find((w: any) => w.type === 'BILL_CHECK' && /credit limit/i.test(w.reason ?? ''));
        if (bad) contradictions.push(`${row.accountid} (${bad.reason}; balance before ${balanceBefore.get(row.accountid) ?? 'unknown'})`);
      }
      expect.soft(
        contradictions,
        `Invoiced AND refused for credit limit in the same run - a false credit-limit error ` +
        `(tracker item 9a): ${contradictions.join('; ')}`,
      ).toEqual([]);

      expect(
        gained.length + notBilled.length,
        `Bookkeeping error: ${gained.length} billed + ${notBilled.length} not billed ` +
        `does not account for all ${eligible.length} eligible account(s).`,
      ).toBe(eligible.length);

      testLogger.log(
        `PASS — billing ran from the Core UI on ${date}; ` +
        `${gained.length} of ${eligible.length} account(s) gained an invoice: ` +
        gained.map((r: any) => r.accountid).join(', '),
      );

      // ── 7. Reconcile the invoice against what the account actually did ──
      //
      // Counting invoices only proves the screen fired. This checks the money:
      // that the lines are the four JASEC prepaid charges, that the tax base
      // excludes ALUMBRADO PUBLICO, that tax appears exactly when the cycle's kWh
      // crosses the configured thresholds and is arithmetically right, that the
      // header total equals its own lines plus tax, and that the balance moved by
      // the invoice.
      //
      // SOFT throughout. The billing run is irreversible, so a reconciliation
      // problem must report every finding in one pass rather than abort on the
      // first - a second run to see the next failure is not available.
      const thresholds = await db.query(TAX_THRESHOLDS_SQL);
      const thresholdFor = (taxType: 'MAIN_TAX' | 'ADDITIONAL_TAX') =>
        thresholds.find((t: any) => t.name === (taxType === 'MAIN_TAX' ? 'IVA' : 'BOM'));

      for (const row of gained) {
        const acct = row.accountid as string;
        await test.step(`reconcile ${acct}`, async () => {
          const inv = (await db.query(NEWEST_INVOICE_SQL, [acct]))[0];
          expect.soft(inv, `${acct}: no invoice row to reconcile`).toBeTruthy();
          if (!inv) return;

          const lines = await db.query(INVOICE_LINES_SQL, [inv.id]);
          const taxes = await db.query(INVOICE_TAXES_SQL, [inv.billunitid]);
          const kwhRow = await db.query(CYCLE_KWH_SQL, [acct, inv.billunitid]);
          const period = (await db.query(BILL_PERIOD_SQL, [inv.billunitid]))[0];
          const balRow = await db.query(CRC_BALANCE_SQL, [acct]);
          // Needs the bill period, so it must run AFTER the period lookup above.
          // Without a period there is nothing to scope to, and an unscoped total
          // would be the whole account history - report null rather than a wrong
          // number.
          const topups = period?.startdate && period?.enddate
            ? (await db.query(CYCLE_TOPUPS_SQL, [acct, period.startdate, period.enddate]))[0]
            : null;

          const cycleKwh = Number(kwhRow[0]?.kwh ?? 0);
          const balAfter = balRow.length ? Number(balRow[0].amount) : null;
          const balBefore = balanceBefore.get(acct) ?? null;

          const lineName = (n: string) => String(n ?? '').split('|')[0].trim().toUpperCase();
          const lineSum = lines.reduce((s: number, l: any) => s + Number(l.amount), 0);
          const taxSum = taxes.reduce((s: number, t: any) => s + Number(t.amount), 0);

          testLogger.log(
            `${acct}: invoice ${inv.id} total=${inv.total} due=${inv.duedate} | ` +
            `${lines.length} line(s) summing ${lineSum.toFixed(2)} | ` +
            `tax ${taxSum.toFixed(2)} (${taxes.map((t: any) => `${t.taxtype}@${t.taxrate}=${t.amount}`).join(', ') || 'none'}) | ` +
            `cycle ${period?.startdate ?? '?'}..${period?.enddate ?? '?'} kWh ${cycleKwh} | ` +
            `balance ${String(balBefore)} -> ${String(balAfter)} | ` +
            `top-ups ${topups?.n ?? 0} totalling ${topups?.total ?? 0}`,
          );

          // (a) Line composition.
          //
          // Do NOT require all four charge types. A real consumption invoice
          // carries ONE ROW PER TIER, and the CVG lines are not always present:
          // invoice 002210 on this tenant has 8 lines across only three types and
          // no CVG ALUMBRADO PUBLICO at all. Requiring the full set was measured
          // from a minimum-charge invoice and would false-fail on every account
          // that actually consumed. Assert instead that ENERGIA and ALUMBRADO
          // PUBLICO are billed, and that nothing UNKNOWN appears.
          const KNOWN_LINES = [
            'ENERGIA', 'CVG ENERGIA', 'ALUMBRADO PUBLICO', 'CVG ALUMBRADO PUBLICO',
          ];
          expect
            .soft(lines.length, `${acct}: invoice ${inv.id} has no lines`)
            .toBeGreaterThan(0);
          for (const want of ['ENERGIA', 'ALUMBRADO PUBLICO']) {
            expect
              .soft(
                lines.some((l: any) => lineName(l.name) === want),
                `${acct}: invoice ${inv.id} is missing the "${want}" line. ` +
                `Lines present: ${lines.map((l: any) => lineName(l.name)).join(', ')}`,
              )
              .toBe(true);
          }
          const unknown = lines
            .map((l: any) => lineName(l.name))
            .filter((n: string) => !KNOWN_LINES.includes(n));
          expect
            .soft(
              unknown.length,
              `${acct}: invoice ${inv.id} carries unrecognised line(s): ` +
              `${[...new Set(unknown)].join(', ')}. Either the catalogue changed or ` +
              `this account is not billing the JASEC prepaid charges.`,
            )
            .toBe(0);

          // (b) The tax base. ALUMBRADO PUBLICO is excluded (taxcode NA); the
          //     other three carry IVA_BOM. This is the documented JASEC rule
          //     "tax base = ENE + ENE CVG + ALP CVG, ALP Sin CVG EXCLUDED".
          for (const l of lines) {
            const nm = lineName(l.name);
            const want = nm === 'ALUMBRADO PUBLICO' ? 'NA' : 'IVA_BOM';
            expect
              .soft(
                String(l.taxcode),
                `${acct}: line "${nm}" has taxcode ${l.taxcode}, expected ${want}. ` +
                `ALUMBRADO PUBLICO must be OUTSIDE the tax base and the other three inside it.`,
              )
              .toBe(want);
          }

          // (c) Tax presence follows the CONFIGURED kWh thresholds, read live.
          for (const taxType of ['ADDITIONAL_TAX', 'MAIN_TAX'] as const) {
            const cfg = thresholdFor(taxType);
            if (!cfg) continue;
            const min = Number(cfg.minthreshold);
            const present = taxes.some((t: any) => t.taxtype === taxType && Number(t.amount) > 0);
            const shouldApply = cycleKwh > min;
            expect
              .soft(
                present,
                `${acct}: ${cfg.name} (${taxType}) ${present ? 'WAS' : 'was NOT'} applied at ` +
                `${cycleKwh} kWh, but its configured threshold is ${min} kWh so it ` +
                `${shouldApply ? 'should' : 'should not'} apply.`,
              )
              .toBe(shouldApply);
          }

          // (d) Tax arithmetic: amount = taxableamount x rate.
          for (const t of taxes) {
            const expected = Number(t.taxableamount) * Number(t.taxrate);
            expect
              .soft(
                Math.abs(expected - Number(t.amount)) <= 0.05,
                `${acct}: ${t.taxtype} is ${t.amount} but ${t.taxableamount} x ${t.taxrate} ` +
                `= ${expected.toFixed(2)}. Beyond what currency rounding explains.`,
              )
              .toBe(true);
          }

          // (e) The header equals its own parts.
          expect
            .soft(
              Math.abs(Number(inv.total) - (lineSum + taxSum)) <= 0.05,
              `${acct}: invoice ${inv.id} total is ${inv.total} but its lines (${lineSum.toFixed(2)}) ` +
              `plus tax (${taxSum.toFixed(2)}) come to ${(lineSum + taxSum).toFixed(2)}.`,
            )
            .toBe(true);

          // (f) The balance must NOT move at billing — the money already moved
          //     at RATING.
          //
          //     THIS ASSERTION USED TO DEMAND THE OPPOSITE and it was wrong: it
          //     encoded a POSTPAID assumption, where billing creates the
          //     receivable. JASEC is prepaid. Rating debits the balance in real
          //     time, and the cycle-end invoice is a FISCAL DOCUMENT of what was
          //     already taken, not a second charge.
          //
          //     Measured on ACT-100821 (2026-09-08, 105 kWh, invoice 002756):
          //       fresh account      balance        0
          //       rate 105 kWh       balance   +6,916.02   <- the charge, here
          //       stage credit       balance -200,000.00
          //       bill               balance -200,000.00   <- unchanged, correct
          //     The invoice total was 6,916.02 — exactly what rating had already
          //     debited. A balance move at billing would be DOUBLE CHARGING.
          //
          //     BUT "never moves" is ALSO wrong, proven the same day. A cycle that
          //     consumed NOTHING still bills the 0-30 fixed charge, and that charge
          //     originates at BILLING (the *-MIN-TRUEUP offers), not at rating:
          //       ACT-100823, 0 kWh, invoice 002758 for 1,960.80: balance 0 -> 1,960.80
          //       ACT-100824, 35 kWh, invoice 002759 for 2,267.30: balance unchanged
          //
          //     So the real rule is: billing moves the balance by the part rating
          //     did NOT already take. That is 0 for a consumption-only cycle and the
          //     whole fixed charge for a zero-consumption one, with partial-deficit
          //     cycles somewhere between.
          //
          //     Asserting the exact split needs the pre-staging balance, which this
          //     spec does not capture. So bound it instead: the movement must be
          //     between zero and the invoice total. That still catches the two things
          //     worth catching - DOUBLE CHARGING (moved > total) and a charge landing
          //     as a credit (moved < 0) - without encoding an assumption we have not
          //     established. The actual split is logged for the record.
          if (balBefore !== null && balAfter !== null) {
            const moved = balAfter - balBefore;
            const total = Number(inv.total);
            testLogger.log(
              `${acct}: invoice ${inv.id} total ${total}; balance moved ${moved.toFixed(2)} ` +
              `(${balBefore} -> ${balAfter}) = the part not already taken at rating`,
            );
            expect
              .soft(
                moved >= -0.05 && moved <= total + 0.05,
                `${acct}: invoice ${inv.id} is ${inv.total} but the CRC balance moved ` +
                `${moved.toFixed(2)} (${balBefore} -> ${balAfter}), which is outside ` +
                `0..${total}. Above the total means the charge was applied twice; ` +
                `below zero means it landed as a credit.`,
              )
              .toBe(true);
          }

          // (g) Quantity sanity: the invoice bills the cycle's own kWh.
          // SUM the ENERGIA rows - there is one per tier, so checking only the
          // first would compare a single tier's slice against the whole cycle and
          // pass trivially. On invoice 002210 the three ENERGIA rows are
          // 30 + 170 + 10703 = 10903, exactly the cycle accumulator.
          const energiaKwh = lines
            .filter((l: any) => lineName(l.name) === 'ENERGIA')
            .reduce((sum: number, l: any) => sum + Number(l.quantity), 0);
          //
          // EXCEPT BELOW THE 30 kWh MINIMUM. JASEC prepaid includes the first
          // 30 kWh in the monthly fixed charge, so a cycle that consumed LESS is
          // still billed 30 - that is the true-up, not a mis-billing. Measured on
          // ACT-100858 / invoice 002797: cycle 25 kWh, ENERGIA line 30 kWh,
          // subtotal 1,943.40 with CVG ENERGIA -17.40, no tax rows, and the balance
          // moved 323.90 = 1,943.40 - 1,619.50, the part rating had not taken.
          // Asserting energiaKwh === cycleKwh here reported CORRECT product
          // behaviour as a defect, and was the ONLY failure in the run that closed
          // the 0-30 band. Assert the real rule instead of skipping: below the
          // minimum the invoice must bill exactly 30, which is a STRONGER check.
          const MIN_BILLED_KWH = 30;
          if (energiaKwh > 0 && cycleKwh > 0) {
            const expectedKwh = cycleKwh < MIN_BILLED_KWH ? MIN_BILLED_KWH : cycleKwh;
            const rule =
              cycleKwh < MIN_BILLED_KWH
                ? `the cycle metered ${cycleKwh} kWh, below the ${MIN_BILLED_KWH} kWh ` +
                  `monthly minimum, so the invoice must bill exactly ${MIN_BILLED_KWH}`
                : `the cycle accumulator holds ${cycleKwh}, so the invoice must bill the same`;
            expect
              .soft(
                Math.abs(energiaKwh - expectedKwh) <= 0.001,
                `${acct}: the ENERGIA lines bill ${energiaKwh} kWh but ${rule}.`,
              )
              .toBe(true);
          }

          // (h) What the agent sees (2026-10-06): account > Billing Data > Bills lists this invoice with
          //     the same Bill Total, and the Account Statement carries its INVOICE line for the same amount.
          //     A correct invoice the agent sees wrongly is still a wrong answer on the phone.
          const ui = new AgentScreens(page);
          await ui.openAccount(acct);
          await billsPage.navigateToBills();
          const bill = (await billsPage.openClosedBillRows()).find((r: any) => r['Invoice Id'] === inv.id);
          testLogger.log(`${acct}: Core UI Bills ${bill ? `${inv.id} Bill Total "${bill['Bill Total']}"` : `${inv.id} NOT LISTED`}`);
          expect.soft(bill, `${acct}: Core UI Bills does not list invoice ${inv.id}`).toBeTruthy();
          if (bill) {
            expect.soft(uiAmount(bill['Bill Total']), `${acct}: Core UI Bills - Bill Total of ${inv.id}`)
              .toBeCloseTo(Number(inv.total), 2);
          }
          await billsPage.navigateToAccountStatement();
          const stLine = (await billsPage.accountStatementRows())
            .find(r => r['Document Type'] === 'INVOICE' && r['Invoice Id'] === inv.id);
          testLogger.log(`${acct}: Core UI Account Statement ${stLine ? `INVOICE ${inv.id} Total "${stLine['Total']}"` : `no INVOICE row for ${inv.id}`}`);
          expect.soft(stLine, `${acct}: Core UI Account Statement has no INVOICE line for ${inv.id}`).toBeTruthy();
          if (stLine) {
            expect.soft(uiAmount(stLine['Total']), `${acct}: Core UI Account Statement - INVOICE ${inv.id} Total`)
              .toBeCloseTo(Number(inv.total), 2);
          }
        });
      }
    } finally {
      await db.disconnect();
    }
  });
});
