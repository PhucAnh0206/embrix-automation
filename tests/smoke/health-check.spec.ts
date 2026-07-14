/**
 * Smoke Tests — Health Check
 *
 * Fast, environment-agnostic tests that verify the application
 * is reachable and the core login flow works.
 * These run on EVERY pipeline (no storageState dependency).
 *
 * Tags: @smoke
 */

import { test, expect } from '../../fixtures/page-factory';
import * as Timeouts from '../../helpers/timeouts.helper';

test.describe('SMOKE — Embrix CoreUI Health Check', () => {

  test('SMOKE-01: Login page is reachable and renders login form', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Login form must be visible
    await expect(page.getByPlaceholder(/username/i)).toBeVisible({ timeout: Timeouts.LONG_WAIT });
    await expect(page.getByPlaceholder(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /login/i })).toBeVisible();
  });

  test('SMOKE-02: Valid credentials login successfully', async ({ page, loginPage }) => {
    const username = process.env.EMBRIX_USER ?? '';
    const password = process.env.EMBRIX_PASSWORD ?? '';

    if (!username || !password) {
      test.skip(true, 'EMBRIX_USER / EMBRIX_PASSWORD not set — skipping login smoke test.');
    }

    await loginPage.goto();
    await loginPage.login(username, password);
    await loginPage.assertLoginSuccess();

    // Dashboard / main app should be visible after login, login form should be hidden
    await expect(page.getByPlaceholder(/username/i)).toBeHidden({ timeout: Timeouts.LONG_WAIT });
    await expect(page.getByRole('button', { name: /Customer Hub/i })).toBeVisible({ timeout: Timeouts.LONG_WAIT });
  });

  test('SMOKE-03: Invalid credentials show an error message', async ({ page, loginPage }) => {
    await loginPage.goto();
    await loginPage.login('invalid_user_smoke_test', 'wrong_password_12345!');
    await loginPage.assertLoginError();
  });

  test('SMOKE-04: Page title is set (basic SEO / app sanity)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

});
