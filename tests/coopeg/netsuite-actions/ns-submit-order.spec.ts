/**
 * NetSuite — last step of manual provisioning on coopegsbx2 (Kiet's CoopeG TC02): after the order's provisioning
 * steps are marked done in the DB, press "Submit order" on Customer > Subscription Data > Assets > Services and wait
 * for the service to be ACTIVE. QA accounts only.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_SUBMIT_ACCOUNT='QA-ANH-NS-R2-…-VN'
 *   npx playwright test tests/coopeg/netsuite-actions/ns-submit-order.spec.ts --project=dev --reporter=line
 */
import { test, expect } from '../../../fixtures/page-factory';

const ACC = process.env.NS_SUBMIT_ACCOUNT ?? '';
// Subscription status expected after the order: ACTIVE after NEW / RESUME / MODIFY, SUSPENDED after SUSPEND, CLOSED after CANCEL.
const EXPECT = process.env.NS_SUBMIT_EXPECT ?? 'ACTIVE';
const GQL = 'https://service-transactional.coopegsbx2.embrix.org/graphql';
const gql = async (query: string) => (await (await fetch(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })).json()) as any;

test('NS provisioning: Submit order for a QA contract', async ({ page, baseURL, testLogger }) => {
  test.setTimeout(10 * 60_000);
  expect(ACC, 'NS_SUBMIT_ACCOUNT must be a QA account').toMatch(/^QA-ANH-NS-/);
  // Customer > Subscription Data > Assets > Services is the route /customers/<id>/services.
  await page.goto(`${baseURL!.replace(/\/+$/, '')}/customers/${ACC}/services`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(8000);
  // In-Complete Orders: select the order row, refresh, and wait for Submit order to be enabled.
  const submit = page.getByRole('button', { name: 'Submit order' });
  for (let i = 0; i < 6 && !(await submit.isEnabled().catch(() => false)); i++) {
    await page.getByRole('row').filter({ hasText: 'ORD-' }).last().click().catch(() => {});
    await page.waitForTimeout(3000);
    if (await submit.isEnabled().catch(() => false)) break;
    await page.getByRole('button', { name: 'Refresh' }).click().catch(() => {});
    await page.waitForTimeout(5000);
  }
  testLogger.log(`${ACC}: Submit order enabled: ${await submit.isEnabled().catch(() => false)}`);
  await submit.click();
  testLogger.log(`${ACC}: Submit order clicked`);
  // The subscription status from the API: the screen hides CLOSED services and often shows the new status only after a reload.
  let status = '';
  for (let i = 0; i < 18 && status !== EXPECT; i++) {
    await page.waitForTimeout(5000);
    status = (await gql(`{ getSubscriptionByAccountId(input:{id:"${ACC}"}) { status } }`)).data?.getSubscriptionByAccountId?.[0]?.status ?? '';
  }
  await page.screenshot({ path: `test-results/ns-submit-${ACC}.png`, fullPage: true }).catch(() => {});
  testLogger.log(`${ACC}: subscription ${status || 'unknown'} (expected ${EXPECT})`);
  expect(status).toBe(EXPECT);
});
