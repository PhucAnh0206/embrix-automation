/**
 * NetSuite — a manual invoice made the agents' way (Customer > Manual Billing > + ADD NEW MANUAL TRANSACTION > item,
 * quantity, price > RUN MANUAL BILL), with screenshots of the filled screen and of the answer. Used on 28 Oct to show the
 * prepaid electricity case: "Bill total and invoice total not matched". Does not touch the clock. QA / test accounts only.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_MI_ACCOUNT='PREP-2024090501'; $env:NS_MI_LINE='ELECTRICITY:I-100003:1000'
 *   npx playwright test tests/coopeg/netsuite-actions/ns-manual-invoice.spec.ts --project=dev --reporter=line
 */
import { test } from '@playwright/test';
import { NsApi } from '../../../helpers/netsuite/ns-api.helper';
import { attachUi } from '../../../helpers/netsuite/ns-ui.helper';

const ACC = process.env.NS_MI_ACCOUNT ?? '';
const [SVC, ITEM, PRICE] = (process.env.NS_MI_LINE ?? 'ELECTRICITY:I-100003:1000').split(':');

test('NS manual invoice: one line through Manual Billing, answer on screen', async ({ playwright, browser }) => {
  test.setTimeout(10 * 60_000);
  test.skip(!ACC, 'NS_MI_ACCOUNT=<account>');
  const api = new NsApi(await playwright.request.newContext());
  const ui: any = await attachUi(api, browser);
  const shot = (name: string) => ui.page.screenshot({ path: `test-results/ns-manual-invoice-${ACC}-${name}.png`, fullPage: true }).catch(() => { });
  // The answer toast is short-lived: catch it as soon as it appears.
  ui.page.on('console', () => { });
  let result: string;
  try {
    const r = await ui.manualInvoice(ACC, [{ serviceType: SVC, itemId: ITEM, quantity: 1, unitPrice: Number(PRICE), description: 'QA-NS prepaid check' }]);
    result = `invoice ${r.id} created: ${r.toast}`;
  } catch (e) { result = `refused: ${(e as Error).message.split('\n').find(l => /Received|Expected|toast|refused|Bill total/i.test(l)) ?? (e as Error).message.slice(0, 200)}`; }
  await shot('answer');
  console.log(`${ACC} Manual Billing ${SVC} ${ITEM} ${PRICE}: ${result}`);
});
