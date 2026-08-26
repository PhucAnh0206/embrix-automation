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
 * variant) with a unique value so reruns don't hit the DB's unique
 * constraints — see uniqueRunSuffix below.
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
import { embrixCredentials } from '../helpers/credentials.helper';
import { AccountOrderApiHelper } from '../helpers/account-order-api.helper';

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


/**
 * Unique suffix appended to customerId and provisioningId.
 *
 * Both carry DB unique constraints that span every row ever created, not
 * just the current run — provisioningId via
 * `order_service_provisions (provisioningid, servicetype, action)` — so the
 * suffix has to stay unique against historical data, not only against other
 * accounts in this process.
 *
 * Format is 11 numeric chars: 8 digits of ms timestamp plus 3 random. The
 * timestamp keeps values loosely ordered and readable in logs; the random
 * tail separates accounts created within the same millisecond.
 * `issuedSuffixes` additionally guarantees no repeat inside one run.
 */
const issuedSuffixes = new Set<string>();

export function uniqueRunSuffix(): string {
  const build = () => {
    const stamp = String(Date.now()).slice(-8);
    const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    return stamp + rand;
  };
  let candidate = build();
  while (issuedSuffixes.has(candidate)) {
    candidate = build();
  }
  issuedSuffixes.add(candidate);
  return candidate;
}

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
  const suffix = uniqueRunSuffix();
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
  const suffix = uniqueRunSuffix();
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

  const { username, password } = embrixCredentials();
  await selfcareLoginPage.goto();
  await selfcareLoginPage.login(username, password);
  await selfcareLoginPage.assertLoginSuccess();

  await selfcareAccountSearchPage.navigate();
  await selfcareAccountSearchPage.searchAndSelectAccount(accountId);

  return accountId;
}

/**
 * Log into Self Care and navigate to an EXISTING account (no creation).
 * Companion to setUpAccountInSelfCare — use when a shared account was
 * created by an earlier test and this test just needs a fresh page
 * attached to it.
 */
export async function attachToAccountInSelfCare(
  fixtures: {
    selfcareLoginPage: SelfcareLoginPage;
    selfcareAccountSearchPage: SelfcareAccountSearchPage;
  },
  accountId: string,
): Promise<void> {
  const { selfcareLoginPage, selfcareAccountSearchPage } = fixtures;

  const { username, password } = embrixCredentials();
  await selfcareLoginPage.goto();
  await selfcareLoginPage.login(username, password);
  await selfcareLoginPage.assertLoginSuccess();

  await selfcareAccountSearchPage.navigate();
  await selfcareAccountSearchPage.searchAndSelectAccount(accountId);
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

  const { username, password } = embrixCredentials();
  await selfcareLoginPage.goto();
  await selfcareLoginPage.login(username, password);
  await selfcareLoginPage.assertLoginSuccess();

  await selfcareAccountSearchPage.navigate();
  await selfcareAccountSearchPage.searchAndSelectAccount(accountId);

  await selfcareActivityPage.navigateToManagePaymentProfile();

  return accountId;
}

/**
 * FAST PATH — create the account through the CRM gateway instead of the Core UI
 * wizard, then log into Self Care against it.
 *
 * Drop-in for `setUpAccountInSelfCare` for tests that need an account with a
 * working subscription but NOT a meter. Measured on jasec-dev 2026-08-21:
 * the gateway returns in ~3s where the Core UI wizard takes ~95s (41s account
 * + 53s order across ~15 sequential clicks).
 *
 * USE FOR    top-up, saved-card and Min-Amount tests — anything that only needs
 *            balance to move.
 * DO NOT USE for MDR / tariff / tax-tier work, or notification Events 3 and 5.
 *
 * Why not for those: the gateway accepts `services[].provisioningId` and
 * `meterReading` and then SILENTLY IGNORES them, returning HTTP 200 with
 * status SUCCESS. No `core_engine.service_provision` type=METER row is created,
 * so the account can never be rated. The meter is attached by a separate
 * provisioning step, not by the NEW order. An un-rateable account that reports
 * SUCCESS is a trap, which is why this helper does not send those fields at all.
 *
 * Also note `legalEntity` is ignored (stored as 'US'), and the credit profile is
 * not guaranteed by this path — assert it if the test depends on it.
 */
export async function setUpAccountInSelfCareViaGateway(
  fixtures: {
    testLogger: TestLogger;
    accountOrderApiHelper: AccountOrderApiHelper;
    selfcareLoginPage: SelfcareLoginPage;
    selfcareAccountSearchPage: SelfcareAccountSearchPage;
  },
  row?: PrepaidAccountWithOrderRow,
): Promise<string> {
  const { testLogger, accountOrderApiHelper } = fixtures;

  const started = Date.now();
  // Mirrors test-data/jasec-prepaid-accounts.data.json, minus the meter. The
  // template merged in underneath is CoopeG-shaped (Guanacaste), so every
  // address field is overridden here rather than inherited.
  const { accountId } = await accountOrderApiHelper.createAccountAndOrder({
    orderType: 'NEW',
    // Taken from the row when supplied. This MATTERS: callers deep-copy the row
    // and rewrite contact.email to route correspondence to the monitored
    // mailbox (see ts-01-topup-confirmation). Hardcoding it would send the
    // confirmation email to the wrong address -- failing the assertion, and
    // mailing a real person on every run.
    firstName: row?.contact?.firstName ?? 'Anh',
    lastName: row?.contact?.lastName ?? 'Tran',
    email: row?.contact?.email ?? 'anh.tran@congerotechnology.com',
    accounttype: 'RESIDENTIAL',
    accountCategory: 'PREPAID',
    accountSubType: 'PREPAID',
    customerSegment: 'B2C',
    currency: 'CRC',
    legalEntity: 'Jasec',
    country: 'Costa Rica',
    state: 'Cartago',
    city: 'Cartago',
    district: 'Cartago',
    neighbourhood: 'Centro',
    street: 'Colon 111',
    postalCode: '30101',
    landmark: '',
    extraLine: '',
    billingOnlyFlag: 'false',
    billingFrequency: 'MONTHLY',
    billingDom: '1',
    paymentProfiles: [{ paymentMethod: 'CHECK', paymentTerm: 'NET_30' }],
    services: [{
      bundleId: 'B-100000-E',
      packageId: '',
      serviceType: 'ELECTRICITY',
      action: 'ADD',
      quantity: '1',
    }],
  });
  testLogger.log(`gateway created ${accountId} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  await attachToAccountInSelfCare(fixtures, accountId);
  return accountId;
}

/**
 * Fixture bundle for `setUpAccountForTopUp` — the UI set plus the API helper,
 * so EITHER path can run without the call site changing.
 */
export interface SwitchableSetupFixtures extends SetUpWithOrderFixtures {
  accountOrderApiHelper: AccountOrderApiHelper;
}

/**
 * Account setup for the top-up suites, switchable at RUN TIME.
 *
 *   default            → CRM gateway  (fast: ~2.2s to create)
 *   JASEC_ACCOUNT_SETUP=ui → Core UI wizard (original: ~95s to create)
 *
 * Measured on jasec-preprod 2026-08-25, same test (TC 3.3) both ways:
 * gateway 1.7 min vs UI 4.9 min — about 3.2 minutes per test.
 *
 * Why a switch and not commented-out code: reverting has to be instant and
 * total. One env var puts every call site back on the Core UI path with no
 * edit, no redeploy and nothing to un-comment, and both paths stay compiled so
 * neither can silently rot.
 *
 *   npx playwright test --project=jasec-top-up          # gateway (default)
 *   JASEC_ACCOUNT_SETUP=ui npx playwright test ...      # back to the UI path
 *
 * DO NOT route a test through here if it needs a METER. The gateway cannot
 * attach one — both provisioning endpoints were tested on 2026-08-25 and are
 * closed for this tenant, so the account is created without a meter and can
 * never be rated. TC 2.10 asserts "Medidor" on the receipt PDF and must keep
 * calling setUpAccountInSelfCare directly. Same for anything that rates:
 * MDR, tariff, tax tiers, notification Events 3 and 5.
 */
export async function setUpAccountForTopUp(
  fixtures: SwitchableSetupFixtures,
  baseRow: PrepaidAccountWithOrderRow,
): Promise<string> {
  const mode = (process.env.JASEC_ACCOUNT_SETUP ?? 'gateway').trim().toLowerCase();
  if (mode === 'ui') {
    fixtures.testLogger.log('account setup: UI wizard (JASEC_ACCOUNT_SETUP=ui)');
    return setUpAccountInSelfCare(fixtures, baseRow);
  }
  return setUpAccountInSelfCareViaGateway(fixtures, baseRow);
}
