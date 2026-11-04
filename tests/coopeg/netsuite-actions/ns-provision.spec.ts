/**
 * NetSuite — provision QA test contracts on coopegsbx2 so they can be billed (Bug_032: a new contract's order stays
 * CREATED until provisioning completes). Target build: feature/netsuite (provision-gateway EFT-98 rule).
 *
 * Flow (Congero QA evidence, 26-oct release, adapted to feature/netsuite):
 *   1. crm-gateway processAccountAndOrder (NEW)                         → order CREATED
 *   2. Core UI Order Management: New Order → Reference Order → View → +Add ONT → Submit → Next → Create
 *      → PROVISIONING_INITIATED; the NOKIA tasks run for real, UPDATE_WORK_ORDER fails (contract unknown in Coopeweb)
 *   3. provision-gateway updateProvisioningRequest with manualProvisioning = true ("provisioned by hand in NOKIA").
 *      A plain SUCCESS confirmation is rejected on feature/netsuite once an INTERNET step FAILED (EFT-98, C2-1).
 *   4. order COMPLETED, subscription + service ACTIVE
 *
 * Step 2 sends real requests to NOKIA for the ONT, so:
 *   - NS_PROV_ONT / NS_PROV_ONT_MODEL are required (never the page object's default, which is Kiet's ONT)
 *   - Kiet's ALCLB3A97FBA is refused
 *   - NS_PROV_ONT_CLEARED=true must confirm the ONT is free in NOKIA (Adrian / Coope) - this file cannot see NOKIA
 *   - refused if the ONT is on an active service / provision in this environment's database (read-only check)
 * Nothing is sent unless NS_PROV_GO=true; without it the test only runs the checks and prints the plan.
 * One ONT serves one contract: NS_PROV_TAGS lists the contracts (N normal, I intercompany, H PHC, X no Party Id), NS_PROV_ONT a
 * comma list with one ONT per tag, NS_PROV_ONT_MODEL one model or a comma list.
 *
 * Run (only when the ONT is free; VPN on for the DB check):
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_PROV_ONT='ALCLB3D9363D'; $env:NS_PROV_ONT_MODEL='G-2425G-B';
 *   $env:NS_PROV_TAGS='N'; $env:NS_PROV_ONT_CLEARED='true'; $env:NS_PROV_GO='true';
 *   npx playwright test tests/coopeg/netsuite-actions/ns-provision.spec.ts --project=dev --reporter=line
 * Results: test-results/ns-provision.json
 */
import * as fs from 'fs';
import { Client } from 'pg';
import { test, expect } from '../../../fixtures/page-factory';
import { contractBody, qaId, TD } from '../../../helpers/netsuite/ns-data';
import { provisioningOrder } from '../../../helpers/netsuite/ns-provision.helper';
import { suiteDir } from '../../../helpers/netsuite/suite-dir';

const GQL = 'https://service-transactional.coopegsbx2.embrix.org/graphql';
const CRM = 'https://crm-gateway.coopegsbx2.embrix.org';
const PROV = 'https://provision-gateway.coopegsbx2.embrix.org';
const PG_CFG = require('path').join(suiteDir(), 'tools', '.pg-coopegsbx-dev.json');
const KIET_ONT = 'ALCLB3A97FBA';

const list = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
const TAGS = list(process.env.NS_PROV_TAGS || 'N');
const ONTS = list(process.env.NS_PROV_ONT);
const MODELS = list(process.env.NS_PROV_ONT_MODEL);
const GO = process.env.NS_PROV_GO === 'true';

const gql = async (query: string) => (await (await fetch(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })).json()) as any;
const post = async (url: string, body: unknown) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: r.status, json, text }; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Contract per tag: N normal, I intercompany (CoopeG TC-14 shape), H PHC (CoopeG TC-16 shape, confirmed by Kiet),
 * T Internet + TV (BDL_INT_200MBPS_TV + BDL_TV, TV on MOTV with the contract number as id), B business (ENTERPRISE,
 * BDL_INT_30MBPS_EMP: the type and plans of Coope's business contracts, e.g. 140189). */
function contract(tag: string): { account: string; order: string; body: Record<string, unknown>; services: { serviceType: string; bundleId: string; packageId: string }[] } {
  const id = qaId(`V${tag}`);
  // NS_PROV_B_TYPE / NS_PROV_B_BUNDLE vary the business contract (B) to tell an account-type effect from a plan effect.
  // NS_PROV_X_PARTY=EMPTY sends the no-Party-Id contract (X) with partyId "" instead of without the field (Bug_026).
  const accounttype = ['N', 'X', 'T'].includes(tag) ? 'RESIDENTIAL' : tag === 'B' ? (process.env.NS_PROV_B_TYPE || 'ENTERPRISE') : 'INTERCOMPANY';
  const noParty = process.env.NS_PROV_X_PARTY === 'EMPTY' ? '' : null;
  const body = contractBody({ tag: `V${tag}`, partyId: tag === 'H' ? TD.PHC.party : tag === 'X' ? noParty : TD.FONATEL.party, accounttype, customAccountType: tag === 'H' ? 'PHC' : '' });
  let services = [{ serviceType: 'INTERNET', bundleId: 'BDL_INT_300MBPS', packageId: '' }];
  if (tag === 'H') services = [{ serviceType: 'INTERNET', bundleId: 'BDL_PHC_Q1_INT', packageId: '' }, { serviceType: 'INTERNET', bundleId: 'BDL_PHC_Q1_DISP', packageId: '' }];
  if (tag === 'T') services = [{ serviceType: 'INTERNET', bundleId: 'BDL_INT_200MBPS_TV', packageId: 'PKG_INT_TV_200MBPS' }, { serviceType: 'IPTV', bundleId: 'BDL_TV', packageId: 'PKG_INT_TV_200MBPS' }];
  if (tag === 'B') services = [{ serviceType: 'INTERNET', bundleId: process.env.NS_PROV_B_BUNDLE || 'BDL_INT_30MBPS_EMP', packageId: '' }];
  body.services = services.map(s => ({ ...s, action: 'ADD', quantity: '1' }));
  return { account: id, order: `${id}-O`, body, services };
}

async function ontInUse(ont: string): Promise<string[]> {
  const c = new Client({ ...JSON.parse(fs.readFileSync(PG_CFG, 'utf8')), port: 5432, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
    options: '-c default_transaction_read_only=on -c statement_timeout=60000' });
  await c.connect();
  try {
    const su = (await c.query(`select id, accountid, status from core_engine.service_unit where provisioningid = $1 and status <> 'CLOSED'`, [ont])).rows;
    const sp = (await c.query(`select provisioningid, enddate from core_engine.service_provision where provisioningid = $1 and enddate is null`, [ont])).rows;
    const osp = (await c.query(`select id, status from core_oms.order_service_provisions where provisioningid = $1`, [ont])).rows;
    return [...su.map(r => `service ${r.id} (${r.accountid}) ${r.status}`), ...sp.map(() => 'open service provision'),
      ...osp.map(r => `order row ${r.id} status ${r.status ?? 'null'} (informational)`)];
  } finally { await c.end(); }
}

test('NS provisioning: QA test contracts provisioned on coopegsbx2', async ({ page, orderManagementPage, testLogger }) => {
  test.setTimeout(45 * 60_000);
  expect(process.env.TEST_ENV, 'coopegsbx2 only').toBe('coopegsbx2');
  expect(ONTS.length, 'NS_PROV_ONT: one ONT per contract tag').toBe(TAGS.length);
  expect(ONTS, `never Kiet's ONT ${KIET_ONT}`).not.toContain(KIET_ONT);
  const models = TAGS.map((_, i) => MODELS[i] ?? MODELS[0]);
  expect(models.every(Boolean), 'NS_PROV_ONT_MODEL is required').toBeTruthy();

  const plan = TAGS.map((tag, i) => ({ tag, ont: ONTS[i], model: models[i], ...contract(tag) }));
  const out: any = { go: GO, plan: plan.map(p => ({ tag: p.tag, account: p.account, ont: p.ont, model: p.model, services: p.services })), contracts: [] as any[] };
  testLogger.log(`plan: ${JSON.stringify(out.plan)}`);

  // Read-only checks first.
  for (const p of plan) {
    const use = await ontInUse(p.ont);
    testLogger.log(`ONT ${p.ont} on this environment: ${use.join('; ') || 'free'}`);
    expect(use.filter(u => !u.endsWith('(informational)')), `ONT ${p.ont} busy on coopegsbx2`).toEqual([]);
  }
  if (!GO) {
    out.result = 'dry run: checks only, nothing sent (set NS_PROV_GO=true to act)';
    fs.writeFileSync('test-results/ns-provision.json', JSON.stringify(out, null, 2));
    testLogger.log(out.result);
    return;
  }
  expect(process.env.NS_PROV_ONT_CLEARED, 'confirm the ONT is free in NOKIA (Adrian / Coope): NS_PROV_ONT_CLEARED=true').toBe('true');
  for (const p of plan) {
    const c: any = { tag: p.tag, account: p.account, order: p.order, ont: p.ont };
    out.contracts.push(c);
    // 1. contract
    const created = await post(`${CRM}/processAccountAndOrder`, p.body);
    c.create = `${created.status} ${created.text.slice(0, 200)}`;
    testLogger.log(`${p.account}: processAccountAndOrder ${c.create}`);
    expect(created.json?.status, 'contract created').toBe('SUCCESS');
    // 2. provisioning order in Order Management (same screens as CoopeG ts-01 TC-03 / Congero evidence step 2)
    if (p.tag === 'T') {
      // One provisioning row per service type: the ONT for the Internet, MOTV (id = contract number) for the TV.
      c.provisioningOrder = await provisioningOrder(page, orderManagementPage, p.account, p.order,
        [{ serviceType: 'INTERNET', id: p.ont, model: p.model }, { serviceType: 'IPTV', id: p.account, platform: 'MOTV' }]).catch(e => `error: ${(e as Error).message}`);
      testLogger.log(`${p.account}: provisioning order ${c.provisioningOrder}`);
      if (process.env.NS_PROV_DB_COMPLETE === 'true') { c.next = 'complete the order in the DB, then ns-submit-order'; continue; }
    } else {
    await (page as any).navigateToHome();
    await orderManagementPage.navigateViaNav();
    await orderManagementPage.clickCreateNewOrder();
    await orderManagementPage.searchAccountById(p.account, { clearFilters: true });
    await orderManagementPage.clickNextInFirstRow();
    await orderManagementPage.clickReferenceOrder();
    await orderManagementPage.searchByOrderId(p.order);
    // The visible box is drawn by CSS on a zero-size label, so fire the click on the input itself (ns-90 probe).
    await page.getByRole('dialog').locator('tr', { hasText: p.order }).first().getByRole('checkbox').dispatchEvent('click');
    await orderManagementPage.clickSelectButton();
    // The subscription panel is titled "Subscription: Primary" here, not FIRST_INVOICE_SUBSCRIPTION as the page object
    // expects, so open the provisioning data from the service row's View button (as Kiet's TC02) and fill it.
    await page.getByRole('button', { name: 'View', exact: true }).first().click();
    await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: 30_000 });
    await orderManagementPage.clickAddButton();
    await orderManagementPage.inputProvisioningId(p.ont);
    await orderManagementPage.inputOntModel(p.model);
    await orderManagementPage.clickSubmitButton();
    await orderManagementPage.clickNextAboveSubscription();
    await orderManagementPage.clickCreate();
    c.provisioningOrder = await orderManagementPage.isProvisioningOrderSuccessfulToastAppear().catch(e => `error: ${(e as Error).message}`);
    testLogger.log(`${p.account}: provisioning order ${c.provisioningOrder}`);
    // NS_PROV_DB_COMPLETE=true: stop here; the order is completed with the DB step + Submit order (coopegsbx2: the
    // manual re-run fails on GET_ACCOUNT_PROVISIONING_DATA / NOKIA for test contracts).
    if (process.env.NS_PROV_DB_COMPLETE === 'true') { c.next = 'complete the order in the DB, then ns-submit-order'; continue; }
    }
    // 3. wait for the NOKIA tasks to settle (PROVISIONING_ERROR expected: UPDATE_WORK_ORDER fails in a sandbox)
    let status = '';
    for (let i = 0; i < 30 && !['PROVISIONING_ERROR', 'COMPLETED'].includes(status); i++) {
      await sleep(10_000);
      status = (await gql(`{ searchOrders(page:1,size:5,filter:{accountId:"${p.account}"}) { id status } }`)).data?.searchOrders?.find((o: any) => o.id === p.order)?.status ?? '';
    }
    c.orderAfterTasks = status;
    testLogger.log(`${p.account}: order after NOKIA tasks ${status}`);
    // 4. simulated Coopeweb confirmation: provisioned by hand (manualProvisioning)
    if (status !== 'COMPLETED') {
      const confirm = await post(`${PROV}/updateProvisioningRequest`, {
        orderId: p.order, accountId: p.account, orderType: 'NEW', restartProvisioning: false, manualProvisioning: true,
        services: p.services.map(s => ({ ...s, action: 'ADD', provisioningId: p.ont, ontModel: p.model, provisioningDataType: 'DEVICE' })),
      });
      c.confirmation = `${confirm.status} ${confirm.text.slice(0, 300)}`;
      testLogger.log(`${p.account}: updateProvisioningRequest ${c.confirmation}`);
    }
    // 5. order COMPLETED, subscription + service ACTIVE
    let state: any = {};
    for (let i = 0; i < 24; i++) {
      await sleep(10_000);
      state = (await gql(`{ o: searchOrders(page:1,size:5,filter:{accountId:"${p.account}"}) { id status } s: getSubscriptionByAccountId(input:{id:"${p.account}"}) { id status } v: getServiceUnitsByAccountId(input:{id:"${p.account}"}) { id status } }`)).data ?? {};
      if (state.o?.find((o: any) => o.id === p.order)?.status === 'COMPLETED' && state.s?.some((x: any) => x.status === 'ACTIVE')) break;
    }
    c.final = state;
    testLogger.log(`${p.account}: final ${JSON.stringify(state)}`);
  }
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/ns-provision.json', JSON.stringify(out, null, 2));
  for (const c of out.contracts) {
    // NS_PROV_DB_COMPLETE: done here once the provisioning order exists (the order left CREATED); the DB step + Submit order follow.
    if (process.env.NS_PROV_DB_COMPLETE === 'true') {
      const st = (await gql(`{ searchOrders(page:1,size:5,filter:{accountId:"${c.account}"}) { id status } }`)).data?.searchOrders?.find((o: any) => o.id === c.order)?.status;
      testLogger.log(`${c.account}: order ${st}`);
      expect.soft(st, `${c.account} provisioning order created`).not.toBe('CREATED');
      continue;
    }
    expect.soft(c.final?.o?.find((o: any) => o.id === c.order)?.status, `${c.account} order`).toBe('COMPLETED');
    expect.soft(c.final?.s?.some((x: any) => x.status === 'ACTIVE'), `${c.account} subscription ACTIVE`).toBe(true);
  }
});
