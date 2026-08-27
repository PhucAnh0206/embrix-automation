import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../helpers/timeouts.helper';
import { selfcareHostRe } from './selfcare-login.page';

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
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });

    await expect(this.saveWithPlaceToPayButton).toBeVisible({ timeout: LONG_WAIT });
  }

  async navigateToTopUp(): Promise<void> {
    await this.openActivityDropdown();
    await this.page
      .getByRole('link', { name: /^\s*Top\s*Up\s*$/i })
      .or(this.page.getByText(/^\s*Top\s*Up\s*$/i))
      .first()
      .click();
    await this.page.waitForLoadingToDisappear();
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
    await this.page.waitForURL(selfcareHostRe(), {
      timeout: EXTRA_LONG_WAIT,
    });
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });

    const tokenInput = this.page.getByPlaceholder(/Card Number/i).first();

    const populatedFast = await tokenInput
      .waitFor({ state: 'visible', timeout: MEDIUM_WAIT })
      .then(async () => (await tokenInput.inputValue()) !== '')
      .catch(() => false);

    // The token field is filled by a fetch on PAGE LOAD; nothing updates it in
    // place. So polling the DOM cannot make a value appear -- only re-fetching
    // can. That is why the re-navigation belongs INSIDE the retry.
    //
    // This previously re-navigated exactly ONCE and then polled for 30s. When
    // the PlaceToPay round-trip landed after that single re-navigation, the poll
    // was watching a DOM that would never change: 63 polls, every one
    // value="", then a timeout. Being a race against an external gateway it
    // failed DETERMINISTICALLY for a tester whose round-trip is slower, and
    // passed deterministically here -- six consecutive identical failures on one
    // machine (2026-08-27, account AC-840608) while the card sat in
    // core_engine.credit_card the whole time and rendered fine when opened later.
    //
    // Re-fetching on every attempt removes the timing dependency entirely.
    if (!populatedFast) {
      await expect(async () => {
        await this.navigateToManagePaymentProfile();
        expect(await tokenInput.inputValue()).not.toBe('');
      }).toPass({
        timeout: VERY_LONG_WAIT,
        intervals: [1000, 2000, 3000, 5000],
      });
    }

    await expect(tokenInput).not.toHaveValue('', { timeout: LONG_WAIT });

    const expiryInput = this.page.getByPlaceholder(/MM\/YYYY/i).first();
    await expect(expiryInput).not.toHaveValue('', { timeout: MEDIUM_WAIT });

    await expect(
      this.page.locator('text=/TOKEN\\s*:/i').first(),
    ).toBeVisible({ timeout: MEDIUM_WAIT });
  }

  /**
   * Assert the Card On File section is empty (token and expiry cleared).
   *
   * Same re-fetch rule as assertCardOnFilePopulated, in both directions:
   *
   *  - AFTER A DELETE, a stale token cannot clear itself. The field is filled on
   *    page load, so polling it would watch the old value until timeout. Hence
   *    the re-navigation lives inside the retry.
   *  - FOR A NEGATIVE ("no card was saved"), the opposite risk applies and it is
   *    worse: an empty field is indistinguishable from one that has not rendered
   *    yet, so the assertion can pass instantly while proving nothing. Pass
   *    `settleMs` to require the field to STAY empty across further re-fetches.
   *
   * `settleMs` still cannot prove a negative outright -- only bound it. The
   * definitive oracle is DbHelper.getSavedCardCount(); see cases 1.2 / 1.3.
   */
  async assertCardOnFileEmpty(opts: { settleMs?: number } = {}): Promise<void> {
    await this.page.waitForLoadingToDisappear();

    const tokenInput = this.page.getByPlaceholder(/Card Number/i).first();
    const expiryInput = this.page.getByPlaceholder(/MM\/YYYY/i).first();

    await expect(async () => {
      await this.navigateToManagePaymentProfile();
      expect(await tokenInput.inputValue()).toBe('');
      expect(await expiryInput.inputValue()).toBe('');
    }).toPass({ timeout: LONG_WAIT, intervals: [1000, 2000, 3000] });

    const settleMs = opts.settleMs ?? 0;
    if (settleMs > 0) {
      const deadline = Date.now() + settleMs;
      while (Date.now() < deadline) {
        await this.page.waitForTimeout(3000);
        await this.navigateToManagePaymentProfile();
        const seen = await tokenInput.inputValue();
        expect(
          seen,
          `a card appeared ${settleMs}ms into the settle window -- it was saved ` +
          `late, so an immediate empty check would have passed wrongly`,
        ).toBe('');
      }
    }
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
    await this.page.waitForLoadingToDisappear();

    await this.assertCardOnFileEmpty();
  }
}
