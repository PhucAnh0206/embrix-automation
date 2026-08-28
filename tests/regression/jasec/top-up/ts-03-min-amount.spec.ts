/**
 * TS-03 — Minimum Amount Business Logic
 *
 * Rules (see MIN_AMOUNT_BASE constant below):
 *   • Displayed value = MAX(0, base − abs(creditBalance) + debtBalance)
 *   • Section is visible when displayed value > 0, removed when <= 0
 *   • Balance uses inverted CRC sign: > 0 = debt, < 0 = credit
 *
 * WHAT THE BASE ACTUALLY IS — corrected 2026-08-29 from the product source
 * (PGPrepaidSubscriptionService.calculateTopupAmount + the SQL function
 * core_engine.get_minimum_topup_amount).
 *
 * The base is NOT a property of the calendar month. It is the TIER-AWARE
 * INCREMENTAL cost of the next N units given what the account has already
 * consumed this cycle:
 *
 *     base = f(topupQuantity + consumedThisCycle) − f(consumedThisCycle)
 *
 * where f prices a quantity through the offer's tiers. So the base rises when
 * consumption pushes the next N units into a higher tier. The firstMonth /
 * ongoing constants below are the values that behaviour produces for THIS test
 * data — they are correct as expectations, but the reason they differ is tier
 * position, not "which month it is". Treat a change in them as a pricing or
 * consumption change, not a calendar bug.
 *
 * Two further details from the same source, both currently benign here:
 *
 *   • `noOfTopup` is counted over billingProfile.lastBillDate..nextBillDate,
 *     i.e. the BILLING CYCLE, not the calendar month.
 *   • A separate branch subtracts current consumption from the required initial
 *     quantity when noOfTopup == 0, but it is gated on the ccp property
 *     `includeCurrentConsumptionForIntialTopup`, which is UNSET on jasec-dev, so
 *     that branch does not run and is not what makes the base move.
 *
 * CAVEAT ON THE ABOVE, and it matters. That logic is the ENGINE's, reached through
 * CrmGatewayController.getTopUp — and on jasec-dev that route answers
 * "Canonical Mapping Configuration is not found for GET_TOP_UP API", i.e. it is not
 * wired for this tenant. So the description above is where the platform implements
 * a prepaid minimum, NOT a proven account of what Self Care shows here. No response
 * observed during a Top Up page load carried these fields either.
 *
 * Treat the constants as empirically correct (they pass, repeatedly) and the
 * mechanism above as the best available explanation rather than a verified one. If
 * they ever drift, find the endpoint Self Care actually reads first; do not assume
 * the engine path above.
 *
 * Setup requirement: account MUST be created with a real order so top-ups
 * actually reach the backend. Setup helper uses createPrepaidAccountWithOrder.
 *
 * Post-top-up refresh: Min Amount doesn't auto-refresh. Every post-top-up
 * assertion reloads the Top Up view first.
 *
 * Tests (expected values all derive from MIN_AMOUNT_BASE — see the constant
 * rather than hardcoding figures here):
 *   3.1  Visible on a mid-month day — shows the firstMonth base
 *   3.2  Account in debt, set directly via DbHelper — base + debt, asserted in
 *        both the first and a later month
 *   3.3  Partial credit — a top-up smaller than the base leaves base − credit
 *   3.4  Fully covered credit — a top-up above the base hides the section
 *   3.5  Cross-month base flip with no top-up — firstMonth then ongoing
 *   3.6  Cross-month base flip with credit carried over — ongoing − credit
 *
 * Debt is injected through the DB because JASEC only produces a positive CRC
 * balance through kWh consumption, which this suite does not drive.
 *
 * Account-setup strategy: 3.1 and 3.5 share one pristine account (see
 * `pristineAccount` below) — 3.1's only assertion is 3.5's first one, so they
 * were building the same account twice. 3.2, 3.3, 3.4 and 3.6 each still need
 * their own, because each one dirties it in a different way.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test } from '../../../../fixtures/jasec-fixtures';
import {
  setUpAccountForTopUp,
  attachToAccountInSelfCare,
  type PrepaidAccountWithOrderRow,
} from '../../../../fixtures/create-prepaid-account.helper';
import { SharedAccount } from '../../../../fixtures/shared-account.helper';

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const dataRows: PrepaidAccountWithOrderRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const baseRow = dataRows[0];

/** The clock both PRISTINE-account tests run their first assertion at. */
const PRISTINE_MONTH_A = '2026-07-15';
const PRISTINE_MONTH_B = '2026-08-15';

/**
 * Shared by 3.1 and 3.5 — the only two tests here that need a PRISTINE account
 * (no top-up, no debt) and never dirty it. 3.1's single assertion, "Min = the
 * first-month base at a mid-month date", is literally 3.5's first assertion, so
 * the two were creating identical accounts and paying twice: 126s + 146s on the
 * 2026-08-20 run. One account covers both.
 *
 * Safe to reuse across the intervening tests (3.2-3.4) because those act on
 * their OWN accounts: 3.2 writes a balance, 3.3 and 3.4 top up, and none of them
 * touch this one. They do move the shared CCP clock, which is why 3.5 re-pins it
 * to PRISTINE_MONTH_A before asserting rather than trusting where it was left.
 *
 * The other four tests cannot join: 3.2 needs an injected debt, 3.3 and 3.4 need
 * a zero-credit starting balance they then spend, and 3.6 carries a top-up
 * across the month boundary.
 */
const pristineAccount = new SharedAccount<Parameters<typeof setUpAccountForTopUp>[0]>({
  label: 'TS-03 pristine (3.1, 3.5)',
  create: (fixtures) => setUpAccountForTopUp(fixtures, baseRow),
  attach: (fixtures, accountId) => attachToAccountInSelfCare(fixtures, accountId),
});

/**
 * JASEC minimum-top-up base amounts (CRC). Regulated by ARESEP.
 * If either changes, update the constant — every expected value in this
 * suite derives from it.
 */
const MIN_AMOUNT_BASE = {
  firstMonth: 2920,
  ongoing: 3300,
} as const;

test.describe(
  'TS-03 — Minimum Amount Business Logic',
  { tag: ['@regression', '@jasec', '@top-up', '@ts-03'] },
  () => {
    // ── TC 3.1 — Visibility on a non-1st day ────────────────────────
    test(
      '3.1: Min Amount box IS visible on a mid-month day when value > 0',
      { tag: ['@tc-3-1'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        serverHelper,
      }) => {
        await serverHelper.setAndVerifyCcpTime(PRISTINE_MONTH_A);

        const accountId = await pristineAccount.ensure({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        });

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth);

        testLogger.log(`✓ TC 3.1 — account ${accountId} shows Min = ${MIN_AMOUNT_BASE.firstMonth}`);
      },
    );

    // ── TC 3.2 — Account in debt ────────────────────────────────────
    // Debt state is set via a direct UPDATE (DbHelper) because JASEC only
    // produces positive CRC through kWh consumption, which we don't automate.
    // Checks both months: Min = base + debt in each month.
    test(
      '3.2: Account in debt — month A Min = 3420, month B Min = 3800',
      { tag: ['@tc-3-2'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        dbHelper, serverHelper,
      }) => {
        const monthA = '2026-07-05';
        const monthB = '2026-08-05';

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        const debt = 500;

        // Sanity-check initial state (no debt yet).
        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth);

        // Positive CRC = debt (JASEC inverted sign convention).
        await dbHelper.setAccountBalance(accountId, debt);

        // Month A check: Min = firstMonth base + debt.
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth + debt);

        // Advance to month B; debt carries over; base flips to ongoing.
        await serverHelper.setAndVerifyCcpTime(monthB);
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.ongoing + debt);

        testLogger.log(
          `✓ TC 3.2 — account ${accountId}: month A = ${MIN_AMOUNT_BASE.firstMonth + debt}, ` +
          `month B = ${MIN_AMOUNT_BASE.ongoing + debt}`,
        );
      },
    );

    // ── TC 3.3 — Partial credit ─────────────────────────────────────
    test(
      '3.3: Partial credit — top up 1000 on fresh account → Min = 1920',
      { tag: ['@tc-3-3'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth);

        const topUp = 1000;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth - topUp);

        testLogger.log(
          `✓ TC 3.3 — account ${accountId}: Min = ${MIN_AMOUNT_BASE.firstMonth - topUp} ` +
          `after ${topUp} CRC top-up`,
        );
      },
    );

    // ── TC 3.4 — Fully covered credit ───────────────────────────────
    test(
      '3.4: Fully covered credit — top up 5000 → Min box HIDDEN',
      { tag: ['@tc-3-4'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth);

        const topUp = 5000;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertMinimumAmountHidden();

        testLogger.log(`✓ TC 3.4 — account ${accountId}: Min hidden after fully-covered top-up`);
      },
    );

    // ── TC 3.5 — Cross-month base (no top-up) ───────────────────────
    test(
      '3.5: Cross-month base — month A = 2920, month B = 3300 (no top-up)',
      { tag: ['@tc-3-5'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        serverHelper,
      }) => {
        // Same dates as 3.1 so the pristine account can be shared. The day of the
        // month is not what this test is about — the base flip between the first
        // effective month and every month after it is — so 15th works exactly as
        // the old 5th did.
        const monthA = PRISTINE_MONTH_A;
        const monthB = PRISTINE_MONTH_B;

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await pristineAccount.ensure({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        });

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth);

        await serverHelper.setAndVerifyCcpTime(monthB);
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.ongoing);

        testLogger.log(
          `✓ TC 3.5 — account ${accountId}: month A = ${MIN_AMOUNT_BASE.firstMonth}, ` +
          `month B = ${MIN_AMOUNT_BASE.ongoing}`,
        );
      },
    );

    // ── TC 3.6 — Cross-month base with top-up ───────────────────────
    test(
      '3.6: Cross-month base with top-up — month B uses 3300 − credit',
      { tag: ['@tc-3-6'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        serverHelper,
      }) => {
        const monthA = '2026-07-05';
        const monthB = '2026-08-05';

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();

        const topUp = 500;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertHistoryRowCountAtLeast(1);

        await serverHelper.setAndVerifyCcpTime(monthB);
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.ongoing - topUp);

        testLogger.log(
          `✓ TC 3.6 — account ${accountId}: month B = ${MIN_AMOUNT_BASE.ongoing} − ${topUp} ` +
          `= ${MIN_AMOUNT_BASE.ongoing - topUp}`,
        );
      },
    );
  },
);
