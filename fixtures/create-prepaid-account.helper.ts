/**
 * Helpers to bootstrap a JASEC prepaid account for a test.
 *
 * Two variants:
 *   • createPrepaidAccountOnly     — account only, no order/subscription.
 *   • createPrepaidAccountWithOrder — full setup (account + order + meter).
 *     Required whenever the test needs top-ups to actually process at the
 *     backend; account-only setups leave the customer without an active
 *     subscription so top-ups appear successful in the UI but don't persist.
 *
 * Both variants suffix customerId (and provisioningId, for the WithOrder
 * variant) with a per-run timestamp to keep the DB's unique constraints happy.
 */

import { Page, expect } from '@playwright/test';
import { SearchAccountsPage } from '../pages/customer-hub/customer-management/search-accounts.page';
import { CreateAccountPage, PrepaidAccountPayload } from '../pages/customer-hub/customer-management/create-account.page';
import { JasecOrderManagementPage } from '../pages/customer-hub/order-management/jasec-order-management.page';
import { SelfcareLoginPage } from '../pages/selfcare/selfcare-login.page';
import { SelfcareAccountSearchPage } from '../pages/selfcare/selfcare-account-search.page';
import { SelfcareActivityPage } from '../pages/selfcare/selfcare-activity.page';
import { ScreenshotHelper } from '../helpers/screenshot.helper';
import { TestLogger } from '../helpers/test-logger';

/** Data needed for the order + meter portion of the setup. */
export interface JasecOrderData {
  bundleId: string;
  meter: { provisioningId: string; lecturaInicialKwh: string };
}

/**
 * Shape of one JASEC test-data row (account only — no order).
 * Loaded from `test-data/jasec-prepaid-accounts.data.json`.
 */
export type PrepaidAccountRow = {
  accountInfo: PrepaidAccountPayload['accountInfo'];
  contact: PrepaidAccountPayload['contact'];
  address: PrepaidAccountPayload['address'];
  paymentProfile: PrepaidAccountPayload['paymentProfile'];
  billingProfile: PrepaidAccountPayload['billingProfile'];
};

/** Shape of one JASEC test-data row including order + meter data. */
export type PrepaidAccountWithOrderRow = PrepaidAccountRow & JasecOrderData;

const USERNAME = process.env.EMBRIX_USER ?? 'congeroadmin';
const PASSWORD = process.env.EMBRIX_PASSWORD ?? 'congero@123';

/** Fixture bundle required by setUpAccountInSelfCare (with-order setup). */
export interface SetUpWithOrderFixtures {
  page: Page;
  testLogger: TestLogger;
  searchAccountsPage: SearchAccountsPage;
  createAccountPage: CreateAccountPage;
  orderManagementPage: JasecOrderManagementPage;
  screenshotHelper: ScreenshotHelper;
  selfcareLoginPage: SelfcareLoginPage;
  selfcareAccountSearchPage: SelfcareAccountSearchPage;
}

/** Fixture bundle required by setUpAccountAndEnterManagePaymentProfile. */
export interface SetUpAccountOnlyFixtures {
  page: Page;
  testLogger: TestLogger;
  searchAccountsPage: SearchAccountsPage;
  createAccountPage: CreateAccountPage;
  selfcareLoginPage: SelfcareLoginPage;
  selfcareAccountSearchPage: SelfcareAccountSearchPage;
  selfcareActivityPage: SelfcareActivityPage;
}

/** Create a fresh JASEC prepaid account (no order) and return the accountId. */
export async function createPrepaidAccountOnly(
  page: Page,
  searchAccountsPage: SearchAccountsPage,
  createAccountPage: CreateAccountPage,
  baseRow: {
    accountInfo: PrepaidAccountPayload['accountInfo'];
    contact: PrepaidAccountPayload['contact'];
    address: PrepaidAccountPayload['address'];
    paymentProfile: PrepaidAccountPayload['paymentProfile'];
    billingProfile: PrepaidAccountPayload['billingProfile'];
  },
  testLogger?: TestLogger,
): Promise<string> {
  const suffix = Date.now().toString().slice(-5);
  const customerId = `${baseRow.accountInfo.customerId}-${suffix}`;

  await page.navigateToHome();
  await searchAccountsPage.navigateViaNav();
  await createAccountPage.clickCreateNew();

  const payload: PrepaidAccountPayload = {
    accountInfo: { ...baseRow.accountInfo, customerId },
    contact: baseRow.contact,
    address: baseRow.address,
    paymentProfile: baseRow.paymentProfile,
    billingProfile: baseRow.billingProfile,
  };

  const accountId = await createAccountPage.createPrepaidAccount(payload);
  expect(accountId).toMatch(/^(ACT|AC)-\d+$/);
  testLogger?.data('Account created', { accountId, customerId });

  return accountId;
}

/**
 * Create a fresh JASEC prepaid account WITH order (subscription + meter +
 * submit). Returns { accountId, orderId, provisioningId }.
 */
export async function createPrepaidAccountWithOrder(
  page: Page,
  searchAccountsPage: SearchAccountsPage,
  createAccountPage: CreateAccountPage,
  orderManagementPage: JasecOrderManagementPage,
  screenshotHelper: ScreenshotHelper,
  baseRow: {
    accountInfo: PrepaidAccountPayload['accountInfo'];
    contact: PrepaidAccountPayload['contact'];
    address: PrepaidAccountPayload['address'];
    paymentProfile: PrepaidAccountPayload['paymentProfile'];
    billingProfile: PrepaidAccountPayload['billingProfile'];
  } & JasecOrderData,
  testLogger?: TestLogger,
): Promise<{ accountId: string; orderId: string; provisioningId: string }> {
  const suffix = Date.now().toString().slice(-5);
  const customerId = `${baseRow.accountInfo.customerId}-${suffix}`;
  const provisioningId = `${baseRow.meter.provisioningId}${suffix}`;

  // Account
  await page.navigateToHome();
  await searchAccountsPage.navigateViaNav();
  await createAccountPage.clickCreateNew();

  const payload: PrepaidAccountPayload = {
    accountInfo: { ...baseRow.accountInfo, customerId },
    contact: baseRow.contact,
    address: baseRow.address,
    paymentProfile: baseRow.paymentProfile,
    billingProfile: baseRow.billingProfile,
  };

  const accountId = await createAccountPage.createPrepaidAccount(payload);
  expect(accountId).toMatch(/^(ACT|AC)-\d+$/);
  testLogger?.data('Account created', { accountId, customerId });

  // Order + meter + submit
  await page.navigateToHome();
  await orderManagementPage.navigateViaNav();
  await orderManagementPage.clickCreateNewOrder();

  await orderManagementPage.searchAccountById(accountId);
  const orderAcctNo = await orderManagementPage.getFirstRowCellValue('ACCT No');
  expect(orderAcctNo).toBe(accountId);
  await orderManagementPage.clickNextInFirstRow();

  await orderManagementPage.clickNextTop();
  await orderManagementPage.clickNextTop();
  await orderManagementPage.clickNextBelowSubscription();
  await orderManagementPage.clickAddBundle();
  await orderManagementPage.selectBundleById(baseRow.bundleId);
  await orderManagementPage.clickNextBelowSubscription();
  await orderManagementPage.addMeterProvisioningData(
    provisioningId,
    baseRow.meter.lecturaInicialKwh,
  );
  await orderManagementPage.clickNextTop();
  await orderManagementPage.clickCreate();

  const orderUrl = await orderManagementPage.isProvisioningOrderSuccessfulToastAppear(screenshotHelper);
  const orderId = orderUrl.match(/orders\/(ORD-\d+)\//)?.[1] ?? '';
  expect(orderId).toMatch(/^ORD-\d+$/);
  testLogger?.data('Order created', { orderId, orderUrl });

  await orderManagementPage.clickRefresh();
  await orderManagementPage.clickSubmitOrder();
  await orderManagementPage.clickRefresh();
  await orderManagementPage.verifyOrderCompletedWithBundle('TARIFICACION ENERGIA PREAPGO');

  return { accountId, orderId, provisioningId };
}

/**
 * Full setup: create a fresh account+order, log into Self Care, and act as
 * the account. Used by TS-02 / TS-03 (any test that needs top-ups to persist).
 */
export async function setUpAccountInSelfCare(
  fixtures: SetUpWithOrderFixtures,
  baseRow: PrepaidAccountWithOrderRow,
): Promise<string> {
  const {
    page, testLogger,
    searchAccountsPage, createAccountPage,
    orderManagementPage, screenshotHelper,
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

/**
 * Lightweight setup: create an account-only (no order), log into Self Care,
 * act as the account, and open Manage Payment Profile. Used by TS-01 card
 * management tests where a subscription is not required.
 */
export async function setUpAccountAndEnterManagePaymentProfile(
  fixtures: SetUpAccountOnlyFixtures,
  baseRow: PrepaidAccountRow,
): Promise<string> {
  const {
    page, testLogger,
    searchAccountsPage, createAccountPage,
    selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
  } = fixtures;

  const accountId = await createPrepaidAccountOnly(
    page, searchAccountsPage, createAccountPage, baseRow, testLogger,
  );

  await selfcareLoginPage.goto();
  await selfcareLoginPage.login(USERNAME, PASSWORD);
  await selfcareLoginPage.assertLoginSuccess();

  await selfcareAccountSearchPage.navigate();
  await selfcareAccountSearchPage.searchAndSelectAccount(accountId);

  await selfcareActivityPage.navigateToManagePaymentProfile();

  return accountId;
}
