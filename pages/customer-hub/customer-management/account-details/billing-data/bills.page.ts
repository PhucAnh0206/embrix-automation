import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../../../base.page';
import { test, expect } from '../../../../../fixtures/page-factory';
import { SHORT_WAIT, EXTRA_LONG_WAIT } from '../../../../../helpers/timeouts.helper';
import { AccountDetailsSidebar } from '../account-details-sidebar';
import { TableComponent } from '../../../../components/table.component';
import { ToastComponent } from '../../../../components/toast.component';
import { ScreenshotHelper } from '../../../../../helpers/screenshot.helper';

/**
 * BillsPage — Page Object for the Billing Data > Bills screen.
 *
 * Accessed via: Account Info sidebar → Billing Data → Bills
 */
export class BillsPage extends BasePage {
  readonly sidebar: AccountDetailsSidebar;
  readonly table: TableComponent;
  readonly pendingBillsTable: TableComponent;
  readonly resultsTable: Locator;
  readonly tableRows: Locator;
  readonly toastComponent: ToastComponent;


  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.sidebar = new AccountDetailsSidebar(page);
    this.resultsTable = page.locator('table#scrollableDiv'); // update selector
    this.tableRows = this.resultsTable.locator('tbody tr');
    this.table = new TableComponent(
      page,
      this.page.locator('//h5[contains(text(), "Open/Closed bills")]/following::table[1]')
    );
    this.pendingBillsTable = new TableComponent(
      page,
      this.page.locator('//h5[contains(text(), "Pending Bills")]/following::table[1]')
    );
    this.toastComponent = new ToastComponent(page);
  }

  private get startDateInput() { return this.page.locator(`//input[@name='startDate']`).first(); }
  private get endDateInput() { return this.page.locator(`//input[@name='endDate']`).first(); }
  private get searchButton() { return this.page.getByRole('button', { name: 'Search' }) }
  private get downloadButton() { return this.page.getByRole('button', { name: 'Download' }) }
  private get backButton() { return this.page.getByRole('button', { name: 'Back' }) }
  private get billPendingButton() { return this.page.getByRole('button', { name: 'Bill Pending charges' }) }
  private get addNewButton() { return this.page.getByRole('button', { name: '+Add New' }) }
  private get quickNotesButton() { return this.page.getByRole('button', { name: 'Quick Notes' }) }
  private get invoiceInput() { return this.page.locator(`//input[@name='invoiceUnitId']`).first(); }



  /**
   * Navigate to Bills via the left sidebar.
   * Clicks "Billing Data" section → "Bills" option.
   * Returns the Bills page URL.
   */
  async navigateViaSideMenu(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Bills');
    return this.page.url();
  }

  /**
   * Get the text content of a cell in the first row by column name.
   */
  async getFirstRowCellValue(columnName: string): Promise<string> {
    return this.table.getFirstRowCellValue(columnName);
  }

  /**
   * Get cell value from a row where Invoice Id matches the given value.
   * @param invoiceId The invoice ID to locate the row
   * @param columnName The column to read the value from
   */
  async getRowCellValueByInvoiceId(invoiceId: string, columnName: string): Promise<string> {
    return this.table.getCellValueByMatch('Invoice Id', invoiceId, columnName);
  }

  /**
  * Navigate to Balances via the left sidebar.
  * Clicks "Billing Data" section → "Balances" option.
  * Returns the Bills page URL.
  */
  async navigateToBalance(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Balances');
    return this.page.url();
  }

  /**
* Navigate to Rated Usage via the left sidebar.
* Clicks "Billing Data" section → "Rated Usage" option.
* Returns the Bills page URL.
*/
  async navigateToRatedUsage(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Rated Usage');
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

  /**
* Navigate to Usage Record via the left sidebar.
* Clicks "Billing Data" section → "Usage Record" option.
* Returns the Bills page URL.
*/
  async navigateToUsageRecord(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Usage Records');
    return this.page.url();
  }

  async clickDownloadButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.downloadButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async getRowCount() {
    return await this.tableRows.count();
  }
  async getRowData(rowIndex: number) {
    const row = this.tableRows.nth(rowIndex);
    return row.locator('td').allTextContents();
  }

  async getAllTableData() {
    const rows = await this.tableRows.all();
    const data = [];
    for (const row of rows) {
      const cells = await row.locator('td').allTextContents();
      data.push(cells);
    }
    return data;
  }

  /**
* Navigate to AR Request Log Record via the left sidebar.
* Clicks "Billing Data" section → "AR Request Log" option.
* Returns the Bills page URL.
*/
  async navigateToARRequestLog(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'AR Request Log');
    return this.page.url();
  }

  async selectType(): Promise<void> {
    const firstDropdown = this.page.locator('.react-select').first();
    await firstDropdown.locator('.custom-react-select__control').click();
    await this.page.waitForTimeout(500);
    await this.page.keyboard.type('TAX', { delay: 100 });
    await this.page.waitForTimeout(500);
    await this.page.locator('.custom-react-select__option', { hasText: 'TAX_ADJUSTMENT' }).click();
  }

  /**
* Navigate to AR Ops Units Record via the left sidebar.
* Clicks "Billing Data" section → "AR Ops Units" option.
* Returns the Bills page URL.
*/
  async navigateToAROpsUnits(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'AR Ops Units');
    return this.page.url();
  }

  /**
* Navigate to Transactions Record via the left sidebar.
* Clicks "Billing Data" section → "Transactions" option.
* Returns the Bills page URL.
*/
  async navigateToTransactions(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Transactions');
    return this.page.url();
  }
  async clickBackButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.backButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  /**
* Navigate to Account Statement via the left sidebar.
* Clicks "Billing Data" section → "Account Statement" option.
* Returns the Bills page URL.
*/
  async navigateToAccountStatement(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Account Statement');
    return this.page.url();
  }


  async clickquickNotesButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.quickNotesButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  /**
* Navigate to Bills via the left sidebar.
* Clicks "Billing Data" section → "Bills" option.
* Returns the Bills page URL.
*/
  async navigateToBills(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Bills');
    return this.page.url();
  }

  async clickBillPendingButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.billPendingButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  /**
* Click on radio button of the first row
*/
  async clickRadioButtonById(): Promise<void> {
    const radioButton = await this.table.getCellByLocation(0, 'Select')
    await radioButton.click();
  }

  /**
* Navigate to Charge Share via the left sidebar.
* Clicks "Billing Data" section → "Charge Share" option.
* Returns the Bills page URL.
*/
  async navigateToChargeShare(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Sharing', 'Charge Share');
    return this.page.url();
  }

  async clickAddNewButton(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
    await this.addNewButton.click();
    await this.page.waitForLoadingToDisappear();

  }


  async modifySharingChargeSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {
      await expect(successToast).toContainText('Create Sharing Group Successfully');
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
      console.log('===ShARING CHARGE CREATION FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Sharing charge create Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }

  async navigateToPayments(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Payments');
    return this.page.url();
  }


  async searchByInvoiceId(invoiceId: string): Promise<void> {
    await this.invoiceInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.invoiceInput.fill(invoiceId);
    await this.page.waitForLoadState('networkidle')
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  async getFirstRowCellValueNew(columnHeader: string): Promise<string> {
    const table = this.page.locator('div#scrollableDiv table');

    await table.waitFor({ state: 'visible' });

    // Find column index by label text
    const headers = table.locator('thead tr.text-dark th');
    const count = await headers.count();

    let colIndex = -1;
    for (let i = 0; i < count; i++) {
      const label = headers.nth(i).locator('label.label-header');
      if (await label.count() > 0) {
        const text = await label.innerText();
        if (text.trim() === columnHeader) {
          colIndex = i;
          break;
        }
      }
    }

    if (colIndex === -1) throw new Error(`Column "${columnHeader}" not found`);

    // Get first row value
    const value = await table.locator('tbody tr').first()
      .locator('td').nth(colIndex)
      .innerText();

    return value.trim();
  }


  async navigateToCreditDebitNotes(): Promise<string> {
    await this.sidebar.navigateToSubScreen('Billing Data', 'Credit/Debit Notes');
    return this.page.url();
  }
}
