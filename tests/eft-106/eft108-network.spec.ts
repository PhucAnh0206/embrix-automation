/**
 * EFT-108 / EFT-109: the network side on coopegsbx2 — real provisioning (NOKIA), TV (MOTV), phone (PortaOne) and
 * relocation — ready for when Coope gives this environment its own equipment. Until then every test records
 * "Blocked" with what it needs, and sends nothing.
 *
 * Settings (all required for anything to be sent):
 *   EFT_ONT, EFT_ONT_MODEL     a test ONT of this environment (never Kiet's ALCLB3A97FBA)
 *   EFT_ONT_CLEARED=true       Coope (Adrian) confirmed the ONT is free in NOKIA (this file cannot see NOKIA)
 *   EFT_GO=true                act; without it only the checks run
 * Optional:
 *   EFT_TV=true                            add TV with BDL_INT_200MBPS_TV (MOTV logs the viewer in with the contract number,
 *                                          no TV box). The contract gets the QA e-mail (MOTV refused the Sandbox's "--email--"
 *                                          placeholder); EFT_EMAIL / EFT_PHONE override it if MOTV refuses ours
 *   EFT_DID                                add a phone line with this number from the PortaOne number inventory
 *   EFT_RELOC_ONT, EFT_RELOC_ONT_MODEL     relocate the new contract to this ONT (Coopeweb RELOCATION order)
 *   EFT_ACCOUNT                            judge a contract an earlier run already created and ordered (sends nothing)
 *   EFT_RESUBMIT=true (with EFT_ACCOUNT)   first send its failed order again: Order detail > Submit order, as an agent
 *                                          retries a PROVISIONING_ERROR order (Cancel is disabled in that state)
 *
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; npx playwright test --project=eft106 tests/eft-106/eft108-network.spec.ts --reporter=line
 * Then rerun eft109-integrations with EFT_SINCE = the first activity id of this run, so EFT-109 judges these calls.
 */
import { expect } from '@playwright/test';
import { test } from '../../fixtures/page-factory';
import { NsApi } from '../../helpers/netsuite/ns-api.helper';
import { contractBody, qaId } from '../../helpers/netsuite/ns-data';
import { QA_EMAIL } from '../../helpers/customer-contact.helper';
import { KIET_ONT, ontInUse, provisioningOrder, ProvRow } from '../../helpers/netsuite/ns-provision.helper';
import { calls, Call, db, record, Shots } from './eft-lib';
import { SuspendResumeOrderPage } from '../../pages/customer-hub/order-management/suspend-resume-order.page';

const E = process.env;
const TV = E.EFT_TV === 'true';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test.use({ viewport: { width: 1800, height: 1000 } });

/** Why nothing can be sent yet ('' = all set). */
function gate(): string {
  if (!E.EFT_ONT || !E.EFT_ONT_MODEL) return 'a test ONT of this environment (EFT_ONT / EFT_ONT_MODEL): the only one is shared with the CoopeG Sandbox';
  if (E.EFT_ONT === KIET_ONT || E.EFT_RELOC_ONT === KIET_ONT) return `never Kiet's ONT ${KIET_ONT}`;
  if (E.EFT_ONT_CLEARED !== 'true') return 'confirmation from Coope that the ONT is free in NOKIA (EFT_ONT_CLEARED=true)';  return '';
}

const orderStatus = async (order: string) => (await db('select status from core_oms."order" where id = $1', [order]))[0]?.status as string | undefined;
async function settle(order: string, done = ['COMPLETED', 'PROVISIONING_ERROR', 'CANCELLED']): Promise<string> {
  let s = '';
  for (let i = 0; i < 40 && !done.includes(s); i++) { await sleep(10_000); s = (await orderStatus(order)) ?? ''; }
  return s;
}
const verdict = (cs: Call[]) => cs.length && cs.every(c => c.ok) ? 'Pass' as const : 'Fail' as const;
const line = (cs: Call[]) => cs.map(c => `${c.api} ${c.ok ? 'answered' : 'FAILED'}`).join(', ') || 'no call';

test.describe.serial('EFT-108 network processes (NOKIA / MOTV / PortaOne)', () => {
  const acc = E.EFT_ACCOUNT ?? qaId('E108');
  const order = `${acc}-O`;
  let provisioned = false;

  test('Provisioning: a new contract is provisioned in NOKIA (and MOTV / PortaOne when ordered)', async ({ page, orderManagementPage, playwright }) => {
    test.setTimeout(30 * 60_000);
    const why = gate();
    if (why) {
      record('EFT108-PROVISIONING', 'Blocked', `Not run: needs ${why}.`);
      if (TV) record('EFT108-TV', 'Blocked', `Not run: needs ${why}.`);
      if (E.EFT_DID) record('EFT108-VOIP', 'Blocked', `Not run: needs ${why}.`);
      test.skip(true, why);
    }
    const busy = E.EFT_ACCOUNT ? [] : await ontInUse(E.EFT_ONT!);
    expect(busy, `ONT ${E.EFT_ONT} still used on coopegsbx2`).toEqual([]);
    if (!E.EFT_ACCOUNT && E.EFT_GO !== 'true') { record('EFT108-PROVISIONING', 'Not tested', `Checks passed for ONT ${E.EFT_ONT}; nothing sent (EFT_GO=true to act).`); test.skip(true, 'dry run'); }

    // 1. The contract, as Coopeweb sends it (system actor: API).
    const body = contractBody({ tag: 'E108' });
    const rows: ProvRow[] = [{ serviceType: 'INTERNET', id: E.EFT_ONT!, model: E.EFT_ONT_MODEL! }];
    if (TV || E.EFT_DID) {
      const pkg = E.EFT_DID ? 'PKG_INT_TV_VOIP_10MBPS' : 'PKG_INT_TV_200MBPS';
      body.services = [
        { action: 'ADD', bundleId: E.EFT_DID ? 'BDL_INT_10MBPS_TV_VOIP' : 'BDL_INT_200MBPS_TV', quantity: '1', packageId: pkg, serviceType: 'INTERNET' },
        { action: 'ADD', bundleId: 'BDL_TV', quantity: '1', packageId: pkg, serviceType: 'IPTV' },
        ...(E.EFT_DID ? [{ action: 'ADD', bundleId: 'BDL_VOIP', quantity: '1', packageId: pkg, serviceType: 'VOIP' }] : []),
      ];
      // The package always brings TV: MOTV gets the contract number as the viewer login.
      rows.push({ serviceType: 'IPTV', id: acc, platform: 'MOTV' });
      if (E.EFT_DID) rows.push({ serviceType: 'VOIP', id: E.EFT_DID });
    }
    if (TV) body.email = QA_EMAIL;
    if (E.EFT_EMAIL) body.email = E.EFT_EMAIL;
    if (E.EFT_PHONE) body.phone = E.EFT_PHONE;
    let toast = 'created by an earlier run';
    const sinceRetry = E.EFT_RESUBMIT === 'true' ? Number((await db('select max(substring(id from 3)::int) m from core_engine.activity'))[0].m) : 0;
    if (E.EFT_ACCOUNT && E.EFT_RESUBMIT === 'true') {
      expect(E.EFT_GO, 'EFT_GO=true to send the order again').toBe('true');
      const od = new SuspendResumeOrderPage(page);
      await od.openOrderDetail(order);
      await od.submitOrder();
      toast = 'submitted again from Order detail';
    }
    if (!E.EFT_ACCOUNT) {
      const api = new NsApi(await playwright.request.newContext());
      const created = await api.crm('processAccountAndOrder', body);
      expect(created.json?.status, `contract ${acc}`).toBe('SUCCESS');
      // 2. The provisioning order in Order Management (agent), then NOKIA / MOTV / PortaOne run on their own.
      toast = await provisioningOrder(page, orderManagementPage, acc, order, rows);
    }
    const status = await settle(order);
    const all = (await calls({ accountId: acc }, true)).filter(c => Number(c.id.slice(2)) > sinceRetry); // a retry is judged on its own calls
    const nokia = all.filter(c => c.provider === 'NOKIA');
    const motv = all.filter(c => c.provider === 'MOTV');
    const porta = all.filter(c => c.provider === 'PORTAONE');
    const coope = all.filter(c => c.provider === 'COOPEWEB' && /WORK_ORDER|PROVISIONING|STB|IDENTIFIER/.test(c.api));

    const shots = new Shots(page, 'EFT108-PROVISIONING');
    await shots.screen('services', `/customers/${acc}/services`);
    const lastOf = (cs: Call[], api: string) => [...cs].reverse().find(c => c.api === api);
    for (const c of [lastOf(nokia, 'GET_LOCATION_DATA'), lastOf(nokia, 'GET_SPACE_DATA'), lastOf(nokia, 'CREATE_PROVISIONING_ORDER'), lastOf(coope, 'UPDATE_WORK_ORDER')].filter(Boolean) as Call[])
      await shots.activity(c.api.toLowerCase().replace(/_/g, '-'), acc, c.id);
    provisioned = verdict(nokia) === 'Pass' && status === 'COMPLETED';
    record('EFT108-PROVISIONING', provisioned ? 'Pass' : 'Fail',
      `New contract ${acc} with ONT ${E.EFT_ONT}: provisioning order ${toast ? 'created' : 'not confirmed'}; order ${status}. NOKIA: ${line(nokia)}. Coopeweb: ${line(coope)}.`,
      { account: acc, order, status, rows, nokia, coopeweb: coope, screenshots: shots.files });

    if (TV && !motv.length && !provisioned) {
      record('EFT108-TV', 'Blocked', `Not reached: TV goes to MOTV only after the Internet is provisioned, and ${acc}'s provisioning did not complete (order ${status}).`);
    } else if (TV) {
      // MOTV's own calls: the session login keeps MOTV's password in the activity, so no screenshot of it (only the order).
      const tvShots = new Shots(page, 'EFT108-TV');
      const stb = lastOf(motv, 'CREATE_STB_PROVISIONING_ORDER');
      if (stb) await tvShots.activity('motv-stb-provisioning', acc, stb.id);
      record('EFT108-TV', verdict(motv.filter(c => c.api !== 'SESSION_LOGIN')),
        `TV on ${acc}: MOTV ${line(motv)}; NOKIA TV steps: ${line(nokia.filter(c => /IPTV|TEMPLATE|REPROVISIONING/.test(c.api)))}.`, { motv, screenshots: tvShots.files });
    }
    if (E.EFT_DID) {
      // No screenshots: PortaOne activity shows its token and password.
      record('EFT108-VOIP', verdict(porta.filter(c => !/LOGIN|LOGOUT/.test(c.api))), `Phone line ${E.EFT_DID} on ${acc}: PortaOne ${line(porta)}.`, { portaone: porta });
    }
    expect(nokia.filter(c => !c.ok).map(c => `${c.id} ${c.api}`), 'NOKIA calls that failed').toEqual([]);
    expect(status).toBe('COMPLETED');
  });

  test('Relocation: the provisioned contract moves to another ONT (Coopeweb RELOCATION order)', async ({ page, playwright }) => {
    test.setTimeout(20 * 60_000);
    const why = gate() || (!E.EFT_RELOC_ONT || !E.EFT_RELOC_ONT_MODEL ? 'the ONT to relocate to (EFT_RELOC_ONT / EFT_RELOC_ONT_MODEL)' : '')
      || (E.EFT_GO !== 'true' ? 'EFT_GO=true' : '') || (!provisioned ? 'a contract provisioned by the test above' : '');
    if (why) { record('EFT108-RELOCATION', 'Blocked', `Not run: needs ${why}.`); test.skip(true, why); }
    expect(await ontInUse(E.EFT_RELOC_ONT!), `ONT ${E.EFT_RELOC_ONT} still used on coopegsbx2`).toEqual([]);

    // The request Coopeweb sends for a relocation (shape from the copied data: 227860, orders 2089124 / 2187625).
    const reloc = `${acc}-R`;
    const api = new NsApi(await playwright.request.newContext());
    const res = await api.crm('processAccountAndOrder', {
      userId: 'COOPEWEB', orderId: reloc, accountId: acc, orderType: 'RELOCATION', provisioningOnlyFlag: 'true', changeOlt: 'true',
      services: [{ action: 'ADD', serviceType: 'INTERNET', provisioningDataType: 'DEVICE', ontSerialNumber: E.EFT_RELOC_ONT, ontModelNumber: E.EFT_RELOC_ONT_MODEL }],
    });
    expect(res.json?.status, 'relocation order accepted').toBe('SUCCESS');
    const status = await settle(reloc);
    const nokia = (await calls({ accountId: acc }, true)).filter(c => c.provider === 'NOKIA' && c.request && (c.request.includes(E.EFT_RELOC_ONT!) || /DEPROVISIONING|SPACE/.test(c.api)));
    const shots = new Shots(page, 'EFT108-RELOCATION');
    await shots.screen('order', `/orders/${encodeURIComponent(reloc)}/detail`);
    const prov = [...nokia].reverse().find(c => c.api === 'CREATE_PROVISIONING_ORDER');
    if (prov) await shots.activity('nokia-provisioning', acc, prov.id);
    // Expected NOKIA steps (completed relocation ORD-2468 in the copied data): location, clean the old port, free space, provision.
    const need = ['GET_LOCATION_DATA', 'CREATE_DEPROVISIONING_ORDER', 'GET_SPACE_DATA', 'CREATE_PROVISIONING_ORDER'];
    const missing = need.filter(a => !nokia.some(c => c.api === a && c.ok));
    const ok = status === 'COMPLETED' && missing.length === 0;
    record('EFT108-RELOCATION', ok ? 'Pass' : 'Fail',
      `Relocation ${reloc} of ${acc} to ONT ${E.EFT_RELOC_ONT}: order ${status}; NOKIA ${line(nokia)}${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`,
      { order: reloc, status, nokia, screenshots: shots.files });
    expect(missing).toEqual([]);
    expect(status).toBe('COMPLETED');
  });
});
