import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { EXTRA_LONG_WAIT, MEDIUM_WAIT } from '../../helpers/timeouts.helper';

/**
 * Self Care base URL for the ACTIVE environment (SELFCARE_BASE_URL in .env).
 * Fallback is the jasec-dev host, so dev runs behave exactly as before.
 */
export function selfcareBaseUrl(): string {
  return process.env.SELFCARE_BASE_URL ?? 'https://selfcare-ui.jasec-dev.embrix.org/';
}

/**
 * Regex matching the Self Care host of the ACTIVE environment. Used to detect
 * the return trip from PlaceToPay back to Self Care.
 *
 * Must be derived from SELFCARE_BASE_URL, never hardcoded: the host differs
 * per environment (`selfcare-ui.jasec-dev...` vs `selfcare.jasec-preprod...`),
 * and a hardcoded `selfcare-ui.` pattern silently hangs for the full
 * EXTRA_LONG_WAIT on every env that doesn't use that prefix.
 */
export function selfcareHostRe(): RegExp {
  return new RegExp(new URL(selfcareBaseUrl()).host.replace(/\./g, '\\.'), 'i');
}

/**
 * SelfcareLoginPage — login screen for the Self Care UI.
 *
 * Admin credentials are shared with CoreUI. After login, admins get an
 * "Account Search" tab to select which account to act as.
 */
export class SelfcareLoginPage extends BasePage {
  private readonly usernameInput = () => this.page.getByPlaceholder(/username/i);
  private readonly passwordInput = () => this.page.getByPlaceholder(/password/i);
  private readonly loginButton = () => this.page.getByRole('button', { name: /login/i });

  constructor(page: Page) {
    super(page);
  }

  /** Navigate to the Self Care login page. Uses SELFCARE_BASE_URL from .env. */
  /**
   * True when this page already holds an authenticated Self Care session.
   *
   * Exists so attachToAccountInSelfCare can be called twice in one test without
   * hanging. goto() on an authenticated session routes straight to the app, so
   * there is NO login form to wait for and usernameInput().waitFor() burns its
   * full 180s. Verified 2026-08-28: after logging in, a second goto() landed on
   * "/" with the nav rendered and no username field. Not a product defect -
   * expected SPA behaviour, and previously a nine-minute stall.
   */
  async isAuthenticated(): Promise<boolean> {
    const url = this.page.url();
    if (!selfcareHostRe().test(url)) return false;
    if (/login/i.test(url)) return false;
    const loginFormVisible = await this.page
      .getByPlaceholder(/username/i)
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    return !loginFormVisible;
  }

  async goto(): Promise<void> {
    await this.page.goto(selfcareBaseUrl(), { waitUntil: 'domcontentloaded' });
  }

  /** Fill credentials + submit. Waits for either success or an error state. */
  async login(username: string, password: string): Promise<void> {
    await this.usernameInput().waitFor({ state: 'visible', timeout: EXTRA_LONG_WAIT });
    await this.usernameInput().fill(username);
    await this.passwordInput().fill(password);
    await this.loginButton().click();

    await Promise.race([
      this.loginButton().waitFor({ state: 'hidden', timeout: EXTRA_LONG_WAIT }),
      this.page
        .locator('.alert-danger, [class*="error"], .Toastify__toast--error, .invalid-feedback')
        .first()
        .waitFor({ state: 'visible', timeout: EXTRA_LONG_WAIT }),
    ]).catch(() => { });
  }

  /** Assert admin login succeeded (Account Search tab visible). */
  async assertLoginSuccess(): Promise<void> {
    await expect(this.page).not.toHaveURL(/\/login/i, { timeout: MEDIUM_WAIT });
    await expect(
      this.page.getByRole('link', { name: /Account Search/i }).first(),
    ).toBeVisible({ timeout: MEDIUM_WAIT });
  }
}
