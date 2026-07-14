import { Page, Locator } from '@playwright/test';
import { MEDIUM_WAIT } from '../../helpers/timeouts.helper';

/**
 * TableComponent — Reusable component for interacting with grid tables.
 *
 * Scoped to a specific table Locator. Provides helpers to read headers, rows,
 * fetch cells by column name, find rows matching a value, and click actions.
 */
export class TableComponent {
  private headerMap: Map<string, number> | null = null;

  /**
   * @param page - Playwright's Page instance.
   * @param tableLocator - Locator targeting the root <table> element or scroll container containing rows.
   */
  constructor(
    readonly page: Page,
    readonly tableLocator: Locator
  ) { }


  /** Lazy locator for header cells. */
  private get headerCells(): Locator {
    return this.tableLocator.locator('thead th, thead td');
  }


  /** Lazy locator for table body rows. */
  get rows(): Locator {
    return this.tableLocator.locator('tbody tr');
  }


  /**
   * Parse headers and cache them in a map of (columnName -> index).
   * @param forceRefresh - Force refresh the headers.
   * @returns A Promise that resolves to the headers map.
   */
  async getHeaders(forceRefresh = false): Promise<Map<string, number>> {
    if (this.headerMap && !forceRefresh) {
      return this.headerMap;
    }

    await this.headerCells.first().waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    const allTexts = await this.headerCells.allTextContents();
    const map = new Map<string, number>();

    allTexts.forEach((text, index) => {
      const cleaned = text.trim();
      if (cleaned) {
        map.set(cleaned, index);
      }
    });

    this.headerMap = map;
    return map;
  }


  /**
   * Get total row count inside tbody.
   * @returns A Promise that resolves to the total number of rows in the table.
   */
  async getRowCount(): Promise<number> {
    return this.rows.count();
  }


  /**
   * Get Cell at specific row index and column name.
   * @param rowIndex - The index of the row to get the value from.
   * @param columnName - The name of the column to get the value from.
   * @returns A Promise that resolves to the Locator of the cell in the columnName column.
   */
  async getCellByLocation(rowIndex: number, columnName: string): Promise<Locator> {
    const headers = await this.getHeaders();
    const colIndex = headers.get(columnName);
    if (colIndex === undefined) {
      throw new Error(`Column "${columnName}" not found. Available columns: ${[...headers.keys()].join(', ')}`);
    }

    const row = this.rows.nth(rowIndex);
    await row.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    const cell = row.locator('td, th').nth(colIndex);
    return cell;
  }


  /**
   * Get text value of a cell at specific row index and column name.
   * @param rowIndex - The index of the row to get the value from.
   * @param columnName - The name of the column to get the value from.
   * @returns A Promise that resolves to the value of the cell in the columnName column.
   */
  async getCellValue(rowIndex: number, columnName: string): Promise<string> {
    const cell = await this.getCellByLocation(rowIndex, columnName);
    return (await cell.innerText()).trim();
  }


  /**
   * Get cell value for the first row under a column name.
   * @param columnName - The name of the column to get the value from.
   * @returns A Promise that resolves to the value of the cell in the columnName column.
   */
  async getFirstRowCellValue(columnName: string): Promise<string> {
    return this.getCellValue(0, columnName);
  }


  /**
   * Find row index where the cell under matchColumnName matches matchValue.
   * @param matchColumnName - The name of the column to match.
   * @param matchValue - The value to match in the matchColumnName column.
   * @returns A Promise that resolves to the index of the row that matches the matchValue.
   */
  async findRowIndex(matchColumnName: string, matchValue: string): Promise<number> {
    const headers = await this.getHeaders();
    const matchColIndex = headers.get(matchColumnName);
    if (matchColIndex === undefined) {
      throw new Error(`Match column "${matchColumnName}" not found. Available columns: ${[...headers.keys()].join(', ')}`);
    }

    const cellLocators = this.rows.locator(`td:nth-child(${matchColIndex + 1}), th:nth-child(${matchColIndex + 1})`);
    const allCellTexts = await cellLocators.allTextContents();
    const index = allCellTexts.findIndex(text => text.trim() === matchValue);

    if (index === -1) {
      throw new Error(`Row with "${matchColumnName}" = "${matchValue}" not found.`);
    }

    return index;
  }


  /**
   * Get cell value from a row matched by another cell's value.
   * @param matchColumnName - The name of the column to match.
   * @param matchValue - The value to match in the matchColumnName column.
   * @param targetColumnName - The name of the column to get the value from.
   * @returns A Promise that resolves to the value of the cell in the targetColumnName column.
   */
  async getCellValueByMatch(matchColumnName: string, matchValue: string, targetColumnName: string): Promise<string> {
    const rowIndex = await this.findRowIndex(matchColumnName, matchValue);
    return this.getCellValue(rowIndex, targetColumnName);
  }


  /**
   * Find the LAST row index where the cell under matchColumnName matches matchValue.
   * @param matchColumnName - The name of the column to match.
   * @param matchValue - The value to match in the matchColumnName column.
   * @returns A Promise that resolves to the index of the row that matches the matchValue.
   */
  async findLastRowIndex(matchColumnName: string, matchValue: string): Promise<number> {
    const headers = await this.getHeaders();
    const matchColIndex = headers.get(matchColumnName);
    if (matchColIndex === undefined) {
      throw new Error(`Match column "${matchColumnName}" not found. Available columns: ${[...headers.keys()].join(', ')}`);
    }

    const cellLocators = this.rows.locator(`td:nth-child(${matchColIndex + 1}), th:nth-child(${matchColIndex + 1})`);
    const allCellTexts = await cellLocators.allTextContents();
    let lastIndex = -1;
    allCellTexts.forEach((text, index) => {
      if (text.trim() === matchValue) {
        lastIndex = index;
      }
    });

    if (lastIndex === -1) {
      throw new Error(`Row with "${matchColumnName}" = "${matchValue}" not found.`);
    }

    return lastIndex;
  }


  /**
   * Click an element (link, button, input) inside a cell, or the cell itself.
   * @param rowIndex - The index of the row to click the link in.
   * @param columnName - The name of the column to click the link in.
   * @returns A Promise that resolves to void.
   */
  async clickCellLink(rowIndex: number, columnName: string): Promise<void> {
    const headers = await this.getHeaders();
    const colIndex = headers.get(columnName);
    if (colIndex === undefined) {
      throw new Error(`Column "${columnName}" not found. Available columns: ${[...headers.keys()].join(', ')}`);
    }

    const row = this.rows.nth(rowIndex);
    await row.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    const cell = row.locator('td, th').nth(colIndex);

    // Try clicking an interactive element (link, button, input, checkbox, svg, etc.)
    const interactive = cell.locator('a, button, input, [role="button"], svg, i').first();
    if (await interactive.count() > 0 && await interactive.isVisible()) {
      await interactive.click();
    } else {
      await cell.click();
    }

  }


  /**
   * Locate a row by matching cell value and click target column link.
   * @param matchColumnName - The name of the column to match.
   * @param matchValue - The value to match in the matchColumnName column.
   * @param targetColumnName - The name of the column to click the link in.
   * @returns A Promise that resolves to void.
   */
  async clickCellLinkByMatch(matchColumnName: string, matchValue: string, targetColumnName: string): Promise<void> {
    const rowIndex = await this.findRowIndex(matchColumnName, matchValue);
    await this.clickCellLink(rowIndex, targetColumnName);
  }


  /**
   * Get all text values in a column.
   * @param columnName - The name of the column to get the values from.
   * @returns A Promise that resolves to an array of strings containing all the values in the specified column.
   */
  async getAllColumnValues(columnName: string): Promise<string[]> {
    const headers = await this.getHeaders();
    const colIndex = headers.get(columnName);
    if (colIndex === undefined) {
      throw new Error(`Column "${columnName}" not found. Available columns: ${[...headers.keys()].join(', ')}`);
    }

    const cellLocators = this.rows.locator(`td:nth-child(${colIndex + 1}), th:nth-child(${colIndex + 1})`);
    const allCellTexts = await cellLocators.allTextContents();
    return allCellTexts.map(text => text.trim());
  }
}
