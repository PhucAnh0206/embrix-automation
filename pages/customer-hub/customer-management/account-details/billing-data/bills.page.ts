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

  /**
   * Set the Start/End Date filter, and PROVE it took.
   *
   * FAIL CLOSED. A fill that does not stick is otherwise invisible: the screen
   * keeps its own default window (these grids default to the whole current
   * month), the search runs against dates nobody asked for, and the grid comes
   * back empty. On the usage screens an empty grid is EXACTLY the defect under
   * test, so a silent filter failure is indistinguishable from a product bug.
   *
   * Not hypothetical. On 2026-09-22 ts-07 asked for 2026-08-22 -> 2026-08-26 on
   * Usage Records; the fields still read 2026-09-01 -> 2026-09-30, the reading
   * was dated 2026-08-24, and BOTH jasec-dev and jasec-preprod were reported as
   * still carrying the defect when the run had simply searched the wrong month.
   *
   * The picker commits on blur, so the value is committed with Tab before it is
   * read back.
   */
  async searchByDate(startDate: string, endDate: string): Promise<void> {
    // LOCATE BY THE VISIBLE LABEL, not by name. `input[name='startDate']`
    // matches on Rated Usage but picks up a different node on Usage Records,
    // whose filter panel carries ~20 fields — the fill lands somewhere the user
    // cannot see and the real Start/End Date keep their month defaults. Same
    // class of bug as `table#scrollableDiv`: a locator right on one screen and
    // silently wrong on its sibling. The label is what the user reads, so bind
    // to that and fall back to the name-based pair only if the label is absent.
    const byLabel = (label: string) =>
      this.page.getByText(label, { exact: true }).first()
        .locator('xpath=following::input[1]');

    const startInput = (await byLabel('Start Date').count())
      ? byLabel('Start Date') : this.startDateInput;
    const endInput = (await byLabel('End Date').count())
      ? byLabel('End Date') : this.endDateInput;

    // DRIVE THE CALENDAR, do not type into the box.
    //
    // Clicking the field opens a react-datepicker; it takes focus, so keystrokes
    // aimed at the input never reach it and the calendar commits a date of its
    // own. That is why five typing variants — fill+Tab, label-bound fill,
    // type+Enter, type+Escape+Tab, three different encodings — all produced
    // 2026-02-10 no matter which window was requested, on both tenants.
    //
    // The widget is standard: a year select, a month select, a day grid, and a
    // Time field. Use them.
    const setDate = async (input: Locator, value: string) => {
      const [y, m, d] = value.slice(0, 10).split('-').map(Number);

      await input.waitFor({ state: 'visible', timeout: SHORT_WAIT });
      await input.click();

      const cal = this.page.locator('.react-datepicker').last();
      await cal.waitFor({ state: 'visible', timeout: SHORT_WAIT });

      await cal.locator('select.react-datepicker__year-select').selectOption(String(y));
      // react-datepicker months are 0-based in the select value.
      await cal.locator('select.react-datepicker__month-select').selectOption(String(m - 1));

      // Exact text, and NOT a greyed-out neighbouring-month cell — those carry
      // the same number and clicking one silently jumps the month.
      await cal
        .locator('.react-datepicker__day:not(.react-datepicker__day--outside-month)')
        .filter({ hasText: new RegExp(`^${d}$`) })
        .first()
        .click();

      // Dismiss the calendar so the next field is clickable.
      await this.page.keyboard.press('Escape');
    };

    await setDate(startInput, startDate);
    await setDate(endInput, endDate);

    const gotStart = (await startInput.inputValue()).trim();
    const gotEnd = (await endInput.inputValue()).trim();
    const day = (v: string) => v.slice(0, 10);

    if (day(gotStart) !== day(startDate) || day(gotEnd) !== day(endDate)) {
      throw new Error(
        'searchByDate did not take effect on this screen. Asked for '
        + `${startDate} -> ${endDate}, the fields read `
        + `${gotStart || '<empty>'} -> ${gotEnd || '<empty>'}. `
        + 'Searching now would use a window nobody asked for, and an empty grid '
        + 'would be meaningless. Fix the filter before trusting any result.',
      );
    }
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

  /**
   * The results grid on **Rated Usage** and on **Usage Records**.
   *
   * NOT `resultsTable`. That one is `table#scrollableDiv`, which belongs to the
   * Bills screen and matches nothing on either usage screen — so `tableRows`
   * resolves to zero and `getAllTableData()` returns `[]` while the grid is
   * plainly full. That reads as "the screen is empty", which is exactly the
   * defect these screens are tested for, so the wrong locator produces a
   * convincing false positive. Found on jasec-dev 2026-09-22.
   *
   * Both usage grids render a plain `<table>`; the results grid is the one
   * carrying a "Usage Id" column header.
   */
  private get usageGrid(): Locator {
    return this.page.locator('table').filter({
      has: this.page.getByRole('columnheader', { name: 'Usage Id', exact: true }),
    });
  }

  /**
   * Every DATA row of the Rated Usage / Usage Records grid, as cell text.
   *
   * An empty grid still renders one `<tr>` — a single cell reading "No records
   * found". Counting that as a row makes an empty screen look like a populated
   * one, which is the precise failure these screens are tested for, so it is
   * dropped here rather than in each caller.
   */
  async getUsageGridRows(): Promise<string[][]> {
    const rows = await this.usageGrid.locator('tbody tr').all();
    const out: string[][] = [];
    for (const row of rows) {
      const cells = await row.locator('td').allTextContents();
      if (cells.length <= 1 && /no records found/i.test(cells.join(' '))) continue;
      out.push(cells);
    }
    return out;
  }

  /** Column headers of the Rated Usage / Usage Records grid. */
  async getUsageGridHeaders(): Promise<string[]> {
    return this.usageGrid.locator('thead th').allTextContents();
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
