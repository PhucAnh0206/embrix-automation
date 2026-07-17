import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { EXTRA_LONG_WAIT, MEDIUM_WAIT } from '../../helpers/timeouts.helper';

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
  async goto(): Promise<void> {
    const selfcareBaseUrl =
      process.env.SELFCARE_BASE_URL ?? 'https://selfcare-ui.jasec-dev.embrix.org/';
    await this.page.goto(selfcareBaseUrl, { waitUntil: 'domcontentloaded' });
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
