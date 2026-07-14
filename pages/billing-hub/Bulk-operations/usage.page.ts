import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * UsagePage — Page Object for the Usage screen.
 *
 * Accessed via: Billing Hub → Usage
 */
export class UsagePage extends BasePage {
  readonly table: TableComponent;
  readonly toastComponent: ToastComponent;
  readonly popup: Locator;

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.table = new TableComponent(page, this.page.locator('table').first());
    this.popup = page.locator('[role="dialog"]').last(); // or your popup selector
    this.toastComponent = new ToastComponent(page);
  }

  // DOM Elements

  private get searchButton() { return this.page.getByRole('button', { name: 'Search' }) }
  private get downloadButton() { return this.popup.getByRole('button', { name: 'Download' }) }
  private get searchPopupButton() { return this.popup.getByRole('button', { name: 'Search' }) }
  private get backPopupButton() { return this.popup.getByRole('button', { name: 'Back' }) }
  private get processAllButton() { return this.page.getByRole('button', { name: 'PROCESS-ALL' }) }


  // Navigation

  /** Hover on "Billing Hub" → click "Usage" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Billing Hub/i);
    await this.clickNavLink(/Usage/i, /usage-config/i);

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


  async clickSearchButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async clickPopupSearchButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.searchPopupButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async clickDownloadButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.downloadButton.click();
    await this.page.waitForLoadingToDisappear();

  }


  async clickPopupBackButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.backPopupButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async createUsageReprocessSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {

      await expect(successToast).toContainText('Initiate Usage Reprocess successfully!');
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
      console.log('=== CREATE USAGE REPROCESS FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Initiate Usage Reprocess Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }

  async clickProcessAllButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.processAllButton.click();
    await this.page.waitForLoadingToDisappear();

  }

}
