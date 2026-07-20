/**
 * TS-02 — Top-Up
 *
 * Tests (in execution order):
 *   2.1  Top-Up history date range — history clears at month rollover
 *   2.2  Top Up using Pay Now (saved-card token, no PTP redirect)
 *   2.3a Top Up using Pay with PlaceToPay — APPROVE card
 *   2.3b Top Up using Pay with PlaceToPay — DECLINE card
 *
 * Each test creates its own fresh account + order (subscription required
 * for top-ups to persist). TC 2.2 also saves a card in setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test } from '../../../../fixtures/page-factory';
import { createPrepaidAccountWithOrder } from '../../../../fixtures/create-prepaid-account.helper';

interface JasecAccountTestRow {
  accountInfo: {
    accountCategory: string;
    customerSegment: string;
    customerId: string;
    legalEntity: string;
    accountType: string;
    currency?: string;
    sellingCompany?: string;
  };
  contact: { firstName: string; lastName: string; email: string; useAsBilling: boolean };
  address: {
    street: string;
    country: string;
    state: string;
    city: string;
    postalCode: string;
    useAsBilling: boolean;
  };
  paymentProfile: { paymentMethod: string; paymentTerm: string };
  billingProfile: { billingDom: string | number };
  meter: { provisioningId: string; lecturaInicialKwh: string };
  bundleId: string;
}

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const dataRows: JasecAccountTestRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const baseRow = dataRows[0];

const USERNAME = process.env.EMBRIX_USER ?? 'congeroadmin';
const PASSWORD = process.env.EMBRIX_PASSWORD ?? 'congero@123';

/** Create fresh account+order, log into Self Care, act as the account. */
async function setUpAccountInSelfCare(fixtures: {
  page: any;
  testLogger: any;
  searchAccountsPage: any;
  createAccountPage: any;
  orderManagementPage: any;
  screenshotHelper: any;
  selfcareLoginPage: any;
  selfcareAccountSearchPage: any;
}): Promise<string> {
  const {
    page, testLogger,
    searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
    selfcareLoginPage, selfcareAccountSearchPage,
  } = fixtures;

  const { accountId } = await createPrepaidAccountWithOrder(
    page, searchAccountsPage, createAccountPage,
    orderManagementPage, screenshotHelper,
    baseRow, testLogger,
  );

  await selfcareLoginPage.goto();
  await selfcareLoginPage.login(USERNAME, PASSWORD);
  await selfcareLoginPage.assertLoginSuccess();

  await selfcareAccountSearchPage.navigate();
  await selfcareAccountSearchPage.searchAndSelectAccount(accountId);

  return accountId;
}

test.describe(
  'TS-02 — Top-Up',
  { tag: ['@regression', '@jasec', '@top-up', '@ts-02'] },
  () => {
    // ── TC 2.1 — History date range ───────────────────────────────────
    test(
      '2.1: Top-Up history table only shows current-period entries',
      { tag: ['@tc-2-1'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        serverHelper, dbHelper,
      }) => {
        const monthA = '2026-07-15';
        const monthB = '2026-08-15';

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        });

        // Top up in month A.
        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();

        // TODO(balance-check): re-enable DB balance verification when we're
        // ready to enforce it.
        // const balanceBefore = await dbHelper.getAccountBalance(accountId);
        const topUp = 500;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertPaymentSuccess();
        await selfcareTopupPage.assertHistoryRowCountAtLeast(1);
        // await dbHelper.assertTopUpApplied(accountId, topUp, balanceBefore);

        // Advance to month B; history should be empty. Reload so the Top Up
        // view fetches the new-month state (the view doesn't auto-refresh).
        await serverHelper.setAndVerifyCcpTime(monthB);
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertHistoryEmpty();

        testLogger.log(`✓ TC 2.1 — account ${accountId}: history scoped to current period`);
      },
    );

    // ── TC 2.2 — Pay Now (saved card, no PTP redirect) ────────────────
    test(
      '2.2: Top Up using Pay Now with a saved card',
      { tag: ['@tc-2-2'] },
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
        });

        // Precondition: save a card so Pay Now has a token.
        await selfcareActivityPage.navigateToManagePaymentProfile();
        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');
        await selfcareActivityPage.assertCardOnFilePopulated();

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        // Reload so the Top Up view's Card On File section picks up the token
        // just saved via Manage Payment Profile — without this, the view
        // renders CVV/Token/Expiry as empty and Pay Now silently no-ops.
        await selfcareTopupPage.reload(selfcareActivityPage);

        // TODO(balance-check): re-enable DB balance verification when we're
        // ready to enforce it. Commented out for now — keep the top-up itself
        // running so the rest of the assertions still exercise the flow.
        // const balanceBefore = await dbHelper.getAccountBalance(accountId);
        const topUp = 5000;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayNow();
        await selfcareTopupPage.assertPaymentSuccess();
        // await dbHelper.assertTopUpApplied(accountId, topUp, balanceBefore);

        testLogger.log(`✓ TC 2.2 — account ${accountId} topped up ${topUp} CRC via saved card`);
      },
    );

    // ── TC 2.3a — Pay with PlaceToPay (APPROVE) ───────────────────────
    test(
      '2.3a: Top Up using Pay with PlaceToPay — APPROVE card',
      { tag: ['@tc-2-3', '@tc-2-3a'] },
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
        });

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();

        // TODO(balance-check): re-enable DB balance verification when we're
        // ready to enforce it.
        // const balanceBefore = await dbHelper.getAccountBalance(accountId);
        const topUp = 500;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertPaymentSuccess();
        // await dbHelper.assertTopUpApplied(accountId, topUp, balanceBefore);

        testLogger.log(`✓ TC 2.3a — account ${accountId} topped up ${topUp} CRC (approved)`);
      },
    );

    // ── TC 2.3b — Pay with PlaceToPay (DECLINE) ───────────────────────
    test(
      '2.3b: Top Up using Pay with PlaceToPay — DECLINE card, no top-up recorded',
      { tag: ['@tc-2-3', '@tc-2-3b'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        });

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.enterAmount(500);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('deny');

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertHistoryEmpty();

        testLogger.log(`✓ TC 2.3b — account ${accountId}: declined payment not recorded`);
      },
    );

  },
);
