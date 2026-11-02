/**
 * NetSuite — send one invoice to NetSuite the agents' way (Bills > select the invoice > SYNC_INVOICE) and report NetSuite's
 * answer. Used for invoices never sent, e.g. prepaid electricity invoices since financeSyncPrepaidInvoices = true (28 Oct:
 * "older ones can be sent from Bills > SYNC_INVOICE"). Does not touch the clock.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_SYNC_INVOICE='146195:206874'
 *   npx playwright test tests/dev/ns-sync-invoice.spec.ts --project=dev --reporter=line
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../helpers/netsuite/ns-api.helper';
import { attachUi } from '../../helpers/netsuite/ns-ui.helper';
import { Shots } from '../eft-106/eft-lib';

const [ACC, INV] = (process.env.NS_SYNC_INVOICE ?? '').split(':');

test('NS sync: one invoice sent to NetSuite from Bills > SYNC_INVOICE', async ({ playwright, browser }) => {
  test.setTimeout(15 * 60_000);
  expect(ACC && INV, 'NS_SYNC_INVOICE=<account>:<invoice>').toBeTruthy();
  const api = new NsApi(await playwright.request.newContext());
  // NS_SYNC_SHOT_ONLY=true: only a screenshot of the invoice's row on Bills (finance status and error), nothing sent.
  if (process.env.NS_SYNC_SHOT_ONLY === 'true') {
    const page = await browser.newPage({ viewport: { width: 2600, height: 1000 } });
    const shots = new Shots(page, `SYNC-${INV}`);
    await shots.billRow('bills', ACC, INV);
    console.log(`${INV}: ${shots.files.join(', ')}`);
    return;
  }
  await attachUi(api, browser);
  const sendsBefore = (await api.activitiesFor(ACC, INV, 'CREATE_INVOICE')).length;
  const before = await api.invoice(INV);
  const r = await api.syncInvoice(INV, ACC);
  console.log(`${INV} (${ACC}) before: ${before.financeSyncStatus ?? 'never sent'} ${before.financeVersion ?? ''}; screen: ${JSON.stringify(r)}`);
  const act = await api.waitForActivity(ACC, INV, 'CREATE_INVOICE', 240_000);
  const sends = await api.activitiesFor(ACC, INV, 'CREATE_INVOICE');
  const after = await api.invoice(INV);
  const res = parse(act?.response);
  console.log(`${INV}: CREATE_INVOICE calls ${sendsBefore} → ${sends.length}; NetSuite ${JSON.stringify(res ?? act?.response ?? 'no answer').slice(0, 400)}; after: ${after.financeSyncStatus} ${after.financeVersion ?? ''} ${after.financeErrorMessage ?? ''}`);
  expect(sends.length, 'the invoice was sent to NetSuite').toBeGreaterThan(sendsBefore);
});
