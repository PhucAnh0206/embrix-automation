import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * Account in Collection Page — Page Object for the collection screen.
 *
 * Accessed via: AR Hub → Collections
 */
export class CollectionPage extends BasePage {
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
  private get searchButton() { return this.page.getByRole('button', { name: 'Search' }) }
  private get accountIdInput() { return this.page.locator(`//input[@name='accountId']`).first(); }

  // Navigation

  /** Hover on "AR Hub" → click "Collection" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/AR Hub/i);
    await this.clickNavLink(/Collections/i, /collection-agent/i);

  }


  // Table Helpers (Delegated to TableComponent)

  /**
   * Get the text content of a cell in the first row by column name.
   */
  async getFirstRowCellValue(columnName: string): Promise<string> {
    return this.table.getFirstRowCellValue(columnName);
  }



  async searchByAccountId(accountId: string): Promise<void> {
    await this.accountIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.accountIdInput.fill(accountId);
    await this.page.waitForLoadState('networkidle')
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForTimeout(MEDIUM_WAIT);

  }

}
