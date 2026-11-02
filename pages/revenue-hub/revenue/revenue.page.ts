import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * RevenuePage — Page Object for the Revenue screen of Revenue hub.
 *
 * Accessed via: Revenue Hub →  Revenue
 */
export class RevenuePage extends BasePage {
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
  private get startDateInput() { return this.page.locator(`//input[@name='revenueStartDate']`).first(); }
  private get endDateInput() { return this.page.locator(`//input[@name='revenueEndDate']`).first(); }
  private get searchButton() { return this.page.getByRole('button', { name: 'Search' }) }


  /**
     * Navigate to Reports via top nav menu + sidebar.
     * Opens Revenue Hub → Revenue
     */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Revenue Hub/i);
    await this.clickNavLink(/Revenue/i, /revenue/i);
    await this.page.waitForLoadingToDisappear();
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


  async searchByDate(startDate: string, endDate: string): Promise<void> {
    await this.startDateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.startDateInput.fill(startDate);
    await this.endDateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.endDateInput.fill(endDate);
  }

  async clickSearchButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

  }

}
