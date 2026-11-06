/**
 * Helpers to bootstrap a JASEC prepaid account for a test.
 *
 * Two shapes, each built two ways:
 *   • account only (no order/subscription)  — createPrepaidAccountOnly (Core UI) / seedPrepaidAccountOnly (GraphQL)
 *   • account + order + meter                — createPrepaidAccountWithOrder (Core UI) / seedPrepaidAccountWithOrder (GraphQL)
 *     Needed whenever top-ups must reach the backend: without a subscription a
 *     top-up looks successful in the UI but does not persist.
 *
 * Rule: the screens are used where the case TESTS account creation (account/ts-01); a case that only needs an
 * account uses the GraphQL seed, which stores exactly what the screens store. JASEC_ACCOUNT_SETUP=ui sends every
 * such case back to the screens (see accountSetupMode).
 *
 * customerId, NISE and the meter carry a unique suffix so reruns don't hit the
 * DB's unique constraints — see uniqueRunSuffix below.
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
import { PrepaidSeedHelper, type SeedPrepaidOptions } from '../helpers/prepaid-seed.helper';

/** Data needed for the order + meter portion of the setup. */
export interface JasecOrderData {
  bundleId: string;
  meter: { provisioningId: string; lecturaInicialKwh: string };
}

/**
 * Shape of one JASEC test-data row (account only — no order).
 * Loaded from `tests/data/jasec-prepaid-accounts.data.json`.
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

/**
 * Every meter this suite invents MUST match this — `M-QA<TAG>-<suffix>`.
 *
 * provisioningEnabled is ON on jasec-dev, so a seeded account can dispatch
 * SUSPEND/RESUME to JASEC's live AMI. The old seed shape, `002100` + 11 digits,
 * was 17 numeric chars — indistinguishable from a real device such as
 * 00210018641144770; only the AMI answering "El Medidor No existe" kept it safe.
 * A non-numeric prefix can never be a real JASEC meter. The Core UI order screen
 * accepts it (manual E2E 2026-09-29 used M-202609291001) and the MDR pipeline
 * rates it (the provisioning cases breach M-QAAUTO- meters).
 */
export const QA_METER_RE = /^M-QA[A-Z]+-[0-9A-Za-z-]+$/;

/** Refuse to seed a meter that could be a real one. Fails closed. */
export function assertQaMeter(meter: string): string {
  if (!QA_METER_RE.test(meter)) {
    throw new Error(
      `Refusing to seed meter "${meter}": it does not match ${QA_METER_RE}. ` +
      `A seeded meter must never look like a real JASEC device - use an M-QA<TAG>- prefix.`,
    );
  }
  return meter;
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
  // NISE became mandatory with JEPYP-231. Suffixed for the same reason
  // customerId is — a fixed value would collide on the second run.
  const clientId = `${baseRow.accountInfo.clientId ?? 'NISE'}-${suffix}`;

  await page.navigateToHome();
  await searchAccountsPage.navigateViaNav();
  await createAccountPage.clickCreateNew();

  const payload: PrepaidAccountPayload = {
    accountInfo: { ...baseRow.accountInfo, customerId, clientId },
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
  const provisioningId = assertQaMeter(`${baseRow.meter.provisioningId}${suffix}`);
  // NISE became mandatory with JEPYP-231; suffixed so reruns cannot collide.
  const clientId = `${baseRow.accountInfo.clientId ?? 'NISE'}-${suffix}`;

  // Account
  await page.navigateToHome();
  await searchAccountsPage.navigateViaNav();
  await createAccountPage.clickCreateNew();

  const payload: PrepaidAccountPayload = {
    accountInfo: { ...baseRow.accountInfo, customerId, clientId },
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

  await orderManagementPage.searchAccountById(accountId, { clearFilters: true });
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
 * Full setup through the Core UI wizard: create a fresh account+order, log into
 * Self Care, and act as the account (the ui path of setUpAccountInSelfCareBy).
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

  // Idempotent on purpose. Called a second time inside one test this would
  // otherwise wait out its full 180s for a login form that cannot appear: an
  // authenticated session routes goto() straight to the app.
  // Switching accounts is all a logged-in caller needs.
  // Not on Self Care right now (e.g. the test went back to Core UI) does NOT mean logged out: open Self Care and log in
  // only if the form really shows - the session cookie may route straight into the app (TC-150 2nd invoice, 10-21).
  if (!(await selfcareLoginPage.isAuthenticated())) {
    await selfcareLoginPage.goto();
    if (await selfcareLoginPage.loginFormAppears()) {
      const { username, password } = embrixCredentials();
      await selfcareLoginPage.login(username, password);
      await selfcareLoginPage.assertLoginSuccess();
    }
  }

  await selfcareAccountSearchPage.navigate();
  await selfcareAccountSearchPage.searchAndSelectAccount(accountId);
}

/**
 * Lightweight setup: create an account-only (no order), log into Self Care,
 * act as the account, and open Manage Payment Profile, for card-management
 * cases where a subscription is not required. Built the accountSetupMode(fallback) way.
 */
export async function setUpAccountAndEnterManagePaymentProfile(
  fixtures: SetUpAccountOnlyFixtures,
  baseRow: PrepaidAccountRow,
  fallback: AccountSetupMode = 'ui',
): Promise<string> {
  const {
    page, testLogger,
    searchAccountsPage, createAccountPage,
    selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
  } = fixtures;

  const accountId = await createPrepaidAccountOnlyBy(
    accountSetupMode(fallback), page, searchAccountsPage, createAccountPage, baseRow, testLogger,
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
 * Only for a throwaway account whose shape does not matter (JASEC_ACCOUNT_SETUP=gateway); the suites use the
 * screen-shaped seed instead. The gateway account differs from a screen-made one and has NO meter:
 * the gateway accepts `services[].provisioningId` and
 * `meterReading` and then SILENTLY IGNORES them, returning HTTP 200 with
 * status SUCCESS. No `core_engine.service_provision` type=METER row is created,
 * so the account can never be rated. The meter is attached by a separate
 * provisioning step, not by the NEW order. An un-rateable account that reports
 * SUCCESS is a trap, which is why this helper does not send those fields at all.
 *
 * Also note `legalEntity` is ignored (stored as 'US'), and the credit profile is
 * not guaranteed by this path — assert it if the test depends on it.
 */
export async function createPrepaidAccountViaGateway(
  fixtures: {
    testLogger: TestLogger;
    accountOrderApiHelper: AccountOrderApiHelper;
  },
  row?: PrepaidAccountWithOrderRow,
): Promise<string> {
  const { testLogger, accountOrderApiHelper } = fixtures;

  const started = Date.now();
  // Mirrors tests/data/jasec-prepaid-accounts.data.json, minus the meter. The
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
    ...(row?.contact?.middleName ? { middleName: row.contact.middleName } : {}),
    email: row?.contact?.email ?? (process.env.QA_EMAIL || process.env.NOTIFY_EMAIL_TO || 'qa.mailbox@example.com'),
    accounttype: 'RESIDENTIAL',
    accountCategory: 'PREPAID',
    accountSubType: 'PREPAID',
    customerSegment: 'B2C',
    currency: 'CRC',
    legalEntity: 'US',   // the Create Account form's own default; see the note on legalEntity below
    country: 'Costa Rica',
    state: 'Cartago',
    city: 'Cartago',
    district: 'Oriental',   // Cartago / Cartago / 30101 is the district Oriental; "Cartago" is not a district (JEPYP-316)
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
  return accountId;
}

/**
 * Create via the gateway AND attach to the account in Self Care.
 *
 * Split from createPrepaidAccountViaGateway so a caller that is ALREADY logged
 * in can create an account without logging in again -- repeating the Self Care
 * login inside one test leaves the form unrendered and every following action
 * times out. Such a caller creates, then navigates and
 * searches, rather than calling this.
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
  const accountId = await createPrepaidAccountViaGateway(fixtures, row);
  await attachToAccountInSelfCare(fixtures, accountId);
  return accountId;
}

// ── SEED PATH: the account the Create Account + Create Order screens make, over GraphQL (~6 s instead of ~2 min) ──
//
// It sends the screens' own requests, so the stored account is the same field by field (checked against a
// screen-made account): type PREPAID / subtype SUBTYPE_01, the row's contact, address and billing day, NISE, the
// meter with its Lectura Inicial and rating link, credit profile, bundle lines and discounts. The screen picks
// "Costa Rica" and stores CRI, so CRI is sent.

/** The seed options that reproduce what the screens store for `row` (suffix = uniqueRunSuffix()). */
function screenShapedSeed(row: PrepaidAccountRow, suffix: string): Omit<SeedPrepaidOptions, 'meter'> {
  const a = row.address;
  return {
    customerId: `${row.accountInfo.customerId}-${suffix}`,
    clientId: `${row.accountInfo.clientId ?? 'NISE'}-${suffix}`,
    name: '',
    email: row.contact.email,
    contact: {
      firstName: row.contact.firstName, lastName: row.contact.lastName,
      middleName: row.contact.middleName, identityDocument: row.contact.identityDocument,
    },
    address: { street: a.street, city: a.city, state: a.state, country: 'CRI', postalCode: a.postalCode, district: a.district },
    billingDom: Number(row.billingProfile.billingDom ?? 1),
    accountType: 'PREPAID',
    subType: 'SUBTYPE_01',
  };
}

/** Seed path of createPrepaidAccountWithOrder: account + order + meter, waited until the order is COMPLETED. */
export async function seedPrepaidAccountWithOrder(
  row: PrepaidAccountWithOrderRow, testLogger: TestLogger,
): Promise<{ accountId: string; orderId: string; provisioningId: string }> {
  const started = Date.now();
  const suffix = uniqueRunSuffix();
  const provisioningId = assertQaMeter(`${row.meter.provisioningId}${suffix}`);
  const seed = new PrepaidSeedHelper(testLogger);
  const { accountId, orderId } = await seed.seed({
    ...screenShapedSeed(row, suffix),
    meter: provisioningId,
    startReading: row.meter.lecturaInicialKwh,
    bundleId: row.bundleId,
    screenOrder: true,
  });
  const status = await seed.waitForOrder(orderId);
  expect(status, `seeded order ${orderId} on ${accountId} did not complete`).toBe('COMPLETED');
  testLogger.data('Account created (seed)', { accountId, orderId, provisioningId, seconds: (Date.now() - started) / 1000 });
  return { accountId, orderId, provisioningId };
}

/** Seed path of createPrepaidAccountOnly: the account, no order. */
export async function seedPrepaidAccountOnly(row: PrepaidAccountRow, testLogger: TestLogger): Promise<string> {
  const accountId = await new PrepaidSeedHelper(testLogger).createAccountOnly(screenShapedSeed(row, uniqueRunSuffix()));
  expect(accountId).toMatch(/^(ACT|AC)-\d+$/);
  testLogger.data('Account created (seed, no order)', { accountId });
  return accountId;
}

export type AccountSetupMode = 'ui' | 'seed' | 'gateway';

/** How a case builds the account it needs: JASEC_ACCOUNT_SETUP=ui | seed | gateway, else the caller's default. */
export function accountSetupMode(fallback: AccountSetupMode): AccountSetupMode {
  const v = (process.env.JASEC_ACCOUNT_SETUP ?? '').trim().toLowerCase();
  return v === 'ui' || v === 'seed' || v === 'gateway' ? v : fallback;
}

/** setUpAccountInSelfCare, with the account built the `mode` way ('gateway' is not offered: it attaches no meter). */
export async function setUpAccountInSelfCareBy(
  mode: AccountSetupMode, fixtures: SetUpWithOrderFixtures, baseRow: PrepaidAccountWithOrderRow,
): Promise<string> {
  if (mode !== 'seed') return setUpAccountInSelfCare(fixtures, baseRow);
  fixtures.testLogger.log('account setup: GraphQL seed, screen-shaped (JASEC_ACCOUNT_SETUP=ui for the Core UI wizard)');
  const { accountId } = await seedPrepaidAccountWithOrder(baseRow, fixtures.testLogger);
  await attachToAccountInSelfCare(fixtures, accountId);
  return accountId;
}

/** createPrepaidAccountOnly, with the account built the `mode` way. */
export async function createPrepaidAccountOnlyBy(
  mode: AccountSetupMode, page: Page, searchAccountsPage: SearchAccountsPage, createAccountPage: CreateAccountPage,
  baseRow: PrepaidAccountRow, testLogger: TestLogger,
): Promise<string> {
  if (mode !== 'seed') return createPrepaidAccountOnly(page, searchAccountsPage, createAccountPage, baseRow, testLogger);
  return seedPrepaidAccountOnly(baseRow, testLogger);
}

/**
 * Fixture bundle for `setUpAccountForTopUp` — the UI set plus the API helper,
 * so EITHER path can run without the call site changing.
 */
export interface SwitchableSetupFixtures extends SetUpWithOrderFixtures {
  accountOrderApiHelper: AccountOrderApiHelper;
}

/**
 * Create the account + order + meter and open it in Self Care, built the way JASEC_ACCOUNT_SETUP says, else `fallback`:
 *
 *   seed     screen-shaped GraphQL seed (~6 s) — what the top-up and notification specs pass
 *   ui       Core UI wizard (~2 min)
 *   gateway  CRM gateway (~3 s) — a different account shape and NO meter, so never for a case that reads the meter
 *            or rates (receipt "Medidor", MDR, tariff, tax tiers)
 *
 * legalEntity is `US` on every path (the Create Account form's default, which credit profiles match on).
 */
export async function setUpAccountForTopUp(
  fixtures: SwitchableSetupFixtures,
  baseRow: PrepaidAccountWithOrderRow,
  fallback: AccountSetupMode = 'ui',
): Promise<string> {
  const mode = accountSetupMode(fallback);
  if (mode === 'seed') return setUpAccountInSelfCareBy('seed', fixtures, baseRow);
  if (mode === 'gateway') {
    fixtures.testLogger.log(
      'account setup: CRM gateway (JASEC_ACCOUNT_SETUP=gateway) — NOTE this ' +
      'creates legalentity=US, which DOES match a credit profile, unlike a ' +
      'real UI-created account',
    );
    return setUpAccountInSelfCareViaGateway(fixtures, baseRow);
  }
  fixtures.testLogger.log('account setup: Core UI wizard (JASEC_ACCOUNT_SETUP=ui, or the caller default)');
  return setUpAccountInSelfCare(fixtures, baseRow);
}
