import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../../../base.page';
import { AccountDetailsSidebar } from '../account-details-sidebar';
import { TableComponent } from '../../../../components/table.component';

/**
 * ServicesPage — Page Object for the Subscription Data > Assets > Services screen.
 *
 * Accessed via: Subscription Data sidebar → Assets → Services
 */
export class ServicesPage extends BasePage {
  readonly sidebar: AccountDetailsSidebar;

  // Explicit, descriptive tables
  readonly incompleteOrdersTable: TableComponent;
  readonly servicesTable: TableComponent;

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.sidebar = new AccountDetailsSidebar(page);

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

  private get searchButton() { return this.page.getByRole('button', { name: 'Search' }) }


  /**
   * Navigate to Services page via sidebar.
   * Clicks "Subscription Data" → "Assets" → "Services".
   */
  async navigateViaSideMenu(): Promise<string> {
    return this.sidebar.navigateToSubScreen('Subscription Data', 'Assets', 'Services');
  }

  /**
   * Get the text content of a cell in the first row by column name (defaulting to In-Complete Orders).
   */
  async getInCompleteOrdersFirstRowCellValue(columnName: string): Promise<string> {
    return this.incompleteOrdersTable.getFirstRowCellValue(columnName);
  }


  /**
  * Navigate to Subscription Data page via sidebar.
  * Clicks "Subscription Data" → "Assets" → "Subscription View".
  */
  async navigateSubscriptionView(): Promise<string> {
    return this.sidebar.navigateToSubScreen('Subscription Data', 'Assets', 'Subscription View');
  }

  /**
* Navigate to Offers page via sidebar.
* Clicks " Offers" → "Assets" → "Offers".
*/
  async navigateToOffers(): Promise<string> {
    return this.sidebar.navigateToSubScreen('Subscription Data', 'Assets', 'offers');
  }

  async clickSearchButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

  }
}
