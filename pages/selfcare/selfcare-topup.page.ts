import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../helpers/timeouts.helper';
import type { SelfcareActivityPage } from './selfcare-activity.page';

/**
 * SelfcareTopupPage — Activity → Top Up view.
 *
 * Exposes:
 *   • Amount input + PAY NOW + PAY WITH PLACETOPAY buttons
 *   • Minimum Top Up Amount section (label + value input)
 *   • Current Period Balance history table
 *
 * PAY NOW requires a saved card token (uses stored token, no PTP redirect).
 * PAY WITH PLACETOPAY works with or without a saved card (redirects to PTP).
 */
export class SelfcareTopupPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── Locators ────────────────────────────────────────────────────────

  private get amountInput() {
    return this.page.getByPlaceholder(/e\.?g\.?\s*1500/i).first();
  }

  private get minimumAmountInput() {
    return this.page
      .locator(
        'xpath=//*[contains(normalize-space(.),"Minimum Top Up Amount")]/following::input[1]',
      )
      .first();
  }

  private get payNowButton() {
    return this.page.getByRole('button', { name: /^\s*Pay\s*Now\s*$/i }).first();
  }

  private get payWithPlaceToPayButton() {
    return this.page.getByRole('button', { name: /Pay\s*With\s*PlaceToPay/i }).first();
  }

  private get historyTable() {
    return this.page
      .locator(
        'xpath=//*[contains(normalize-space(.),"Current Period Balance") or contains(normalize-space(.),"Balance Periodo Actual")]/following::table[1]',
      )
      .first();
  }

  private get historyRows() {
    return this.historyTable.locator('tbody tr');
  }

  /** History rows excluding the "No record has found!" empty-state placeholder. */
  private get historyDataRows() {
    return this.historyTable
      .locator('tbody tr')
      .filter({ hasNotText: /No\s*record\s*has\s*found/i });
  }

  private get receiptColumnHeader() {
    return this.historyTable
      .locator('thead th')
      .filter({ hasText: /^\s*(Receipt|Recibo)\s*$/i })
      .first();
  }

  private get receiptButtons() {
    return this.page.getByRole('button', {
      name: /View\s*\/\s*Download\s*Receipt|Ver\s*\/\s*Descargar\s*recibo/i,
    });
  }

  // Language toggle link's accessible name is "flag English" / "flag Español"
  // (image alt + text), not just "English" / "Español" — use unanchored regex.
  private get languageToggle() {
    return this.page
      .getByRole('link', { name: /\b(English|Español)\b/i })
      .or(this.page.getByRole('button', { name: /\b(English|Español)\b/i }))
      .first();
  }

  // ── Actions ─────────────────────────────────────────────────────────

  /** Assert we're on the Top Up view (Pay Now + Pay With PTP buttons visible). */
  async assertLoaded(): Promise<void> {
    await this.page.waitForLoadingToDisappear();
    await expect(this.payNowButton).toBeVisible({ timeout: LONG_WAIT });
    await expect(this.payWithPlaceToPayButton).toBeVisible({ timeout: LONG_WAIT });
  }

  /**
   * Reload the Top Up view so it re-fetches backend state.
   *
   * Needed after any action that changes account state on the server (top-ups,
   * CCP time changes, etc.) — the Top Up view doesn't auto-refresh, so
   * without a reload we see stale data (old history, old min amount, etc.).
   *
   * If the reload lands on a different route, re-navigates back to Top Up.
   */
  async reload(activityPage: SelfcareActivityPage): Promise<void> {
    await activityPage.navigateToTopUp();
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });

    const onTopUp = await this.payNowButton.isVisible().catch(() => false);
    if (!onTopUp) {
      await activityPage.navigateToTopUp();
    }
    await this.assertLoaded();
  }

  /** Read the Minimum Top Up Amount value (empty string if hidden). */
  async getDisplayedMinimumAmount(): Promise<string> {
    if (await this.minimumAmountInput.isVisible().catch(() => false)) {
      return (await this.minimumAmountInput.inputValue()).trim();
    }
    return '';
  }

  /** Assert the Minimum Amount section is visible; optionally check its value. */
  async assertMinimumAmountVisible(expected?: string | number): Promise<void> {
    const label = this.page.getByText(/Minimum\s*Top\s*Up\s*Amount/i).first();
    await expect(label).toBeVisible({ timeout: LONG_WAIT });

    if (expected !== undefined) {
      await expect(this.minimumAmountInput).toHaveValue(String(expected), {
        timeout: LONG_WAIT,
      });
    }
  }

  /** Assert the Minimum Amount section is hidden (removed from UI). */
  async assertMinimumAmountHidden(): Promise<void> {
    const label = this.page.getByText(/Minimum\s*Top\s*Up\s*Amount/i).first();
    await expect(label).not.toBeVisible({ timeout: MEDIUM_WAIT });
  }

  /** Type an amount into the Amount input. */
  async enterAmount(amount: number | string): Promise<void> {
    await this.amountInput.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await this.amountInput.click();
    await this.amountInput.press('Control+A');
    await this.amountInput.press('Delete');
    await this.amountInput.fill(String(amount));
  }

  /** Click PAY NOW (uses saved card token, no PTP redirect). */
  async clickPayNow(): Promise<void> {
    await this.payNowButton.scrollIntoViewIfNeeded().catch(() => { });
    await this.payNowButton.click();
    await this.page.waitForTimeout(500);
  }

  /**
   * Fire N click events without waiting for actionability — bypasses the
   * "button disabled after first click" state so subsequent clicks still
   * dispatch. A correctly-idempotent frontend ignores them.
   */
  async rapidClickPayNow(count = 3): Promise<void> {
    await this.payNowButton.scrollIntoViewIfNeeded().catch(() => { });
    await this.payNowButton.waitFor({ state: 'visible', timeout: LONG_WAIT });
    const clicks: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      clicks.push(this.payNowButton.dispatchEvent('click'));
    }
    await Promise.all(clicks);
  }

  async assertAmountInputCleared(): Promise<void> {
    await expect(this.amountInput).toHaveValue('', { timeout: LONG_WAIT });
  }

  /** Click PAY WITH PLACETOPAY and wait for the PTP checkout URL. */
  async clickPayWithPlaceToPay(): Promise<void> {
    await this.payWithPlaceToPayButton.scrollIntoViewIfNeeded().catch(() => { });
    await this.payWithPlaceToPayButton.click();
    await this.page.waitForURL(/checkout-test\.placetopay\.com/i, {
      timeout: EXTRA_LONG_WAIT,
    });
  }

  /** Assert a top-up succeeded — success toast or new history data row. */
  async assertPaymentSuccess(): Promise<void> {
    await this.page.waitForLoadingToDisappear();

    const toast = this.page.locator('.Toastify__toast--success').first();
    const approvedHeading = this.page.getByRole('heading', { name: /Payment\s*approved/i }).first();
    const firstDataRow = this.historyDataRows.first();

    await Promise.race([
      toast.waitFor({ state: 'visible', timeout: LONG_WAIT }),
      approvedHeading.waitFor({ state: 'visible', timeout: LONG_WAIT }),
      firstDataRow.waitFor({ state: 'visible', timeout: LONG_WAIT }),
    ]).catch(() => { });

    await this.assertHistoryRowCountAtLeast(1);
  }

  /** Assert an error indication after Pay Now (e.g. no saved card token). */
  async assertPaymentError(expectedText?: string | RegExp): Promise<void> {
    const errorToast = this.page.locator('.Toastify__toast--error, .alert-danger').first();
    const alertText = this.page
      .getByText(/Missing\s*saved\s*card\s*token|Please\s*add\s*a\s*card\s*first/i)
      .first();

    const winner = await Promise.race([
      errorToast.waitFor({ state: 'visible', timeout: LONG_WAIT }).then(() => 'toast' as const),
      alertText.waitFor({ state: 'visible', timeout: LONG_WAIT }).then(() => 'text' as const),
    ]).catch(() => 'timeout' as const);

    if (winner === 'timeout') {
      throw new Error('No error indication appeared after Pay Now.');
    }

    if (expectedText && winner === 'toast') {
      await expect(errorToast).toContainText(expectedText);
    }
  }

  /**
   * Assert the history table has at least N real data rows.
   *
   * Excludes the "No record has found!" empty-state placeholder, which is
   * rendered as a table row and would otherwise count as 1 — turning a failed
   * top-up into a false pass.
   *
   * Polls until the count is reached (Pay Now flows show the row after the
   * charge API completes, which can be several seconds after the click).
   */
  async assertHistoryRowCountAtLeast(n: number): Promise<void> {
    await expect
      .poll(async () => this.historyDataRows.count(), { timeout: LONG_WAIT })
      .toBeGreaterThanOrEqual(n);
  }

  async assertHistoryRowCountEquals(n: number): Promise<void> {
    await expect
      .poll(async () => this.historyDataRows.count(), { timeout: LONG_WAIT })
      .toBe(n);
  }

  /** Assert the history table is empty ("No record has found."). */
  async assertHistoryEmpty(): Promise<void> {
    await expect(
      this.page.getByText(/No\s*record\s*has\s*found/i).first(),
    ).toBeVisible({ timeout: LONG_WAIT });
  }

  /** Get the amount from the first history row. */
  async getFirstHistoryRowAmount(): Promise<string> {
    await this.historyRows.first().waitFor({ state: 'visible', timeout: LONG_WAIT });
    const cell = this.historyRows.first().locator('td').nth(1);
    return (await cell.innerText()).trim();
  }

  /**
   * Assert the Recibo/Receipt column is present with a properly-localized
   * header (not a raw i18n key like "label.receipt"). Assumes the feature
   * flag topupReceiptsEnabled is on.
   */
  async assertReceiptColumnVisible(language: 'en' | 'es' = 'en'): Promise<void> {
    const expectedText = language === 'en' ? /^\s*Receipt\s*$/i : /^\s*Recibo\s*$/i;
    await expect(this.receiptColumnHeader).toBeVisible({ timeout: LONG_WAIT });
    await expect(this.receiptColumnHeader).toHaveText(expectedText, { timeout: LONG_WAIT });

    await expect(
      this.page.locator('th').filter({ hasText: /label\.receipt/i }),
    ).toHaveCount(0);
  }

  /**
   * Toggle the Self Care nav language dropdown to the target language.
   * The toggle shows the CURRENT language and opens a dropdown with the
   * OTHER language as the choosable option.
   */
  async switchLanguageTo(target: 'en' | 'es'): Promise<void> {
    await this.languageToggle.click();

    const optionText = target === 'es' ? /\bEspañol\b/i : /\bEnglish\b/i;
    const option = this.page
      .getByRole('link', { name: optionText })
      .or(this.page.getByRole('button', { name: optionText }))
      .or(this.page.getByText(optionText))
      .last();
    await option.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await option.click();

    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
    await this.page.waitForLoadingToDisappear();
  }

  /**
   * Click the receipt button on the row at `rowIndex` (0 = first row) and
   * return the URL Chrome actually navigated the new tab to. Uses
   * network-response interception instead of newPage.url() because headless
   * Chromium never populates the PDF tab's URL — the request completes but
   * the tab stays at ":".
   */
  async clickReceiptButtonForRow(rowIndex = 0): Promise<string> {
    const btn = this.receiptButtons.nth(rowIndex);
    await btn.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await btn.scrollIntoViewIfNeeded().catch(() => { });

    const responsePromise = this.page.context().waitForEvent('response', {
      predicate: (res) => {
        const url = res.url();
        return /\.pdf(\?|$)|amazonaws|receipts?\/topups?|receipt/i.test(url);
      },
      timeout: EXTRA_LONG_WAIT,
    });

    await btn.click();
    const response = await responsePromise;
    return response.url();
  }
}
