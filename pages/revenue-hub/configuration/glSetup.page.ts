import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';

/**
 * GL Setup Page — Page Object for the SL Setup screen.
 *
 * Accessed via: Revenue Hub → Configuration
 */
export class GLSetupPage extends BasePage {
  readonly tableGL: TableComponent;
  readonly toastComponent: ToastComponent;


  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.tableGL = new TableComponent(
      page,
      page.locator('.collapse__content.collapse.show')
        .locator('table.center-aligned-table.mb-0.table-collapsible')
        .first()
    );
    this.toastComponent = new ToastComponent(page);
  }

  // DOM Elements
  private get addNewSegmentButton() { return this.page.getByRole('button', { name: '+Add New Segment' }) }
  private get addNewGlAccountButton() { return this.page.getByRole('button', { name: '+Add New GL Account Range' }) }
  private get saveConfigButton() { return this.page.getByRole('button', { name: 'Save config' }) }


  // Navigation

  /** Hover on "Revenue Hub" → click "Configuration" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Revenue Hub/i);
    await this.clickNavLink(/Configuration/i, /revenue-configuration/i);

  }


  // Table Helpers (Delegated to TableComponent)

  /**
   * Get the text content of a cell in the first row by column name.
   */
  async getFirstRowCellValue(columnName: string): Promise<string> {
    return this.tableGL.getFirstRowCellValue(columnName);
  }

  /**
   * Click the link/text in a cell of the first row for a given column.
   * Returns the URL after navigation.
   */
  async clickFirstRowLink(columnName: string): Promise<string> {
    const currentUrl = this.page.url();
    await this.tableGL.clickCellLink(0, columnName);
    await this.page.waitForFunction((oldUrl) => window.location.href !== oldUrl, currentUrl, { timeout: MEDIUM_WAIT }).catch(() => { });
    await this.page.waitForLoadState('networkidle')
    return this.page.url();
  }

  async addGlSegment(): Promise<void> {
    await this.page.locator('[role="button"]', { hasText: 'GL Segments' }).click();

  }

  async clickaddNewSegButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.addNewSegmentButton.click();
    await this.page.waitForLoadingToDisappear();

  }


  async clickaddNewGlAccButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.addNewGlAccountButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async clickSaveButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.saveConfigButton.click();
    await this.page.waitForLoadingToDisappear();

  }



}
