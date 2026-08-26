/// <reference types="node" />
/**
 * Auth Setup — runs ONCE before all tests.
 * Logs in and saves browser storage state so other test projects
 * can reuse the session without re-authenticating.
 *
 * Run via:  playwright test --project=setup
 * Output:   playwright/.auth/user.json
 */

import { test as setup, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as Timeouts from '../helpers/timeouts.helper';

const authFile = path.join('playwright', '.auth', 'user.json');

setup('authenticate', async ({ page, baseURL }) => {
  const username = process.env.EMBRIX_USER;
  const password = process.env.EMBRIX_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'EMBRIX_USER and EMBRIX_PASSWORD must be set in environment variables or .env file.\n' +
      'Copy .env.example to .env and fill in your credentials.'
    );
  }

  // Navigate to login
  await page.goto(baseURL!, { waitUntil: 'domcontentloaded', timeout: Timeouts.EXTRA_LONG_WAIT * 2 });

  // Wait for SPA to fully hydrate before touching the form.
  // Without this, Apollo Client's mutation onCompleted handler that persists
  // the auth token to localStorage isn't wired yet — the login succeeds server-side
  // but the token is dropped, subsequent calls 401, and the app bounces back to /login.
  await page.waitForLoadState('networkidle', { timeout: Timeouts.EXTRA_LONG_WAIT }).catch(() => {});

  // The FIRST page load of a run pays for the main bundle on a cold cache:
  // measured 10,960,918 bytes taking 67s from jasec-dev on 2026-08-25. The
  // networkidle wait above is best-effort (.catch), so without an explicit wait
  // the fill below dies on the 30s actionTimeout while the SPA is still
  // painting -- a blank screenshot and "waiting for getByPlaceholder(/username/i)".
  // Waiting on the field itself is the honest signal that hydration finished,
  // and it costs a fast environment nothing.
  await page.getByPlaceholder(/username/i)
    .waitFor({ state: 'visible', timeout: Timeouts.EXTRA_LONG_WAIT });

  // Fill credentials
  await page.getByPlaceholder(/username/i).fill(username);
  await page.getByPlaceholder(/password/i).fill(password);
  await page.getByRole('button', { name: /login/i }).click();

  // Wait until login button disappears (redirected away from login page)
  await page.getByRole('button', { name: /login/i }).waitFor({ state: 'hidden', timeout: Timeouts.LONG_WAIT });

  // Confirm we are on the dashboard / main app
  await expect(page.getByRole('button', { name: /Customer Hub/i })).toBeVisible({ timeout: Timeouts.LONG_WAIT });

  // Ensure output directory exists
  const authDir = path.dirname(authFile);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // Save session state
  await page.context().storageState({ path: authFile });
});
