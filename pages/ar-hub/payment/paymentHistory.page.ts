import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * Payment History Page — Page Object for the payment history screen.
 *
 * Accessed via: AR Hub → Payments
 */
export class PaymentHistoryPage extends BasePage {
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
  private get startDateInput() { return this.page.locator(`//input[@name='startDate']`).first(); }
  private get endDateInput() { return this.page.locator(`//input[@name='endDate']`).first(); }


  // Navigation

  /** Hover on "AR Hub" → click "Payments" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/AR Hub/i);
    await this.clickNavLink(/Payments/i, /payment-agent/i);

  }


  async searchByAccountId(accountId: string): Promise<void> {
    await this.accountIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.accountIdInput.fill(accountId);
    await this.page.waitForLoadState('networkidle')
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async searchBystartDateandEndDateAccount(accountId: string): Promise<void> {
    await this.startDateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.startDateInput.fill('2026-08-01');
    await this.endDateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.endDateInput.fill('2026-09-02');
    await this.accountIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.accountIdInput.fill('ACT-100094');
  }

}
