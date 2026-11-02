/**
 * NetSuite — a discount added to a QA contract the way Coope's agents add one (ORD-2603 on 244915: a MODIFY order with a
 * discount line, by coopeg_sbx1): Customer > Services > Place Order: Modify > Add Discounts > pick the discount offer >
 * Select > Next > Create > Submit order. The order then waits for provisioning like the others: complete it with the DB step
 * and ns-submit-order.spec.ts (ns-cycle.ps1 finish). QA accounts only. Screenshots of every step in test-results.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_DISC_ACCOUNT='QA-ANH-NS-R2-…'; $env:NS_DISC_OFFER='Recurring_Discount_Internet'
 *   npx playwright test tests/dev/ns-discount-order.spec.ts --project=dev --reporter=line
 * NS_DISC_GO=true creates the order; without it the run stops at the discount list (probe).
 */
import { test, expect } from '../../fixtures/page-factory';

const ACC = process.env.NS_DISC_ACCOUNT ?? '';
const OFFER = process.env.NS_DISC_OFFER ?? 'Recurring_Discount_Internet';
const GO = process.env.NS_DISC_GO === 'true';

test('NS discount: Modify order adding a discount to a QA contract', async ({ page, baseURL, testLogger }) => {
  test.setTimeout(10 * 60_000);
  expect(ACC, 'NS_DISC_ACCOUNT must be a QA account').toMatch(/^QA-ANH-NS-/);
  let n = 0;
  const step = async (name: string) => {
    const buttons = (await page.getByRole('button').allInnerTexts()).map(t => t.trim()).filter(Boolean);
    testLogger.log(`${ACC} ${name}: buttons ${[...new Set(buttons)].join(' | ').slice(0, 400)}`);
    await page.screenshot({ path: `test-results/ns-discount-${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => {});
  };
  await page.goto(`${baseURL!.replace(/\/+$/, '')}/customers/${ACC}/services`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(8000);
  await step('services');
  // Place Order: Modify (a link styled as a button, like Cancel / Suspend / Resume)
  const modify = page.getByRole('link', { name: 'Modify', exact: true });
  if (await modify.isVisible().catch(() => false)) await modify.click();
  else await page.getByRole('button', { name: 'Modify', exact: true }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(5000);
  await step('modify');
  await page.getByRole('button', { name: /^Add Discounts$/i }).first().click();
  const dlg = page.locator('.modal-content').last();
  await dlg.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(3000);
  await step('discount-list');
  const row = dlg.locator('tr', { hasText: OFFER }).first();
  expect(await row.count(), `discount offer ${OFFER} listed`).toBeGreaterThan(0);
  if (!GO) { testLogger.log(`${ACC}: probe only (NS_DISC_GO=true to create the order)`); return; }
  await row.click();
  await dlg.getByRole('button', { name: 'Select', exact: true }).click();
  await page.waitForTimeout(3000);
  await step('selected');
  // A 3-step wizard (Select Account > Manage & Override > Provisioning Data & Create Order): Next, then Create.
  await page.getByRole('button', { name: /^Next$/i }).first().click();
  await page.waitForTimeout(4000);
  // Billing Only, as Coope's discount order (ORD-2603: billingOnlyFlag true): a discount has nothing to provision.
  await page.getByText('Billing Only', { exact: true }).click();
  await step('step3');
  await page.getByRole('button', { name: /^Create$/i }).last().click();
  const toast = page.locator('.Toastify__toast, [role="alert"]').first();
  const message = await toast.innerText({ timeout: 20_000 }).catch(() => '(no message)');
  testLogger.log(`${ACC}: Create → ${message.replace(/\s+/g, ' ').slice(0, 300)}`);
  await page.waitForTimeout(4000);
  await step('created');
  // (the toast always ends with its close mark ✖︎: not a sign of failure)
  expect(message, 'order created').toMatch(/successfully/i);
  testLogger.log(`${ACC}: Modify order with ${OFFER} created`);
});
