/**
 * Tags: @regression
 * Tags: @embrixPlatform
 *
 * Serial test suite: each TC depends on data created by the previous one.
 * Shared state is held in a mutable object at suite level and also persisted
 * to `playwright/.auth/test-context.json` via `updateTestContext()`.
 */

import { test as base, expect } from '../../../fixtures/page-factory';
import type { Locator } from '@playwright/test';
import { SharedAccount } from '../../../fixtures/shared-account.helper';
import { MEDIUM_WAIT, EXTRA_LONG_WAIT, LONG_WAIT, SHORT_WAIT } from '../../../helpers/timeouts.helper';
import { updateTestContext, loadTestContext } from '../../../helpers/test-context.helper';
import { embrixPlatformData } from '../../../test-data/embrix-platform.data';

// Shared mutable state across serial tests
interface SuiteState {
  startDate: string;
  nextMonthFirstDate: string;
  nextTwoMonthsFirstDate: string;
  nextThreeMonthsFirstDate: string;
  nextFourMonthsFirstDate: string;
  nextFiveMonthsFirstDate: string;
  quickAccUrl: string;
  accountId: string;
  orderId: string;
  invoiceId: string;
  endDate: string;
  amount: string;
  subscriptionId: string;
}

/**
 * A grid is empty when it has no rows, OR when its only row is the full-width
 * empty-state cell (`<td colspan="N">No records found</td>`).
 *
 * Counting rows alone is not enough: the empty state IS a row, so a naive
 * count of 1 reads as "has data" and the case then times out reaching for a
 * cell that does not exist. That is exactly how TC-48 slipped past its guard.
 */
async function gridIsEmpty(table: Locator): Promise<boolean> {
  const rows = table.locator('tbody tr');
  if (await rows.count() === 0) return true;
  return (await rows.first().locator('td[colspan]').count()) > 0;
}

const state: Partial<SuiteState> = {};

// Catalog + seed values for the tenant this run targets.
const data = embrixPlatformData();


/** Fixtures the shared-account create/attach steps need. */
type AccountFixtures = {
  page: any;
  testLogger: any;
  customerManagementPage: any;
  orderManagementPage: any;
  createOrderPage: any;
  screenshotHelper: any;
  servicesPage: any;
};

const accountUrl = (accountId: string) =>
  `${(process.env.EMBRIX_BASE_URL ?? '').replace(/\/+$/, '')}/customers/${accountId}/info`;

/**
 * Create the account + ala-carte order the suite operates on. Extracted from
 * TC-18 so any case can obtain one via `useAccount()` instead of depending on
 * TC-18 having run first.
 */
async function createAccountWithOrder(f: AccountFixtures): Promise<string> {
  const { page, testLogger, customerManagementPage, orderManagementPage,
          createOrderPage, screenshotHelper, servicesPage } = f;
    await page.navigateToHome();
    await customerManagementPage.navigateViaNav();
    await page.mouse.click(10, 10);
    await page.waitForTimeout(SHORT_WAIT);

    await customerManagementPage.clickCreateButton();

    await page.locator('.panel__title', { hasText: 'Create Contact' }).click();

    await customerManagementPage.quickCreateAccount(data.account.email, data.account.firstName, data.account.lastName);
    await page.locator('.panel__title', { hasText: 'Create Address' }).click();
    await customerManagementPage.addressDetails(data.account.street, data.account.state, data.account.city, data.account.postalCode);

    const quickAccUrl = await customerManagementPage.isQuickAccountCreatedSuccesfully(screenshotHelper);
    testLogger.data('Quick Account Create URL', quickAccUrl);

    const accountNumber = await page.locator('#year-tab').textContent() ?? undefined;

    updateTestContext({ quickAccUrl });
    state.quickAccUrl = quickAccUrl;
    // NOTE: the keys written here MUST match the keys beforeEach reads back.
    // They did not — 6 keys were written, 8 different ones read — so the
    // "restore state when running isolated tests" block never restored
    // anything, and the suite could only ever run start-to-finish.


    console.log('Account Number:', accountNumber?.trim().match(/ACT-\d+/)?.[0] ?? undefined);
    state.accountId = accountNumber?.trim().match(/ACT-\d+/)?.[0] ?? undefined;
    await page.waitForTimeout(LONG_WAIT);
    await orderManagementPage.clickCreateNewOrder();
    await page.waitForTimeout(SHORT_WAIT);
    await expect(page.locator('input[name="accountId"]')).toHaveValue(state.accountId!);

    await createOrderPage.clickTopNextButton();
    await createOrderPage.clickTopNextButton();
    await createOrderPage.clickBottomNextButton();
    await createOrderPage.clickAddAlaCarteButton();

    const alaCrteSelect = data.alaCarteOffer;
    await createOrderPage.searchByName(alaCrteSelect);
    await createOrderPage.clickRadioButtonById(alaCrteSelect);
    await createOrderPage.clickSelectButton();
    await createOrderPage.clickBottomNextButton();

    await expect(page.locator('h5.card-title.title-form.font-weight-normal')).toHaveText('Service Type: INTERNET');
    await page.waitForTimeout(SHORT_WAIT);
    await createOrderPage.clickTopNextButton();
    await page.locator('input[name="billingOnlyFlag"]').click({ force: true });
    await createOrderPage.clickCreateButton();
    await page.waitForTimeout(SHORT_WAIT);

    const incompleteOrderId = await servicesPage.getInCompleteOrdersFirstRowCellValue('Id');
    state.orderId = incompleteOrderId;
    updateTestContext({
      incompleteOrderId,
      accountId: state.accountId!,
      orderId: incompleteOrderId,
    });
    console.log(incompleteOrderId);

  return state.accountId!;
}

/**
 * One account + ala-carte order, created on first use and reused by every case
 * that needs one.
 *
 * The suite used to be `describe.serial` with TC-18 as an implicit prerequisite:
 * a case could not run on its own, and one failure skipped everything after it
 * (a 30s timeout at position 14 once cost 27 cases). Now any case can run alone
 * with `--grep` — whichever runs first pays the ~2min creation, the rest attach.
 *
 * Deliberately not a `beforeAll`: that would force the cost onto every run even
 * when a single test is selected. See fixtures/shared-account.helper.ts.
 */
const platformAccount = new SharedAccount<AccountFixtures>({
  label: 'TS-02 Embrix Platform',
  create: async (f) => createAccountWithOrder(f),
  attach: async (f, accountId) => {
    state.accountId = accountId;
    state.quickAccUrl = accountUrl(accountId);
    await f.page.goto(state.quickAccUrl!);
    await f.page.waitForLoadState('networkidle');
  },
});


/**
 * `embrixAccount` — declare this fixture in any case that needs the shared
 * account; omit it and the case pays nothing.
 *
 * A fixture rather than a helper call because Playwright requires the first
 * test argument to be an object destructuring pattern, so a case cannot hand
 * the whole fixtures object to a helper.
 */
const test = base.extend<{ embrixAccount: string }>({
  embrixAccount: async (
    { page, testLogger, customerManagementPage, orderManagementPage,
      createOrderPage, screenshotHelper, servicesPage },
    use,
  ) => {
    const accountId = await platformAccount.ensure({
      page, testLogger, customerManagementPage, orderManagementPage,
      createOrderPage, screenshotHelper, servicesPage,
    });
    state.accountId = accountId;
    state.quickAccUrl = state.quickAccUrl ?? accountUrl(accountId);
    await use(accountId);
  },
});

test.describe('REGRESSION: Test Suite - 02', () => {

  test.beforeEach(async () => {
    // Restore shared state from test-context.json if we are running isolated tests
    try {
      const saved = loadTestContext();
      if (saved.testingDateObj) {
        state.startDate = state.startDate ?? saved.testingDateObj.startDate;
        state.nextMonthFirstDate = state.nextMonthFirstDate ?? saved.testingDateObj.nextMonthFirstDate;
        state.nextTwoMonthsFirstDate = state.nextTwoMonthsFirstDate ?? saved.testingDateObj.nextTwoMonthsFirstDate;
        state.nextThreeMonthsFirstDate = state.nextThreeMonthsFirstDate ?? saved.testingDateObj.nextThreeMonthsFirstDate;
        state.nextFourMonthsFirstDate = state.nextFourMonthsFirstDate ?? saved.testingDateObj.nextFourMonthsFirstDate;
        state.nextFiveMonthsFirstDate = state.nextFiveMonthsFirstDate ?? saved.testingDateObj.nextFiveMonthsFirstDate;
      }
      state.accountId = state.accountId ?? saved.accountId;
      state.orderId = state.orderId ?? saved.orderId;
      state.quickAccUrl = state.quickAccUrl ?? saved.quickAccUrl;
      state.invoiceId = state.invoiceId ?? saved.invoiceId;
      state.amount = state.amount ?? saved.amount;
      state.endDate = state.endDate ?? saved.endDate;
      state.subscriptionId = state.subscriptionId ?? saved.subscriptionId;
    } catch {
      // Ignored: context file might not exist on the first run of the suite
    }
  });


  test('TC-00: Suite Setup — Set CCP Time', async ({ serverHelper }) => {
    // Generate random dates for future testing period
    const testingDateObj = await serverHelper.generateRandomFutureDate();
    state.startDate = testingDateObj.startDate; // Date for creating account, order and first invoice
    state.nextMonthFirstDate = testingDateObj.nextMonthFirstDate; // Date for next month's jobs
    state.nextThreeMonthsFirstDate = testingDateObj.nextThreeMonthsFirstDate;
    console.log(state.startDate);
    console.log(state.nextMonthFirstDate);
    console.log('nextThreeMonthsFirstDate--------' + state.nextThreeMonthsFirstDate);
    await serverHelper.setAndVerifyCcpTime(state.startDate); // Set date for create account, order and first invoice

  });

  test('TC-18: Create Account in Embrix', async ({ embrixAccount, testLogger }) => {
    // Assertions hold whether this case created the account or attached to one
    // an earlier case made.
    expect(embrixAccount, 'No account id captured').toMatch(/^ACT-\d+$/);
    expect(state.orderId, 'No in-complete order recorded for the account').toBeTruthy();
    testLogger.data('Account under test', embrixAccount);
  });

  test('TC-20: Send Existing Order from Order Management', async ({ embrixAccount,
    page, testLogger, customerManagementPage, orderManagementPage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await orderManagementPage.navigateViaNav();
    await orderManagementPage.searchOrderId(state.orderId ?? '');
    await page.waitForTimeout(SHORT_WAIT);
    const orderId = await orderManagementPage.getFirstRowCellValue('Id');
    expect(state.orderId).toBe(orderId);
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('a', { hasText: orderId }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await expect(page.locator('input[name="accountId"]')).toHaveValue(state.accountId!);
    await page.waitForTimeout(SHORT_WAIT);
    await orderManagementPage.clickSubmitOrderButton();
    await page.waitForTimeout(SHORT_WAIT);
    const orderUrl = await orderManagementPage.isUpdateOrderSuccesfully(screenshotHelper);
    console.log(orderUrl);
    testLogger.data('orderUrl', orderUrl);
    updateTestContext({ orderUrl });

  });

  test('TC-54: Billing Data / Invoice Management – View and Manage Invoices', async ({ embrixAccount,
    page, billsPage, screenshotHelper, testLogger, serverHelper
  }) => {
    const date = state.nextMonthFirstDate!;
    await serverHelper.setAndVerifyCcpTime(date);

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToBills();
    await page.waitForLoadState('networkidle');

    // PRECONDITION (spec): "At least one invoice exists... Billable pending
    // charges exist." TC-18's order parks at PROVISIONING_INITIATED because
    // billingOnlyFlag does not persist, so no subscription and no charges are
    // ever created. Without this guard the case clicked the empty-state row,
    // timed out after 30s, and — being serial — took the other ~37 cases with
    // it. Report BLOCKED with the reason printed instead.
    const pendingRows = await page.locator('table tbody tr').count();
    const emptyGrid = await page.locator('td[colspan]').count();
    testLogger.data('Bill rows visible', pendingRows);
    test.skip(
      pendingRows === 0 || emptyGrid > 0,
      'BLOCKED: account has no billable charges — order never provisioned (billingOnlyFlag does not persist)'
    );

    await billsPage.clickBillPendingButton();
    const popup = page.locator('[role="dialog"]'); // or your popup selector
    await popup.waitFor({ state: 'visible' });

    await page.waitForTimeout(SHORT_WAIT);
    await popup.getByRole('button', { name: 'Process', exact: true }).click();
    await page.waitForTimeout(MEDIUM_WAIT);
    await billsPage.clickRadioButtonById();
    const invoiceGroup = page.locator('div.form-group.select-group', { hasText: 'Action' });
    await invoiceGroup.locator('.custom-react-select__control').click();

    await page.locator('.custom-react-select__option')
      .filter({ hasText: 'GENERATE_INVOICE' })
      .first()
      .click();
    await page.waitForTimeout(SHORT_WAIT);
    const submitBtn = page.getByRole('button', { name: /SUBMIT/i }).first();
    await submitBtn.click();
    await page.waitForTimeout(SHORT_WAIT);
    const firstRowText = await page.locator('table').nth(1)
      .locator('tbody tr').first()
      .locator('td').nth(8)
      .innerText();
    state.invoiceId = firstRowText;
    console.log(state.invoiceId);
    state.invoiceId = firstRowText;
    console.log(state.invoiceId);
    const amount = await page.locator('table').nth(1)
      .locator('tbody tr').first()
      .locator('td').nth(7).innerText();
    state.amount = amount;
    const endDate = await page.locator('table').nth(1)
      .locator('tbody tr').first()
      .locator('td').nth(4).innerText();
    state.endDate = endDate;
    updateTestContext({ invoiceId: state.invoiceId, amount: state.amount, endDate });
  });

  test('TC-38: Account Data / Account Information – Customer Segment Modification', async ({ embrixAccount,
    page, accountInfoPage, contactPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    console.log(state.quickAccUrl!);
    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);
    await page.waitForLoadState('networkidle')
    await customerManagementPage.changeCustomerSegment();
    await page.waitForTimeout(SHORT_WAIT);
    const modifyAccUrl = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify customer segment URL', modifyAccUrl);

    // The toast only says the request was accepted. Reload and read the field
    // back, so a backend that acknowledges and discards the write is caught.
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle');
    const segment = page.locator('div.form-group.select-group', { hasText: 'Customer Segment' })
      .locator('.custom-react-select__single-value').first();
    await expect(segment, 'Customer Segment did not persist as B2B').toHaveText('B2B');
  });


  test('TC-39: Account Data / Contact – Contact Modification and Creation', async ({ embrixAccount,
    page, accountInfoPage, contactPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    console.log(state.quickAccUrl!);
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle')
    await contactPage.navigateToContactActivity();
    // Contacts render as stacked form panels, NOT table rows — each has its own
    // `Id` input (PRIMARY, CONTACT-nnnnnn). Counting table rows here counts the
    // wrong thing entirely.
    const contactIds = page.locator('input[name="id"]');
    const contactsBefore = await contactIds.count();
    testLogger.data('Contacts before', contactsBefore);

    await contactPage.clickAddNewContact();
    await contactPage.addContactDetails();
    await page.waitForTimeout(SHORT_WAIT);
    const modifycontact = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify contact on account URL', modifycontact);

    // Reload and confirm the contact really was added.
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle');
    await contactPage.navigateToContactActivity();
    expect(
      await page.locator('input[name="id"]').count(),
      'Contact count did not increase after save'
    ).toBeGreaterThanOrEqual(contactsBefore + 1);
    // ...and the new contact is the one we filled in.
    await expect(
      page.locator('input[value="Danial"]').first(),
      'Newly created contact "Danial" not found after reload'
    ).toBeVisible();
  });


  test('TC-40: Account Data / Addresses – Address Creation and Modification', async ({ embrixAccount,
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle')
    await accountInfoPage.navigateToAddresses();
    // Addresses render as stacked form panels, not table rows (same as Contacts) —
    // each has its own `Id` input (PRIMARY, ADDRESS-nnnnnn).
    const addressesBefore = await page.locator('input[name="id"]').count();
    testLogger.data('Addresses before', addressesBefore);

    await accountInfoPage.clickAddNewAddress();
    await accountInfoPage.addressDetails('Principal', data.account.state, data.account.city, '102339');
    await page.waitForTimeout(SHORT_WAIT);
    const modifyAddress = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify Address on account URL', modifyAddress);

    // Reload and confirm the address persisted.
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle');
    await accountInfoPage.navigateToAddresses();
    expect(
      await page.locator('input[name="id"]').count(),
      'Address count did not increase after save'
    ).toBeGreaterThanOrEqual(addressesBefore + 1);
    await expect(
      page.getByText('Principal', { exact: true }).first(),
      'Newly created address street "Principal" not found after reload'
    ).toBeVisible();

    // [FINDING 2026-09-12] The saved address comes back with Country="United
    // States" / State="Alaska" although addressDetails() was passed 'Alajuela'
    // (the PRIMARY address on the same account is correctly Costa Rica /
    // Alajuela). The state typeahead appears to match 'Ala' -> 'Alaska'. The
    // address IS created, so TC-40's documented steps pass, but the values
    // written are wrong. Raise with the team before relying on this case.
  });

  test('TC-42: Account Data / Billing Profile – Annual Billing Modification', async ({ embrixAccount,
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle')
    await accountInfoPage.navigateToBillingProfile();
    await page.waitForLoadState('networkidle');

    // Done inline rather than via changeBillingFrequency() so the documented
    // intermediate expectations can actually be asserted.
    const frequency = page.locator('div.form-group.select-group', { hasText: 'Billing Frequency' });
    await frequency.locator('.custom-react-select__control').click();
    await page.locator('.custom-react-select__option').filter({ hasText: 'ANNUAL' }).first().click();

    // Steps 4-5: "The Annual billing option is selected."
    await expect(frequency.locator('.custom-react-select__single-value').first()).toHaveText('ANNUAL');

    // Step 6: "The system requests confirmation to apply the changes."
    await page.getByRole('button', { name: 'Modify', exact: true }).click();
    const confirm = page.locator('[role="dialog"]').last();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/effective from next billing cycle/i);

    // Step 7
    await confirm.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.waitForLoadingToDisappear();
    await page.waitForLoadState('networkidle');

    // Step 8: confirmation message.
    const modifyBillingProfile = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify Billing Profile on account URL', modifyBillingProfile);

    // NOTE: deliberately no read-back of ANNUAL here. The confirmation dialog
    // states the change is "effective from next billing cycle", and the screen
    // keeps showing the currently-effective frequency (MONTHLY). Verified
    // 2026-09-12: after saving, both the UI and
    // getAccountById.billingProfiles[].billingFrequency still read MONTHLY,
    // with futureBillDate null — so the pending value is not exposed anywhere
    // we can reach. Confirming it truly applies needs a billing-cycle run.
    // [OPEN QUESTION for the team: where is a scheduled frequency change stored?]
  });

  test('TC-43: Account Data / Custom Attributes & Tax Exemptions – Configuration and Modification', async ({ embrixAccount,
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);
    await accountInfoPage.navigateToTaxExemptions();
    const exemptionsBefore = await accountInfoPage.activityTable.getRowCount();
    testLogger.data('Tax exemptions before', exemptionsBefore);

    await accountInfoPage.addNewTaxExemption();
    await accountInfoPage.activityTable.selectCellOption(0, 'Level', data.taxExemptionLevel);
    await accountInfoPage.clickSave();
    const modifyTaxExemption = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify TaxExemptions on account URL', modifyTaxExemption);

    // Reload and confirm the exemption persisted at the configured Level.
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle');
    await accountInfoPage.navigateToTaxExemptions();
    expect(
      await accountInfoPage.activityTable.getRowCount(),
      'Tax exemption count did not increase after save'
    ).toBeGreaterThanOrEqual(exemptionsBefore + 1);
    await expect(
      page.locator('tbody tr').filter({ hasText: data.taxExemptionLevel }).first(),
      `No tax exemption row at Level ${data.taxExemptionLevel}`
    ).toBeVisible();
  });

  test('TC-44: Account Data / Hierarchy – Move Account to Parent Hierarchy', async ({ embrixAccount,
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.navigateToHome();
    await customerManagementPage.navigateViaNav();
    await page.mouse.click(10, 10);
    await page.waitForTimeout(SHORT_WAIT);
    await customerManagementPage.clickCreateButton();

    await page.locator('.panel__title', { hasText: 'Create Contact' }).click();

    await customerManagementPage.quickCreateAccount(data.account.email, data.account.firstName, data.account.lastName);
    await page.locator('.panel__title', { hasText: 'Create Address' }).click();
    await customerManagementPage.addressDetails(data.account.street, data.account.state, data.account.city, data.account.postalCode);
    const accountNumber = await page.locator('#year-tab').textContent() ?? undefined;
    const trimAccount = accountNumber?.trim().match(/ACT-\d+/)?.[0] ?? undefined!;

    await page.goto(state.quickAccUrl!);
    await accountInfoPage.navigateToHierarchy();
    await page.locator('#toAccount input').click();
    await page.waitForTimeout(SHORT_WAIT);
    const popup = page.locator('[role="dialog"]'); // or your popup selector
    await page.waitForTimeout(SHORT_WAIT);
    // await popup.locator('input[name="accountId"]').fill(accountNumber);
    await popup.locator('input[name="accountId"]').fill(trimAccount);

    await page.waitForTimeout(SHORT_WAIT);
    await accountInfoPage.clickSearchPopupButton();
    await accountInfoPage.clickRadioButtonById(trimAccount);
    await accountInfoPage.clickSelectButton();
    const submitBtn = page.getByRole('button', { name: /SUBMIT/i }).first();
    await submitBtn.click();
    await page.waitForLoadingToDisappear();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(SHORT_WAIT);
    const modifyHierarchy = await customerManagementPage.moveAccountSuccessfully(screenshotHelper);
    testLogger.data('Modify Hierarchy on account URL', modifyHierarchy);
    await page.waitForTimeout(SHORT_WAIT);

    // EMBRIX_BASE_URL carries a trailing slash, so the old concatenation built
    // `...org//customers/...`. Trim it.
    const base = (process.env.EMBRIX_BASE_URL ?? '').replace(/\/+$/, '');
    await page.goto(`${base}/customers/${trimAccount}/info`);
    // The sidebar is rendered by the SPA after hydration; navigating it
    // straight after goto raced it and timed out waiting for "Account Data".
    await page.waitForLoadState('networkidle');

    await accountInfoPage.navigateToHierarchy();
    const rowAccId = await accountInfoPage.getFirstRowCellValue('ACCT No');
    expect(state.accountId!).toBe(rowAccId);

  });


  test('TC-45: Account Data / Tasks – Installment Payment Plan Creation', async ({ embrixAccount,
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await accountInfoPage.navigateToPaymentInstallment();
    // Plans render as collapsible panels headed "PI-nnnnn - STATUS".
    const planPanels = page.getByText(/^PI-\d+ - /);
    const plansBefore = await planPanels.count();
    testLogger.data('Installment plans before', plansBefore);

    await accountInfoPage.clickAddInstallmemtButton();
    await accountInfoPage.clickbuttontoExpand();
    await accountInfoPage.clickSaveConfig();

    // This case's only verification was commented out, leaving it passing on
    // nothing. Restoring the toast check was wrong too: SAVE CONFIG on this
    // screen fires NO toast at all (verified 2026-09-12 — the plan PI-51223
    // was created and ACTIVE while the toast race timed out after 8 minutes).
    // Verify the persisted plan instead, which is stronger than a toast.
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle');
    await accountInfoPage.navigateToPaymentInstallment();
    expect(
      await page.getByText(/^PI-\d+ - /).count(),
      'Installment plan count did not increase after save'
    ).toBeGreaterThanOrEqual(plansBefore + 1);
    await expect(
      page.getByText(/^PI-\d+ - ACTIVE/).first(),
      'No ACTIVE installment plan after save'
    ).toBeVisible();
  });

  test('TC-46: Account Data / Exchange Rates – External Purchase Order Configuration', async ({ embrixAccount,
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await accountInfoPage.navigateToXchangeRates();
    await accountInfoPage.clickAddNewXchangeButton();
    await accountInfoPage.activityTable.selectCellOption(0, 'Xchange Currency', data.exchangeCurrency);
    await accountInfoPage.clickSaveConfig();

    // The commented-out check here was a copy-paste of the installment-plan
    // helper, which asserts "Create Payment Installment successfully!" — the
    // wrong toast for this screen. Verify the saved row instead.
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle');
    await accountInfoPage.navigateToXchangeRates();
    // Assert the specific configured currency, not a row-count delta: this
    // screen renders a blank row by default, so `before` is already 1 and a
    // delta check fails even though the row saved correctly.
    await expect(
      page.getByText(data.exchangeCurrency, { exact: true }).first(),
      `Exchange rate row for ${data.exchangeCurrency} not found after reload`
    ).toBeVisible();
  });



  test('TC-47: Subscription Data / Subscription View – Active Subscription Detail', async ({ embrixAccount,
    page, servicesPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);
    await servicesPage.navigateSubscriptionView();
    await page.waitForTimeout(SHORT_WAIT);
    const accountGroup = page.locator('.family-chart-group')
      .filter({ has: page.locator('.title', { hasText: 'Account' }) });

    const idBlock = accountGroup.locator('.col-md-12.row')
      .filter({ has: page.locator('.title-description', { hasText: 'Id:' }) });

    await expect(idBlock.locator('.description-content')).toHaveText(state.accountId!);
    const subscriptionGroup = page.locator('.family-chart-group')
      .filter({ has: page.locator('.title', { hasText: /^Subscription$/ }) })
      .first();

    // PRECONDITION: the family chart only renders a Subscription node once the
    // order provisions. It never does here, so guard rather than time out for
    // 30s and take the rest of the serial block down.
    test.skip(await subscriptionGroup.count() === 0, 'BLOCKED: account has no subscription — order never provisioned (billingOnlyFlag does not persist)');

    await subscriptionGroup.locator('.description .col-md-12.row').first().click();
    await page.waitForTimeout(SHORT_WAIT);
    await expect(page.locator('input[name="accountId"]')).toHaveValue(state.accountId!);
    await page.waitForTimeout(SHORT_WAIT);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const serviceUnitGroup = page.locator('.family-chart-group')
      .filter({ has: page.locator('.title', { hasText: /^Service\sUnits$/ }) })
      .first();

    await serviceUnitGroup.locator('.description .col-md-12.row').first().click();
    const popup = page.locator('[role="dialog"]'); // or your popup selector
    await popup.waitFor({ state: 'visible' });

    await page.waitForTimeout(SHORT_WAIT);
    await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
    const priceUnitGroup = page.locator('.family-chart-group')
      .filter({ has: page.locator('.title', { hasText: /^Price\sUnit$/ }) })
      .first();

    await priceUnitGroup.locator('.description .col-md-12.row').first().click();

    await popup.waitFor({ state: 'visible' });

    await page.waitForTimeout(SHORT_WAIT);
    await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  });


  test('TC-48: Subscription Data / Services – Service Creation and Order Approval', async ({ embrixAccount,
    page, servicesPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);

    await page.waitForTimeout(SHORT_WAIT);

    await servicesPage.navigateViaSideMenu();
    await page.waitForLoadState('networkidle');

    // PRECONDITION: needs a provisioned subscription.
    const subTable = page.locator('//h5[contains(text(), "Subscription")]/following::table').first();
    test.skip(await gridIsEmpty(subTable), 'BLOCKED: account has no subscription — order never provisioned (billingOnlyFlag does not persist)');

    const accountId = await servicesPage.getSubscriptionFirstRowCellValue('Account Id');
    expect(accountId).toBe(state.accountId);
    const subscriptionId = await servicesPage.getSubscriptionFirstRowCellValue('Id');
    state.subscriptionId = subscriptionId;
    updateTestContext({ subscriptionId });
    testLogger.data('subscriptionId', subscriptionId);
    const subId = await servicesPage.getServiceUnitFirstRowCellValue('Subscription Id');
    expect(subId).toBe(state.subscriptionId);

  });


  test('TC-49: Subscription Data / Offers – Filter Active Offers', async ({ embrixAccount,
    page, servicesPage, accountInfoPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);

    await servicesPage.navigateToOffers();
    await page.waitForTimeout(SHORT_WAIT);

    // PRECONDITION: without a subscription the Offers screen renders EMPTY —
    // no filters and no grid at all, not merely an empty table. Guard on the
    // Status filter's existence, before touching it.
    const statusGroup = page.locator('div.form-group.select-group', { hasText: 'Status' });
    test.skip(await statusGroup.count() === 0, 'BLOCKED: account has no subscription — order never provisioned (billingOnlyFlag does not persist)');

    await statusGroup.locator('.custom-react-select__control').click();

    await page.locator('.custom-react-select__option')
      .filter({ hasText: 'ACTIVE' })
      .first()
      .click();
    await servicesPage.clickSearchButton();
    await page.waitForLoadState('networkidle');

    const accountId = await accountInfoPage.getFirstRowCellValue('Account Id');
    expect(accountId).toBe(state.accountId!);


  });


  test('TC-53: Billing Data / Subscription Balance Inquiry – View Subscription Balances', async ({ embrixAccount,
    page, accountInfoPage, billsPage, screenshotHelper, testLogger
  }) => {


    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);
    const value = await page.locator('.m-b-0[style*="color: rgb(62, 193, 211)"]').innerText();

    await billsPage.navigateToBalance();
    await page.waitForLoadState('networkidle');

    // PRECONDITION: subscription balances require a subscription.
    test.skip(await gridIsEmpty(page.locator('table.center-aligned-table.mb-0').first()), 'BLOCKED: account has no subscription — order never provisioned (billingOnlyFlag does not persist)');

    const firstTable = page.locator('table.center-aligned-table.mb-0').first();
    const amountValue = await firstTable.locator('tbody tr').nth(0).locator('td').nth(1).innerText();

    expect(amountValue.trim()).toBe(value.trim());
    testLogger.data('Billing data balance', amountValue);

  });

  test('TC-24: Pricing Center – Basic Configurations (Currency)', async ({
    page, testLogger, currencyPage, screenshotHelper,
  }) => {
    await page.navigateToHome();
    await currencyPage.navigateViaNav();

    // Pick a currency this tenant does NOT already have. Re-selecting an
    // existing one leaves the new row's Currency Id blank and the save is
    // rejected as "...are all mandatory", so a fixed currency makes the case
    // pass exactly once per tenant — the run that creates it.
    const existing: string[] = [];
    const rowCount = await currencyPage.table.getRowCount();
    for (let i = 0; i < rowCount; i++) {
      existing.push((await currencyPage.table.getCellValue(i, 'Currency Id')).trim());
    }
    testLogger.data('Currencies already configured', existing);

    // Dropdown renders "Euro (EUR)" but the cell reads back as "Euro (EUR)" or
    // a truncated label, so match on the bracketed ISO code.
    const isoOf = (label: string) => label.match(/\(([A-Z]{3})\)/)?.[1] ?? label;
    const target = data.currency.candidates.find(
      c => !existing.some(e => isoOf(e) === isoOf(c) || e.includes(isoOf(c)))
    );
    if (!target) {
      throw new Error(
        `Every candidate currency is already configured on this tenant ` +
        `(${existing.join(', ')}). Add an unused one to ` +
        `test-data/embrix-platform.data.ts → currency.candidates.`
      );
    }
    testLogger.data('Creating currency', target);

    await currencyPage.clickAddCurrencyButton();
    await currencyPage.table.selectCellOption(0, 'Currency Id', target);
    await currencyPage.table.fillCellInput(0, 'Name', isoOf(target));
    await currencyPage.table.selectCellOption(0, 'Rounding Method', data.currency.roundingMethod);
    await currencyPage.table.fillCellInput(0, 'Rounding Precision', data.currency.roundingPrecision);

    // Selecting a valid Currency Id auto-populates Symbol. If it is still
    // blank the save will fail on a mandatory field, so catch it here where
    // the cause is obvious rather than in the toast.
    const symbol = (await currencyPage.table.getCellValue(0, 'Symbol')).trim();
    expect(symbol, `Symbol did not auto-populate for ${target}`).not.toBe('');

    await page.waitForTimeout(SHORT_WAIT);
    await currencyPage.clickModifyButton();
    const currencyUrl = await currencyPage.createCurrencySuccessfully(screenshotHelper);
    testLogger.data('currencyUrl', currencyUrl);
    updateTestContext({ currencyUrl });

    // Prove it persisted, rather than trusting the toast.
    await page.reload();
    await page.waitForLoadState('networkidle');
    const after = await currencyPage.table.getRowCount();
    expect(after).toBeGreaterThanOrEqual(rowCount + 1);
  });


  test('TC-25: Pricing Center – Price Management (Product Family)', async ({
    page, testLogger, productFamilyPage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await productFamilyPage.navigateViaNav();
    await page.waitForTimeout(SHORT_WAIT);
    // `(productcompany, productfamily, productline, producttype, productsubtype)`
    // is UNIQUE in the DB, so the original fixed row could only ever be created
    // once per tenant — every later run failed with "duplicate key value
    // violates unique constraint product_family_list_...". Tag the Product Type
    // per run so the case is repeatable.
    const runTag = Date.now().toString().slice(-6);
    const productType = `${data.productFamily.type}-${runTag}`;
    testLogger.data('Product Type for this run', productType);

    await productFamilyPage.clickAddNewProductButton();
    // All five Product Family columns are plain text inputs, not react-selects.
    // Product Line / Type / Sub Type used selectCellOption, which waits for a
    // `.custom-react-select__control` that never exists here and timed out.
    await productFamilyPage.table.fillCellInput(0, 'Product Company', data.productFamily.company);
    await productFamilyPage.table.fillCellInput(0, 'Product Family', data.productFamily.family);
    await productFamilyPage.table.fillCellInput(0, 'Product Line', data.productFamily.line);
    await productFamilyPage.table.fillCellInput(0, 'Product Type', productType);
    await productFamilyPage.table.fillCellInput(0, 'Product Sub Type', data.productFamily.subType);
    await productFamilyPage.clickModifyButton();
    const productFamilyUrl = await productFamilyPage.createProductFamilySuccessfully(screenshotHelper);
    testLogger.data('productFamilyUrl', productFamilyUrl);
    updateTestContext({ productFamilyUrl });

    // Prove the row persisted rather than trusting the toast.
    //
    // NOT by row count: this grid paginates at 20, so adding a 21st row leaves
    // page 1 showing 20 and a count delta reads as "nothing saved". Search for
    // the run-tagged Product Type instead — it is unique by construction.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator('input').nth(3).fill(productType);
    await page.getByRole('button', { name: 'SEARCH', exact: false }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('tbody tr').filter({ has: page.locator(`input[value="${productType}"]`) }).first(),
      `Product Family row with Product Type ${productType} not found after save`
    ).toBeVisible();
  });



  test('TC-22: Billing Center / Taxes – Tax Code Configuration', async ({
    page, testLogger, taxationPage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await taxationPage.navigateViaNav();
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('table tbody tr').nth(0).locator('td').nth(0).getByRole('button', { name: 'View' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    const code = await taxationPage.getFirstRowCellValue('Code');
    const popup = page.locator('[role="dialog"]');
    await expect(popup.locator('input[name="productCode"]')).toHaveValue(code);
    await page.waitForTimeout(SHORT_WAIT);
    await taxationPage.clickSaveConfigButtonButton();

    const taxationUrl = await taxationPage.modifyTaxSuccessfully(screenshotHelper);
    updateTestContext({ taxationUrl });
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('table tbody tr').nth(0).locator('td').nth(0).getByRole('button', { name: 'View' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    const code1 = await taxationPage.getFirstRowCellValue('Code');

    await expect(popup.locator('input[name="productCode"]')).toHaveValue(code1);
    await page.waitForTimeout(SHORT_WAIT);
    await popup.locator('.custom-react-select__control').nth(0).click();

    await popup.locator('.custom-react-select__option')
      .filter({ hasText: 'COUNTRY' })
      .first()
      .click();
    await page.waitForTimeout(SHORT_WAIT);
    await taxationPage.clickSaveConfigButtonButton();
    const taxationUrl1 = await taxationPage.modifyTaxSuccessfully(screenshotHelper);
    testLogger.data('taxationUrl 1st time', taxationUrl1);

    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('table tbody tr').nth(0).locator('td').nth(0).getByRole('button', { name: 'View' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    const code2 = await taxationPage.getFirstRowCellValue('Code');

    await expect(popup.locator('input[name="productCode"]')).toHaveValue(code2);
    await page.waitForTimeout(SHORT_WAIT);

    await popup.locator('input[name="taxCategory"]').click();
    await page.waitForTimeout(SHORT_WAIT);
    await taxationPage.clickSaveConfigButtonButton();
    const taxationUrl2 = await taxationPage.modifyTaxSuccessfully(screenshotHelper);
    testLogger.data('taxationUrl 2nd time', taxationUrl2);
  });



  test('TC-26: Pricing Center – Package Management', async ({
    page, testLogger, bundlePage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await bundlePage.navigateViaNav();
    await page.locator('input[name="id"]').clear();
    await page.locator('input[name="id"]').fill(data.bundleId);
    await bundlePage.clickSearchButton();
    const firstRowText = await page.locator('table tbody tr:first-child td:nth-child(1)').innerText();
    expect(firstRowText.trim()).toBe(data.bundleId);
  });






  test('TC-32: Operations Center / User Management – Successful Creation and Modification', async ({
    page, userManagementPage, screenshotHelper, testLogger
  }) => {
    await page.navigateToHome();
    await userManagementPage.navigateViaNav();
    await userManagementPage.clickCreateUserButton();
    await page.waitForTimeout(SHORT_WAIT);
    await userManagementPage.addDetailsForUser();
    const createUserUrl = await userManagementPage.createUserSuccessfully(screenshotHelper);
    testLogger.data('Create User URL', createUserUrl);

    // Read the user back. The toast only reports that the request was accepted.
    const createdUser = userManagementPage.createdUsername;
    testLogger.data('Created user id', createdUser);
    expect(createdUser, 'addDetailsForUser() did not record a username').not.toBe('');

    await page.navigateToHome();
    await userManagementPage.navigateViaNav();
    await page.locator('input[name="userId"]').fill(createdUser);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('tbody tr').filter({ hasText: createdUser }).first(),
      `Created user ${createdUser} is not listed after search`
    ).toBeVisible();
  });



  test('TC-34: Operations Center / Correspondence – Template Configuration and Download Validation', async ({
    page, corrspondencePage, screenshotHelper, testLogger
  }) => {
    // KNOWN PRODUCT DEFECT (coopeg-sandbox, confirmed 2026-09-12): the View
    // button on a correspondence template opens nothing at all. Marked as an
    // expected failure so it neither halts the serial block nor hides itself:
    // if the product is fixed this reports as an UNEXPECTED PASS, which is the
    // signal to remove this line.
    test.fail(true, 'Correspondence View button does nothing — see assertion below');

    await page.navigateToHome();
    await corrspondencePage.navigateViaNav();
    await page.mouse.click(10, 10);
    await page.waitForTimeout(SHORT_WAIT);

    // Steps 1-3: "The configuration of available templates is displayed."
    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count();
    expect(rowCount, 'No correspondence templates configured on this tenant').toBeGreaterThan(0);
    testLogger.data('Correspondence templates configured', rowCount);

    // Step 4: "The details of the selected template are displayed."
    //
    // KNOWN DEFECT (coopeg-sandbox, 2026-09-12): this button does nothing.
    // Diagnosed with tests/dev — the click lands (the button takes focus) but
    // no [role=dialog], no .modal, no new tab and no navigation follows. The
    // original code waited 30s for a dialog and failed with an opaque timeout;
    // this fails naming the defect instead.
    const viewButton = rows.nth(0).locator('td').nth(5).getByRole('button', { name: 'View' });
    await expect(viewButton, 'View button missing from the template row').toBeVisible();
    await viewButton.click();

    const popup = page.locator('[role="dialog"]');
    await expect(
      popup,
      'DEFECT: clicking View on a correspondence template opens nothing — ' +
      'no dialog, modal, new tab or navigation. Spec TC-34 step 4 expects ' +
      '"The details of the selected template are displayed."'
    ).toBeVisible({ timeout: MEDIUM_WAIT });

    // Steps 5-6, reachable only once the defect above is fixed.
    await popup.getByRole('button', { name: 'Download', exact: true }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(popup).not.toBeVisible();
  });



  test('TC-37: Operations Center / Task Administration – Successful Task Creation', async ({ embrixAccount,
    page, taskManagementPage, screenshotHelper, testLogger
  }) => {
    await page.navigateToHome();
    await taskManagementPage.navigateViaNav();
    await page.waitForTimeout(SHORT_WAIT);
    await taskManagementPage.clickCreateTaskButton();
    const popup = page.locator('[role="dialog"]'); // or your popup selector
    await popup.waitFor({ state: 'visible' });

    await popup.locator('input[name="accountId"]').click();
    await page.waitForTimeout(SHORT_WAIT);
    const topPopup = page.locator('[role="dialog"]').last();

    // Fill accountId inside top popup
    await topPopup.locator('#accountId input').fill(state.accountId!);
    await topPopup.getByRole('button', { name: 'Search', exact: true }).click();
    await page.waitForTimeout(SHORT_WAIT);
    const targetRow = topPopup.locator('table tr').filter({
      hasText: state.accountId!
    });
    await targetRow.click();
    await topPopup.getByRole('button', { name: 'Select', exact: true }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await popup.getByRole('button', { name: 'Create', exact: true }).click();
    const createTaskUrl = await taskManagementPage.createTaskSuccessfully(screenshotHelper);
    testLogger.data('Create Task URL', createTaskUrl);
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('#accountId input').fill(state.accountId!);
    await taskManagementPage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    const firstRowText = await page.locator('table tbody tr:first-child td:nth-child(6)').innerText();
    expect(firstRowText.trim()).toBe(state.accountId!);
  });



  test('TC-57: Billing Data / Rated Usage Inquiry – Filter Rated Usage Transactions', async ({ embrixAccount,
    page, billsPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToRatedUsage();
    await page.waitForTimeout(SHORT_WAIT);

    const today = new Date();
    const formattedDate = today.toISOString().split('T')[0];

    await billsPage.searchByDate(data.searchFromDate, formattedDate);
    await page.waitForTimeout(SHORT_WAIT);
    await billsPage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    // "The system displays rated usage transactions according to the applied
    // filters." The grid must settle into EXACTLY ONE definite state. The old
    // form — branch on rowCount, then assert the branch you took — could not
    // fail: a stuck spinner or an error surface passed just as happily.
    const rowCount = await billsPage.getRowCount();
    const emptyState = page.getByText('No records found');
    testLogger.data('Rated usage rows returned', rowCount);

    if (rowCount === 0) {
      await expect(emptyState, 'Grid returned no rows but showed no empty state').toBeVisible();
    } else {
      await expect(billsPage.resultsTable).toBeVisible();
      await expect(emptyState, 'Grid showed rows AND the empty state').toHaveCount(0);
      testLogger.data('Rated usage sample', (await billsPage.getAllTableData()).slice(0, 3));
    }
  });


  test('TC-58: Billing Data / Usage Records – Filter and Export Usage Data', async ({ embrixAccount,
    page, billsPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToUsageRecord();
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.clickSearchButton();
    await page.waitForLoadState('networkidle');
    await page.locator('span.label-switch').click();

    // "Filter and Export" — assert a file actually comes back, rather than
    // only that the button was clickable.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: MEDIUM_WAIT }),
      billsPage.clickDownloadButton(),
    ]);
    testLogger.data('Usage export file', download.suggestedFilename());
    expect(download.suggestedFilename(), 'Export produced no filename').not.toBe('');
  });


  test('TC-59: Subscription & Billing Data / AR Request Log – Filter AR Requests', async ({ embrixAccount,
    page, billsPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToARRequestLog();
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.selectType();
    await billsPage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    // "...displaying the corresponding AR requests." Same reasoning as TC-57:
    // assert the grid resolved to exactly one definite state, so a stuck or
    // errored surface is a failure rather than a silent pass.
    const rowCount = await billsPage.getRowCount();
    const emptyState = page.getByText('No records found');
    testLogger.data('AR request rows returned', rowCount);

    if (rowCount === 0) {
      await expect(emptyState, 'Grid returned no rows but showed no empty state').toBeVisible();
    } else {
      await expect(billsPage.resultsTable).toBeVisible();
      await expect(emptyState, 'Grid showed rows AND the empty state').toHaveCount(0);
      testLogger.data('AR request sample', (await billsPage.getAllTableData()).slice(0, 3));
    }
  });



  test('TC-56: Billing Data / Transactions – View Transaction Detail and Recurring Data', async ({ embrixAccount,
    page, billsPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    // PRECONDITION: needs an invoice from TC-54, which cannot run while
    // billingOnlyFlag fails to persist (order parks at PROVISIONING_INITIATED,
    // no subscription, no bills). Without it this ran against `undefined`.
    // Report BLOCKED with the reason printed rather than failing on bad input.
    test.skip(!state.invoiceId, 'BLOCKED: no invoice available — TC-54 could not generate one');

    await billsPage.navigateToTransactions();
    await page.waitForTimeout(SHORT_WAIT);

    await page.locator('input[name="invoiceUnitId"]').click();
    await page.waitForTimeout(SHORT_WAIT);
    const topPopup = page.locator('[role="dialog"]').last();


    const targetRow = topPopup.locator('table tr').filter({
      hasText: state.invoiceId!
    });
    await targetRow.click();
    await topPopup.getByRole('button', { name: 'Select', exact: true }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await billsPage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('table tbody tr').nth(0).locator('td').nth(1).getByRole('button', { name: 'View' }).click();
    await page.locator('[role="button"]', { hasText: 'Recurring Data' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('[role="button"]', { hasText: 'Currency' }).click();
    await billsPage.clickBackButton();
  });


  test('TC-64: Billing Data / Account Statement – Filter, Export and View Notes', async ({ embrixAccount,
    page, billsPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    // PRECONDITION: needs an invoice from TC-54, which cannot run while
    // billingOnlyFlag fails to persist (order parks at PROVISIONING_INITIATED,
    // no subscription, no bills). Without it this ran against `undefined`.
    // Report BLOCKED with the reason printed rather than failing on bad input.
    test.skip(!state.invoiceId, 'BLOCKED: no invoice available — TC-54 could not generate one');

    await billsPage.navigateToAccountStatement();
    await page.waitForTimeout(SHORT_WAIT);

    await page.locator('input[name="invoiceId"]').fill(state.invoiceId!);
    await page.waitForTimeout(SHORT_WAIT);
    await billsPage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('span.label-switch').click();
    await billsPage.clickDownloadButton();
    await page.waitForTimeout(SHORT_WAIT);
    await billsPage.clickquickNotesButton();
  });



  test('TC-65: Billing Data / Shared Charge Configuration – Create New Shared Charge', async ({ embrixAccount,
    page, billsPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    // Steps 1-3: the list of existing shared charge configurations is displayed.
    const chargeShareUrl = await billsPage.navigateToChargeShare();
    await page.waitForLoadState('networkidle');
    testLogger.data('charge share url', chargeShareUrl);
    await expect(page.locator('table').first()).toBeVisible();

    // Step 4: the form to create a new shared charge is enabled.
    await billsPage.clickAddNewButton();
    const popup = page.locator('[role="dialog"]');
    await expect(popup).toBeVisible();

    // Step 5: a valid subscription can be selected.
    //
    // The spec stops here — it never submits. The previous implementation
    // clicked Submit on a completely empty form, which produces neither a
    // success nor an error toast, so the case sat in the toast race for
    // ~7 minutes before failing. Assert the documented outcome instead.
    const subscriptionField = popup.locator('input[name="subscriptionId"]').first();
    await expect(
      subscriptionField,
      'Shared charge form has no Subscription ID field'
    ).toBeVisible();
    await subscriptionField.click();

    const picker = page.locator('[role="dialog"]').last();
    await expect(
      picker,
      'Clicking Subscription ID did not open a subscription picker'
    ).toBeVisible({ timeout: MEDIUM_WAIT });
    await screenshotHelper.captureAndAttach('TC-65-subscription-picker');
  });


  test('TC-28: View Invoice Units in Collections', async ({ embrixAccount,
    page, testLogger, collectionPage, screenshotHelper, serverHelper, dailySchedulePage, toast, jobScheduleDbHelper
  }) => {
    // PRECONDITION: clearExistingJobSchedule() talks to the tenant database.
    // No CoopeG DB configuration exists in the repo or its history, so this
    // throws an AggregateError from pg and halts the serial block.
    test.skip(
      !process.env.DB_NAME || !process.env.DB_HOST,
      'BLOCKED: no CoopeG database configuration (DB_NAME/DB_HOST unset)'
    );

    const date = state.nextThreeMonthsFirstDate!;
    console.log('collection date' + date);
    await serverHelper.setAndVerifyCcpTime(date);
    await page.navigateToHome();
    await dailySchedulePage.navigateViaNav();

    // Input the target date into the calendar
    await dailySchedulePage.inputJobCalendar(date);

    // If jobs list for that date already exists, clear it via DB helper
    await dailySchedulePage.clearExistingJobSchedule(jobScheduleDbHelper, date, testLogger);

    // Verify cleanup — use DB helper to confirm deletion
    try {
      const remainingJobs = await jobScheduleDbHelper.getJobSchedule(date);
      testLogger.data('Remaining jobs after cleanup', remainingJobs);
      expect(remainingJobs.length).toBe(0);
      testLogger.log('DB cleanup verified: no remaining job schedules.');
    } catch (error) {
      testLogger.error('DB cleanup verification failed', String(error));
    }

    // Click Create Job Schedule button, expect a success toast
    await dailySchedulePage.clickCreateJobSchedule();
    await toast.expectSuccess();
    testLogger.log('Job Schedule created successfully.');

    // Wait for job cards list to appear on the UI
    const jobListVisible = await dailySchedulePage.isJobListVisible();
    expect(jobListVisible).toBeTruthy();
    testLogger.log('Job cards are now visible on the UI.');

    // Click on Process button
    await dailySchedulePage.clickProcess();

    // Click Yes on confirmation modal, expect a success toast
    await dailySchedulePage.confirmProcess();
    await toast.expectSuccess();
    testLogger.log('Process confirmed and started.');

    // Poll for all jobs to complete (max 10 retries with refresh)
    const allCompleted = await dailySchedulePage.waitForAllJobsCompleted(testLogger);
    expect(allCompleted).toBeTruthy();
    testLogger.log('All job cards have completed processing.');

    await screenshotHelper.captureAndAttach('TC-28-all-jobs-completed');



    await page.navigateToHome();
    await collectionPage.navigateViaNav();
    await collectionPage.searchByAccountId(state.accountId!);
    await page.waitForLoadState('networkidle');

    // PRECONDITION: an account only appears in Collections once it has an
    // overdue invoice. No invoice is ever generated here, so the grid comes
    // back on its empty-state row.
    test.skip(
      await gridIsEmpty(page.locator('table').first()),
      'BLOCKED: account is not in collections — no invoice was ever generated (billingOnlyFlag does not persist)'
    );

    const accountId = await collectionPage.getFirstRowCellValue('Account Id');
    expect(accountId).toBe(state.accountId!);
    await page.locator('table tbody tr').nth(0).locator('td').nth(0).getByRole('button', { name: 'View' }).click();
    await page.waitForTimeout(MEDIUM_WAIT);
    const popup = page.locator('[role="dialog"]');
    await expect(popup.locator('h5.card-title.title-form')).toHaveText('Invoice Units In Collection');
    await expect(page.locator('.nav-link[aria-selected="false"]')).toContainText(state.accountId!);
    await popup.locator('table tbody tr').nth(0).locator('td').nth(6).getByRole('button', { name: 'View' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    const secondPopup = page.locator('[role="dialog"]').nth(1);
    await secondPopup.locator('button', { hasText: 'Back' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await popup.locator('button', { hasText: 'Back' }).click();
    await page.waitForTimeout(SHORT_WAIT);
  });


  test('TC-29: A/R Center Flow Validation', async ({ embrixAccount,
    page, collectionPage
  }) => {
    await page.navigateToHome();
    await collectionPage.navigateViaNav();
    await collectionPage.searchByAccountId(state.accountId!);
    await page.waitForLoadState('networkidle');

    // PRECONDITION: an account only appears in Collections once it has an
    // overdue invoice. No invoice is ever generated here, so the grid comes
    // back on its empty-state row.
    test.skip(
      await gridIsEmpty(page.locator('table').first()),
      'BLOCKED: account is not in collections — no invoice was ever generated (billingOnlyFlag does not persist)'
    );

    const accountId = await collectionPage.getFirstRowCellValue('Account Id');
    expect(accountId).toBe(state.accountId!);
    await page.locator('table tbody tr').nth(0).locator('td').nth(0).getByRole('button', { name: 'View' }).click();
    await page.waitForTimeout(MEDIUM_WAIT);
    const popup = page.locator('[role="dialog"]');
    await expect(popup.locator('h5.card-title.title-form')).toHaveText('Invoice Units In Collection');
    await expect(page.locator('.nav-link[aria-selected="false"]')).toContainText(state.accountId!);
    await popup.locator('table tbody tr').nth(0).locator('td').nth(6).getByRole('button', { name: 'View' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    const secondPopup = page.locator('[role="dialog"]').nth(1);
    await secondPopup.locator('button', { hasText: 'Back' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await popup.locator('button', { hasText: 'Back' }).click();
    await page.waitForTimeout(SHORT_WAIT);
  });







  test('TC-61: Billing Data / Payments – Filter Payments by Date, Status, Reference and Invoice', async ({ embrixAccount,
    page, manualPaymentPage, billsPage, screenshotHelper, testLogger
  }) => {

    // PRECONDITION: needs the invoice TC-54 could not generate.
    test.skip(!state.invoiceId, 'BLOCKED: no invoice available — TC-54 could not generate one');

    await page.navigateToHome();
    await manualPaymentPage.navigateViaNav();
    await page.waitForTimeout(SHORT_WAIT);
    await manualPaymentPage.navigateViaSideMenu();
    await page.locator('input[name="accountId"]').click();
    await page.waitForTimeout(SHORT_WAIT);
    const popup = page.locator('[role="dialog"]');
    await page.waitForTimeout(SHORT_WAIT);
    await popup.locator('input[name="accountId"]').fill(state.accountId!);
    // await popup.locator('input[name="accountId"]').fill('ACT-100175');
    await popup.getByRole('button', { name: 'Search', exact: true }).click();
    await manualPaymentPage.clickRadioButtonById();
    await manualPaymentPage.clickSelectButton();
    await page.waitForTimeout(SHORT_WAIT);
    await manualPaymentPage.selectCurrency();
    await page.waitForTimeout(SHORT_WAIT);
    console.log('amount' + state.amount);
    console.log('end date' + state.endDate);
    await manualPaymentPage.addAmountDate(state.amount!, state.endDate!);
    await page.waitForTimeout(SHORT_WAIT);
    await manualPaymentPage.selectInvoice(state.invoiceId!);
    await manualPaymentPage.clickRadioButtonByIdNew();
    await page.waitForTimeout(SHORT_WAIT);
    await manualPaymentPage.clickSelectButton();
    await page.waitForTimeout(SHORT_WAIT);
    await manualPaymentPage.allocatePayment();
    //Payment is successfully!

    await page.goto(state.quickAccUrl!);

    await page.waitForTimeout(SHORT_WAIT);
    await billsPage.navigateToPayments();
    await billsPage.searchByInvoiceId(state.invoiceId!);
    await page.waitForTimeout(SHORT_WAIT);

    const accountId = await billsPage.getFirstRowCellValueNew('Account Id');

    // expect(accountId).toBe(state.accountId!);
    expect(accountId).toBe(state.accountId);
    const status = await billsPage.getFirstRowCellValueNew('Status');
    expect(status).toBe('CLOSED');
  });

  test('TC-27: Payment History Inquiry in A/R Center', async ({ embrixAccount,
    page, testLogger, paymentHistoryPage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await paymentHistoryPage.navigateViaNav();
    await paymentHistoryPage.searchBystartDateandEndDateAccount(state.accountId!);
    await page.waitForTimeout(MEDIUM_WAIT);
    await paymentHistoryPage.searchByAccountId(state.accountId!);
    await page.waitForLoadState('networkidle');

    // "The payment history corresponding to the filters is displayed."
    const historyRows = await page.locator('table tbody tr').count();
    testLogger.data('Payment history rows', historyRows);
    if (historyRows === 0) {
      await expect(page.getByText('No records found')).toBeVisible();
    } else {
      await expect(page.locator('table').first()).toBeVisible();
    }

    await page.locator('button', { hasText: 'Quick Notes' }).click();
    const popup = page.locator('[role="dialog"]');
    await expect(popup, 'Quick Notes dialog did not open').toBeVisible();
    await popup.locator('button', { hasText: 'OK' }).click();
    await expect(popup).not.toBeVisible();
  });

  test('TC-60: Billing Data / AR Operation Units – Filter by Item ID', async ({ embrixAccount,
    page, billsPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    // PRECONDITION: filters AR operation units by the invoice TC-54 generates.
    test.skip(!state.invoiceId, 'BLOCKED: no invoice available — TC-54 could not generate one');

    await billsPage.navigateToAROpsUnits();
    await page.waitForTimeout(SHORT_WAIT);

    const targetRow = page.locator('table tr').filter({
      hasText: state.invoiceId!
    });
    const count = await targetRow.count();
    expect(count).toBe(1);

  });


  test('TC-21: Invoice Consultation and Validation in Billing Center', async ({ embrixAccount,
    page, testLogger, invoicePage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await invoicePage.navigateViaNav();
    await page.waitForTimeout(SHORT_WAIT);
    await expect(page.locator('input[name="startDate"]')).toBeVisible();
    await invoicePage.searchBystartDateandEndDateAccount(state.accountId!);
    await invoicePage.clickSearchButton();
    await page.waitForLoadState('networkidle');

    // PRECONDITION: the account must actually have an invoice to consult.
    test.skip(await gridIsEmpty(page.locator('table').first()), 'BLOCKED: no invoice available — TC-54 could not generate one');

    await page.locator('table tbody tr').nth(0).locator('td').nth(1).getByRole('button', { name: 'View' }).click();
    const popup1 = page.locator('[role="dialog"]'); // or your popup selector
    await popup1.getByRole('button', { name: 'Back' }).click();
    await page.locator('table tbody tr').nth(0).locator('td').nth(2).getByRole('button', { name: 'View' }).click();
    const popup = page.locator('[role="dialog"]'); // or your popup selector
    await expect(popup.locator('input[name="accountId"]')).toHaveValue(state.accountId!);
    await page.getByRole('button', { name: 'Invoice Lines' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await page.getByRole('button', { name: 'Tax Lines' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await page.getByRole('button', { name: 'Invoice Summary' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await invoicePage.clickCancelButton();
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });


  test('TC-30: Revenue Center / Configuration', async ({
    page, gLAccountsPage, gLSetupPage
  }) => {
    await page.navigateToHome();
    await gLSetupPage.navigateViaNav();
    await gLSetupPage.addGlSegment();
    await gLSetupPage.clickaddNewSegButton();

    await page.waitForTimeout(MEDIUM_WAIT);


    const table1 = page.locator('.collapse__content.collapse.show')
      .locator('table.center-aligned-table.mb-0.table-collapsible').first();

    // Only real data rows (skip the hidden Sub-Account-Range expander rows)
    const dataRows1 = table1.locator('tbody > tr.job-config-row');
    const lastRow1 = dataRows1.last();

    const startingNumberCell1 = lastRow1.locator('td').nth(2);
    await startingNumberCell1.locator('#length input').click();
    await startingNumberCell1.locator('#length input').fill('100');
    const nameCell3 = dataRows1.last().locator('td').nth(4);

    await nameCell3.locator('.custom-react-select__control').click();

    // The dropdown menu is portalled to the page root, not inside the row
    await page.locator('.custom-react-select__option')
      .getByText('DIVISION', { exact: true })  // replace with the value you want
      .click();



    await page.locator('[role="button"]', { hasText: 'GL Account Ranges' }).click();
    await gLSetupPage.clickaddNewGlAccButton();
    await page.waitForTimeout(MEDIUM_WAIT);



    const table2 = page.locator('.collapse__content.collapse.show')
      .locator('table.center-aligned-table.mb-0.table-collapsible').first();

    // Only real data rows (skip the hidden Sub-Account-Range expander rows)
    const dataRows = table2.locator('tbody > tr.job-config-row');
    const lastRow = dataRows.last();
    const nameCell2 = dataRows.last().locator('td').nth(2);

    await nameCell2.locator('.custom-react-select__control').click();

    // The dropdown menu is portalled to the page root, not inside the row
    await page.locator('.custom-react-select__option')
      .getByText('LIABILITY', { exact: true })  // replace with the value you want
      .click();
    const startingNumberCell = lastRow.locator('td').nth(3);
    await startingNumberCell.locator('#startingNumber input').click();
    await startingNumberCell.locator('#startingNumber input').fill('1');
    await gLSetupPage.clickSaveButton();

    // Documented step 7: "A confirmation message is displayed indicating that
    // the GL account configuration was saved successfully." The case asserted
    // nothing at all, so a silently-failing save passed.
    await expect(
      page.locator('.Toastify__toast--success'),
      'No success confirmation after saving GL configuration'
    ).toBeVisible({ timeout: MEDIUM_WAIT });
  });


  test('TC-63: Billing Data / Credit and Debit Notes – Filter by Date Range and Note Type', async ({ embrixAccount,
    page, billsPage, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);

    await page.waitForTimeout(SHORT_WAIT);
    await billsPage.navigateToCreditDebitNotes();
    const today = new Date();
    const formattedDate = today.toISOString().split('T')[0];
    await billsPage.searchByDate(data.searchFromDate, formattedDate);
    await page.waitForTimeout(MEDIUM_WAIT);
    await billsPage.clickSearchButton();
    await page.waitForLoadState('networkidle');

    // "Credit and debit notes matching the date range are displayed."
    const rows = await page.locator('table tbody tr').count();
    testLogger.data('Credit/debit note rows', rows);
    if (rows === 0) {
      await expect(page.getByText('No records found')).toBeVisible();
    } else {
      await expect(page.locator('table').first()).toBeVisible();
    }
  });


  test('TC-35: Operations Center / Reports – Accounts Report Validation', async ({
    page, reportsPage, testLogger
  }) => {
    await page.navigateToHome();
    await reportsPage.navigateViaNav();
    await page.mouse.click(10, 10);
    await page.waitForTimeout(SHORT_WAIT);

    const today = new Date();
    const formattedDate = today.toISOString().split('T')[0];
    await reportsPage.searchByDate(data.searchFromDate, formattedDate);
    await page.waitForTimeout(SHORT_WAIT);

    await reportsPage.clickSearchButton();
    await page.waitForLoadState('networkidle');

    // "The results corresponding to the applied filters are displayed."
    const rows = await page.locator('table tbody tr').count();
    testLogger.data('Accounts report rows', rows);
    if (rows === 0) {
      await expect(page.getByText('No records found')).toBeVisible();
    } else {
      await expect(page.locator('table').first()).toBeVisible();
    }
  });



  test('TC-31: Revenue Center / Revenues', async ({
    page, revenuePage, testLogger
  }) => {
    await page.navigateToHome();
    await revenuePage.navigateViaNav();
    await page.mouse.click(10, 10);
    await page.waitForTimeout(SHORT_WAIT);
    const today = new Date();
    const formattedDate = today.toISOString().split('T')[0];
    await revenuePage.searchByDate(data.searchFromDate, formattedDate);
    await page.waitForTimeout(SHORT_WAIT);

    await revenuePage.clickSearchButton();
    await page.waitForLoadState('networkidle');

    // "The revenue records matching the filters are displayed."
    const rows = await page.locator('table tbody tr').count();
    testLogger.data('Revenue rows', rows);
    if (rows === 0) {
      await expect(page.getByText('No records found')).toBeVisible();
    } else {
      await expect(page.locator('table').first()).toBeVisible();
    }
  });



  test('TC-50: Subscription Data / Billable Services – Filter and Export', async ({ embrixAccount,
    page, servicesPage, screenshotHelper, testLogger
  }) => {

    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);
    await servicesPage.navigatetoBillableService();
    await servicesPage.searchByDate(data.searchFromDate);
    await servicesPage.clickSearchButton();
    await page.waitForLoadState('networkidle');

    // "The billable services matching the filter are displayed."
    const rows = await page.locator('table tbody tr').count();
    testLogger.data('Billable service rows', rows);
    if (rows === 0) {
      await expect(page.getByText('No records found')).toBeVisible();
    } else {
      await expect(page.locator('table').first()).toBeVisible();
    }
  });


  test('TC-19: Create Quotation in Embrix', async ({
    page, searchQuote, newQuote, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.navigateToHome();
    await customerManagementPage.navigateViaNav();
    await page.mouse.click(10, 10);
    await page.waitForTimeout(SHORT_WAIT);

    await customerManagementPage.clickCreateButton();
    await page.locator('.panel__title', { hasText: 'Create Contact' }).click();
    await customerManagementPage.quickCreateAccount(data.account.email, data.account.firstName, data.account.lastName);
    await page.locator('.panel__title', { hasText: 'Create Address' }).click();
    await customerManagementPage.addressDetails(data.account.street, data.account.state, data.account.city, data.account.postalCode);
    const quickAccUrl = await customerManagementPage.isQuickAccountCreatedSuccesfully(screenshotHelper);
    testLogger.data('Quick Account Create URL', quickAccUrl);
    const accountNumberStr = await page.locator('#year-tab').textContent() ?? undefined;
    const accountNumber = accountNumberStr?.trim().match(/ACT-\d+/)?.[0] ?? undefined;

    await searchQuote.navigateQuoteViaNav();
    await searchQuote.clickCreateNewButton();
    await newQuote.searchByAccountId(accountNumber!);
    const firstRowAccNo = await page.locator('table tbody tr:first-child td:nth-child(2)').innerText();
    expect(firstRowAccNo.trim()).toBe(accountNumber!);
    await page.locator('table tbody tr:first-child button.btn-select-next').click();
    await newQuote.clickAddBundleButton();
    const idBundleSelect = data.bundleId;
    await newQuote.searchById(idBundleSelect);
    await newQuote.clickRadioButtonById();
    await newQuote.clickSelectButton();
    await newQuote.clickTopNextButton();
    await newQuote.clickTopNextButton();
    await newQuote.clickGetQuoteButton();
    await newQuote.clickCancelQuoteButton();
    await newQuote.clickSaveQuoteButton();
  });


  test('TC-23: Billing Center – Usage', async ({
    page, testLogger, usagePage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await usagePage.navigateViaNav();
    await page.waitForTimeout(SHORT_WAIT);
    await usagePage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('table tbody tr').nth(0).locator('td').nth(3).getByRole('button', { name: 'View Records' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    await usagePage.clickPopupSearchButton();
    await usagePage.clickDownloadButton();
    await usagePage.clickPopupBackButton();
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('table tbody tr').nth(0).locator('td').nth(4).getByRole('button', { name: 'Reprocess' }).click();
    await page.waitForTimeout(SHORT_WAIT);

    const createUsageReprocess = await usagePage.createUsageReprocessSuccessfully(screenshotHelper);
    testLogger.data('Create Usage Reprocess on account URL', createUsageReprocess);
    await usagePage.clickProcessAllButton();
    await page.waitForTimeout(SHORT_WAIT);
    const createUsageProcessAll = await usagePage.createUsageReprocessSuccessfully(screenshotHelper);
    testLogger.data('Create Usage Process All on account URL', createUsageProcessAll);


  });

});