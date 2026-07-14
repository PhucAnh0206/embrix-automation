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
