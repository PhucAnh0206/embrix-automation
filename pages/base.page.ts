import { Page } from '@playwright/test';
import { MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../helpers/timeouts.helper';

/**
 * BasePage — Abstract base class for all Page Objects.
 *
 * Provides:
 *   - Common navigation helpers (nav menu hover, link click)
 *   - Utility helpers (dismissDropdowns)
 *
 * UI-component interactions (Toast, React-Select, Table) are handled by
 * standalone component classes injected via the component factory fixture.
 */
export abstract class BasePage {
  /**
   * @param page - Playwright's Page instance.
   */
  constructor(protected readonly page: Page) { }

  // ── Navigation ────────────────────────────────────────────────────────

  /** Hover a nav menu item to open its dropdown. */
  async hoverNavMenu(menuText: string | RegExp): Promise<void> {
    const menu = this.page.getByRole('button', { name: menuText }).first();
    await menu.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await menu.click();
  }

  /** Click a nav link and wait for URL to match. */
  async clickNavLink(linkName: string | RegExp, expectedUrlPattern: RegExp): Promise<void> {
    const link = this.page.getByRole('link', { name: linkName }).first();
    await link.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await link.click();
    await this.page.waitForURL(expectedUrlPattern, { timeout: MEDIUM_WAIT });
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle');
  }

  /** Dismiss any open dropdowns by moving focus to a neutral area. */
  async dismissDropdowns(): Promise<void> {
    await this.page.locator('body').click({ position: { x: 10, y: 10 } });
  }
}
