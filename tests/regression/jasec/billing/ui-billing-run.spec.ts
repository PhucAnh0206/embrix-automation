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
 * behind JASEC_BILL_UI_RUN=true and it refuses to start without an explicit date.
 *
 * THREE RULES THAT DECIDE WHETHER THIS DOES ANYTHING AT ALL:
 *
 *  1. The schedule date must EXACTLY equal an account's own next billing date,
 *     which is `billing_profile.nextaccountingdate + get_future_cycle_date(account)`.
 *     On JASEC that offset is 8 days, so a BDOM-1 account bills on the 9th and a
 *     BDOM-10 account on the 18th. Pick any other date and the run completes
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
 *     choose the jobs — which also means COLLECTION_ACTIONS and
 *     CANCEL_SUBSCRIPTION run. On prepaid JASEC there is no collections flow, so
 *     a non-billing job in that chain reporting ERROR is not this test failing.
 *     We assert on BILL_CHECK / INVOICE_CHECK and on the invoice, never on the
 *     schedule's overall status.
 *
 * USAGE
 *
 *   $env:JASEC_BILL_UI_RUN='true'; $env:JASEC_BILL_UI_DATE='2026-10-18'; npx playwright test --project=jasec-billing-ui --reporter=line
 *
 * Add --headed to watch it happen. To find a safe date first — one with few
 * eligible accounts and a free slot — run the query in `pickDateHint` below.
 */

import { test, expect } from '../../../../fixtures/page-factory';
import { DatabaseHelper } from '../../../../helpers/database.helper';

/** Accounts a schedule on `date` will actually bill. Conditions mirror
 *  NotificationDbHelper.findEligibleAccounts — every one is load-bearing. */
const ELIGIBLE_SQL = `
  SELECT a.id AS accountid, bp.billingdom
    FROM core_engine.account a
    JOIN core_engine.billing_profile bp ON bp.accountid = a.id
    JOIN core_engine.bill_unit bu       ON bu.accountid = a.id AND bu.status = 'PENDING'
    JOIN core_engine.payment_profile pp ON pp.accountid = a.id
    JOIN core_engine.subscription s     ON s.accountid = a.id AND s.status = 'ACTIVE'
   WHERE a.accountcategory = 'PREPAID'
     AND a.status = 'ACTIVE'
     AND bp.nextaccountingdate + core_engine.get_future_cycle_date(a.id) = $1::date
   GROUP BY a.id, bp.billingdom
   ORDER BY a.id`;

const INVOICE_COUNT_SQL = `
  SELECT count(*)::int AS n FROM core_engine.invoice_unit WHERE accountid = $1`;

/** Mirrors NotificationDbHelper.clearStaleJobs('BILL_CHECK'). Tenant-wide by
 *  design — that is what ts-02 and the runbook both do. */
const CLEAR_STALE_BILL_CHECK_SQL = `
  DELETE FROM core_engine.jobs WHERE type = 'BILL_CHECK' RETURNING id`;

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
  const date = (process.env.JASEC_BILL_UI_DATE ?? '').trim();
  const enabled = process.env.JASEC_BILL_UI_RUN === 'true';
  const maxAccounts = Number(process.env.JASEC_BILL_UI_MAX_ACCOUNTS ?? '5');

  test.skip(
    !enabled,
    'Set JASEC_BILL_UI_RUN=true to run. This moves the CCP clock, spends a job_schedule slot and bills real accounts.',
  );

  test('a schedule created and processed in the UI produces an invoice', async ({
    page,
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
      'Set JASEC_BILL_UI_DATE to the target schedule date, formatted YYYY-MM-DD. ' +
      'It must equal some account\'s nextaccountingdate + get_future_cycle_date, ' +
      'or the run bills nobody. See the header comment.',
    ).toBe(true);

    const db = new DatabaseHelper();

    try {
      // ── 1. Who will this bill, and is that an acceptable blast radius? ──
      const eligible = await db.executeQuery(ELIGIBLE_SQL, [date]);
      testLogger.log(
        `${date}: ${eligible.length} account(s) will be billed — ` +
        `${eligible.map((r: any) => `${r.accountid}(BDOM ${r.billingdom})`).join(', ') || 'NONE'}`,
      );

      expect(
        eligible.length,
        `No account has a required billing date of ${date}, so this run would ` +
        `complete having billed nobody and prove nothing. Pick a date equal to ` +
        `some account's nextaccountingdate + offset.`,
      ).toBeGreaterThan(0);

      expect(
        eligible.length,
        `${eligible.length} accounts would be billed on ${date}, over the limit of ` +
        `${maxAccounts}. Billing is irreversible per account. Raise ` +
        `JASEC_BILL_UI_MAX_ACCOUNTS deliberately if that is really what you want.`,
      ).toBeLessThanOrEqual(maxAccounts);

      // ── 2. Before state, per account ──
      const before = new Map<string, number>();
      for (const row of eligible) {
        const r = await db.executeQuery(INVOICE_COUNT_SQL, [row.accountid]);
        before.set(row.accountid, Number(r[0]?.n ?? 0));
      }
      testLogger.data(
        'invoice_unit rows BEFORE',
        Object.fromEntries(before),
      );

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

      // A spent or errored schedule on this date occupies the DAILY slot and
      // there is only one, so clear it first. This is the same two ordered
      // deletes the CoopeG suite uses (children, then parent).
      await dailySchedulePage.clearExistingJobSchedule(jobScheduleDbHelper, date, testLogger);

      // Second, separate wipe — different table, different failure. Stale
      // BILL_CHECK rows in core_engine.jobs collide on batch ids with a new run,
      // and they are left behind by a run that died midway: precisely when you
      // re-run. ts-02 does this via NotificationDbHelper.clearStaleJobs; done
      // inline here so this spec carries no dependency on the notification suite.
      const staleJobs = await db.executeQuery(CLEAR_STALE_BILL_CHECK_SQL);
      if (staleJobs.length) {
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

      await dailySchedulePage.clickProcess();
      await dailySchedulePage.confirmProcess();
      testLogger.log('Process confirmed — waiting for the chain to finish');

      const finished = await dailySchedulePage.waitForAllJobsCompleted(testLogger, 40);
      testLogger.log(`all jobs settled: ${finished}`);

      // ── 5. Did the two jobs that matter actually run? ──
      const children = await db.executeQuery(JOB_CHILDREN_SQL, [date]);
      testLogger.data(
        'job chain',
        children.map((c: any) => `${c.type}=${c.status}`).join(' | '),
      );

      const statusOf = (type: string) =>
        children.find((c: any) => c.type === type)?.status ?? '(absent)';

      expect(
        statusOf('BILL_CHECK'),
        `BILL_CHECK did not complete. Chain: ${children.map((c: any) => c.type + '=' + c.status).join(', ')}`,
      ).toBe('COMPLETED');

      expect(
        statusOf('INVOICE_CHECK'),
        `INVOICE_CHECK did not complete — without it there is no PDF and no due ` +
        `date even when charges exist. Chain: ${children.map((c: any) => c.type + '=' + c.status).join(', ')}`,
      ).toBe('COMPLETED');

      // ── 6. The point of the whole exercise: an invoice exists. ──
      const after = new Map<string, number>();
      for (const row of eligible) {
        const r = await db.executeQuery(INVOICE_COUNT_SQL, [row.accountid]);
        after.set(row.accountid, Number(r[0]?.n ?? 0));
      }
      testLogger.data('invoice_unit rows AFTER', Object.fromEntries(after));

      const gained = eligible.filter(
        (row: any) => (after.get(row.accountid) ?? 0) > (before.get(row.accountid) ?? 0),
      );

      expect(
        gained.length,
        `No eligible account gained an invoice. BILL_CHECK and INVOICE_CHECK both ` +
        `completed, so the screen worked — the accounts were simply not billed. ` +
        `Before: ${JSON.stringify(Object.fromEntries(before))} ` +
        `After: ${JSON.stringify(Object.fromEntries(after))}`,
      ).toBeGreaterThan(0);

      testLogger.log(
        `PASS — billing ran from the Core UI on ${date}; ` +
        `${gained.length} of ${eligible.length} account(s) gained an invoice: ` +
        gained.map((r: any) => r.accountid).join(', '),
      );
    } finally {
      await db.disconnect();
    }
  });
});
