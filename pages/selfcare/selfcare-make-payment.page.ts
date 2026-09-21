import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../helpers/timeouts.helper';
import type { SelfcareActivityPage } from './selfcare-activity.page';

/**
 * SelfcareMakePaymentPage — Activity → Make Payment.
 *
 * This screen SETTLES INVOICES. It is not the wallet screen — Top Up, one item
 * away in the same Activity dropdown, credits the wallet with no invoice
 * involved. Confusing the two is the main trap here.
 *
 * What feeds the grid (traced 2026-08-26 on jasec-dev, see
 * tests/regression/jasec/payment/explore-01-make-payment-recon.spec.ts):
 *
 *   rated MDR usage → transaction_unit (USAGE / MEDIATION) → end-of-cycle
 *   billing job → bill_unit → invoice_unit (status ACTIVE, due > 0)
 *     → GraphQL `searchInvoiceUnits` → this grid
 *
 * Layout:
 *   • "Select Invoices" grid — Select | Invoice Id | Invoice Date | Due Date |
 *     Invoice Amount | Due. Empty state renders as a row reading
 *     "No record has found!".
 *   • "Total Selected To Pay :<n>" — running total of ticked rows.
 *   • "Card On File" — the saved token, if any.
 *   • PAY NOW (saved token, no redirect) and PAY WITH PLACETOPAY (redirects).
 *     BOTH are disabled until at least one invoice is ticked.
 */
export class SelfcareMakePaymentPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── Locators ────────────────────────────────────────────────────────

  /** The invoice grid — anchored on the "Select Invoices" heading above it. */
  private get invoiceTable() {
    return this.page
      .locator(
        'xpath=//*[contains(normalize-space(.),"Select Invoices") or contains(normalize-space(.),"Seleccionar Facturas")]/following::table[1]',
      )
      .first();
  }

  /**
   * Real data rows only.
   *
   * The empty state is rendered AS A TABLE ROW ("No record has found!"), so a
   * bare `tbody tr` count returns 1 for an empty grid — which would turn "the
   * invoice is missing" into a passing assertion.
   */
  private get dataRows() {
    return this.invoiceTable
      .locator('tbody tr')
      .filter({ hasNotText: /No\s*record\s*has\s*found/i });
  }

  private get payNowButton() {
    return this.page.getByRole('button', { name: /^\s*Pay\s*Now\s*$/i }).first();
  }

  private get payWithPlaceToPayButton() {
    return this.page.getByRole('button', { name: /Pay\s*With\s*PlaceToPay/i }).first();
  }

  /** The "Total Selected To Pay :<n>" heading. */
  private get totalSelectedHeading() {
    return this.page
      .getByText(/Total\s*Selected\s*To\s*Pay\s*:/i)
      .first();
  }

  // ── Loading ─────────────────────────────────────────────────────────

  /** Assert we are on Make Payment (both pay buttons present). */
  async assertLoaded(): Promise<void> {
    await this.page.waitForLoadingToDisappear();
    await expect(this.payNowButton).toBeVisible({ timeout: LONG_WAIT });
    await expect(this.payWithPlaceToPayButton).toBeVisible({ timeout: LONG_WAIT });
  }

  /**
   * Reload so the invoice grid actually fetches.
   *
   * REQUIRED WORKAROUND, not a nicety. Arriving via the Activity dropdown fires
   * only `getAccountById` and `getTenantSelfCareConfig` — `searchInvoiceUnits`
   * never runs — so the grid shows "No record has found!" even when the account
   * has an open invoice. A reload fires it and the row appears. Reproduced three
   * runs out of three on jasec-dev 2026-08-26 with ACT-100145 (one ACTIVE invoice,
   * due 5,354,343.60): 0 rows on arrival, 1 row after reload.
   *
   * Every test that needs to SEE an invoice calls this first. The one test that
   * must not is the case pinned on the defect itself.
   */
  async reloadToPopulateGrid(activityPage?: SelfcareActivityPage): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
    await this.page.waitForLoadingToDisappear();

    // A reload that lands somewhere else (session bounce) needs the nav redone.
    const stillHere = await this.payNowButton.isVisible().catch(() => false);
    if (!stillHere && activityPage) {
      await activityPage.navigateToMakePayment();
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
      await this.page.waitForLoadingToDisappear();
    }
    await this.assertLoaded();
  }

  // ── Reading the grid ────────────────────────────────────────────────

  /** Number of real invoice rows (0 when the grid shows its empty state). */
  async getInvoiceRowCount(): Promise<number> {
    await this.page.waitForLoadingToDisappear();
    return this.dataRows.count();
  }

  /**
   * Every listed invoice, as rendered. Strings, deliberately — comparing the
   * rendered text against the DB is the point, so no parsing is done here beyond
   * trimming.
   */
  async getListedInvoices(): Promise<
    { invoiceId: string; invoiceDate: string; dueDate: string; amount: string; due: string }[]
  > {
    const count = await this.getInvoiceRowCount();
    const out: {
      invoiceId: string; invoiceDate: string; dueDate: string; amount: string; due: string;
    }[] = [];

    for (let i = 0; i < count; i++) {
      const cells = this.dataRows.nth(i).locator('td');
      const text = async (n: number) => ((await cells.nth(n).textContent()) ?? '').trim();
      out.push({
        invoiceId: await text(1),
        invoiceDate: await text(2),
        dueDate: await text(3),
        amount: await text(4),
        due: await text(5),
      });
    }
    return out;
  }

  /** Assert the grid is showing its empty state. */
  async assertNoInvoicesListed(): Promise<void> {
    await expect(
      this.page.getByText(/No\s*record\s*has\s*found/i).first(),
    ).toBeVisible({ timeout: LONG_WAIT });
  }

  /** The number rendered in "Total Selected To Pay :<n>". */
  async getTotalSelectedToPay(): Promise<number> {
    const text = (await this.totalSelectedHeading.textContent()) ?? '';
    const m = text.match(/:\s*([\d.,]+)/);
    return m ? Number(m[1].replace(/,/g, '')) : NaN;
  }

  // ── Selecting ───────────────────────────────────────────────────────

  /**
   * Tick the Select checkbox on the row for `invoiceId`.
   *
   * Use `dispatchEvent('click')` on the input — nothing else works. The row is a
   * Bootstrap custom-checkbox:
   *
   *   <div class="check-item"><div class="custom-control custom-checkbox">
   *     <input readonly name="action" class="custom-control-input" type="checkbox" value="false">
   *     <label class="custom-control-label" for="checkbox-…"></label>
   *   </div></div>
   *
   * `input.click()` times out (opacity-0 / z-index--1, so not a hittable target)
   * and `label.click({force:true})` fails "Element is outside of the viewport"
   * because the label is empty and its box collapses. Both report plausibly and
   * leave `value="false"`, which is how the first version of this method passed a
   * click and then failed on the total. Dispatching the event directly reaches
   * React's synthetic onChange: measured on jasec-dev 2026-08-26, total 0 → 4.46,
   * checkbox false → true, both pay buttons enabled. Strategy comparison is in
   * explore-01's `selectionProbe` artifact.
   *
   * The running total is the assertion, not the DOM property: the input is
   * `readonly` and React-controlled, so `checked` can be set without the app
   * having registered the selection.
   */
  async selectInvoice(invoiceId: string): Promise<void> {
    const row = this.dataRows.filter({ hasText: invoiceId }).first();
    await row.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await row.scrollIntoViewIfNeeded().catch(() => { });

    const before = await this.getTotalSelectedToPay();
    await row.locator('input[type="checkbox"]').first().dispatchEvent('click');

    await expect
      .poll(async () => this.getTotalSelectedToPay(), { timeout: MEDIUM_WAIT })
      .toBeGreaterThan(before);
  }

  /** Assert both pay buttons are disabled (nothing selected). */
  async assertPayButtonsDisabled(): Promise<void> {
    await expect(this.payNowButton).toBeDisabled({ timeout: MEDIUM_WAIT });
    await expect(this.payWithPlaceToPayButton).toBeDisabled({ timeout: MEDIUM_WAIT });
  }

  /** Assert both pay buttons are enabled (something selected). */
  async assertPayButtonsEnabled(): Promise<void> {
    await expect(this.payNowButton).toBeEnabled({ timeout: MEDIUM_WAIT });
    await expect(this.payWithPlaceToPayButton).toBeEnabled({ timeout: MEDIUM_WAIT });
  }

  // ── Paying ──────────────────────────────────────────────────────────

  /** Click PAY NOW (charges the saved token; no PlaceToPay redirect). */
  async clickPayNow(): Promise<void> {
    await this.payNowButton.scrollIntoViewIfNeeded().catch(() => { });
    await this.payNowButton.click();
    await this.page.waitForTimeout(1000);
  }

  /** Click PAY WITH PLACETOPAY and wait for the hosted checkout to take over. */
  async clickPayWithPlaceToPay(): Promise<void> {
    await this.payWithPlaceToPayButton.scrollIntoViewIfNeeded().catch(() => { });
    await this.payWithPlaceToPayButton.click();
    await this.page.waitForURL(/checkout-test\.placetopay\.com/i, {
      timeout: EXTRA_LONG_WAIT,
    });
  }

  /**
   * Wait for the UI's own confirmation that the payment went through.
   *
   * Any of: a success toast, PlaceToPay's "Payment approved" page, or the paid
   * invoice disappearing from the grid. The DB is the real oracle — this only
   * stops the test racing ahead of the UI.
   */
  async waitForPaymentAcknowledged(paidInvoiceId?: string): Promise<void> {
    await this.page.waitForLoadingToDisappear();

    const toast = this.page.locator('.Toastify__toast--success').first();
    const approved = this.page.getByRole('heading', { name: /Payment\s*approved/i }).first();

    await Promise.race([
      toast.waitFor({ state: 'visible', timeout: LONG_WAIT }),
      approved.waitFor({ state: 'visible', timeout: LONG_WAIT }),
      paidInvoiceId
        ? expect
          .poll(async () => (await this.getListedInvoices()).some((i) => i.invoiceId === paidInvoiceId), {
            timeout: LONG_WAIT,
          })
          .toBe(false)
        : Promise.resolve(),
    ]).catch(() => { });
  }
}
