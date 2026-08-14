import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * InvoicePage — Page Object for the Billing screen.
 *
 * Accessed via: Billing Hub → Billing
 */
export class InvoicePage extends BasePage {
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
  private get startDateInput() { return this.page.locator(`//input[@name='startDate']`).first(); }
  private get endDateInput() { return this.page.locator(`//input[@name='endDate']`).first(); }
  private get accountIdInput() { return this.page.locator(`//input[@name='accountId']`).first(); }
  private get cancelButton() { return this.page.getByRole('button', { name: 'Cancel' }) }


  // Navigation

  /** Hover on "Billing Hub" → click "Billing" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Billing Hub/i);
    await this.clickNavLink(/Billing/i, /invoicing-billing/i);

  }


  async clickSearchButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async clickCancelButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.cancelButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async searchBystartDateandEndDateAccount(accountId: string): Promise<void> {
    // await this.startDateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    // await this.startDateInput.fill('2026-06-01');
    // await this.endDateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    // await this.endDateInput.fill('2026-06-09');
    await this.accountIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.accountIdInput.fill(accountId);

  }

}
