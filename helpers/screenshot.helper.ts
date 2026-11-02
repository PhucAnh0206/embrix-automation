import { Page, TestInfo } from '@playwright/test';

/**
 * ScreenshotHelper — Captures screenshots and attaches them to the Playwright HTML report.
 *
 * WHY THIS EXISTS:
 * Playwright's built-in `screenshot: 'only-on-failure'` captures the screen AFTER
 * the error has propagated through the test runner. By that time:
 *   - Toastify toasts may have auto-dismissed (5s animation)
 *   - The page may have redirected or gone blank
 *   - Modals may have closed
 *
 * This helper captures screenshots AT THE MOMENT of interest (e.g., when an error toast
 * is detected) and immediately attaches them to the HTML report, so you see the exact
 * screen state that caused the failure.
 *
 * Usage in page objects:
 *   // In fixture: pass screenshotHelper to page object or call from test
 *   await screenshotHelper.captureAndAttach('error-toast-visible');
 *
 * Usage in tests:
 *   test('...', async ({ screenshotHelper }) => {
 *     await screenshotHelper.captureAndAttach('before-submit');
 *   });
 */
export class ScreenshotHelper {
  private counter = 0;

  constructor(
    private readonly page: Page,
    private readonly testInfo: TestInfo,
  ) { }

  /**
   * Capture a full-page screenshot and attach it to the test report.
   *
   * @param name - Descriptive name (appears as attachment label in the HTML report)
   * @returns The screenshot buffer (for further use if needed)
   */
  async captureAndAttach(name: string): Promise<Buffer> {
    this.counter++;
    const label = `${String(this.counter).padStart(2, '0')}-${name}`;
    const body = await this.page.screenshot({ fullPage: true, type: 'png' });
    await this.testInfo.attach(label, {
      body,
      contentType: 'image/png',
    });
    return body;
  }

  /**
   * Capture just the visible viewport (not full page).
   * Useful when full-page screenshots are too large or the relevant content is above the fold.
   */
  async captureViewportAndAttach(name: string): Promise<Buffer> {
    this.counter++;
    const label = `${String(this.counter).padStart(2, '0')}-${name}`;
    const body = await this.page.screenshot({ fullPage: false, type: 'png' });
    await this.testInfo.attach(label, {
      body,
      contentType: 'image/png',
    });
    return body;
  }

  /**
   * Capture a screenshot of a specific element/locator.
   * Useful for capturing just a toast, modal, or error area.
   */
  async captureElementAndAttach(name: string, selector: string): Promise<Buffer | null> {
    this.counter++;
    const label = `${String(this.counter).padStart(2, '0')}-${name}`;
    const element = this.page.locator(selector).first();
    if (await element.isVisible().catch(() => false)) {
      const body = await element.screenshot({ type: 'png' });
      await this.testInfo.attach(label, {
        body,
        contentType: 'image/png',
      });
      return body;
    }
    return null;
  }
}
