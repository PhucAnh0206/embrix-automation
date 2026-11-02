import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';
import { AccountDetailsSidebar } from '../../customer-hub/customer-management/account-details/account-details-sidebar';
/**
 * Manual Payment Page — Page Object for the payment screen.
 *
 * Accessed via: AR Hub → Manual Payment
 */
export class ManualPaymentPage extends BasePage {
  readonly table: TableComponent;
  readonly toastComponent: ToastComponent;
  readonly sidebar: AccountDetailsSidebar;
  readonly popup: Locator;


  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.popup = page.locator('[role="dialog"]').last();
    this.table = new TableComponent(page, this.page.locator('table').first());
    this.toastComponent = new ToastComponent(page);
    this.sidebar = new AccountDetailsSidebar(page);
  }

  // DOM Elements
  private get selectButton() { return this.popup.getByRole('button', { name: 'Select', exact: true }); }
  private get amountInput() { return this.page.locator(`//input[@name='amount']`).first(); }
  private get paymentDtInput() { return this.page.locator(`//input[@name='paymentDate']`).first(); }
  private get bankInput() { return this.page.locator(`//input[@name='bank']`).first(); }
  private get allocatePayButton() { return this.popup.getByRole('button', { name: 'Allocate Payment', exact: true }); }

  private get invoiceInput() { return this.page.locator(`//input[@name='invoiceUnitId']`).first(); }
  private get invoiceButton() { return this.popup.getByRole('button', { name: 'Select Invoice', exact: true }); }
  private get searchButton() { return this.popup.getByRole('button', { name: 'Search', exact: true }); }

  private get idInput() { return this.page.locator(`//input[@name='id']`).first(); }

  // Navigation

  /** Hover on "AR Hub" → click "Payments" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/AR Hub/i);
    await this.clickNavLink(/Payments/i, /payment-agent/i);

  }

  async navigateViaSideMenu(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Payment operations', 'Manual Payment');
    return this.page.url();
  }


  /**
  * Click on radio button of the first row
  */
  async clickRadioButtonById(): Promise<void> {
    await this.page.locator('.group-loader').waitFor({ state: 'hidden', timeout: 30000 });

    await this.page.waitForTimeout(500);
    const radioButton = await this.table.getCellByLocation(0, 'Selected')
    await radioButton.click();
  }

  async clickSelectButton(): Promise<void> {
    await this.selectButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async selectCurrency(): Promise<void> {
    const currencyGroup = this.page.locator('div.form-group.select-group', { hasText: 'Payment Currency' });
    await currencyGroup.locator('.custom-react-select__control').click();

    await this.page.locator('.custom-react-select__option')
      .filter({ hasText: 'Mexican Peso (MXN)' })
      .first()
      .click();

  }

  async addAmountDate(amount: string, paymentDate: string): Promise<void> {
    await this.amountInput.fill(amount);
    await this.paymentDtInput.fill(paymentDate);
    await this.bankInput.fill('National');
  }

  async selectInvoice(invoice: string): Promise<void> {
    await this.invoiceInput.click();
    await this.page.waitForTimeout(MEDIUM_WAIT);
    await this.invoiceButton.click();
    await this.page.waitForTimeout(MEDIUM_WAIT);
    await this.idInput.fill(invoice);
    await this.searchButton.click();

  }

  async allocatePayment(): Promise<void> {
    await this.allocatePayButton.click();
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async clickRadioButtonByIdNew(): Promise<void> {
    await this.page.waitForTimeout(500);

    const firstRow = this.popup.locator('table').first()
      .locator('tbody tr').first();
    const html = await firstRow.innerHTML();

    await firstRow.locator('input').first().click({ force: true });
  }
}
