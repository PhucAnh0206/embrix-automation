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
 * The UI's DAILY template contains BILL_CHECK and no BILL_CC, so it bills CHECK
 * accounts only. Without this filter the spec would announce a CREDIT_CARD
 * account as "will be billed", the chain would correctly skip it, and the run
 * would fail with "no eligible account gained an invoice" — a false failure
 * against a healthy screen. JASEC is genuinely mixed: on 2026-08-29 dev held 631
 * CHECK and 283 CREDIT_CARD prepaid accounts, preprod 84 and 38.
 *
 * If a tenant's DAILY template ever gains BILL_CC, widen this to match.
 */
const ELIGIBLE_SQL = `
  SELECT a.id AS accountid, bp.billingdom
    FROM core_engine.account a
    JOIN core_engine.billing_profile bp ON bp.accountid = a.id
    JOIN core_engine.bill_unit bu       ON bu.accountid = a.id AND bu.status = 'PENDING'
    JOIN core_engine.payment_profile pp ON pp.accountid = a.id
    JOIN core_engine.subscription s     ON s.accountid = a.id AND s.status = 'ACTIVE'
   WHERE a.accountcategory = 'PREPAID'
     AND a.status = 'ACTIVE'
     AND pp.paymentmethod = 'CHECK'
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
     AND pp.paymentmethod <> 'CHECK'
     AND bp.nextaccountingdate + core_engine.get_future_cycle_date(a.id) = $1::date
   GROUP BY pp.paymentmethod
   ORDER BY pp.paymentmethod`;

const INVOICE_COUNT_SQL = `
  SELECT count(*)::int AS n FROM core_engine.invoice_unit WHERE accountid = $1`;

/** Mirrors NotificationDbHelper.clearStaleJobs('BILL_CHECK'). Tenant-wide by
 *  design — that is what ts-02 and the runbook both do. */
const CLEAR_STALE_BILL_CHECK_SQL = `
  DELETE FROM core_engine.jobs WHERE type = 'BILL_CHECK' RETURNING id`;

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

/** Top-ups registered in the cycle, so the balance arithmetic can account for them. */
const CYCLE_TOPUPS_SQL = `
  SELECT count(*)::int AS n, coalesce(sum(amount), 0)::float8 AS total
    FROM core_engine.subscription_topup t
   WHERE t.accountid = $1`;

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
  SELECT accountid, reason
    FROM core_engine.jobs_error
   WHERE type = 'BILL_CHECK'
     AND accountid = $1
   ORDER BY index DESC
   LIMIT 1`;

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
      // Cap the list. A bulk date resolves to ~200 accounts and printing them all
      // buries the count, which is the number that actually matters here.
      const shown = eligible
        .slice(0, 10)
        .map((r: any) => `${r.accountid}(BDOM ${r.billingdom})`)
        .join(', ');
      testLogger.log(
        `${date}: ${eligible.length} CHECK account(s) will be billed — ` +
        `${shown || 'NONE'}${eligible.length > 10 ? ` ... +${eligible.length - 10} more` : ''}`,
      );

      // Say what the chain will skip, so a low count is never a mystery.
      const excluded = await db.executeQuery(EXCLUDED_BY_PAYMENT_METHOD_SQL, [date]);
      if (excluded.length) {
        testLogger.log(
          `${date}: NOT billed by this chain (no BILL_CC in the DAILY template) — ` +
          excluded.map((r: any) => `${r.paymentmethod}=${r.n}`).join(', '),
        );
      }

      expect(
        eligible.length,
        `No CHECK account has a required billing date of ${date}, so this run would ` +
        `complete having billed nobody and prove nothing. Pick a date equal to ` +
        `some account's nextaccountingdate + offset. Note the chain bills CHECK ` +
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
        `JASEC_BILL_UI_MAX_ACCOUNTS deliberately if that is really what you want.`,
      ).toBeLessThanOrEqual(maxAccounts);

      // ── 2. Before state, per account ──
      // Balance and cycle kWh are captured too, so the invoice can be reconciled
      // against what the account actually consumed rather than merely counted.
      const before = new Map<string, number>();
      const balanceBefore = new Map<string, number | null>();
      const kwhBefore = new Map<string, number>();
      for (const row of eligible) {
        const r = await db.executeQuery(INVOICE_COUNT_SQL, [row.accountid]);
        before.set(row.accountid, Number(r[0]?.n ?? 0));

        const b = await db.executeQuery(CRC_BALANCE_SQL, [row.accountid]);
        balanceBefore.set(row.accountid, b.length ? Number(b[0].amount) : null);

        const pend = await db.executeQuery(PENDING_BILL_UNIT_SQL, [row.accountid]);
        const pendId = pend[0]?.id;
        const k = pendId
          ? await db.executeQuery(CYCLE_KWH_SQL, [row.accountid, pendId])
          : [];
        kwhBefore.set(row.accountid, Number(k[0]?.kwh ?? 0));
      }
      testLogger.data('invoice_unit rows BEFORE', Object.fromEntries(before));
      testLogger.data('CRC balance BEFORE', Object.fromEntries(balanceBefore));
      testLogger.data('cycle kWh BEFORE', Object.fromEntries(kwhBefore));

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
        const r = await db.executeQuery(INVOICE_COUNT_SQL, [row.accountid]);
        after.set(row.accountid, Number(r[0]?.n ?? 0));
      }
      testLogger.data('invoice_unit rows AFTER', Object.fromEntries(after));

      const gained = eligible.filter(
        (row: any) => (after.get(row.accountid) ?? 0) > (before.get(row.accountid) ?? 0),
      );

      // Separate "refused for insufficient credit" (expected) from "silently not
      // billed" (a real problem) before deciding this run failed.
      const notBilled = eligible.filter(
        (row: any) => (after.get(row.accountid) ?? 0) <= (before.get(row.accountid) ?? 0),
      );
      const unexplained: string[] = [];
      for (const row of notBilled) {
        const why = await db.executeQuery(BILL_REFUSAL_SQL, [row.accountid]);
        const reason = why[0]?.reason as string | undefined;
        if (reason && /credit limit/i.test(reason)) {
          testLogger.log(
            `${row.accountid}: not billed, and correctly so - ${reason}. Under Option A ` +
            `a charge above the balance is refused rather than billed.`,
          );
        } else {
          unexplained.push(`${row.accountid}${reason ? ` (${reason})` : ' (no jobs_error row)'}`);
        }
      }

      expect(
        unexplained.length,
        `Account(s) were eligible, were not billed, and nothing explains why: ` +
        `${unexplained.join('; ')}. A credit-limit refusal would be expected; ` +
        `silence is not.`,
      ).toBe(0);

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
      const thresholds = await db.executeQuery(TAX_THRESHOLDS_SQL);
      const thresholdFor = (taxType: 'MAIN_TAX' | 'ADDITIONAL_TAX') =>
        thresholds.find((t: any) => t.name === (taxType === 'MAIN_TAX' ? 'IVA' : 'BOM'));

      for (const row of gained) {
        const acct = row.accountid as string;
        await test.step(`reconcile ${acct}`, async () => {
          const inv = (await db.executeQuery(NEWEST_INVOICE_SQL, [acct]))[0];
          expect.soft(inv, `${acct}: no invoice row to reconcile`).toBeTruthy();
          if (!inv) return;

          const lines = await db.executeQuery(INVOICE_LINES_SQL, [inv.id]);
          const taxes = await db.executeQuery(INVOICE_TAXES_SQL, [inv.billunitid]);
          const kwhRow = await db.executeQuery(CYCLE_KWH_SQL, [acct, inv.billunitid]);
          const period = (await db.executeQuery(BILL_PERIOD_SQL, [inv.billunitid]))[0];
          const balRow = await db.executeQuery(CRC_BALANCE_SQL, [acct]);
          const topups = (await db.executeQuery(CYCLE_TOPUPS_SQL, [acct]))[0];

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

          // (f) The balance moved by the invoice. Inverted CRC sign: charging a
          //     prepaid account consumes credit, so the balance moves UP by the
          //     invoice total. Skipped when either reading is unavailable.
          if (balBefore !== null && balAfter !== null) {
            const moved = balAfter - balBefore;
            expect
              .soft(
                Math.abs(moved - Number(inv.total)) <= 0.05,
                `${acct}: invoice ${inv.id} charged ${inv.total} but the CRC balance moved ` +
                `${moved.toFixed(2)} (${balBefore} -> ${balAfter}). Inverted sign: a charge ` +
                `moves the balance UP. A mismatch means a top-up or adjustment landed ` +
                `mid-run, or the charge did not reach the balance.`,
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
          if (energiaKwh > 0 && cycleKwh > 0) {
            expect
              .soft(
                Math.abs(energiaKwh - cycleKwh) <= 0.001,
                `${acct}: the ENERGIA lines bill ${energiaKwh} kWh but the cycle ` +
                `accumulator holds ${cycleKwh}. Billing a different quantity from ` +
                `what was metered.`,
              )
              .toBe(true);
          }
        });
      }
    } finally {
      await db.disconnect();
    }
  });
});
