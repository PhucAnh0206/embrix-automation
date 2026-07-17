import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../helpers/timeouts.helper';

/**
 * SelfcareActivityPage — the Activity dropdown in Self Care's top nav.
 *
 * Dropdown items: Manage Payment Profile, Make Payment, Top Up,
 * Number Portability. Each is its own view.
 *
 * Also exposes the Manage Payment Profile view's actions:
 *   • Save card via PlaceToPay
 *   • Delete saved card
 *   • Assert Card On File populated / empty
 */
export class SelfcareActivityPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── Nav ─────────────────────────────────────────────────────────────

  private get activityTab() {
    return this.page
      .getByRole('link', { name: /^\s*Activity\s*$/i })
      .or(this.page.getByRole('button', { name: /^\s*Activity\s*$/i }))
      .first();
  }

  private async openActivityDropdown(): Promise<void> {
    const tab = this.activityTab;
    await tab.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await this.page.keyboard.press('Escape').catch(() => { });
    await tab.click();
    await this.page.waitForTimeout(300);
  }

  async navigateToManagePaymentProfile(): Promise<void> {
    await this.openActivityDropdown();
    const item = this.page
      .getByRole('link', { name: /Manage\s*Payment\s*Profile/i })
      .or(this.page.getByText(/Manage\s*Payment\s*Profile/i))
      .first();
    await item.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await item.click();
    await this.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });

    await expect(this.saveWithPlaceToPayButton).toBeVisible({ timeout: LONG_WAIT });
  }

  async navigateToMakePayment(): Promise<void> {
    await this.openActivityDropdown();
    await this.page
      .getByRole('link', { name: /^\s*Make\s*Payment\s*$/i })
      .or(this.page.getByText(/^\s*Make\s*Payment\s*$/i))
      .first()
      .click();
    await this.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
  }

  async navigateToTopUp(): Promise<void> {
    await this.openActivityDropdown();
    await this.page
      .getByRole('link', { name: /^\s*Top\s*Up\s*$/i })
      .or(this.page.getByText(/^\s*Top\s*Up\s*$/i))
      .first()
      .click();
    await this.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
  }

  // ── Manage Payment Profile view ─────────────────────────────────────

  private get saveWithPlaceToPayButton() {
    return this.page
      .getByRole('button', { name: /Save\s*With\s*PlaceToPay/i })
      .first();
  }

  /** Click SAVE WITH PLACETOPAY; wait for the PlaceToPay checkout URL. */
  async clickSaveWithPlaceToPay(): Promise<void> {
    await this.saveWithPlaceToPayButton.scrollIntoViewIfNeeded().catch(() => { });
    await this.saveWithPlaceToPayButton.click();
    await this.page.waitForURL(/checkout-test\.placetopay\.com/i, {
      timeout: EXTRA_LONG_WAIT,
    });
  }

  /**
   * Assert the Card On File section is populated (token, expiry, and TOKEN
   * label all present). If the initial view shows stale/empty state after
   * returning from PlaceToPay, re-navigate to force a fresh fetch.
   */
  async assertCardOnFilePopulated(): Promise<void> {
    await this.page.waitForURL(/selfcare-ui\..*embrix\.org/i, {
      timeout: EXTRA_LONG_WAIT,
    });
    await this.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });

    const tokenInput = this.page.getByPlaceholder(/Card Number/i).first();

    const populatedFast = await tokenInput
      .waitFor({ state: 'visible', timeout: MEDIUM_WAIT })
      .then(async () => (await tokenInput.inputValue()) !== '')
      .catch(() => false);

    if (!populatedFast) {
      await this.navigateToManagePaymentProfile();
    }

    await expect(tokenInput).not.toHaveValue('', { timeout: LONG_WAIT });

    const expiryInput = this.page.getByPlaceholder(/MM\/YYYY/i).first();
    await expect(expiryInput).not.toHaveValue('', { timeout: MEDIUM_WAIT });

    await expect(
      this.page.locator('text=/TOKEN\\s*:/i').first(),
    ).toBeVisible({ timeout: MEDIUM_WAIT });
  }

  /** Assert the Card On File section is empty (token and expiry cleared). */
  async assertCardOnFileEmpty(): Promise<void> {
    await this.waitForLoadingToDisappear();

    const tokenInput = this.page.getByPlaceholder(/Card Number/i).first();
    await expect(tokenInput).toHaveValue('', { timeout: LONG_WAIT });

    const expiryInput = this.page.getByPlaceholder(/MM\/YYYY/i).first();
    await expect(expiryInput).toHaveValue('', { timeout: MEDIUM_WAIT });
  }

  /**
   * Delete the saved card. Clicks the trash icon next to the Card Number
   * input (identified as a sibling button that isn't "Save With PlaceToPay"),
   * handles any confirmation dialog, and asserts the section is empty.
   */
  async deleteSavedCard(): Promise<void> {
    const deleteButton = this.page
      .locator('xpath=//input[@placeholder="Card Number"]/following-sibling::button')
      .filter({ hasNotText: /Save With PlaceToPay/i })
      .first();

    await deleteButton.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await deleteButton.click();

    const confirmYes = this.page
      .getByRole('button', { name: /^\s*(Yes|Confirm|OK|Remove|Delete)\s*$/i })
      .first();

    const confirmationAppeared = await confirmYes
      .waitFor({ state: 'visible', timeout: MEDIUM_WAIT })
      .then(() => true)
      .catch(() => false);

    if (confirmationAppeared) {
      await confirmYes.click();
    }

    await this.page.waitForTimeout(1500);
    await this.waitForLoadingToDisappear();

    await this.assertCardOnFileEmpty();
  }
}
