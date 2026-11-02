/**
 * NetSuite — CAN-001: create a cancellation order for a QA contract on coopegsbx2 (Kiet's CoopeG cancel flow):
 * Customer > Services > Place Order: Cancel > Create > Submit order. The cancel order then waits for provisioning
 * like the others; complete it and run ns-submit-order.spec.ts with NS_SUBMIT_EXPECT=CLOSED. QA accounts only.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_CANCEL_ACCOUNT='QA-ANH-NS-R2-…'
 *   npx playwright test tests/dev/ns-cancel-order.spec.ts --project=dev --reporter=line
 */
import { test, expect } from '../../fixtures/page-factory';

const ACC = process.env.NS_CANCEL_ACCOUNT ?? '';
// Place Order button: Cancel (CAN-001), Suspend / Resume (SUS-001).
const KIND = process.env.NS_ORDER_KIND ?? 'Cancel';

test('NS cancellation: cancel order for a QA contract', async ({ page, baseURL, testLogger }) => {
  test.setTimeout(10 * 60_000);
  expect(ACC, 'NS_CANCEL_ACCOUNT must be a QA account').toMatch(/^QA-ANH-NS-/);
  await page.goto(`${baseURL!.replace(/\/+$/, '')}/customers/${ACC}/services`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(8000);
  // Place Order: CANCEL (a link styled as a button, as in Kiet's cancel.spec)
  const cancel = page.getByRole('link', { name: KIND, exact: true });
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  else await page.getByRole('button', { name: KIND, exact: true }).first().click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  testLogger.log(`${ACC}: ${KIND} order created`);
  await page.waitForTimeout(5000);
  const submit = page.getByRole('button', { name: 'Submit order', exact: true });
  for (let i = 0; i < 6 && !(await submit.isEnabled().catch(() => false)); i++) {
    await page.getByRole('button', { name: 'Refresh' }).click().catch(() => {});
    await page.waitForTimeout(4000);
  }
  if (await submit.isEnabled().catch(() => false)) { await submit.click(); testLogger.log(`${ACC}: Submit order clicked`); }
  else testLogger.log(`${ACC}: Submit order not enabled after creating the cancel order`);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `test-results/ns-cancel-${ACC}.png`, fullPage: true }).catch(() => {});
});
