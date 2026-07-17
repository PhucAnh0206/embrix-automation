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
import { OrderManagementPage } from '../pages/customer-hub/order-management/order-management.page';
import { ScreenshotHelper } from '../helpers/screenshot.helper';
import { TestLogger } from '../helpers/test-logger';

/** Data needed for the order + meter portion of the setup. */
export interface JasecOrderData {
  bundleId: string;
  meter: { provisioningId: string; lecturaInicialKwh: string };
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
  orderManagementPage: OrderManagementPage,
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
