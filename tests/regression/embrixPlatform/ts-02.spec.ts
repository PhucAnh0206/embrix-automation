/**
 * Tags: @regression
 * Tags: @embrixPlatform
 *
 * Serial test suite: each TC depends on data created by the previous one.
 * Shared state is held in a mutable object at suite level and also persisted
 * to `playwright/.auth/test-context.json` via `updateTestContext()`.
 */

import { test, expect } from '../../../fixtures/page-factory';
import { MEDIUM_WAIT, EXTRA_LONG_WAIT, LONG_WAIT, SHORT_WAIT } from '../../../helpers/timeouts.helper';
import { updateTestContext } from '../../../helpers/test-context.helper';

// Shared mutable state across serial tests
interface SuiteState {
  quickAccUrl: string;
  accountId: string;
  orderId: string;
  invoiceId: string;
}

const state: Partial<SuiteState> = {};

test.describe.serial('REGRESSION: Test Suite - 02', () => {

  /*
  test('TC-18: Create Account in Embrix', async ({
    page, testLogger, customerManagementPage, orderManagementPage, createOrderPage, screenshotHelper, servicesPage
  }) => {
    await page.navigateToHome();
    await customerManagementPage.navigateViaNav();
    await customerManagementPage.clickCreateButton();
    await page.locator('.panel__title', { hasText: 'Create Contact' }).click();

    await customerManagementPage.quickCreateAccount('lisalog2026@gmail.com', 'Lisa', 'Nuevo');
    await page.locator('.panel__title', { hasText: 'Create Address' }).click();
    await customerManagementPage.addressDetails('CallePrincipal', 'Alajuela', 'Grecia', '102333');

    const quickAccUrl = await customerManagementPage.isQuickAccountCreatedSuccesfully(screenshotHelper);
    testLogger.data('Quick Account Create URL', quickAccUrl);

    const accountNumber = await page.locator('#year-tab').textContent() ?? undefined;

    updateTestContext({ quickAccUrl });
    state.quickAccUrl = quickAccUrl;

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

    const alaCrteSelect = "PO_FR";
    await createOrderPage.searchByName(alaCrteSelect);
    await createOrderPage.clickRadioButtonById();
    await createOrderPage.clickSelectButton();
    await createOrderPage.clickBottomNextButton();
    await expect(page.locator('h5.card-title.title-form.font-weight-normal')).toHaveText('Service Type: INTERNET');
    await page.waitForTimeout(SHORT_WAIT);
    await createOrderPage.clickTopNextButton();
    await page.locator('input[name="billingOnlyFlag"]').click({ force: true });
    await createOrderPage.clickCreateButton();
    await page.waitForTimeout(SHORT_WAIT);

    const incompleteOrderId = await servicesPage.getInCompleteOrdersFirstRowCellValue('Id');
    updateTestContext({ incompleteOrderId });
    state.orderId = incompleteOrderId;
    console.log(incompleteOrderId);
  });

  test('TC-20: Send Existing Order from Order Management', async ({
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

 
  test('TC-24: Pricing Center – Basic Configurations (Currency)', async ({
    page, testLogger, currencyPage, screenshotHelper,
  }) => {
    await page.navigateToHome();
    await currencyPage.navigateViaNav();
    await currencyPage.clickAddCurrencyButton();
    await currencyPage.table.selectCellOption(0, 'Currency Id', 'Euro (EUR)');
    await currencyPage.table.fillCellInput(0, 'Name', 'TC-24');
    await currencyPage.table.selectCellOption(0, 'Rounding Method', 'HALF_UP');
    await currencyPage.table.selectCellOption(0, 'Currency Id', 'British Pound Sterling (GBP)');
    await currencyPage.table.selectCellOption(0, 'Rounding Method', 'HALF_DOWN');
    await currencyPage.table.fillCellInput(0, 'Rounding Precision', '2');
    await currencyPage.clickModifyButton();
    const currencyUrl = await currencyPage.createCurrencySuccessfully(screenshotHelper);
    testLogger.data('currencyUrl', currencyUrl);
    updateTestContext({ currencyUrl });
 
  });
 
  test('TC-25: Pricing Center – Price Management (Product Family)', async ({
    page, testLogger, productFamilyPage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await productFamilyPage.navigateViaNav();
    await page.waitForTimeout(SHORT_WAIT);
    await productFamilyPage.clickAddNewProductButton();
    await productFamilyPage.table.fillCellInput(0, 'Product Company', '080');
    await productFamilyPage.table.fillCellInput(0, 'Product Family', 'Communications');
    await productFamilyPage.table.selectCellOption(0, 'Product Line', '03-Information Services');
    await productFamilyPage.table.selectCellOption(0, 'Product Type', 'prueba');
    await productFamilyPage.table.selectCellOption(0, 'Product Sub Type', 'NONE');
    await productFamilyPage.clickModifyButton();
    const productFamilyUrl = await productFamilyPage.createProductFamilySuccessfully(screenshotHelper);
    testLogger.data('productFamilyUrl', productFamilyUrl);
    updateTestContext({ productFamilyUrl });
  });
 
 
  test('TC-21: Invoice Consultation and Validation in Billing Center', async ({
    page, testLogger, invoicePage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await invoicePage.navigateViaNav();
    await page.waitForTimeout(SHORT_WAIT);
    await expect(page.locator('input[name="startDate"]')).toBeVisible();
    await invoicePage.searchBystartDateandEndDateAccount(state.accountId!);
    await invoicePage.clickSearchButton();
    await page.waitForTimeout(MEDIUM_WAIT);
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
    await page.locator('input[name="id"]').fill('TelconectService');
    await bundlePage.clickSearchButton();
    const firstRowText = await page.locator('table tbody tr:first-child td:nth-child(1)').innerText();
    expect(firstRowText.trim()).toBe('TelconectService');
  });
 
  test('TC-28: View Invoice Units in Collections', async ({
    page, testLogger, collectionPage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await collectionPage.navigateViaNav();
    await collectionPage.searchByAccountId(state.accountId!);
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
 
  test('TC-27: Payment History Inquiry in A/R Center', async ({
    page, testLogger, paymentHistoryPage, screenshotHelper
  }) => {
    await page.navigateToHome();
    await paymentHistoryPage.navigateViaNav();
    await paymentHistoryPage.searchBystartDateandEndDateAccount(state.accountId!);
    await page.waitForTimeout(MEDIUM_WAIT);
    await paymentHistoryPage.searchByAccountId(state.accountId!);
    await page.locator('button', { hasText: 'Quick Notes' }).click();
    await page.waitForTimeout(SHORT_WAIT);
    const popup = page.locator('[role="dialog"]');
    await popup.locator('button', { hasText: 'OK' }).click();
    await page.waitForTimeout(SHORT_WAIT);
  });
 
 
  test('TC-19: Create Quotation in Embrix', async ({
    page, searchQuote, newQuote, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.navigateToHome();
    await customerManagementPage.navigateViaNav();
    await customerManagementPage.clickCreateButton();
    await page.locator('.panel__title', { hasText: 'Create Contact' }).click();
    await customerManagementPage.quickCreateAccount('lisalog2026@gmail.com', 'Lisa', 'Nuevo');
    await page.locator('.panel__title', { hasText: 'Create Address' }).click();
    await customerManagementPage.addressDetails('CallePrincipal', 'Alajuela', 'Grecia', '102333');
    const quickAccUrl = await customerManagementPage.isQuickAccountCreatedSuccesfully(screenshotHelper);
    testLogger.data('Quick Account Create URL', quickAccUrl);
    const accountNumber = await page.locator('#year-tab').textContent() ?? undefined;
    await searchQuote.navigateQuoteViaNav();
    await searchQuote.clickCreateNewButton();
    await newQuote.searchByAccountId(accountNumber!);
    const firstRowAccNo = await page.locator('table tbody tr:first-child td:nth-child(2)').innerText();
    expect(firstRowAccNo.trim()).toBe(accountNumber!);
    await page.locator('table tbody tr:first-child button.btn-select-next').click();
    await newQuote.clickAddBundleButton();
    const idBundleSelect = "TelconectService";
    await newQuote.searchById(idBundleSelect);
    await newQuote.clickRadioButtonById();
    await newQuote.clickSelectButton();
    await newQuote.clickTopNextButton();
    await newQuote.clickTopNextButton();
    await newQuote.clickGetQuoteButton();
    await newQuote.clickCancelQuoteButton();
    await newQuote.clickSaveQuoteButton();
  });
 
 
  test('TC-29: A/R Center Flow Validation', async ({
    page, collectionPage
  }) => {
    await page.navigateToHome();
    await collectionPage.navigateViaNav();
    await collectionPage.searchByAccountId(state.accountId!);
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
 
  test('TC-30: Revenue Center / Configuration', async ({
    page, gLAccountsPage, gLSetupPage
  }) => {
    await page.navigateToHome();
    await gLSetupPage.navigateViaNav();
  });
 
  test('TC-38: Account Data / Account Information – Customer Segment Modification', async ({
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
  });
 
 
  test('TC-39: Account Data / Contact – Contact Modification and Creation', async ({
    page, accountInfoPage, contactPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    console.log(state.quickAccUrl!);
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle')
    await contactPage.navigateToContactActivity();
    await contactPage.clickAddNewContact();
    await contactPage.addContactDetails();
    await page.waitForTimeout(SHORT_WAIT);
    const modifycontact = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify contact on account URL', modifycontact);
 
  });
 
 
  test('TC-40: Account Data / Addresses – Address Creation and Modification', async ({
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle')
    await accountInfoPage.navigateToAddresses();
    await accountInfoPage.clickAddNewAddress();
    await accountInfoPage.addressDetails('Principal', 'Alajuela', 'Grecia', '102339');
    await page.waitForTimeout(SHORT_WAIT);
    const modifyAddress = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify Address on account URL', modifyAddress);
  });
 
  test('TC-42: Account Data / Billing Profile – Annual Billing Modification', async ({
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);
    await page.waitForLoadState('networkidle')
    await accountInfoPage.navigateToBillingProfile();
    await accountInfoPage.changeBillingFrequency();
    await page.waitForTimeout(SHORT_WAIT);
    const modifyBillingProfile = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify Billing Profile on account URL', modifyBillingProfile);
  });
 
  test('TC-43: Account Data / Custom Attributes & Tax Exemptions – Configuration and Modification', async ({
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);
    await accountInfoPage.navigateToTaxExemptions();
    await accountInfoPage.addNewTaxExemption();
    await accountInfoPage.activityTable.selectCellOption(0, 'Level', 'STATE');
    await accountInfoPage.clickSave();
    const modifyTaxExemption = await customerManagementPage.accountModifySuccessfully(screenshotHelper);
    testLogger.data('Modify TaxExemptions on account URL', modifyTaxExemption);
  });
 
  test('TC-44: Account Data / Hierarchy – Move Account to Parent Hierarchy', async ({
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
    await page.navigateToHome();
    await customerManagementPage.navigateViaNav();
    await customerManagementPage.clickCreateButton();
    await page.locator('.panel__title', { hasText: 'Create Contact' }).click();
 
    await customerManagementPage.quickCreateAccount('lisalog2026@gmail.com', 'Lisa', 'Nuevo');
    await page.locator('.panel__title', { hasText: 'Create Address' }).click();
    await customerManagementPage.addressDetails('CallePrincipal', 'Alajuela', 'Grecia', '102333');
    const accountNumber = await page.locator('#year-tab').textContent() ?? undefined;
    const trimAccount = accountNumber?.trim().match(/ACT-\d+/)?.[0] ?? undefined!;
    // const accountNumber = '100123';
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100101/info');
    //await page.goto(state.quickAccUrl!);
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
    await page.goto('https://core-ui.congero.embrix.org/customers/' + trimAccount + '/info');
    await accountInfoPage.navigateToHierarchy();
    const rowAccId = await accountInfoPage.getFirstRowCellValue('ACCT No');
    expect(state.accountId!).toBe(rowAccId);
 
  });
 
 
  test('TC-45: Account Data / Tasks – Installment Payment Plan Creation', async ({
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
 
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100115/info');
    //await page.goto(state.quickAccUrl!);
    await accountInfoPage.navigateToPaymentInstallment();
    await accountInfoPage.clickAddInstallmemtButton();
    await accountInfoPage.clickbuttontoExpand();
    await accountInfoPage.clickSaveConfig();
 
    const createPaymentInstallation = await accountInfoPage.createPaymentInstallmentSuccessfully(screenshotHelper);
    testLogger.data('Create Payment Installation on account URL', createPaymentInstallation);
 
  });
 
  test('TC-46: Account Data / Exchange Rates – External Purchase Order Configuration', async ({
    page, accountInfoPage, customerManagementPage, screenshotHelper, testLogger
  }) => {
 
    await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);
 
    await accountInfoPage.navigateToXchangeRates();
    await accountInfoPage.clickAddNewXchangeButton();
    await accountInfoPage.activityTable.selectCellOption(0, 'Xchange Currency', 'USD (USD)');
    await accountInfoPage.clickSaveConfig();
    const createPaymentInstallation = await accountInfoPage.createPaymentInstallmentSuccessfully(screenshotHelper);
    testLogger.data('Create Payment Installation on account URL', createPaymentInstallation);
 
  });
 
  test('TC-47: Subscription Data / Subscription View – Active Subscription Detail', async ({
    page, servicesPage, screenshotHelper, testLogger
  }) => {
    await page.goto(state.quickAccUrl!);
    await servicesPage.navigateSubscriptionView();
    await page.waitForTimeout(SHORT_WAIT);
    const accountGroup = page.locator('.family-chart-group')
      .filter({ has: page.locator('.title', { hasText: 'Account' }) });
 
    const idBlock = accountGroup.locator('.col-md-12.row')
      .filter({ has: page.locator('.title-description', { hasText: 'Id:' }) });
 
    await expect(idBlock.locator('.description-content')).toHaveText('ACT-100101');
    const subscriptionGroup = page.locator('.family-chart-group')
      .filter({ has: page.locator('.title', { hasText: 'Subscription', exact: true }) })
      .first();
 
    await subscriptionGroup.locator('.description .col-md-12.row').first().click();
    await page.waitForTimeout(SHORT_WAIT);
    await expect(page.locator('input[name="accountId"]')).toHaveValue('ACT-100101');
    await page.waitForTimeout(SHORT_WAIT);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const serviceUnitGroup = page.locator('.family-chart-group')
      .filter({ has: page.locator('.title', { hasText: 'Service Units', exact: true }) })
      .first();
 
    await serviceUnitGroup.locator('.description .col-md-12.row').first().click();
    const popup = page.locator('[role="dialog"]'); // or your popup selector
    await popup.waitFor({ state: 'visible' });
 
    await page.waitForTimeout(SHORT_WAIT);
    await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
    const priceUnitGroup = page.locator('.family-chart-group')
      .filter({ has: page.locator('.title', { hasText: 'Price Unit', exact: true }) })
      .first();
 
    await priceUnitGroup.locator('.description .col-md-12.row').first().click();
 
    await popup.waitFor({ state: 'visible' });
 
    await page.waitForTimeout(SHORT_WAIT);
    await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
 
  test('TC-49: Subscription Data / Offers – Filter Active Offers', async ({
    page, servicesPage, accountInfoPage, screenshotHelper, testLogger
  }) => {
    //await page.goto(state.quickAccUrl!);
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100101/info');
    await servicesPage.navigateToOffers();
    await page.waitForTimeout(SHORT_WAIT);
 
    const statusGroup = page.locator('div.form-group.select-group', { hasText: 'Status' });
    await statusGroup.locator('.custom-react-select__control').click();
 
    await page.locator('.custom-react-select__option')
      .filter({ hasText: 'ACTIVE' })
      .first()
      .click();
    await servicesPage.clickSearchButton();
    const accountId = await accountInfoPage.getFirstRowCellValue('Account Id');
    // expect(accountId).toBe(state.accountId!);
    expect(accountId).toBe('ACT-100101');
 
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

  */
  test('TC-54: Billing Data / Invoice Management – View and Manage Invoices', async ({
    page, billsPage, screenshotHelper, testLogger
  }) => {
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100135/info');
    // await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToBills();
    await page.waitForTimeout(SHORT_WAIT);
    /*  await billsPage.clickBillPendingButton();
      const popup = page.locator('[role="dialog"]'); // or your popup selector
      await popup.waitFor({ state: 'visible' });
  
      await page.waitForTimeout(SHORT_WAIT);
      await popup.getByRole('button', { name: 'Process', exact: true }).click();
      */
    await billsPage.clickRadioButtonById();
    const invoiceGroup = page.locator('div.form-group.select-group', { hasText: 'Action' });
    await invoiceGroup.locator('.custom-react-select__control').click();

    await page.locator('.custom-react-select__option')
      .filter({ hasText: 'GENERATE_INVOICE' })
      .first()
      .click();
  });

  /*
    test('TC-53: Billing Data / Subscription Balance Inquiry – View Subscription Balances', async ({
      page, accountInfoPage, billsPage, screenshotHelper, testLogger
    }) => {
  
      await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100129/info');
      // await page.goto(state.quickAccUrl!);
      await page.waitForTimeout(SHORT_WAIT);
      const value = await page.locator('.m-b-0[style*="color: rgb(62, 193, 211)"]').innerText();
  
      await billsPage.navigateToBalance();
      await page.waitForTimeout(SHORT_WAIT);
      const firstTable = page.locator('table.center-aligned-table.mb-0').first();
      const amountValue = await firstTable.locator('tbody tr').nth(0).locator('td').nth(1).innerText();
  
      expect(amountValue.trim()).toBe(value.trim());
      testLogger.data('Billing data balance', amountValue);
  
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
  
      await page.waitForTimeout(SHORT_WAIT);
      await userManagementPage.searchUser();
      const modifyUserUrl = await userManagementPage.modifyUserSuccessfully(screenshotHelper);
      testLogger.data('Modify User URL', modifyUserUrl);
  
  
    });
  
  
  
    test('TC-34: Operations Center / Correspondence – Template Configuration and Download Validation', async ({
      page, corrspondencePage, screenshotHelper, testLogger
    }) => {
      await page.navigateToHome();
      await corrspondencePage.navigateViaNav();
      await page.waitForTimeout(SHORT_WAIT);
      await page.locator('table tbody tr').nth(0).locator('td').nth(5).getByRole('button', { name: 'View' }).click();
      await page.waitForTimeout(SHORT_WAIT);
      const popup = page.locator('[role="dialog"]'); // or your popup selector
      await popup.waitFor({ state: 'visible' });
  
      await page.waitForTimeout(SHORT_WAIT);
      await popup.getByRole('button', { name: 'Download', exact: true }).click();
  
      await page.waitForTimeout(SHORT_WAIT);
      await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  
    });
  
  
  
    test('TC-37: Operations Center / Task Administration – Successful Task Creation', async ({
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



  test('TC-37: Operations Center / Task Administration – Successful Task Creation', async ({
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
    

  test('TC-57: Billing Data / Rated Usage Inquiry – Filter Rated Usage Transactions', async ({
    page, billsPage, screenshotHelper, testLogger
  }) => {
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100129/info');
    // await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToRatedUsage();
    await page.waitForTimeout(SHORT_WAIT);

    const today = new Date();
    const formattedDate = today.toISOString().split('T')[0];

    billsPage.searchByDate('2025-06-01', formattedDate);
    await page.waitForTimeout(SHORT_WAIT);
    billsPage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    const rowCount = await billsPage.getRowCount();
    console.log(rowCount);
    if (rowCount === 0) {
      await expect(page.getByText('No records found')).toBeVisible();

    } else {
      // Verify table has records and validate data
      await expect(billsPage.resultsTable).toBeVisible();
      expect(rowCount).toBeGreaterThan(0);

      const tableData = await billsPage.getAllTableData();
      console.log('Records found:', tableData);
      // add further row-level assertions here if needed
    }

  });

  
    test('TC-58: Billing Data / Usage Records – Filter and Export Usage Data', async ({
      page, billsPage, screenshotHelper, testLogger
    }) => {
      await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100129/info');
      // await page.goto(state.quickAccUrl!);
      await page.waitForTimeout(SHORT_WAIT);
  
      await billsPage.navigateToUsageRecord();
      await page.waitForTimeout(SHORT_WAIT);
  
      await billsPage.clickSearchButton();
      await page.waitForTimeout(SHORT_WAIT);
      await page.locator('span.label-switch').click();
      await billsPage.clickDownloadButton();
    });
   

  test('TC-59: Subscription & Billing Data / AR Request Log – Filter AR Requests', async ({
    page, billsPage, screenshotHelper, testLogger
  }) => {
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100129/info');
    // await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToARRequestLog();
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.selectType();
    await billsPage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    const rowCount = await billsPage.getRowCount();
    console.log(rowCount);
    if (rowCount === 0) {
      await expect(page.getByText('No records found')).toBeVisible();

    } else {
      // Verify table has records and validate data
      await expect(billsPage.resultsTable).toBeVisible();
      expect(rowCount).toBeGreaterThan(0);

      const tableData = await billsPage.getAllTableData();
      console.log('Records found:', tableData);
      // add further row-level assertions here if needed


    }

  });
 
  test('TC-60: Billing Data / AR Operation Units – Filter by Item ID', async ({
    page, billsPage, screenshotHelper, testLogger
  }) => {
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100101/info');
    // await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToAROpsUnits();
    await page.waitForTimeout(SHORT_WAIT);
    state.invoiceId = 'INV-100115';


    const targetRow = page.locator('table tr').filter({
      hasText: state.invoiceId!
    });
    const count = await targetRow.count();
    expect(count).toBe(1);

  });

  
  test('TC-56: Billing Data / Transactions – View Transaction Detail and Recurring Data', async ({
    page, billsPage, screenshotHelper, testLogger
  }) => {
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100101/info');
    // await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToTransactions();
    await page.waitForTimeout(SHORT_WAIT);
    state.invoiceId = 'INV-100115';

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


  test('TC-64: Billing Data / Account Statement – Filter, Export and View Notes', async ({
    page, billsPage, screenshotHelper, testLogger
  }) => {
    await page.goto('https://core-ui.congero.embrix.org/customers/ACT-100101/info');
    // await page.goto(state.quickAccUrl!);
    await page.waitForTimeout(SHORT_WAIT);

    await billsPage.navigateToAccountStatement();
    await page.waitForTimeout(SHORT_WAIT);
    state.invoiceId = 'INV-100115';
    await page.locator('input[name="invoiceId"]').fill(state.invoiceId!);
    await page.waitForTimeout(SHORT_WAIT);
    await billsPage.clickSearchButton();
    await page.waitForTimeout(SHORT_WAIT);
    await page.locator('span.label-switch').click();
    await billsPage.clickDownloadButton();
    await page.waitForTimeout(SHORT_WAIT);
    await billsPage.clickquickNotesButton();
  });
  */
});