import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { MEDIUM_WAIT, LONG_WAIT, SHORT_WAIT } from '../../helpers/timeouts.helper';

/**
 * SelfcareAccountSearchPage — the admin-only Account Search tab.
 *
 * Admin flow: search by accountId → click SELECT on the result row →
 * Self Care now acts as that account for subsequent navigation.
 */
export class SelfcareAccountSearchPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /** Click the Account Search tab in the top nav. */
  async navigate(): Promise<void> {
    const tab = this.page.getByRole('link', { name: /Account Search/i }).first();
    await tab.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await tab.click();
    await this.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
  }

  /** Search by accountId and click SELECT on the matching row. */
  async searchAndSelectAccount(accountId: string): Promise<void> {
    // Expand Advanced Search panel if collapsed.
    const advancedSearchHeader = this.page.getByText(/^Advanced Search$/i).first();
    if (await advancedSearchHeader.isVisible().catch(() => false)) {
      const anyFilterVisible = await this.page
        .locator('input[name*="account" i], input[placeholder*="account" i]')
        .first()
        .isVisible()
        .catch(() => false);
      if (!anyFilterVisible) {
        await advancedSearchHeader.click().catch(() => { });
        await this.page.waitForTimeout(500);
      }
    }

    const acctInput = this.page
      .locator(
        'input[name="accountId"], input[name="acctNo"], input[placeholder*="Account" i]',
      )
      .first();
    await acctInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await acctInput.fill(accountId);

    await this.page.getByRole('button', { name: /^\s*Search\s*$/i }).first().click();
    await this.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });

    const row = this.page
      .locator(`//tr[.//td[normalize-space()=${qstr(accountId)}]]`)
      .first();
    await row.waitFor({ state: 'visible', timeout: LONG_WAIT });

    const selectButton = row.getByRole('button', { name: /^\s*Select\s*$/i }).first();
    await selectButton.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await selectButton.click();

    // Confirm acted-as context is now set.
    await expect(
      this.page.getByText(
        new RegExp(`Selfcare context is setup for account\\s+${accountId}`, 'i'),
      ),
    ).toBeVisible({ timeout: LONG_WAIT });

    await expect(
      this.page.getByText(new RegExp(`Account\\s*Number:\\s*${accountId}`, 'i')).first(),
    ).toBeVisible({ timeout: MEDIUM_WAIT }).catch(() => { });
  }
}

/** XPath-safe string literal — handles single/double quotes. */
function qstr(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.split("'").join(`',"'",'`)}')`;
}
