import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * CustomerManagementPage — Page Object for the Customer Management screen.
 *
 * Accessed via: Customer Hub → Customer Management
 */
export class CustomerManagementPage extends BasePage {
  readonly table: TableComponent;
  readonly toastComponent: ToastComponent;


  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.table = new TableComponent(page, this.page.locator('table').first());
    this.toastComponent = new ToastComponent(page);


  }

  // DOM Elements
  private get accountIdInput() { return this.page.locator(`//input[@name='accountId']`).first(); }
  private get emailInput() { return this.page.locator(`//input[@name='email']`).first(); }
  private get searchButton() { return this.page.getByRole('button', { name: 'Search', exact: true }); }
  private get createNewButton() { return this.page.getByRole('link', { name: 'Create New', exact: true }); }
  private get firstNameInput() { return this.page.locator(`//input[@name='firstName']`).first(); }

  private get lastNameInput() { return this.page.locator(`//input[@name='lastName']`).first(); }

  private get cityInput() { return this.page.locator(`//input[@name='city']`).first(); }

  private get streetInput() { return this.page.locator('textarea[name="street"]'); }

  private get stateInput() { return this.page.locator(`//input[@name='state']`).first(); }

  private get postalCodeInput() { return this.page.locator(`//input[@name='postalCode']`).first(); }
  private get countryInput() { return this.page.locator('#react-select-226-input').first(); }
  private get createAccountButton() { return this.page.getByRole('button', { name: 'Create Account', exact: true }); }
  private get modifyButton() { return this.page.getByRole('button', { name: 'Modify', exact: true }); }


  // Navigation

  /** Hover on "Customer Hub" → click "Customer Management" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Customer Hub/i);
    await this.clickNavLink(/Customer Management/i, /customer/i);
  }

  async searchByAccountId(accountId: string): Promise<void> {
    await this.accountIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.accountIdInput.fill(accountId);

    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')

    // Wait for the row with accountId to appear in the table
    const row = this.table.rows.filter({ hasText: accountId }).first();
    await row.waitFor({ state: 'visible', timeout: MEDIUM_WAIT }).catch(() => { });
  }

  // Table Helpers (Delegated to TableComponent)

  /**
   * Get the text content of a cell in the first row by column name.
   */
  async getFirstRowCellValue(columnName: string): Promise<string> {
    return this.table.getFirstRowCellValue(columnName);
  }

  /**
   * Click the link/text in a cell of the first row for a given column.
   * Returns the URL after navigation.
   */
  async clickFirstRowLink(columnName: string): Promise<string> {
    const currentUrl = this.page.url();
    await this.table.clickCellLink(0, columnName);
    await this.page.waitForFunction((oldUrl) => window.location.href !== oldUrl, currentUrl, { timeout: MEDIUM_WAIT }).catch(() => { });
    await this.page.waitForLoadState('networkidle')
    return this.page.url();
  }

  async clickCreateButton(): Promise<void> {
    await this.createNewButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }


  async quickCreateAccount(email: string, firstName: string, lastName: string
  ): Promise<void> {

    await this.emailInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.emailInput.fill(email);
    await this.firstNameInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.firstNameInput.fill(firstName);
    await this.lastNameInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.lastNameInput.fill(lastName);




  }

  /**
   * Set the mandatory Currency on the create form, but only when it is blank.
   *
   * Some tenants pre-fill it (coopeg-sandbox), others leave it empty (congero on
   * OCI). Relying on the pre-fill made Create Account fail on congero with
   * "Mandatory inputs are missing or invalid" before any request was sent.
   */
  async ensureCurrency(currency: string): Promise<void> {
    const group = this.page.locator('div.form-group.select-group', { has: this.page.getByText(/^Currency/) }).first();
    await group.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    const current = group.locator('.custom-react-select__single-value');
    if (await current.count() > 0 && (await current.first().innerText()).trim()) return;

    await group.locator('.custom-react-select__control').first().click();
    await this.page.locator('.custom-react-select__option')
      .filter({ hasText: currency })
      .first()
      .click();
    await expect(current.first(), `Currency did not take '${currency}'`).toContainText(currency);
  }

  /**
   * Set the Payment Method in the Create Payment Profile section.
   *
   * On congero it defaults to CREDIT_CARD, which makes Credit Card Token,
   * Expiry and CVV mandatory. With the section collapsed, Create Account then
   * does nothing visible (only a console error), so choose a method that needs
   * no card, e.g. CHECK.
   */
  async ensurePaymentMethod(method: string): Promise<void> {
    await this.page.locator('.panel__title', { hasText: 'Create Payment Profile' }).click();
    const group = this.page.locator('div.form-group.select-group', { has: this.page.getByText(/^Payment Method/) }).first();
    await group.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    const current = group.locator('.custom-react-select__single-value');
    if (await current.count() > 0 && (await current.first().innerText()).trim() === method) return;

    await group.locator('.custom-react-select__control').first().click();
    await this.page.locator('.custom-react-select__option')
      .filter({ hasText: new RegExp(`^${method}$`) })
      .first()
      .click();
    await expect(current.first(), `Payment Method did not take '${method}'`).toHaveText(method);
  }

  async addressDetails(street: string, state: string,
    city: string,
    postalCode: string): Promise<void> {

    await this.streetInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.streetInput.click();
    await this.streetInput.fill(street);
    const countryGroup = this.page.locator('div.form-group.select-group', { hasText: 'Country' });
    await countryGroup.locator('.custom-react-select__control').click();

    //await this.page.locator('.custom-react-select__control').nth(7).click();
    //await this.page.locator('#react-select-226-input').first().fill('Costa Rica');

    await this.page.locator('.custom-react-select__option')
      .filter({ hasText: 'Costa Rica' })
      .first()
      .click();

    await this.stateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.stateInput.fill(state);
    await this.cityInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.cityInput.fill(city);
    await this.postalCodeInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.postalCodeInput.fill(postalCode);
    await this.createAccountButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')

  }


  async isQuickAccountCreatedSuccesfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {
      await expect(successToast).toContainText('Create Account successfully!');
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
      console.log('=== QUICK CREATE ACCOUNT CREATION FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Quick Account Creation Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }


  async createOrderSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {
      await expect(successToast).toContainText('Create Order successfully!');
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
      console.log('=== ORDER CREATION FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Order Creation Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }

  async changeCustomerSegment(): Promise<void> {
    const costomerSeg = this.page.locator('div.form-group.select-group', { hasText: 'Customer Segment' });
    await costomerSeg.locator('.custom-react-select__control').click();

    await this.page.locator('.custom-react-select__option')
      .filter({ hasText: 'B2B' })
      .first()
      .click();
    await this.modifyButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
  }


  async accountModifySuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {
      await expect(successToast).toContainText('Modify Account successfully!');
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
      console.log('=== Modify Account FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Modify Account Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }

  async moveAccountSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {
      await expect(successToast).toContainText('move Account successfully!');
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
      console.log('=== Move Account FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Move Account Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }



}
