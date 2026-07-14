import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { MEDIUM_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';

/**
 * CustomerListingPage — Page Object for the Search Accounts screen.
 *
 * Accessed via: Customer Hub → Customer Management
 */
export class CustomerListingPage extends BasePage {
  readonly table: TableComponent;

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.table = new TableComponent(page, this.page.locator('table').first());
  }

  /** DOM Elements */
  private get accountIdInput() { return this.page.locator(`//input[@name='accountId']`).first(); }
  private get searchButton() { return this.page.getByRole('button', { name: 'Search', exact: true }); }

  /** Hover on "Customer Hub" → click "Customer Management" link. */
  async navigateViaNav(): Promise<void> {
    await this.page.navigateToHome()
    await this.hoverNavMenu(/Customer Hub/i);
    await this.clickNavLink(/Customer Management/i, /customer/i);
    await this.page.waitForLoadingToDisappear();
  }

  /** Search by Account ID */
  async searchByAccountId(accountId: string): Promise<void> {
    await this.accountIdInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.accountIdInput.fill(accountId);

    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle');

    // Wait for the row with accountId to appear in the table
    const row = this.table.rows.filter({ hasText: accountId }).first();
    await row.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

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
    await this.page.waitForFunction((oldUrl) => window.location.href !== oldUrl, currentUrl, { timeout: MEDIUM_WAIT })
    await this.page.waitForLoadState('networkidle')
    return this.page.url();
  }

  /**
   * Generates a random Account ID and searches the system to ensure it is unique/non-existent.
   * Repeats until a unique ID is found.
   * 
   * @param accountPrefix The prefix for the Account ID (default: 'AC')
   * @param orderPrefix The prefix for the Order ID (default: 'OR')
   * @returns An object containing the unique accountId and orderId
   */
  async generateUniqueAccountAndOrderId(
    accountPrefix: string = 'AC',
    orderPrefix: string = 'OR'
  ): Promise<{ accountId: string; orderId: string }> {
    let isUnique = false;
    let uniqueAccountId = '';
    let uniqueOrderId = '';

    while (!isUnique) {
      const randomSuffix = Math.floor(100000 + Math.random() * 900000);
      const testId = `${accountPrefix}-${randomSuffix}`;

      // Search for the generated test ID
      await this.accountIdInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
      await this.accountIdInput.fill(testId);
      await this.searchButton.click();

      await this.page.waitForLoadingToDisappear();
      await this.page.waitForLoadState('networkidle');

      // Check if the row with this Account ID is visible
      const row = this.table.rows.filter({ hasText: testId }).first();
      const exists = await row.isVisible();

      if (!exists) {
        uniqueAccountId = testId;
        uniqueOrderId = `${orderPrefix}-${randomSuffix}`;
        isUnique = true;
      }
    }

    return { accountId: uniqueAccountId, orderId: uniqueOrderId };
  }
}

