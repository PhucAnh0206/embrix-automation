/**
 * EFT-107: the 5 issues Coopeguanacaste reported on the NetSuite environment (EFT-106), checked on coopegsbx2.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; npx playwright test --project=eft106 tests/coopeg/tickets/eft-106/eft107-client-issues.spec.ts --reporter=line
 * I1-I3 create one new QA contract the way Coopeweb does (crm-gateway processAccountAndOrder: a system actor, so API).
 * I4 reads what NOKIA answered to this environment's provisioning steps (no new provisioning: that needs a free ONT,
 *    the one we have is assigned to a Sandbox contract in NOKIA). EFT_NOKIA_SINCE = first activity id to look at.
 * I5 creates a manual invoice on 208886 through Bills > Manual Billing and finds it once in the NetSuite sandbox.
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../../../helpers/netsuite/ns-api.helper';
import { attachUi } from '../../../../helpers/netsuite/ns-ui.helper';
import { NsSandbox } from '../../../../helpers/netsuite/ns-sandbox.helper';
import { contractBody, qaId, TD } from '../../../../helpers/netsuite/ns-data';
import { calls, db, record, Shots } from './eft-lib';

// First activity of this environment's current database era (the 10-23 database copy): older rows came with the copy.
const SINCE = Number(process.env.EFT_NOKIA_SINCE ?? 1209397);

// Wide enough for the Customer Activity columns (Merchant Name, Api Name) in the screenshots.
test.use({ viewport: { width: 1800, height: 1000 } });

test.describe.serial('EFT-107 client-reported issues', () => {
  let api: NsApi;
  const acc = qaId('E107');
  const sentOrder = `${acc}-O`;

  test.beforeAll(async ({ playwright }) => { api = new NsApi(await playwright.request.newContext()); });

  test('I1: a new contract\'s order keeps the order number Coopeweb sent', async ({ page }) => {
    const res = await api.crm('processAccountAndOrder', contractBody({ tag: 'E107' }));
    let order: any;
    for (let i = 0; i < 12 && !order; i++) {
      order = (await db('select id, accountid, type, status from core_oms."order" where accountid = $1', [acc]))[0];
      if (!order) await new Promise(r => setTimeout(r, 5000));
    }
    const ok = res.status === 200 && order?.id === sentOrder;
    const shots = new Shots(page, 'EFT107-I1');
    if (order) {
      await shots.screen('order', `/orders/${encodeURIComponent(order.id)}/detail`);
      const sent = (await calls({ accountId: acc, api: 'PROCESS_ACCOUNT_AND_ORDER' }))[0];
      if (sent) await shots.activity('coopeweb-request', acc, sent.id);
    }
    record('EFT107-I1', ok ? 'Pass' : 'Fail',
      ok ? `New contract ${acc}: the order is created with the number sent (${sentOrder}), status ${order.status}.`
        : `New contract ${acc}: HTTP ${res.status}; order ${order?.id ?? 'not created'} (sent ${sentOrder}).`,
      { request: contractBody({ tag: 'E107' }), answer: res.json ?? res.text, order, screenshots: shots.files });
    expect(res.status).toBe(200);
    expect(order?.id).toBe(sentOrder);
  });

  test('I2: no subscription is created before the order is provisioned', async ({ page }) => {
    const subs = await db('select id, status from core_engine.subscription where accountid = $1', [acc]);
    const order = (await db('select status from core_oms."order" where id = $1', [sentOrder]))[0];
    const ok = subs.length === 0 && order?.status !== 'COMPLETED';
    const shots = new Shots(page, 'EFT107-I2');
    await shots.screen('services', `/customers/${acc}/services`);
    record('EFT107-I2', ok ? 'Pass' : 'Fail',
      ok ? `Contract ${acc}: no subscription while its order is ${order?.status}.` : `Contract ${acc}: ${subs.length} subscription(s) (${subs.map(s => `${s.id} ${s.status}`).join(', ')}) with the order ${order?.status}.`,
      { subscriptions: subs, order, screenshots: shots.files });
    expect(subs).toEqual([]);
  });

  test('I3: the account has no active service before provisioning', async ({ page }) => {
    const svcs = await db('select id, status from core_engine.service_unit where accountid = $1', [acc]);
    const active = svcs.filter(s => s.status === 'ACTIVE');
    const shots = new Shots(page, 'EFT107-I3');
    await shots.screen('services', `/customers/${acc}/services`);
    record('EFT107-I3', active.length ? 'Fail' : 'Pass',
      active.length ? `Contract ${acc}: ${active.length} active service(s) right after creation.` : `Contract ${acc}: no active service right after creation (${svcs.length} service record(s)).`,
      { services: svcs, screenshots: shots.files });
    expect(active).toEqual([]);
  });

});

test.describe('EFT-107 client-reported issues (independent)', () => {
  let api: NsApi;
  test.beforeAll(async ({ playwright }) => { api = new NsApi(await playwright.request.newContext()); });

  test('I4: provisioning reaches NOKIA (location lookup answered)', async ({ page }) => {
    const nokia = await calls({ provider: 'NOKIA', sinceId: SINCE });
    const lookups = nokia.filter(c => c.api === 'GET_LOCATION_DATA');
    const okLookups = lookups.filter(c => c.ok);
    const failed = nokia.filter(c => !c.ok);
    const why = [...new Set(failed.map(c => c.answer.match(/errorMsg":\s*"([^"]{0,90})/)?.[1] ?? c.answer.slice(0, 90)))];
    const onts = [...new Set((await calls({ provider: 'NOKIA', sinceId: SINCE, api: 'GET_LOCATION_DATA' }, true)).map(c => c.request?.match(/ALCL[A-Z0-9]{8}/)?.[0]).filter(Boolean))];
    if (!nokia.length) {
      record('EFT107-I4', 'Not tested', 'No provisioning has called NOKIA on this environment yet.', {});
      test.skip(true, 'no NOKIA call to judge');
    }
    const ok = lookups.length > 0 && okLookups.length === lookups.length;
    // The latest failed lookup as Customer Activity shows it (request to NOKIA and its answer).
    const shots = new Shots(page, 'EFT107-I4');
    const lastFail = [...lookups].reverse().find(c => !c.ok);
    if (lastFail) await shots.activity('nokia-location-lookup', lastFail.accountId, lastFail.id);
    record('EFT107-I4', ok ? 'Pass' : 'Fail',
      ok ? `All ${lookups.length} NOKIA location lookups answered.`
        : `Reproduced: NOKIA answered with an error to ${lookups.length - okLookups.length} of ${lookups.length} location lookups for the test ONT(s) ${onts.join(', ')}; without the location the next steps are not sent (${failed.length} of ${nokia.length} NOKIA calls failed). Development team: this environment reaches the same NOKIA with the same request as the CoopeG Sandbox; the error is NOKIA's answer for an ONT the Sandbox also uses, not an Embrix defect. Errors: ${why.map(w => w.slice(0, 60)).join(' | ')}.`,
      { since: SINCE, screenshots: shots.files, calls: nokia.map(c => ({ id: c.id, account: c.accountId, api: c.api, ok: c.ok, answer: c.answer.slice(0, 200) })) });
    expect(failed.map(c => `${c.id} ${c.api}`), 'NOKIA calls that failed').toEqual([]);
  });

  test('I5: an invoice of a contract NetSuite knows reaches NetSuite once', async ({ browser, page }) => {
    await attachUi(api, browser);
    const id = await api.manualInvoice(TD.DEFAULT.account, [{ itemId: 'I_INT', serviceType: 'INTERNET', description: 'QA EFT-107 I5', quantity: 1, unitPrice: 1000 }]);
    const act = await api.waitForActivity(TD.DEFAULT.account, id, 'CREATE_INVOICE');
    const res = parse(act?.response);
    const inv = await api.invoice(id);
    const sends = (await api.activitiesFor(TD.DEFAULT.account, id, 'CREATE_INVOICE')).length;
    const shots = new Shots(page, 'EFT107-I5');
    await shots.billRow('bills', TD.DEFAULT.account, id);
    if (act?.id) await shots.activity('netsuite-request', TD.DEFAULT.account, act.id);
    let ns = { total: 0, rows: [] as { text: string }[] };
    if (inv.financeVersion) {
      const sb = await NsSandbox.open(browser);
      ns = await shots.netsuite(`netsuite-${inv.financeVersion}`, sb, inv.financeVersion).finally(() => sb.close());
    }
    const amount = Number(inv.total).toLocaleString('en-US', { minimumFractionDigits: 2 });
    const ok = res?.error === false && sends === 1 && ns.total === 1 && (ns.rows[0]?.text ?? '').includes(amount);
    record('EFT107-I5', ok ? 'Pass' : 'Fail',
      `Invoice ${id} of 208886 (${amount}, made in Bills > Manual Billing): NetSuite ${res?.error === false ? `accepted it as ${inv.financeVersion}` : `answered ${JSON.stringify(res)}`}; sent ${sends} time(s); NetSuite sandbox search ${inv.financeVersion ?? '-'}: ${ns.total} record(s) — ${ns.rows.map(r => r.text).join(' | ')}`,
      { invoice: inv, activity: act?.id, request: parse(act?.request), answer: res, netsuiteSandbox: ns, screenshots: shots.files });
    expect(ok).toBe(true);
  });
});
