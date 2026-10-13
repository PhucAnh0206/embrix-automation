/**
 * Tags: @dev_test @probe-316-qc
 *
 * READ-ONLY: is the reworked ("fit") ui-core of JEPYP-316 deployed? The fit adds an opt-in Tipo de documento
 * (identityDocument) to Quick Create; the change set as first submitted had none. Opens Quick Create, lists the
 * named fields, takes a screenshot, never submits.
 *   $env:TEST_ENV='jasec-dev'; npx playwright test --project=dev --grep "@probe-316-qc"
 */
import * as fs from 'fs';
import { test } from '../../fixtures/page-factory';

test('@probe-316-qc Quick Create fields (no save)', async ({ page }) => {
  await page.navigateToHome();
  await page.goto('/customers/create/quick-create');
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { });
  await page.waitForTimeout(3_000);
  const names = await page.locator('input[name], textarea[name]').evaluateAll(els =>
    els.map(e => `${e.getAttribute('name')}${(e as HTMLElement).offsetParent === null ? '(hidden)' : ''}`));
  const labels = (await page.locator('div.form-group > span, div.form-group label').allTextContents())
    .map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  fs.mkdirSync('artifacts', { recursive: true });
  const out = { env: process.env.TEST_ENV, url: page.url(), names, labels, identityDocument: names.some(n => n.startsWith('identityDocument')) };
  fs.writeFileSync(`artifacts/probe-jepyp-316-quickcreate-${process.env.TEST_ENV}.json`, JSON.stringify(out, null, 2));
  await page.screenshot({ path: `artifacts/probe-jepyp-316-quickcreate-${process.env.TEST_ENV}.png`, fullPage: true });
  console.log(JSON.stringify(out));
});
