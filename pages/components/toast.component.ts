import { Page, expect } from '@playwright/test';
import { LONG_WAIT, VERY_LONG_WAIT } from '../../helpers/timeouts.helper';

/**
 * ToastComponent — Encapsulates all Toastify notification interactions.
 *
 * Scoped to the entire page (toasts are rendered at root level).
 * Provides assertion helpers for success and error toasts.
 *
 * Usage from a Page Object:
 *   await this.toast.expectSuccess('Record saved');
 *   await this.toast.expectError(/failed/i);
 */
export class ToastComponent {
  /**
   * @param page - Playwright's Page instance.
   */
  constructor(private readonly page: Page) { }

  // Locators

  /** Locator targeting the active success Toastify toast. */
  get successToast() {
    return this.page.locator('.Toastify__toast--success').first();
  }

  /** Locator targeting the active error Toastify toast. */
  get errorToast() {
    return this.page.locator('.Toastify__toast--error').first();
  }

  /** Wait for a Toastify success toast and optionally assert its text. */
  async expectSuccess(text?: string | RegExp): Promise<void> {
    await this.successToast.waitFor({ state: 'visible', timeout: VERY_LONG_WAIT });
    if (text) await expect(this.successToast).toContainText(text);
  }

  /** Wait for a Toastify error toast and optionally assert its text. */
  async expectError(text?: string | RegExp): Promise<void> {
    await this.errorToast.waitFor({ state: 'visible', timeout: LONG_WAIT });
    if (text) await expect(this.errorToast).toContainText(text);
  }

  /**
   * Extract the clean error message text from the error toast body,
   * excluding the close button and progress bar text.
   */
  async getErrorMessage(): Promise<string> {
    const body = this.errorToast.locator('.Toastify__toast-body');
    return (await body.innerText()).trim();
  }
}
