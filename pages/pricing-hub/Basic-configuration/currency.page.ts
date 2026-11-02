import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * CurrencyPage — Page Object for the Base configuration screen.
 *
 * Accessed via: Pricing Hub → Base Configuration
 */
export class CurrencyPage extends BasePage {
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
  private get addCurrencyButton() { return this.page.getByRole('button', { name: '+Add New Currency' }) }
  private get quickCreateButton() { return this.page.getByRole('link', { name: 'Quick Create', exact: true }); }

  private get modifyButton() { return this.page.getByRole('button', { name: 'Modify' }) }

  // Navigation

  /** Hover on "Pricing Hub" → click "Base Configuration" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Pricing Hub/i);
    await this.clickNavLink(/Base Configurations/i, /resources/i);

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

  async clickAddCurrencyButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.addCurrencyButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async clickModifyButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.modifyButton.click();
    await this.page.waitForLoadingToDisappear();

  }


  async createCurrencySuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {
      await expect(successToast).toContainText('Modify Currency successfully!');
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
      console.log('=== CURRENCY CREATION FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Currency Creation Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }

}
