/**
 * TC-149 (EPDP-442) - A customer who saved a card in Self Care and topped up with it is still invoiced.
 *
 * Why: JEPYP-326 (Wanda, 2026-10-02). Saving a card switches the payment method CHECK -> CREDIT_CARD,
 * and the JASEC DAILY job schedule has BILL_CHECK / INVOICE_CHECK but no BILL_CC / INVOICE_CC, so the
 * account is silently never billed again. Preprod had 61 such accounts (fixed by hand 2026-10-03).
 * FIXED ON PREPROD 2026-10-05: DAILY gained BILL_CC + INVOICE_CC - the method still flips, but the
 * account is invoiced (TC-149 PASS there). Updated 2026-10-08: JEPYP-326 is now FIXED on dev, preprod
 * and prod (TC-149 PASS on preprod and prod; dev proven via TC-147's run, ACT-101205).
 * dev 2026-10-05: of 545 accounts that topped up by card, the 257 with a STORED card are all
 * CREDIT_CARD, the 288 without are all CHECK.
 *
 * OUTCOME ONLY - it takes no side on the fix. PASS = the cycle produces an invoice for the account,
 * whether the team keeps the method on CHECK or adds BILL_CC / INVOICE_CC to DAILY. That is why the
 * billing jobs are read from the tenant's OWN DAILY template (core_config.config_job_list), never
 * hard-coded: a hard-coded BILL_CHECK/INVOICE_CHECK run would miss a BILL_CC fix and report a false FAIL.
 *
 * CONTROL: JASEC_SAVEDCARD_CONTROL=true runs the same journey but pays PlaceToPay directly without
 * saving a card (the TC-148 / ts-08 path). That account stays CHECK and MUST be invoiced - if the
 * control does not pass, the harness is wrong and the main verdict means nothing.
 *
 * MUTATING: seeds an account, pays with the PlaceToPay TEST card, moves the CCP clock to the bill date
 * and bills through the Core UI Daily Schedule screen (a DAILY on a free or reclaimed date). dev, preprod (own data only - never touch others'
 * accounts; Anh 2026-10-05) and prod build 2; never on the final customer build.
 *
 *   $env:JASEC_SAVEDCARD_RUN='true'; npx playwright test --project=jasec-billing-savedcard --reporter=line
 *   optional: JASEC_SAVEDCARD_CONTROL=true, JASEC_SAVEDCARD_BDOM (default: picked so the bill date is free)
 */
import { test, expect } from '../../../fixtures/jasec-fixtures';
import { PrepaidSeedHelper } from '../../../helpers/prepaid-seed.helper';
import { DbHelper, hasDbConfig } from '../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter, attachToAccountInSelfCare } from '../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../helpers/blocked.helper';
import { AgentScreens } from '../../../helpers/agent-screens.helper';
import { seedOnFreeBillDate } from '../../../helpers/free-billing-day.helper';
import { ensureDateFree } from '../../../helpers/schedule-slot.helper';
import { CLOCK_RESTORE } from '../../../helpers/clock-policy';

const RUN = String(process.env.JASEC_SAVEDCARD_RUN ?? '').trim().toLowerCase() === 'true';
const CONTROL = String(process.env.JASEC_SAVEDCARD_CONTROL ?? '').trim().toLowerCase() === 'true';
// Billing day: JASEC_SAVEDCARD_BDOM if set, else picked so the first bill date has no daily run yet (2026-10-19,
// was a fixed 22 that went BLOCKED whenever that date was taken).
const BDOM_SET = Number(process.env.JASEC_SAVEDCARD_BDOM ?? 0);
const TOP_UP = 5000;
const FINAL = ['COMPLETED', 'ERROR'];
test.use({ ccpBaseline: null });   // this case owns the clock: a free billing day forward from the current one

/**
 * The whole journey: a fresh account on a free billing day -> a Self Care top-up (saved card + Pay Now, or - control -
 * PlaceToPay directly) -> billed from the Daily Schedule screen -> invoiced. With `control` it is TC-148 (2026-10-19):
 * the invoice's billed cycle must also carry the top-up (the JEPYP-47 top-up summary is built from those rows).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function journey(fx: any, control: boolean) {
  const { testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
          selfcareTopupPage, placeToPayCheckoutPage, page, billsPage, dailySchedulePage, accountInfoPage } = fx;
  if (blockedIf(!RUN, 'JASEC_SAVEDCARD_RUN is not "true" - this pays, moves the CCP clock and bills')) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access to read the payment method and the invoice')) return;
  test.setTimeout(900_000);
  const mode = control ? 'CONTROL (pay directly, no saved card)' : 'saved card + Pay Now';

  const seed = new PrepaidSeedHelper(testLogger);
  const db = new DbHelper();
  await db.connect();
  const startClock = await seed.ccpDate();
  try {
    // 1. A fresh CHECK account on a billing day whose bill date is free.
    const seedOn = async (day: number) => {
      const s = uniqueRunSuffix();
      return (await seed.seed({
        meter: assertQaMeter(`M-QASCI-${s}`), customerId: `E2ESCI-${s}`, name: `E2ESCI ${s}`, billingDom: day,
      })).accountId;
    };
    let BDOM = BDOM_SET;
    let accountId = '';
    if (BDOM) accountId = await seedOn(BDOM);
    else {
      const got = await seedOnFreeBillDate(db, { read: () => seed.ccpDate(), set: d => seed.setCcpDate(d) }, seedOn);
      if (blockedIf(!got, 'no usable bill date: the date is taken and cannot be reclaimed here (a PROCESSING run, a non-test tenant or JASEC_RECLAIM_SLOTS=false) - see the log')) return;
      accountId = got!.accountId; BDOM = got!.day;
    }
    console.log(`  ${mode}: account ${accountId} (BDOM ${BDOM}) at ${await seed.ccpDate()}`);

    // 2. Self Care, the customer's way.
    await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, accountId);
    if (!control) {
      await selfcareActivityPage.navigateToManagePaymentProfile();
      await selfcareActivityPage.clickSaveWithPlaceToPay();
      await placeToPayCheckoutPage.completeTokenization('approve');
      await selfcareActivityPage.assertCardOnFilePopulated();
    }
    await selfcareActivityPage.navigateToTopUp();
    await selfcareTopupPage.assertLoaded();
    await selfcareTopupPage.reload(selfcareActivityPage);
    await selfcareTopupPage.enterAmount(TOP_UP);
    if (control) {
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

    // The switch as the agent sees it: Core UI > the account > Account Data > Payment Profile.
    const uiMethod = await test.step(`Core UI: ${accountId} Payment Profile after the top-up`, async () => {
      await new AgentScreens(page).openAccount(accountId);
      return accountInfoPage.readPaymentMethod();
    });
    const method = (await db.query<{ m: string }>(
      `SELECT paymentmethod m FROM core_engine.payment_profile WHERE accountid = $1`, [accountId]))[0]?.m ?? '(none)';
    console.log(`  payment method after the top-up: screen ${uiMethod || '(unread)'} / record ${method}`);
    expect.soft(uiMethod, `Core UI Payment Profile shows "${uiMethod}" but the record says ${method}`).toBe(method);

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
    // account (preprod is shared; full runs are unattended) - BLOCKED instead. Pick another BDOM.
    const others = await db.query<{ n: number }>(
      `SELECT count(DISTINCT bp.accountid)::int n FROM core_engine.billing_profile bp
         JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
        WHERE bp.accountid <> $1 AND bp.nextaccountingdate = $2::date - core_engine.get_future_cycle_date(bp.accountid)`,
      [accountId, billDate]);
    // dev / preprod are test environments (Anh 2026-10-19): billing other accounts due that day is fine. prod: refuse.
    if ((others[0]?.n ?? 0) > 0) {
      if (blockedIf((process.env.TEST_ENV ?? '') === 'jasec',
        `${others[0].n} other account(s) are also due on ${billDate} - refusing to bill them on prod; set JASEC_SAVEDCARD_BDOM to a free day`)) return;
      console.log(`  note: ${others[0].n} other account(s) are also due on ${billDate}; the daily run bills them too (test environment)`);
    }
    // The Daily Schedule screen shows whatever schedule already sits on the date (prod 2026-10-06), so the
    // date must hold none at all - of any frequency. A used date is reclaimed on dev / preprod (schedule-slot.helper).
    const slot = await ensureDateFree(db, billDate);
    if (blockedIf(!slot.free, `${slot.reason} - set JASEC_SAVEDCARD_BDOM to another day`)) return;

    // 4. The tenant's OWN DAILY billing jobs (named in the failure message; the screen runs the whole DAILY template).
    const daily = await db.query<{ jobname: string }>(
      `SELECT jobname FROM (SELECT DISTINCT ON (jobname) jobname, index FROM core_config.config_job_list
                             WHERE id LIKE '%-JOB-DAILY' AND jobname ~ '^(BILL|INVOICE)' ORDER BY jobname, index) t
        ORDER BY index`);
    const jobNames = daily.map(d => d.jobname);
    if (blockedIf(!jobNames.length, 'no BILL_* / INVOICE_* jobs in the tenant DAILY template')) return;
    console.log(`  bill date ${billDate}; DAILY billing jobs: ${jobNames.join(' -> ')}`);

    // 5. Bill it the way an operator does: Operations Hub > Job Management > Daily Schedule > Create Job
    //    Schedule > Process (the same steps as TC-147). Until 2026-10-06 this was a JobScheduleHelper API call
    //    on a SCHEDULED slot. Process enables only while the clock equals the date - wait for it; re-set once.
    await seed.setCcpDate(billDate);
    const uiChain = await dailySchedulePage.createAndProcess(billDate, () => seed.setCcpDate(billDate).then(() => undefined), testLogger);
    console.log(`  Daily Schedule screen: ${Object.entries(uiChain).map(([k, v]) => `${k}=${v}`).join(' ') || '(none parsed)'}`);

    // The record behind the screen: the DAILY schedule on that date, every job final.
    const sched = await db.query<{ id: string }>(
      `SELECT id FROM core_engine.job_schedule WHERE scheduledate::date = $1::date AND schedulefrequency = 'DAILY' ORDER BY id DESC LIMIT 1`, [billDate]);
    const scheduleId = sched[0]?.id ?? '';
    expect(scheduleId, `no DAILY schedule was created on ${billDate} from the screen`).not.toBe('');
    let states: Array<{ type: string; status: string }> = [];
    for (let i = 0; i < 96; i++) { // up to 8 min
      states = await db.query<{ type: string; status: string }>(
        `SELECT type, coalesce(status,'') status FROM core_engine.job_schedule_list WHERE id = $1 ORDER BY index`, [scheduleId]);
      if (states.length && states.every(x => FINAL.includes(x.status))) break;
      await new Promise(res => setTimeout(res, 5_000));
    }
    console.log(`  ${scheduleId}: ${states.map(x => `${x.type}=${x.status}`).join(' ')}`);
    expect(states.every(x => FINAL.includes(x.status)), `${scheduleId} did not finish within 8 minutes`).toBe(true);

    // 6. The outcome, first on the Core UI screen an agent uses: the account's Bills grid lists an invoice.
    const uiBills = await test.step(`Core UI: ${accountId} Bills lists an invoice`, async () => {
      await new AgentScreens(page).openAccount(accountId);
      await billsPage.navigateToBills();
      const rows = (await billsPage.openClosedBillRows()).filter((r: Record<string, string>) => r['Invoice Id']);
      console.log(`  Core UI Bills: ${rows.map((r: Record<string, string>) => `${r['Invoice Id']} ${r['Invoice Status']} due ${r['Due']}`).join(', ') || 'no invoice listed'}`);
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
        ? 'JEPYP-326 shape - saving a card makes the account CREDIT_CARD and DAILY has no BILL_CC/INVOICE_CC. ' +
          'It was fixed on dev, preprod and prod by 2026-10-08, so this is a REGRESSION of that fix.'
        : 'Not the known JEPYP-326 shape - investigate.')).toBeGreaterThan(0);
    expect.soft(uiBills.map((r: Record<string, string>) => r['Invoice Id']).sort(), `Core UI Bills and the database list different invoices for ${accountId}`)
      .toEqual(inv.map(i => i.id).sort());
    if (control) {
      // TC-148: the top-up was made inside the cycle that was just billed, so that cycle carries it.
      const period = (await db.query<{ s: string; e: string }>(
        `SELECT bu.startdate::date::text s, bu.enddate::date::text e FROM core_engine.invoice_unit iu
           JOIN core_engine.bill_unit bu ON bu.id = iu.billunitid WHERE iu.accountid = $1 ORDER BY iu.id LIMIT 1`, [accountId]))[0];
      const tops = period ? (await db.query<{ n: number; total: number }>(
        `SELECT count(*)::int n, coalesce(sum(amount), 0)::float8 total FROM core_engine.subscription_topup
          WHERE accountid = $1 AND createddate >= $2::date AND createddate < $3::date + 1`, [accountId, period.s, period.e]))[0] : undefined;
      console.log(`  billed cycle ${period?.s ?? '?'} -> ${period?.e ?? '?'}: top-ups ${tops?.n ?? 0} totalling ${tops?.total ?? 0}`);
      expect.soft(tops?.n ?? 0, `${accountId}: the billed cycle carries no top-up - the invoice's top-up summary would be empty`).toBeGreaterThan(0);
      expect.soft(tops?.total ?? 0, `${accountId}: the billed cycle's top-ups total less than the ${TOP_UP} paid`).toBeGreaterThanOrEqual(TOP_UP);
    }
    console.log(`  PASS - ${mode}: ${accountId} invoiced`);
  } finally {
    if (CLOCK_RESTORE) await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
    await db.disconnect();
  }
}

// TC-149: saving a card flips the payment method to CREDIT_CARD - the account must still be invoiced.
// JASEC_SAVEDCARD_CONTROL=true still runs this test's control variant, as before.
test('a customer who saved a card and topped up with it is still invoiced @tc-149 @saved-card-invoiced', async ({
  testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
  selfcareTopupPage, placeToPayCheckoutPage, page, billsPage, dailySchedulePage, accountInfoPage,
}) => journey({ testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage,
  placeToPayCheckoutPage, page, billsPage, dailySchedulePage, accountInfoPage }, CONTROL));

// TC-148 (2026-10-19): a top-up paid with PlaceToPay directly, inside the billed cycle, is on that cycle's invoice.
// One command: $env:JASEC_SAVEDCARD_RUN='true'; npx playwright test --grep "@tc-148" (ts-06 / ts-08 skip without their gates).
test('a top-up paid inside the billed cycle is on the invoice of that cycle @tc-148 @topup-on-invoice', async ({
  testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
  selfcareTopupPage, placeToPayCheckoutPage, page, billsPage, dailySchedulePage, accountInfoPage,
}) => journey({ testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage,
  placeToPayCheckoutPage, page, billsPage, dailySchedulePage, accountInfoPage }, true));
