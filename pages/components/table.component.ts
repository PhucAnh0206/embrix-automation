import { Page, Locator } from '@playwright/test';
import { MEDIUM_WAIT, SHORT_WAIT } from '../../helpers/timeouts.helper';

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
    protected readonly page: Page,
    protected readonly tableLocator: Locator
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
   */
  async getRowCount(): Promise<number> {
    return this.rows.count();
  }

  /**
   * Get Cell at specific row index and column name.
   */
  async getCellByLocation(rowIndex: number, columnName: string): Promise<Locator> {
    const headers = await this.getHeaders();
    const colIndex = headers.get(columnName);
    console.log(colIndex);
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
   */
  async getCellValue(rowIndex: number, columnName: string): Promise<string> {
    const cell = await this.getCellByLocation(rowIndex, columnName);
    return (await cell.innerText()).trim();
  }

  /**
   * Get cell value for the first row under a column name.
   */
  async getFirstRowCellValue(columnName: string): Promise<string> {
    return this.getCellValue(0, columnName);
  }

  /**
   * Find row index where the cell under matchColumnName matches matchValue.
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
   */
  async getCellValueByMatch(matchColumnName: string, matchValue: string, targetColumnName: string): Promise<string> {
    const rowIndex = await this.findRowIndex(matchColumnName, matchValue);
    return this.getCellValue(rowIndex, targetColumnName);
  }

  /**
   * Find the LAST row index where the cell under matchColumnName matches matchValue.
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
   */
  async clickCellLinkByMatch(matchColumnName: string, matchValue: string, targetColumnName: string): Promise<void> {
    const rowIndex = await this.findRowIndex(matchColumnName, matchValue);
    await this.clickCellLink(rowIndex, targetColumnName);
  }


  /**
   * Input text in a cell identified by row index and column name.
   */
  async fillCellInput(rowIndex: number, columnName: string, value: string): Promise<void> {
    const cell = await this.getCellByLocation(rowIndex, columnName);
    const input = cell.locator('input');
    await input.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await input.fill(value);
  }

  /**
   * Select option from dropdown in a cell identified by rowIndex and columnName.
   */
  async selectCellOption(rowIndex: number, columnName: string, optionText: string): Promise<void> {
    const cell = await this.getCellByLocation(rowIndex, columnName);

    const selectControl = cell.locator('.custom-react-select__control').first();
    await selectControl.click();

    const option = this.page.locator('.custom-react-select__option').getByText(optionText, { exact: true });
    await option.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await option.click();
  }

}
