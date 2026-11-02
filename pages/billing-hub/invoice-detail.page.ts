import { Page, Locator } from '@playwright/test';
import { BasePage } from '../base.page';
import { SHORT_WAIT, MEDIUM_WAIT } from '../../helpers/timeouts.helper';

/** A dialog table row as header-name -> rendered cell text. */
export type UiRow = Record<string, string>;

/** Strip currency symbols and thousands separators from a rendered cell. */
export const uiNum = (s: string): number => {
  const withCommas = String(s ?? '').replace(/[^\d.,\-]/g, '').trim();
  const out = Number(withCommas.replace(/,/g, ''));
  return Number.isNaN(out) ? NaN : out;
};

/** How many decimal places a rendered figure actually shows. */
export const uiDecimals = (s: string): number => {
  const m = String(s ?? '').trim().match(/\.(\d+)$/);
  return m ? m[1].length : 0;
};

/**
 * InvoiceDetailPage — the invoice as an AGENT sees it.
 *
 * Billing Hub -> Billing -> search by account -> row -> View -> detail dialog,
 * then the dialog's own tabs (Invoice Summary, Tax Lines, ...).
 *
 * WHY THIS EXISTS. The billing read specs assert the invoice over GraphQL, which
 * cannot see how the figure is RENDERED. That blind spot is not theoretical: the
 * Amount column prints `144.29999999999998` where Gross correctly prints
 * `144.30` (Finding 2 of EXPLORE_invoice-document-vs-coreui, still live), and the
 * tax base on screen cannot be reconciled from the lines on screen (Finding 3).
 * Neither is visible to a database read.
 *
 * The selectors here are NOT new. They are lifted verbatim from
 * explore-01-invoice-document.spec.ts, where they have worked since 2026-08-19, so
 * that there is exactly ONE copy of the fragile parts. Three of them are
 * non-obvious and are commented at their use sites below; do not "simplify" them
 * without re-reading those comments.
 *
 * Tester: Anh Tran (QC)
 */
export class InvoiceDetailPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  private get dialog(): Locator { return this.page.locator('[role="dialog"]'); }
  private get startDate(): Locator { return this.page.locator(`//input[@name='startDate']`).first(); }
  private get endDate(): Locator { return this.page.locator(`//input[@name='endDate']`).first(); }
  private get accountIdInput(): Locator { return this.page.locator(`//input[@name='accountId']`).first(); }
  private get searchButton(): Locator { return this.page.getByRole('button', { name: 'Search' }); }

  /** Hover "Billing Hub" -> click "Billing". */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Billing Hub/i);
    await this.clickNavLink(/Billing/i, /invoicing-billing/i);
  }

  /**
   * Find an invoice in the Billing grid and open its detail dialog.
   *
   * @param accountId account the invoice belongs to
   * @param invoiceId the invoice id as rendered, e.g. "002796"
   * @param invoiceYear the invoice's YEAR, used only to size the search window
   * @returns the grid row as header -> cell text, dialog left OPEN
   */
  async open(accountId: string, invoiceId: string, invoiceYear: number): Promise<UiRow> {
    await this.page.navigateToHome();
    await this.navigateViaNav();
    await this.page.waitForTimeout(SHORT_WAIT);

    /**
     * THE GRID'S DATE FILTER IS THE BILL PERIOD, NOT THE INVOICE DATE — the
     * columns are literally "Bill Start Date" / "Bill End Date". Searching
     * invoiceDate..invoiceDate returns "No records found" for an invoice that
     * certainly exists, because its period closes before the invoice is dated.
     * The window is deliberately a year either side: this tenant's CCP clock has
     * been pushed as far as 2027-12, so anything anchored on "today" finds
     * nothing.
     */
    if (await this.startDate.isVisible().catch(() => false)) {
      await this.startDate.fill(`${invoiceYear - 1}-01-01`);
      await this.endDate.fill(`${invoiceYear + 1}-12-31`);
    }

    await this.accountIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.accountIdInput.fill(accountId);
    await this.page.waitForLoadState('networkidle');
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForTimeout(MEDIUM_WAIT);

    const grid = this.page.locator('table').first();
    const headers = (await grid.locator('thead th').allInnerTexts()).map((h) => h.trim());
    const row = this.page.locator('table tbody tr').filter({ hasText: invoiceId }).first();
    if (!(await row.count())) {
      throw new Error(
        `invoice ${invoiceId} is not in the Billing grid for account ${accountId}. `
        + `Grid headers: ${JSON.stringify(headers)}`,
      );
    }
    const cells = await row.locator('td').allInnerTexts();
    const map: UiRow = {};
    headers.forEach((h, i) => { map[h] = (cells[i] ?? '').trim(); });

    /**
     * TWO "View" BUTTONS ON THE ROW. td[1]'s opens the STAMPING popup; td[2]'s
     * opens the invoice detail. Taking the first one lands on the wrong dialog.
     */
    const viewButtons = row.getByRole('button', { name: /^View$/i });
    const n = await viewButtons.count();
    if (!n) throw new Error(`no View button on the row for invoice ${invoiceId}`);
    await viewButtons.nth(n > 1 ? 1 : 0).click();
    await this.dialog.waitFor({ state: 'visible' });
    await this.page.waitForTimeout(SHORT_WAIT);
    return map;
  }

  /** Read one dialog table by index as header -> cell text maps. */
  private async readDialogTable(index: number): Promise<UiRow[]> {
    const table = this.dialog.locator('table').nth(index);
    if (!(await table.count())) return [];
    const headers = (await table.locator('thead th').allInnerTexts()).map((h) => h.trim());
    const rows = table.locator('tbody tr');
    const out: UiRow[] = [];
    for (let i = 0; i < await rows.count(); i += 1) {
      const cells = await rows.nth(i).locator('td').allInnerTexts();
      const m: UiRow = {};
      headers.forEach((h, j) => { m[h] = (cells[j] ?? '').trim(); });
      /**
       * DROP THE EMPTY-STATE ROW. An empty tab still renders its <thead>, plus one
       * <tbody> row holding a single "No records found" cell. Mapped against the
       * headers that row looks like a real record — it even carries a
       * `Taxable Amount` key — so `findTable` matched it and an invoice with NO
       * tax rows reported ONE. That read as a product discrepancy (UI shows a tax
       * the record does not have) when it was this reader's fault. Measured on
       * invoice 002797, which correctly has no tax below 100 kWh.
       */
      const joined = Object.values(m).join('').trim();
      if (!joined) continue;
      if (/^(no records found|no data|not found|sin registros)$/i.test(joined)) continue;
      out.push(m);
    }
    return out;
  }

  /** Click one of the dialog's tabs by its button name. */
  async openTab(name: string): Promise<void> {
    await this.page.getByRole('button', { name }).first().click();
    await this.page.waitForTimeout(SHORT_WAIT);
  }

  /**
   * Find the first dialog table whose first row satisfies `pick`.
   *
   * Index-based lookup is not safe here: the tab decides how many tables render
   * and in what order, so both callers below identify their table by SHAPE.
   */
  private async findTable(pick: (first: UiRow) => boolean): Promise<UiRow[]> {
    const n = await this.dialog.locator('table').count();
    for (let i = 0; i < n; i += 1) {
      const rows = await this.readDialogTable(i);
      if (rows.length && pick(rows[0])) return rows;
    }
    return [];
  }

  /**
   * The printed document body — the charge lines, as rendered.
   *
   * TWO TABLES IN THIS TAB CARRY Name + Amount: the EDITABLE line grid, whose
   * cells are <input> elements so innerText comes back EMPTY, and the read-only
   * summary table. Matching on headers alone picks the editable one and every
   * name assertion then compares against "". Requiring a NON-EMPTY Name in the
   * first row is what selects the read-only table.
   */
  async invoiceLines(): Promise<UiRow[]> {
    await this.openTab('Invoice Summary');
    return this.findTable((r) => 'Name' in r && 'Amount' in r && !!r['Name']);
  }

  /** The dialog's own tax table. Identified by its "Taxable Amount" column. */
  async taxLines(): Promise<UiRow[]> {
    await this.openTab('Tax Lines');
    return this.findTable((r) => 'Taxable Amount' in r);
  }

  /** Every table currently rendered in the dialog, for diagnostics. */
  async allDialogTables(): Promise<UiRow[][]> {
    const n = await this.dialog.locator('table').count();
    const out: UiRow[][] = [];
    for (let i = 0; i < n; i += 1) out.push(await this.readDialogTable(i));
    return out;
  }

  async close(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => undefined);
  }
}
