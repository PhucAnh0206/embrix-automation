/**
 * TS-03 — Minimum Amount Business Logic
 *
 * Rules (see MIN_AMOUNT_BASE constant below):
 *   • Base = firstMonth CRC in the account's first effective month
 *   • Base = ongoing CRC from the second month onward
 *   • Displayed value = MAX(0, base − abs(creditBalance) + debtBalance)
 *   • Section is visible when displayed value > 0, removed when <= 0
 *   • Balance uses inverted CRC sign: > 0 = debt, < 0 = credit
 *
 * Setup requirement: account MUST be created with a real order so top-ups
 * actually reach the backend. Setup helper uses createPrepaidAccountWithOrder.
 *
 * Post-top-up refresh: Min Amount doesn't auto-refresh. Every post-top-up
 * assertion reloads the Top Up view first.
 *
 * Tests:
 *   3.1  Visibility on a non-1st day (2920)
 *   3.2  Account in debt — month A = 3420, month B = 3800 (via DbHelper)
 *   3.3  Partial credit — top up 1000 → Min = 1920
 *   3.4  Fully covered credit — top up 5000 → Min hidden
 *   3.5  Cross-month base — month A = 2920, month B = 3300 (no top-up)
 *   3.6  Base transition after top-up — month A = 2920, month B = 3300 − credit
 */

import * as fs from 'fs';
import * as path from 'path';
import { test } from '../../../../fixtures/page-factory';
import {
  setUpAccountInSelfCare,
  type PrepaidAccountWithOrderRow,
} from '../../../../fixtures/create-prepaid-account.helper';

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const dataRows: PrepaidAccountWithOrderRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const baseRow = dataRows[0];

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
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        serverHelper,
      }) => {
        await serverHelper.setAndVerifyCcpTime('2026-07-15');

        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

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
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        dbHelper, serverHelper,
      }) => {
        const monthA = '2026-07-05';
        const monthB = '2026-08-05';

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        const debt = 500;

        // Sanity-check initial state (no debt yet).
        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth);

        // Put the account into +debt CRC debt via direct UPDATE.
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
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        dbHelper,
      }) => {
        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth);

        // TODO(balance-check): re-enable DB balance verification when we're
        // ready to enforce it.
        // const balanceBefore = await dbHelper.getAccountBalance(accountId);
        const topUp = 1000;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth - topUp);
        // await dbHelper.assertTopUpApplied(accountId, topUp, balanceBefore);

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
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        dbHelper,
      }) => {
        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.assertMinimumAmountVisible(MIN_AMOUNT_BASE.firstMonth);

        // TODO(balance-check): re-enable DB balance verification when we're
        // ready to enforce it.
        // const balanceBefore = await dbHelper.getAccountBalance(accountId);
        const topUp = 5000;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertMinimumAmountHidden();
        // await dbHelper.assertTopUpApplied(accountId, topUp, balanceBefore);

        testLogger.log(`✓ TC 3.4 — account ${accountId}: Min hidden after fully-covered top-up`);
      },
    );

    // ── TC 3.5 — Cross-month base (no top-up) ───────────────────────
    test(
      '3.5: Cross-month base — month A = 2920, month B = 3300 (no top-up)',
      { tag: ['@tc-3-5'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        serverHelper,
      }) => {
        const monthA = '2026-07-05';
        const monthB = '2026-08-05';

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

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
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        serverHelper, dbHelper,
      }) => {
        const monthA = '2026-07-05';
        const monthB = '2026-08-05';

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();

        // TODO(balance-check): re-enable DB balance verification when we're
        // ready to enforce it.
        // const balanceBefore = await dbHelper.getAccountBalance(accountId);
        const topUp = 500;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertHistoryRowCountAtLeast(1);
        // await dbHelper.assertTopUpApplied(accountId, topUp, balanceBefore);

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
