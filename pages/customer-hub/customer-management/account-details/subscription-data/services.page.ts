import { expect, Page } from '@playwright/test';
import { BasePage } from '../../../../base.page';
import { SidebarComponent } from '../../../../components/sidebar.component';
import { TableComponent } from '../../../../components/table.component';
import { MEDIUM_WAIT } from '../../../../../helpers/timeouts.helper';

/**
 * ServicesPage — Page Object for the Subscription Data > Assets > Services screen.
 *
 * Accessed via: Subscription Data sidebar → Assets → Services
 */
export class ServicesPage extends BasePage {
  readonly sidebar: SidebarComponent;

  // Explicit, descriptive tables
  readonly incompleteOrdersTable: TableComponent;
  readonly servicesTable: TableComponent;

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.sidebar = new SidebarComponent(page);

    // Robust selectors locating tables by their respective section headers, falling back to index if not found
    this.incompleteOrdersTable = new TableComponent(
      page,
      this.page.locator('//h5[contains(text(), "In-complete Orders")]/following::table')
    );

    this.servicesTable = new TableComponent(
      page,
      this.page.locator('//h5[contains(text(), "Service Units")]/following::table[1]')
    );
  }


  /**
   * Navigate to Services page via sidebar.
   * Clicks "Subscription Data" → "Assets" → "Services".
   */
  async navigateViaSideMenu(): Promise<string> {
    return this.sidebar.navigateTo('Subscription Data', 'Assets', 'Services');
  }

  /**
   * Get a cell value from the Incomplete Orders table.
   * @param rowIndex - The row index of the cell to get.
   * @param columnName - The column name of the cell to get.
   */
  async getIncompleteOrderValue(rowIndex: number, columnName: string): Promise<string> {
    return this.incompleteOrdersTable.getCellValue(rowIndex, columnName);
  }

  /**
   * Check if the row with the specified orderId is visible in the Incomplete Orders table.
   * @param orderId - The ID of the order to check.
   */
  async isOrderAppearInIncompleteTableWithStatus(orderId: string, status: string): Promise<void> {
    const rowIndex = await this.incompleteOrdersTable.findRowIndex('Id', orderId);
    const statusValue = await this.incompleteOrdersTable.getCellValue(rowIndex, 'Status');
    expect(statusValue).toBe(status);
  }

  /**
   * Click on the Order ID link in the Incomplete Orders table.
   * @param orderId - The ID of the order to click on.
   */
  async clickOnOrderIdLink(orderId: string): Promise<void> {
    const rowIndex = await this.incompleteOrdersTable.findLastRowIndex('Id', orderId);
    await this.incompleteOrdersTable.clickCellLink(rowIndex, 'Id')
    await this.page.waitForLoadingToDisappear()
  }
}
