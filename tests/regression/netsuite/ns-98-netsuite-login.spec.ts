/**
 * One-time NetSuite sandbox login (CoopeG 8754760-sb1) — run HEADED, a person signs in.
 *
 *   npx playwright test --project=netsuite tests/regression/netsuite/ns-98-netsuite-login.spec.ts --headed --no-deps
 *
 * The browser opens the sign-in page and waits up to 10 minutes for you to
 * sign in and pass MFA. Only the resulting session is saved
 * (playwright/.auth/netsuite.json, gitignored with the other auth files);
 * no password is stored by the suite. ns-08 reuses that session.
 * Title has no case id, so the CSV reporter ignores it.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';

export const NETSUITE_URL = 'https://8754760-sb1.app.netsuite.com';
export const NETSUITE_STATE = 'playwright/.auth/netsuite.json';

test.use({ storageState: { cookies: [], origins: [] } });

test('NetSuite sandbox: sign in once (manual, with MFA) and save the session', async ({ page }) => {
  test.setTimeout(12 * 60_000);
  await page.goto(`${NETSUITE_URL}/app/center/card.nl?sc=-29&whence=`, { waitUntil: 'domcontentloaded' });
  console.log('\n>>> Sign in to NetSuite in the opened browser (email, password, MFA). Waiting up to 10 minutes...\n');
  await page.waitForURL(/8754760-sb1\.app\.netsuite\.com\/app\/(center|accounting|common)/, { timeout: 10 * 60_000 });
  await page.waitForLoadState('domcontentloaded');
  fs.mkdirSync('playwright/.auth', { recursive: true });
  await page.context().storageState({ path: NETSUITE_STATE });
  expect(fs.existsSync(NETSUITE_STATE)).toBe(true);
  console.log(`>>> NetSuite session saved to ${NETSUITE_STATE}`);
});
