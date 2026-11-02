import { Page, expect } from '@playwright/test';
import { BasePage } from './base.page';
import { EXTRA_LONG_WAIT, MEDIUM_WAIT } from '../helpers/timeouts.helper';

/**
 * LoginPage — Page Object for the Embrix CoreUI login screen.
 */
export class LoginPage extends BasePage {
  // Locators
  private readonly usernameInput = () => this.page.getByPlaceholder(/username/i);
  private readonly passwordInput = () => this.page.getByPlaceholder(/password/i);
  private readonly loginButton = () => this.page.getByRole('button', { name: /login/i });

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
  }

  /** Navigate to the login page (baseURL root). */
  async goto(): Promise<void> {
    await this.page.goto('/');
    await this.page.waitForLoadState('domcontentloaded');
  }

  /**
   * Fill credentials and submit the login form.
   * Waits for EITHER a successful redirect (button hidden) OR an error message.
   * Use assertLoginSuccess() / assertLoginError() to verify the outcome.
   */
  async login(username: string, password: string): Promise<void> {
    await this.usernameInput().fill(username);
    await this.passwordInput().fill(password);
    await this.loginButton().click();

    // Wait for either: button disappears (success) OR error element appears (failure)
    await Promise.race([
      this.loginButton().waitFor({ state: 'hidden', timeout: EXTRA_LONG_WAIT }),
      this.page.locator(
        '.alert-danger, [class*="error"], .Toastify__toast--error, .invalid-feedback'
      ).first().waitFor({ state: 'visible', timeout: EXTRA_LONG_WAIT }),
    ]).catch(() => {
      // If neither fires, we proceed and let the caller assert the outcome
    });
  }

  /** Assert that the user is NOT on the login page (i.e., login succeeded). */
  async assertLoginSuccess(): Promise<void> {
    await expect(this.page).not.toHaveURL(/\/login/i, { timeout: MEDIUM_WAIT });
  }

  /** Assert that the login error message is shown (invalid credentials). */
  async assertLoginError(): Promise<void> {
    const error = this.page.locator(
      '.alert-danger, [class*="error"], .Toastify__toast--error'
    ).first();
    await expect(error).toBeVisible({ timeout: MEDIUM_WAIT });
  }
}
