import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { MEDIUM_WAIT, LONG_WAIT } from '../../helpers/timeouts.helper';

/** What clicking a payment Id pill actually did — every channel a document could arrive on. */
export interface IdPillProbe {
  /** Rendered pill text, or null when no pill was found for the requested id. */
  clicked: string | null;
  /** URL of a popup/new tab, if one opened. */
  popupUrl: string | null;
  /** Suggested filename, if a download started. */
  download: string | null;
  /** Document-ish requests fired by the click (pdf / receipt / s3 / download …). */
  requests: string[];
  /** Net change in the context's tab count. */
  newTabCount: number;
  /** Console errors raised during the click — a silent JS throw looks like "nothing happened". */
  consoleErrors: string[];
}

/**
 * SelfcarePaymentsPage — Self Care top nav → Billing Data → Payments.
 *
 * The CUSTOMER-facing payment list, not the Core UI one. They are different
 * grids: this one renders Account Id | Payment Date | Id | Transaction Id |
 * External Id | Status | Amount | Currency | Payment Method | Remaining Amount,
 * while Core UI's Billing Data → Payments carries 25 columns including Payment
 * Reference Id and Folio UUID. Asserting the Core UI grid when the report is
 * about this one is the easy mistake.
 *
 * The Id cell renders as a bordered pill that looks clickable and is meant to
 * open the payment document. On jasec-dev it opens nothing: no popup, no
 * download, no request, and no console error — `core_engine.payment.filepath` is
 * NULL on every row on the tenant, so there is no document to open.
 * `probeIdPill()` measures all of that instead of asserting a single channel,
 * because headless Chromium never populates a PDF tab's URL and a naive
 * `newPage.url()` check reports "nothing opened" even on a working link.
 */
export class SelfcarePaymentsPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── Nav ─────────────────────────────────────────────────────────────

  /**
   * Top nav → Billing Data → Payments.
   *
   * The item is labelled "Payments" on jasec-dev and "View Payment" in some
   * builds; match either rather than pinning one and skipping silently.
   */
  async navigate(): Promise<void> {
    const billingTab = this.page
      .getByRole('link', { name: /^\s*Billing\s*Data\s*$/i })
      .or(this.page.getByRole('button', { name: /^\s*Billing\s*Data\s*$/i }))
      .first();
    await billingTab.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await this.page.keyboard.press('Escape').catch(() => { });
    await billingTab.click();
    await this.page.waitForTimeout(300);

    const item = this.page
      .getByRole('link', { name: /(View\s*Payment|^\s*Payments?\s*$)/i })
      .or(this.page.getByText(/(View\s*Payment|^\s*Payments?\s*$)/i))
      .first();
    await item.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await item.click();

    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
    await expect(this.table).toBeVisible({ timeout: LONG_WAIT });
  }

  // ── Locators ────────────────────────────────────────────────────────

  /**
   * The payments grid.
   *
   * Anchored on the page HEADING, not on any element containing the word
   * "Payments": the top-nav item is itself called "Payments", so a
   * `contains(.,"Payments")/following::table[1]` xpath resolves against the nav
   * and can select a different table entirely — which is why the first version of
   * this page object could not find a payment the recon dump saw plainly. Falls
   * back to the page's only table when the heading is not where it is expected.
   */
  private get table() {
    return this.page
      .locator(
        'xpath=//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6]' +
        '[normalize-space()="Payments" or normalize-space()="Pagos"]/following::table[1]',
      )
      .or(this.page.locator('table').first())
      .first();
  }

  /** Real rows only — the empty state is itself a row. */
  private get dataRows() {
    return this.table
      .locator('tbody tr')
      .filter({ hasNotText: /No\s*record\s*has\s*found/i });
  }

  // ── Reading ─────────────────────────────────────────────────────────

  /** Rendered header labels, in order. */
  async getHeaders(): Promise<string[]> {
    const ths = this.table.locator('thead th');
    const n = await ths.count();
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(((await ths.nth(i).textContent()) ?? '').trim());
    return out;
  }

  /**
   * Every payment row as a header→cell map, exactly as rendered.
   *
   * Keyed by header so a column reorder does not silently shift assertions onto
   * the wrong field, and untouched by parsing so blank-vs-zero stays visible: on
   * jasec-dev this grid renders Transaction Id, External Id, Currency and Payment
   * Method EMPTY while the DB holds values for the last three.
   */
  async getRows(): Promise<Record<string, string>[]> {
    await this.page.waitForLoadingToDisappear();
    const headers = await this.getHeaders();
    const count = await this.dataRows.count();
    const rows: Record<string, string>[] = [];

    for (let i = 0; i < count; i++) {
      const cells = this.dataRows.nth(i).locator('td');
      const row: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) {
        row[headers[c] || `col${c}`] = ((await cells.nth(c).textContent()) ?? '').trim();
      }
      rows.push(row);
    }
    return rows;
  }

  /** The row for a payment id (e.g. "P137"), or undefined. */
  async findRow(paymentId: string): Promise<Record<string, string> | undefined> {
    return (await this.getRows()).find((r) => Object.values(r).includes(paymentId));
  }

  /**
   * Assert the payment is listed, reloading once if it is not.
   *
   * The reload is not superstition: the sibling Make Payment screen provably does
   * not fetch on dropdown navigation, and a grid that has just been navigated to
   * after a payment is the same shape of risk. Reloading once turns a stale-view
   * bug into a slow pass rather than a false "payment missing" — and if the row is
   * still absent afterwards, that is a real finding.
   */
  async assertPaymentListed(paymentId: string): Promise<void> {
    const present = async () => !!(await this.findRow(paymentId));

    if (await present()) return;

    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
    await this.page.waitForLoadingToDisappear();

    await expect.poll(present, { timeout: LONG_WAIT }).toBe(true);
  }

  // ── The Id pill ─────────────────────────────────────────────────────

  /**
   * Click the Id pill for `paymentId` and report every channel a document could
   * have arrived on. Never throws on "nothing happened" — that IS the result.
   */
  async probeIdPill(paymentId: string): Promise<IdPillProbe> {
    const requests: string[] = [];
    const consoleErrors: string[] = [];

    const ctx = this.page.context();
    const onRequest = (r: { url(): string }) => {
      const u = r.url();
      if (/\.pdf|receipt|document|download|report|s3|amazonaws/i.test(u)) requests.push(u);
    };
    const onConsole = (m: { type(): string; text(): string }) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    };
    ctx.on('request', onRequest as never);
    this.page.on('console', onConsole as never);

    const tabsBefore = ctx.pages().length;

    const row = this.dataRows.filter({ hasText: paymentId }).first();
    const pill = row
      .getByRole('button', { name: new RegExp(`^\\s*${paymentId}\\s*$`) })
      .or(row.getByRole('link', { name: new RegExp(`^\\s*${paymentId}\\s*$`) }))
      .or(row.locator('td').filter({ hasText: new RegExp(`^\\s*${paymentId}\\s*$`) }))
      .first();

    let clicked: string | null = null;
    let popupUrl: string | null = null;
    let download: string | null = null;

    if (await pill.isVisible().catch(() => false)) {
      clicked = ((await pill.textContent().catch(() => '')) ?? '').trim() || null;

      const popupPromise = ctx.waitForEvent('page', { timeout: MEDIUM_WAIT }).catch(() => null);
      const downloadPromise = this.page
        .waitForEvent('download', { timeout: MEDIUM_WAIT })
        .catch(() => null);

      await pill.click({ timeout: MEDIUM_WAIT }).catch(() => { });

      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: MEDIUM_WAIT }).catch(() => { });
        popupUrl = popup.url();
      }
      const dl = await downloadPromise;
      if (dl) download = dl.suggestedFilename();

      // A slow document call still counts as working — give it room before
      // declaring the click inert.
      await this.page.waitForTimeout(3000);
    }

    ctx.off('request', onRequest as never);
    this.page.off('console', onConsole as never);

    return {
      clicked,
      popupUrl,
      download,
      requests,
      newTabCount: ctx.pages().length - tabsBefore,
      consoleErrors: consoleErrors.slice(0, 20),
    };
  }
}
