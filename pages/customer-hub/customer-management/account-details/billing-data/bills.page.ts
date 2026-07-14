import { Page, expect } from '@playwright/test';
import { BasePage } from '../../../../base.page';
import { SidebarComponent } from '../../../../components/sidebar.component';
import { TableComponent } from '../../../../components/table.component';
import { TestLogger } from '../../../../../helpers/test-logger';
import { SHORT_WAIT } from '../../../../../helpers/timeouts.helper';

export interface InvoiceParams {
  testLogger?: TestLogger;
  row?: number;
  billUnitId?: string;
  billType?: string;
  startDate?: string;
  endDate?: string;
  total?: string;
  invoiceDate?: string;
  invoiceStatus?: string;
  invoiceId?: string;
}

/**
 * BillsPage — Page Object for the Billing Data > Bills screen.
 *
 * Accessed via: Account Info sidebar → Billing Data → Bills
 */
export class BillsPage extends BasePage {
  readonly sidebar: SidebarComponent;
  readonly openClosedBillsTable: TableComponent;
  readonly pendingBillsTable: TableComponent;
  readonly testLogger?: TestLogger;

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page, testLogger?: TestLogger) {
    super(page);
    this.sidebar = new SidebarComponent(page);
    this.openClosedBillsTable = new TableComponent(
      page,
      this.page.locator('//h5[contains(text(), "Open/Closed bills")]/following::table[1]')
    );
    this.pendingBillsTable = new TableComponent(
      page,
      this.page.locator('//h5[contains(text(), "Pending Bills")]/following::table[1]')
    );
    this.testLogger = testLogger;
  }

  /**
   * Navigate to Bills via the left sidebar.
   * Clicks "Billing Data" section → "Bills" option.
   * Returns the Bills page URL.
   */
  async navigateViaSideMenu(): Promise<string> {
    return this.sidebar.navigateTo('Billing Data', 'Bills');
  }

  /**
   * Get cell value from a row where Invoice Id matches the given value.
   * @param tableName The table name to search for the invoice
   * @param invoiceId The invoice ID to locate the row
   * @param columnName The column to read the value from
   */
  async getRowCellValueByInvoiceId(tableName: 'Open/Closed Bills' | 'Pending Bills', id: string, columnName: string): Promise<string> {
    let actualValue = '';

    await this.setPageSizeTo100(tableName);

    const table = tableName === 'Open/Closed Bills' ? this.openClosedBillsTable : this.pendingBillsTable;

    try {
      actualValue = await table.getCellValueByMatch('Invoice Id', id, columnName);
    } catch {
      try {
        actualValue = await table.getCellValueByMatch('Bill Unit Id', id, columnName);
      } catch {
        actualValue = '';
      }
    }

    return actualValue;
  }

  /**
   * Set page size select to 100 for the specified table.
   */
  async setPageSizeTo100(tableName: 'Open/Closed Bills' | 'Pending Bills'): Promise<void> {
    const tableTitle = tableName === 'Open/Closed Bills' ? 'Open/Closed bills' : 'Pending Bills';

    // Find the select element specifically for records per page (avoid matching action selects)
    const selectPageSize = this.page.locator(
      `xpath=//h5[contains(text(), "${tableTitle}")]/following::div[contains(@class, "pagination") or contains(@class, "page")]//select | ` +
      `//h5[contains(text(), "${tableTitle}")]/following::select[contains(@class, "page") or contains(@class, "size") or contains(@id, "page") or contains(@name, "page")]`
    ).first();

    if (await selectPageSize.count() > 0 && await selectPageSize.isVisible()) {
      const currentSize = await selectPageSize.inputValue().catch(() => '');
      if (currentSize !== '100') {
        // Use a short timeout of 3s to prevent hanging if it's the wrong select
        await selectPageSize.selectOption('100', { timeout: SHORT_WAIT }).catch(() => { });
        await this.page.waitForTimeout(SHORT_WAIT); // Wait for reload to trigger
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForLoadingToDisappear().catch(() => { });
      }
    } else {
      // If it's a react-select or similar custom dropdown, try locating and clicking it
      const customSelect = this.page.locator(
        `xpath=//h5[contains(text(), "${tableTitle}")]/following::div[contains(@class, "react-select") or contains(@class, "pagination")]//input`
      ).first();

      if (await customSelect.count() > 0 && await customSelect.isVisible()) {
        await customSelect.click();
        const option100 = this.page.locator('div').filter({ hasText: /^100$/ }).first();
        if (await option100.count() > 0 && await option100.isVisible()) {
          await option100.click()
          await this.page.waitForLoadState('networkidle').catch(() => { });
          await this.page.waitForLoadingToDisappear().catch(() => { });
        }
      }
    }
  }

  /**
   * Helper to set page size to 100, compare Bill Unit IDs, find the new row index,
   * and update the saved context with the new list of Bill Unit IDs.
   */
  private async findNewRowAndUpdateContext(
    tableName: 'Open/Closed Bills' | 'Pending Bills',
    table: TableComponent,
    inputRow?: number,
    inputBillUnitId?: string
  ): Promise<{ targetRow: number; targetBillUnitId: string }> {
    // Load context helpers dynamically
    const { loadTestContext, updateTestContext } = require('../../../../../helpers/test-context.helper');

    // 1. Set page size to 100
    await this.setPageSizeTo100(tableName);

    // Wait for the table rows to be present/loaded (up to 5s) before reading values
    await table.rows.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });

    // 2. Get all Bill Unit IDs from the target table
    const allBillUnitIds = await table.getAllColumnValues('Bill Unit Id').catch(() => []);

    // 3. Load the old lists from context
    let savedContext: any = {};
    try {
      savedContext = loadTestContext();
    } catch {
      // Ignored
    }

    // Choose the list based on tableName to prevent pollution between Open/Closed and Pending tables
    const listKey = tableName === 'Open/Closed Bills' ? 'billList' : 'pendingBillList';
    const oldBillList = savedContext[listKey] || [];

    // 4. Find the new Bill Unit ID
    let targetBillUnitId = inputBillUnitId || '';
    let targetRow = inputRow !== undefined ? inputRow : 0;

    const newBillUnitId = allBillUnitIds.find((id: string) => id && !oldBillList.includes(id));

    if (oldBillList.length === 0) {
      targetRow = 0;
      if (allBillUnitIds[0]) {
        targetBillUnitId = allBillUnitIds[0];
      }
    } else {
      if (newBillUnitId) {
        targetBillUnitId = newBillUnitId;
        targetRow = await table.findRowIndex('Bill Unit Id', targetBillUnitId);
      } else if (targetBillUnitId) {
        try {
          targetRow = await table.findRowIndex('Bill Unit Id', targetBillUnitId);
        } catch {
          // Fallback if not found
        }
      } else {
        // Fallback: check if targetRow is within bounds
        const count = await table.getRowCount();
        if (targetRow >= count) {
          targetRow = count > 0 ? count - 1 : 0;
        }
      }
    }

    // Print detailed verification logs
    const logPrefix = `[Invoice Verification - ${tableName}]`;
    const logMsg = `
            ${logPrefix} Old billList in context: ${JSON.stringify(oldBillList)}
            ${logPrefix} Current bills in table: ${JSON.stringify(allBillUnitIds)}
            ${logPrefix} New bill detected: ${newBillUnitId || 'None'}
            ${logPrefix} Resolved to Row: ${targetRow}, Bill Unit ID: ${targetBillUnitId || 'Unknown'}`;

    if (this.testLogger) {
      this.testLogger.log(logMsg);
    } else {
      console.log(logMsg);
    }

    // 5. Update the context with the union of old and new bill lists
    const updatedBillList = Array.from(new Set([...oldBillList, ...allBillUnitIds]));
    updateTestContext({ [listKey]: updatedBillList });

    return { targetRow, targetBillUnitId };
  }

  /**
   * Read and verify key fields of an invoice row in the Open/Closed Bills table.
   */
  async verifyOpenClosedInvoiceRow({
    row,
    billUnitId,
    billType,
    startDate,
    endDate,
    total,
    invoiceDate,
    invoiceStatus,
  }: InvoiceParams): Promise<InvoiceParams> {
    const { targetRow, targetBillUnitId } = await this.findNewRowAndUpdateContext(
      'Open/Closed Bills',
      this.openClosedBillsTable,
      row,
      billUnitId
    );

    const UI_billUnitId = targetBillUnitId || (await this.openClosedBillsTable.getCellValue(targetRow, 'Bill Unit Id'));
    const UI_billType = await this.openClosedBillsTable.getCellValue(targetRow, 'Bill Type');
    const UI_startDate = await this.openClosedBillsTable.getCellValue(targetRow, 'Start Date');
    const UI_endDate = await this.openClosedBillsTable.getCellValue(targetRow, 'End Date');
    const UI_total = await this.openClosedBillsTable.getCellValue(targetRow, 'Total');
    const UI_invoiceDate = await this.openClosedBillsTable.getCellValue(targetRow, 'Invoice Date');
    const UI_invoiceStatus = await this.openClosedBillsTable.getCellValue(targetRow, 'Invoice Status');
    const UI_invoiceId = await this.openClosedBillsTable.getCellValue(targetRow, 'Invoice Id').catch(() => '');

    const actualInvoiceDetails = {
      row: targetRow,
      billUnitId: UI_billUnitId,
      billType: UI_billType,
      startDate: UI_startDate,
      endDate: UI_endDate,
      total: UI_total,
      invoiceDate: UI_invoiceDate,
      invoiceStatus: UI_invoiceStatus,
      invoiceId: UI_invoiceId,
    };

    this.testLogger?.data('Actual Open/Closed invoice details', actualInvoiceDetails);

    if (billType) {
      expect(UI_billType).toBe(billType);
    }
    if (startDate) {
      expect(UI_startDate).toBe(startDate);
    }
    if (endDate) {
      expect(UI_endDate).toBe(endDate);
    }
    if (total) {
      expect(UI_total).toBe(total);
    }
    if (invoiceDate) {
      expect(UI_invoiceDate).toBe(invoiceDate);
    }
    if (invoiceStatus) {
      expect(UI_invoiceStatus).toBe(invoiceStatus);
    }

    return actualInvoiceDetails;
  }

  /**
   * Read and verify key fields of an invoice row in the Pending Bills table.
   */
  async verifyPendingInvoiceRow({
    row,
    billUnitId,
    startDate,
    endDate,
    total,
    invoiceStatus,
  }: InvoiceParams): Promise<InvoiceParams> {
    const { targetRow, targetBillUnitId } = await this.findNewRowAndUpdateContext(
      'Pending Bills',
      this.pendingBillsTable,
      row,
      billUnitId
    );

    const UI_billUnitId = targetBillUnitId || (await this.pendingBillsTable.getCellValue(targetRow, 'Bill Unit Id').catch(() => ''));
    const UI_startDate = await this.pendingBillsTable.getCellValue(targetRow, 'Start Date');
    const UI_endDate = await this.pendingBillsTable.getCellValue(targetRow, 'End Date');
    const UI_total = await this.pendingBillsTable.getCellValue(targetRow, 'Total');
    const UI_invoiceStatus = await this.pendingBillsTable.getCellValue(targetRow, 'Status');

    const actualInvoiceDetails = {
      row: targetRow,
      billUnitId: UI_billUnitId,
      startDate: UI_startDate,
      endDate: UI_endDate,
      total: UI_total,
      invoiceStatus: UI_invoiceStatus,
    };

    this.testLogger?.data('Actual Pending invoice details', actualInvoiceDetails);

    if (startDate) {
      expect(UI_startDate).toBe(startDate);
    }
    if (endDate) {
      expect(UI_endDate).toBe(endDate);
    }
    if (total) {
      expect(UI_total).toBe(total);
    }
    if (invoiceStatus) {
      expect(UI_invoiceStatus).toBe(invoiceStatus);
    }

    return actualInvoiceDetails;
  }
}
