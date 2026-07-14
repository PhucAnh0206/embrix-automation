import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../../../base.page';
import { test, expect } from '../../../../../fixtures/page-factory';
import { SHORT_WAIT, LONG_WAIT, MEDIUM_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../../../helpers/timeouts.helper';
import { AccountDetailsSidebar } from '../account-details-sidebar';
import { TableComponent } from '../../../../components/table.component';
import { ToastComponent } from '../../../../components/toast.component';
import { ScreenshotHelper } from '../../../../../helpers/screenshot.helper';
/**
 * AccountInfoPage — Page Object for the Account Info / Detail screen.
 *
 * Accessed via: Clicking an account number in Customer Management search results.
 */
export class AccountInfoPage extends BasePage {
  readonly sidebar: AccountDetailsSidebar;
  readonly activityTable: TableComponent;
  readonly popup: Locator;
  readonly toastComponent: ToastComponent;

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.sidebar = new AccountDetailsSidebar(page);
    this.toastComponent = new ToastComponent(page);
    this.popup = page.locator('[role="dialog"]').last(); // or your popup selector
    this.activityTable = new TableComponent(this.page, this.page.locator('table').first());
  }

  /** The dialog modal element containing Customer Activity details. */
  private get activityModal() { return this.page.locator('//div[@role="dialog"]') }

  /** The request JSON payload textarea inside the activity details modal. */
  private get activityRequest() { return this.activityModal.locator('//textarea[@name="request"]') }

  /** The confirmation OK button inside the activity details modal. */
  private get closeActivityModalButton() { return this.activityModal.locator("//button[text()='OK']") }
  private get createNewOrderButton() { return this.page.getByRole('link', { name: 'Create new order', exact: true }); }

  private get addNewAddress() { return this.page.getByRole('button', { name: 'Add new address', exact: true }); }

  private get streetInput() { return this.popup.locator('textarea[name="street"]').nth(0); }
  private get addAddress() { return this.popup.getByRole('button', { name: 'Add new address', exact: true }); }
  private get modifyButton() { return this.page.getByRole('button', { name: 'Modify', exact: true }); }
  private get yesButton() { return this.popup.getByRole('button', { name: 'Yes', exact: true }); }
  private get codigoInput() { return this.page.locator(`//input[@name='codigoActividadReceptor']`).first(); }
  private get addNewButton() { return this.page.getByRole('button', { name: '+Add New', exact: true }); }
  private get saveButton() { return this.page.getByRole('button', { name: 'Save', exact: true }); }
  private get selectButton() { return this.popup.getByRole('button', { name: 'Select', exact: true }); }
  private get submitButton() { return this.popup.getByRole('button', { name: 'Submit', exact: true }); }
  private get addNewInstallButton() { return this.page.getByRole('button', { name: '+Add New Installment Plan', exact: true }); }
  private get addNewExchangeButton() { return this.page.getByRole('button', { name: '+Add New Xchange Rate', exact: true }); }

  private get addNewRowButton() { return this.page.getByRole('button', { name: '+Add New Row', exact: true }); }
  private get saveConfigButton() { return this.page.getByRole('button', { name: 'Save config', exact: true }); }

  /**
   * Navigate to Customer Activity via sidebar.
   */
  async navigateToCustomerActivity(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'Customer Activity');
  }

  /** Click the CLEAR button on the Customer Activity screen. */
  async clickClearButton(): Promise<void> {
    const clearBtn = this.page.getByRole('button', { name: /CLEAR/i }).first();
    await clearBtn.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await clearBtn.click();
  }

  /** Click the SEARCH button on the Customer Activity screen. */
  async clickSearchButton(): Promise<void> {
    const searchBtn = this.page.getByRole('button', { name: /SEARCH/i }).first();
    await searchBtn.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
    await this.activityTable.rows.first().waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  async clickCreateNewOrderButton(): Promise<void> {
    await this.createNewOrderButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }
  /**
   * Find the row with a specific Api Name value and click its View button.
   * @param apiName The Api Name to search for (e.g. "UPDATE_WORK_ORDER")
   */
  async clickViewByApiName(apiName: string): Promise<void> {
    await this.activityTable.clickCellLinkByMatch('Api Name', apiName, 'View');

    // Assert modal title "Customer Activity"
    const modal = this.page.locator('[class*="modal"], [role="dialog"]').filter({ hasText: /Customer Activity/i }).first();
    await modal.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
   * Find the LAST row with a specific Api Name value and click its View button.
   * @param apiName The Api Name to search for (e.g. "UPDATE_WORK_ORDER")
   */
  async clickViewByLastApiName(apiName: string): Promise<void> {
    const tblLocator = this.page.locator('table').first();
    const tableComponent = new TableComponent(this.page, tblLocator);
    const lastRowIndex = await tableComponent.findLastRowIndex('Api Name', apiName);
    await tableComponent.clickCellLink(lastRowIndex, 'View');

    await this.activityModal.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
   * Get the content of the Request textarea inside the Customer Activity modal.
   */
  async getModalRequestContent(): Promise<string> {
    await this.activityRequest.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    return (await this.activityRequest.inputValue()).trim();
  }

  /**
   * Polls Customer Activity to verify that the request content for a specific API contains the expected status.
   * 
   * @param activityName - The activity name to view (e.g., 'UPDATE_WORK_ORDER')
   * @param expectedSubstrings - One or more substrings to check in the request content (e.g., '"status":"FINALIZADO"')
   * @param testLogger - Optional logger for reporting progress
   * @returns The request content string if successful, throws error if timed out
   */
  async waitForActivityRequestContent(
    activityName: string,
    expectedSubstrings: string | string[],
    testLogger?: any
  ): Promise<string> {
    const maxRetries = 10;
    let requestContent = '';
    const substrings = Array.isArray(expectedSubstrings) ? expectedSubstrings : [expectedSubstrings];

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.clickSearchButton();
        await this.page.waitForLoadingToDisappear();
        await this.clickViewByLastApiName(activityName);
        await this.page.waitForLoadState('networkidle');

        requestContent = await this.getModalRequestContent();

        // Close modal by clicking OK button to allow the next search click
        await this.closeActivityModalButton.click();
        await this.activityModal.waitFor({ state: 'hidden', timeout: MEDIUM_WAIT }).catch(() => { });

        const allMatched = substrings.every(sub => requestContent.includes(sub));
        if (allMatched) {
          testLogger?.log(`Provisioning completed and verified on retry #${i + 1}`);
          return requestContent;
        }
      } catch (e: any) {
        testLogger?.log(`Retry #${i + 1} failed: ${e.message}`);
        // Ensure modal is closed on failure so next retry can proceed (only if it is actually open)
        if (await this.activityModal.isVisible()) {
          await this.closeActivityModalButton.click().catch(() => { });
          await this.activityModal.waitFor({ state: 'hidden', timeout: MEDIUM_WAIT }).catch(() => { });
        }
      }

      // Wait before the next poll
      await new Promise(resolve => setTimeout(resolve, LONG_WAIT));
    }

    throw new Error(`Failed to verify activity request content containing ${JSON.stringify(substrings)} after 5 minutes.`);
  }

  /**
    * Navigate to Addresses via sidebar.
    */
  async navigateToAddresses(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'Addresses');
  }

  async clickAddNewAddress(): Promise<void> {
    await this.addNewAddress.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')

  }

  async addressDetails(street: string, state: string,
    city: string,
    postalCode: string): Promise<void> {
    await this.streetInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.streetInput.click();
    await this.streetInput.fill(street);

    const stateGroup = this.popup.locator('.react-select').nth(1);
    await stateGroup.locator('.custom-react-select__control').click();
    await stateGroup.locator('.custom-react-select__input input').type('Alaska', { delay: 100 });
    await this.popup.locator('.custom-react-select__option', { hasText: 'Alaska' }).click();
    const cityGroup = this.popup.locator('.react-select').nth(2);
    await cityGroup.locator('.custom-react-select__control').click();
    await cityGroup.locator('.custom-react-select__input input').type('Jber', { delay: 100 });
    await this.popup.locator('.custom-react-select__option', { hasText: 'Jber' }).click();

    const postalGroup = this.popup.locator('.react-select').nth(3);
    await postalGroup.locator('.custom-react-select__control').click();
    await postalGroup.locator('.custom-react-select__input input').type('99505', { delay: 100 });
    await this.popup.locator('.custom-react-select__option', { hasText: '99505' }).click();

    await this.addAddress.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
    await this.modifyButton.click();
  }


  /**
  * Navigate to Billing profile via sidebar.
  */
  async navigateToBillingProfile(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'Billing Profile');
  }


  async changeBillingFrequency(): Promise<void> {
    const frequencyGroup = this.page.locator('div.form-group.select-group', { hasText: 'Billing Frequency' });
    await frequencyGroup.locator('.custom-react-select__control').click();
    await this.page.locator('.custom-react-select__option')
      .filter({ hasText: 'ANNUAL' })
      .first()
      .click()
    await this.modifyButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle');
    await this.yesButton.click();
  }


  /**
  * Navigate to Custom Attributes via sidebar.
  */
  async navigateToCustomAttributes(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'Custom Attributes');
  }


  async addAttributes(): Promise<void> {
    await this.page.locator('.collapse_sub_title', { hasText: 'BILLING' }).click();
    const autoTrigger = this.page.locator('div.form-group.select-group', { hasText: 'Auto_Trigger_Manual_Billing' });
    await autoTrigger.locator('.custom-react-select__control').click();
    await this.page.locator('.custom-react-select__option')
      .filter({ hasText: 'TRUE' })
      .first()
      .click();
    await this.page.locator('.collapse_sub_title', { hasText: 'CUSTOMER' }).click();
    await this.codigoInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.codigoInput.click();
    await this.codigoInput.fill('NA');
    await this.page.locator('.collapse_sub_title', { hasText: 'DEFAULT' }).click();
    const generateAuto = this.page.locator('div.form-group.select-group', { hasText: 'generateUsageStatement' });
    await generateAuto.locator('.custom-react-select__control').click();
    await this.page.locator('.custom-react-select__option')
      .filter({ hasText: 'TRUE' })
      .first()
      .click();
    await this.modifyButton.click();
  }

  /**
   * Navigate to Tax Exemption via sidebar.
   */
  async navigateToTaxExemptions(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'Tax Exemptions');
  }

  async addNewTaxExemption(): Promise<void> {
    await this.addNewButton.click();

  }

  async clickSave(): Promise<void> {
    await this.saveButton.click();

  }

  /**
 * Navigate to Hierarchy via sidebar.
 */
  async navigateToHierarchy(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'Hierarchy');
  }
  async clickSearchPopupButton(): Promise<void> {
    const searchBtn = this.popup.getByRole('button', { name: /SEARCH/i }).first();
    await searchBtn.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
    await this.activityTable.rows.first().waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }


  async clickRadioButtonById(accountId: string): Promise<void> {
    const targetRow = this.popup.locator('table tr').filter({
      hasText: accountId
    });
    await targetRow.click();
  }
  async clickSelectButton(): Promise<void> {
    await this.selectButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);


  }

  async getFirstRowCellValue(columnName: string): Promise<string> {
    return this.activityTable.getFirstRowCellValue(columnName);
  }

  /**
  * Navigate to Payment installment via sidebar.
  */
  async navigateToPaymentInstallment(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'Payment Installment');
  }

  async clickAddInstallmemtButton(): Promise<void> {
    await this.addNewInstallButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async clickbuttontoExpand(): Promise<void> {
    await this.page.locator('[role="button"]', { hasText: '<id> - ' }).click();
    await this.addNewRowButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);

    const card = this.page.locator('.embrix-card-collapsible')
      .filter({ hasText: '<id> - ' });

    const table = card.locator('.collapse__content.collapse.show table');
    const row = table.locator('tbody tr').nth(0);
    await row.locator('td').nth(1).locator('input').fill('100');
    await row.locator('td').nth(2).locator('input').fill('2');
  }

  async clickSaveConfig(): Promise<void> {
    await this.saveConfigButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async createPaymentInstallmentSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);
    console.log('---******------' + winner);
    if (winner === 'success') {
      console.log('---------' + successToast);
      await expect(successToast).toContainText('Create Payment Installment successfully!');
      await this.page.waitForLoadState('networkidle')
      return this.page.url();
    } else if (winner === 'error') {
      // Capture the screen WHILE the error toast is still visible
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('error-toast-visible');
        await screenshotHelper.captureElementAndAttach(
          'error-toast-detail',
          '.Toastify__toast--error',
        );
      }
      const errorMsg = await this.toastComponent.getErrorMessage();
      console.log('=== CREATE PAYMENT INSTALLATION FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Create payment installation Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }


  async createXchangeRatesSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {

      await expect(successToast).toContainText('Create xChange Rate successfully!');
      await this.page.waitForLoadState('networkidle')
      return this.page.url();
    } else if (winner === 'error') {
      // Capture the screen WHILE the error toast is still visible
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('error-toast-visible');
        await screenshotHelper.captureElementAndAttach(
          'error-toast-detail',
          '.Toastify__toast--error',
        );
      }
      const errorMsg = await this.toastComponent.getErrorMessage();
      console.log('=== CREATE XCHANGE RATE FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Create xChange Rate Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }

  /**
* Navigate to Xchange Rates via sidebar.
*/
  async navigateToXchangeRates(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'xchange Rates');
  }

  async clickAddNewXchangeButton(): Promise<void> {
    await this.addNewExchangeButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }
}
