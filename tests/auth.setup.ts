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

// Per-tenant file set by playwright.config.ts; user.json only if run outside it.
const authFile = process.env.AUTH_FILE ?? path.join('playwright', '.auth', 'user.json');

/**
 * Reuse a still-valid session instead of paying a full browser login.
 *
 * WHY: this setup re-authenticated UNCONDITIONALLY on every Playwright
 * invocation - browser launch, SPA hydration (the comment below measures the
 * cold bundle at 67s), form fill, login. Measured 2026-09-17 over three runs:
 * 25.5s / 36.6s / 47.0s, mean ~36s, paid once PER INVOCATION. Block E alone
 * makes 12 of them.
 *
 * SAFETY, in order of what would hurt most:
 *
 *  1. TENANT. The saved state records its origin, and reusing a jasec-dev
 *     session against jasec-preprod would be the same cross-environment fault
 *     class fixed elsewhere on 2026-09-17. The origin must MATCH baseURL.
 *  2. VALIDITY. The token is opaque - no readable expiry - so age would be a
 *     guess, and a guess that is wrong means 401s across the whole suite. So
 *     the session is VERIFIED with one cheap authenticated GraphQL call
 *     (~0.3s) rather than assumed.
 *  3. FAIL CLOSED. Anything unexpected - missing file, unreadable JSON, no
 *     token, non-200, GraphQL error, network failure - falls through to the
 *     full login. The slow path is always correct.
 *
 * Kill switch: JASEC_FORCE_RELOGIN=true always does the full login.
 */
async function reusableSession(baseURL: string | undefined): Promise<boolean> {
  if (process.env.JASEC_FORCE_RELOGIN === 'true') return false;
  if (!baseURL) return false;
  try {
    if (!fs.existsSync(authFile)) return false;
    const state = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    const want = new URL(baseURL).origin;
    const origin = (state.origins ?? []).find((o: any) => o.origin === want);
    if (!origin) {
      console.log(`[auth] saved session is for a DIFFERENT tenant; logging in fresh.`);
      return false;
    }
    const token = (origin.localStorage ?? [])
      .find((kv: any) => kv.name === 'authToken')?.value;
    if (!token) return false;

    // core-ui.<tenant>.embrix.org -> service-transactional.<tenant>.embrix.org
    const gql = want.replace('//core-ui.', '//service-transactional.') + '/graphql';
    const res = await fetch(gql, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      // getCcpDateTime REQUIRES a dummy argument - without it the server answers
      // 200 with a ValidationError and the check rejects a session that is fine.
      body: JSON.stringify({ query: '{ getCcpDateTime(dummy: "authcheck") { ccpTime } }' }),
    });
    if (!res.ok) return false;
    const body: any = await res.json();
    if (body.errors?.length) return false;
    if (!body.data?.getCcpDateTime) return false;
    console.log(`[auth] reusing the saved ${want} session (verified live).`);
    return true;
  } catch {
    return false;
  }
}

setup('authenticate', async ({ page, baseURL }) => {
  if (await reusableSession(baseURL)) return;

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
