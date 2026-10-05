/**
 * TC-141 (EPDP-442) - A customer who saved a card in Self Care and topped up with it is still invoiced.
 *
 * Why: JEPYP-326 (Wanda, 2026-10-02). Saving a card switches the payment method CHECK -> CREDIT_CARD,
 * and the JASEC DAILY job schedule has BILL_CHECK / INVOICE_CHECK but no BILL_CC / INVOICE_CC, so the
 * account is silently never billed again. Preprod had 61 such accounts (fixed by hand 2026-10-03).
 * FIXED ON PREPROD 2026-10-05: DAILY gained BILL_CC + INVOICE_CC - the method still flips, but the
 * account is invoiced (TC-141 PASS there). Dev and prod: not yet.
 * dev 2026-10-05: of 545 accounts that topped up by card, the 257 with a STORED card are all
 * CREDIT_CARD, the 288 without are all CHECK.
 *
 * OUTCOME ONLY - it takes no side on the fix. PASS = the cycle produces an invoice for the account,
 * whether the team keeps the method on CHECK or adds BILL_CC / INVOICE_CC to DAILY. That is why the
 * billing jobs are read from the tenant's OWN DAILY template (core_config.config_job_list), never
 * hard-coded: a hard-coded BILL_CHECK/INVOICE_CHECK run would miss a BILL_CC fix and report a false FAIL.
 *
 * CONTROL: JASEC_SAVEDCARD_CONTROL=true runs the same journey but pays PlaceToPay directly without
 * saving a card (the TC-140 / ts-08 path). That account stays CHECK and MUST be invoiced - if the
 * control does not pass, the harness is wrong and the main verdict means nothing.
 *
 * MUTATING: seeds an account, pays with the PlaceToPay TEST card, moves the CCP clock to the bill date
 * (restored afterwards) and bills on a SCHEDULED slot. dev, preprod (own data only - never touch others'
 * accounts; Anh 2026-10-05) and prod build 2; never on the final customer build.
 *
 *   $env:JASEC_SAVEDCARD_RUN='true'; npx playwright test --project=jasec-billing-savedcard --reporter=line
 *   optional: JASEC_SAVEDCARD_CONTROL=true, JASEC_SAVEDCARD_BDOM (default 22; each run needs a free bill date)
 */
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { JobScheduleHelper, type JobType } from '../../../../helpers/job-schedule.helper';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter, attachToAccountInSelfCare } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN = String(process.env.JASEC_SAVEDCARD_RUN ?? '').trim().toLowerCase() === 'true';
const CONTROL = String(process.env.JASEC_SAVEDCARD_CONTROL ?? '').trim().toLowerCase() === 'true';
const BDOM = Number(process.env.JASEC_SAVEDCARD_BDOM ?? 22);
const TOP_UP = 5000;
const FINAL = ['COMPLETED', 'ERROR'];

test('a customer who saved a card and topped up with it is still invoiced @tc-141 @saved-card-invoiced', async ({
  request, testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
  selfcareTopupPage, placeToPayCheckoutPage, page, customerManagementPage, billsPage,
}) => {
  if (blockedIf(!RUN, 'JASEC_SAVEDCARD_RUN is not "true" - this pays, moves the CCP clock and bills')) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access to read the payment method and the invoice')) return;
  test.setTimeout(900_000);
  const mode = CONTROL ? 'CONTROL (pay directly, no saved card)' : 'saved card + Pay Now';

  const seed = new PrepaidSeedHelper(testLogger);
  const db = new DbHelper();
  await db.connect();
  const startClock = await seed.ccpDate();
  try {
    // 1. A fresh CHECK account on a quiet billing day.
    const s = uniqueRunSuffix();
    const { accountId } = await seed.seed({
      meter: assertQaMeter(`M-QASCI-${s}`), customerId: `E2ESCI-${s}`, name: `E2ESCI ${s}`, billingDom: BDOM,
    });
    console.log(`  ${mode}: account ${accountId} (BDOM ${BDOM}) at ${startClock}`);

    // 2. Self Care, the customer's way.
    await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, accountId);
    if (!CONTROL) {
      await selfcareActivityPage.navigateToManagePaymentProfile();
      await selfcareActivityPage.clickSaveWithPlaceToPay();
      await placeToPayCheckoutPage.completeTokenization('approve');
      await selfcareActivityPage.assertCardOnFilePopulated();
    }
    await selfcareActivityPage.navigateToTopUp();
    await selfcareTopupPage.assertLoaded();
    await selfcareTopupPage.reload(selfcareActivityPage);
    await selfcareTopupPage.enterAmount(TOP_UP);
    if (CONTROL) {
      await selfcareTopupPage.clickPayWithPlaceToPay();
      await placeToPayCheckoutPage.completePaymentFlow('approve');
      await selfcareTopupPage.reload(selfcareActivityPage);
    } else {
      await selfcareTopupPage.clickPayNow();
    }
    // The top-up is the SETUP here, so confirm it where it is recorded, not on the Self Care history list -
    // that list can lag past 60s although the top-up landed (ACT-101204, dev 2026-10-05: SUCCESS + row, empty list).
    let topUps = 0;
    for (let i = 0; i < 24 && topUps === 0; i++) {
      topUps = await db.getTopUpCount(accountId);
      if (topUps === 0) await new Promise(res => setTimeout(res, 5_000));
    }
    expect(topUps, `${accountId}: the top-up never reached subscription_topup within 2 minutes`).toBeGreaterThan(0);

    const method = (await db.query<{ m: string }>(
      `SELECT paymentmethod m FROM core_engine.payment_profile WHERE accountid = $1`, [accountId]))[0]?.m ?? '(none)';
    console.log(`  payment method after the top-up: ${method}`);

    // 3. The bill date, once the PENDING bill unit exists.
    let billDate = '';
    for (let i = 0; i < 20 && !billDate; i++) {
      const r = await db.query<{ d: string }>(
        `SELECT (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text d
           FROM core_engine.billing_profile bp
           JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
          WHERE bp.accountid = $1`, [accountId]);
      billDate = r[0]?.d ?? '';
      if (!billDate) await new Promise(res => setTimeout(res, 3_000));
    }
    if (blockedIf(!billDate, `${accountId} has no PENDING bill unit - nothing to bill`)) return;

    // The billing jobs bill EVERY account due on this date, not only ours. Never bill someone else's
    // account (preprod is shared; run-suite runs this unattended) - BLOCKED instead. Pick another BDOM.
    const others = await db.query<{ n: number }>(
      `SELECT count(DISTINCT bp.accountid)::int n FROM core_engine.billing_profile bp
         JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
        WHERE bp.accountid <> $1 AND bp.nextaccountingdate = $2::date - core_engine.get_future_cycle_date(bp.accountid)`,
      [accountId, billDate]);
    if (blockedIf((others[0]?.n ?? 0) > 0,
      `${others[0].n} other account(s) are also due on ${billDate} - refusing to bill them; set JASEC_SAVEDCARD_BDOM to a free day`)) return;
    const slot = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM core_engine.job_schedule WHERE scheduledate::date = $1::date AND schedulefrequency = 'SCHEDULED'`, [billDate]);
    if (blockedIf((slot[0]?.n ?? 0) > 0, `${billDate} already has a SCHEDULED job schedule - set JASEC_SAVEDCARD_BDOM to another day`)) return;

    // 4. The tenant's OWN DAILY billing jobs, in its order.
    const daily = await db.query<{ jobname: string }>(
      `SELECT jobname FROM (SELECT DISTINCT ON (jobname) jobname, index FROM core_config.config_job_list
                             WHERE id LIKE '%-JOB-DAILY' AND jobname ~ '^(BILL|INVOICE)' ORDER BY jobname, index) t
        ORDER BY index`);
    const jobNames = daily.map(d => d.jobname);
    if (blockedIf(!jobNames.length, 'no BILL_* / INVOICE_* jobs in the tenant DAILY template')) return;
    console.log(`  bill date ${billDate}; DAILY billing jobs: ${jobNames.join(' -> ')}`);

    // 5. Bill it. processJobSchedule returns at once - wait for every job to be final before reading
    //    results or touching the clock (restoring it mid-run voided a run on 2026-10-05).
    await seed.setCcpDate(billDate);
    const jobs = new JobScheduleHelper(request, testLogger);
    const scheduleId = await jobs.createSchedule({
      scheduleDate: billDate, frequency: 'SCHEDULED', jobs: jobNames.map(type => ({ type: type as JobType })),
    });
    await jobs.processSchedule(scheduleId, 600_000).catch(e => console.log(`  process call: ${String(e).slice(0, 160)}`));
    let states: Array<{ type: string; status: string }> = [];
    for (let i = 0; i < 96; i++) { // up to 8 min
      await new Promise(res => setTimeout(res, 5_000));
      states = await db.query<{ type: string; status: string }>(
        `SELECT type, coalesce(status,'') status FROM core_engine.job_schedule_list WHERE id = $1 ORDER BY index`, [scheduleId]);
      if (states.length && states.every(x => FINAL.includes(x.status))) break;
    }
    console.log(`  ${scheduleId}: ${states.map(x => `${x.type}=${x.status}`).join(' ')}`);
    expect(states.every(x => FINAL.includes(x.status)), `${scheduleId} did not finish within 8 minutes`).toBe(true);

    // 6. The outcome, first on the Core UI screen an agent uses: the account's Bills grid lists an invoice.
    const uiBills = await test.step(`Core UI: ${accountId} Bills lists an invoice`, async () => {
      await page.navigateToHome();
      await customerManagementPage.navigateViaNav();
      await customerManagementPage.searchByAccountId(accountId);
      await customerManagementPage.clickFirstRowLink('ACCT No');
      await billsPage.navigateToBills();
      const rows = (await billsPage.openClosedBillRows()).filter(r => r['Invoice Id']);
      console.log(`  Core UI Bills: ${rows.map(r => `${r['Invoice Id']} ${r['Invoice Status']} due ${r['Due']}`).join(', ') || 'no invoice listed'}`);
      expect.soft(rows.length, `Core UI Bills for ${accountId} lists no invoice for the billed cycle`).toBeGreaterThan(0);
      return rows;
    });

    // 7. Then the record behind the screen.
    const inv = await db.query<{ id: string; total: string }>(
      `SELECT id, coalesce(total, 0)::text total FROM core_engine.invoice_unit WHERE accountid = $1`, [accountId]);
    const errs = await db.query<{ type: string; reason: string }>(
      `SELECT jl.type, left(coalesce(je.reason,''),120) reason FROM core_engine.jobs_error je
         JOIN core_engine.job_schedule_list jl ON jl.jobid = je.id
        WHERE jl.id = $1 AND je.accountid = $2`, [scheduleId, accountId]);
    console.log(`  invoices for ${accountId}: ${inv.length ? inv.map(i => `${i.id} (${i.total})`).join(', ') : 'NONE'}` +
      `${errs.length ? `; job errors: ${errs.map(e => `${e.type}: ${e.reason}`).join(' | ')}` : ''}`);

    expect(inv.length, `${accountId} (${mode}) - payment method ${method} - was NOT invoiced for its cycle on ` +
      `${billDate}. DAILY billing jobs: ${jobNames.join(', ')}. ` +
      (method === 'CREDIT_CARD' && !jobNames.some(j => /_CC$/.test(j))
        ? 'Known: JEPYP-326 - saving a card makes the account CREDIT_CARD and DAILY has no BILL_CC/INVOICE_CC.'
        : 'Not the known JEPYP-326 shape - investigate.')).toBeGreaterThan(0);
    expect.soft(uiBills.map(r => r['Invoice Id']).sort(), `Core UI Bills and the database list different invoices for ${accountId}`)
      .toEqual(inv.map(i => i.id).sort());
    console.log(`  PASS - ${mode}: ${accountId} invoiced`);
  } finally {
    await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
    await db.disconnect();
  }
});
