/**
 * EFT-109: evidence of the 5 integrations Coopeguanacaste listed (NetSuite, CoopeWeb, NOKIA, PortaOne, MOTV), on
 * coopegsbx2. Each check reads what the provider really answered to this environment (activity log, read only) since
 * the current database era (EFT_SINCE, default the first activity of the 10-23 copy), and saves request / answer
 * pairs as evidence (secrets masked). CoopeWeb's inbound side is also called with read-only APIs.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; npx playwright test --project=eft106 tests/coopeg/tickets/eft-106/eft109-integrations.spec.ts --reporter=line
 * Nothing here provisions: NOKIA / MOTV / PortaOne calls come from real orders (eft108-network.spec.ts: a free ONT, TV, a VoIP number).
 */
import { test, expect } from '@playwright/test';
import { NsApi } from '../../../../helpers/netsuite/ns-api.helper';
import { NsSandbox } from '../../../../helpers/netsuite/ns-sandbox.helper';
import { TD } from '../../../../helpers/netsuite/ns-data';
import { calls, Call, clip, db, record, Shots } from './eft-lib';

const SINCE = Number(process.env.EFT_SINCE ?? 1209397);

// Wide enough for the Customer Activity columns (Merchant Name, Api Name) in the screenshots.
test.use({ viewport: { width: 1800, height: 1000 } });

/** Per call type: how many, how many answered, the latest answered and the latest failure. */
function summary(cs: Call[]) {
  const by: Record<string, { n: number; ok: number; simulated: number; lastOk?: string; lastFail?: string; lastFailWhy?: string }> = {};
  for (const c of cs) {
    const s = (by[c.api] ??= { n: 0, ok: 0, simulated: 0 });
    s.n++;
    if (c.simulated) s.simulated++;
    if (c.ok) { s.ok++; s.lastOk = c.id; } else { s.lastFail = c.id; s.lastFailWhy = c.answer.match(/errorMsg":\s*"([^"]{0,100})/)?.[1] ?? c.answer.slice(0, 100); }
  }
  return by;
}
const line = (by: ReturnType<typeof summary>) => Object.entries(by).map(([api, s]) => `${api} ${s.ok}/${s.n}${s.simulated ? ` (${s.simulated} simulated by test mode)` : ''}`).join(', ');

test.describe('EFT-109 integration evidence', () => {
  test('NETSUITE: invoices and credit notes reach NetSuite and are found there', async ({ browser, page }) => {
    const cs = await calls({ provider: 'NETSUITE', sinceId: SINCE }, true);
    const by = summary(cs);
    // Test contracts are not registered in NetSuite: "contract not found" is NetSuite's expected answer for them.
    const unknownContract = cs.filter(c => !c.ok && /No se ha encontrado un contrato/.test(c.answer)).length;
    // Due-date requests NetSuite sent that Embrix refused on purpose (validation cases: past date, wrong format, in collection).
    const refused = cs.filter(c => !c.ok && c.api === 'EXTEND_INVOICE_DUE_DATE');
    const otherFail = cs.filter(c => !c.ok && !/No se ha encontrado un contrato/.test(c.answer) && c.api !== 'EXTEND_INVOICE_DUE_DATE');
    const reasons = [...new Set(otherFail.map(c => c.answer.match(/"message":\s*"([^"]{0,110})/)?.[1] ?? c.answer.slice(0, 110)))];
    const lastInv = [...cs].reverse().find(c => c.api === 'CREATE_INVOICE' && c.ok);
    const lastCn = [...cs].reverse().find(c => c.api === 'CREATE_CREDIT_NOTES' && c.ok);
    const num = (c?: Call) => c?.answer.match(/"tranId":\s*"([A-Z]+\d+)"/)?.[1];
    // Each as Customer Activity shows it (request and NetSuite's answer), then found in the NetSuite sandbox.
    const shots = new Shots(page, 'EFT109-NETSUITE');
    for (const [name, c] of [['invoice', lastInv], ['credit-note', lastCn]] as const) if (c) await shots.activity(`${name}-${num(c)}-request`, c.accountId, c.id);
    const sb = await NsSandbox.open(browser);
    const found: Record<string, string> = {};
    try {
      for (const n of [num(lastInv), num(lastCn)].filter(Boolean) as string[]) {
        const r = await shots.netsuite(`netsuite-${n}`, sb, n);
        found[n] = `${r.total} record(s): ${r.rows.map(x => x.text).join(' | ')}`;
      }
    } finally { await sb.close(); }
    const ok = !!lastInv && !!lastCn && Object.values(found).every(v => v.startsWith('1 record'));
    record('EFT109-NETSUITE', ok ? 'Pass' : 'Fail',
      `${line(by)} answered since the environment was set up; ${unknownContract} refusal(s) are "contract not found" for test contracts (expected); ${refused.length} due-date request(s) refused by Embrix's checks (validation cases); ${otherFail.length} other NetSuite error(s) on test data: ${reasons.join(' | ')}. Latest invoice ${num(lastInv)} and credit note ${num(lastCn)} found once in the NetSuite sandbox.`,
      { summary: by, otherErrors: otherFail.map(c => ({ id: c.id, api: c.api, answer: c.answer })), latestInvoice: lastInv, latestCreditNote: lastCn, netsuiteSandbox: found, screenshots: shots.files });
    expect(ok).toBe(true);
  });

  test('COOPEWEB: Coopeweb calls into Embrix and Embrix notifies Coopeweb', async ({ playwright, page }) => {
    const api = new NsApi(await playwright.request.newContext());
    // Inbound (read only): the invoice inquiry and the item list Coopeweb uses.
    const inv = (await api.invoicesOf(TD.DEFAULT.account)).filter(i => i.folioStatus === 'STAMPED' && /^0\d+$/.test(i.id)).sort((a, b) => b.id.localeCompare(a.id))[0]?.id;
    const items = await api.crm('getAccountItems', { accountId: TD.DEFAULT.account, invoiceUnitId: inv });
    const pdf = await api.crm('getAccountsInvoices', { accountId: TD.DEFAULT.account, invoiceUnitId: inv });
    const inboundOk = items.json?.status === 'SUCCESS' && /JVBERi0/.test(pdf.text);
    // Outbound: what Embrix sent to Coopeweb since the environment was set up.
    const out = await calls({ provider: 'COOPEWEB', sinceId: SINCE }, true);
    const by = summary(out);
    // Real answers needed from Coopeweb's provisioning side; the cancellation notice and SMS are simulated by test mode
    // on this environment (as on the CoopeG Sandbox), so only their being issued is checked.
    const need = ['UPDATE_WORK_ORDER', 'UPDATE_PROVISIONING_REQUEST'];
    const missing = [...need.filter(a => !by[a]?.ok), ...['NOTIFY_CANCELLATION_TO_CRM'].filter(a => !by[a]?.n)];
    const testMode = (await db(`select value from core_config.ccp_properties where property = 'testMode'`))[0]?.value;
    // Inbound calls Coopeweb made (contracts, adjustments, payments, due dates, grace periods) as the log shows them.
    const inbound = await db(`select apiname, count(*) n from core_engine.activity where gatewaytype = 'CRM_GATEWAY' and substring(id from 3)::int > $1 group by 1 order by 2 desc`, [SINCE]);
    const ok = inboundOk && missing.length === 0;
    const samples = [...need, 'NOTIFY_CANCELLATION_TO_CRM'].map(a => [...out].reverse().find(c => c.api === a && c.ok)).filter(Boolean) as Call[];
    const shots = new Shots(page, 'EFT109-COOPEWEB');
    for (const c of samples) await shots.activity(c.api.toLowerCase().replace(/_/g, '-'), c.accountId, c.id);
    record('EFT109-COOPEWEB', ok ? 'Pass' : 'Fail',
      `Inbound: invoice inquiry with PDF and item list answered for 208886 (${inv}); calls received since set-up: ${inbound.map(r => `${r.apiname} ${r.n}`).join(', ')}. Outbound to Coopeweb answered: ${line(by)}${missing.length ? `; missing: ${missing.join(', ')}` : ''}. Test mode is ${testMode === 'true' ? 'on (as on the CoopeG Sandbox): cancellation notices and SMS are issued but not delivered' : 'off'}.`,
      { getAccountItems: { status: items.status, answer: clip(JSON.stringify(items.json ?? items.text), 600) }, getAccountsInvoices: { status: pdf.status, isPdf: /JVBERi0/.test(pdf.text) },
        inbound, outbound: by, testMode, samples, screenshots: shots.files });
    expect(ok).toBe(true);
  });

  test('NOKIA: provisioning orders are answered by NOKIA', async ({ page }) => {
    const cs = await calls({ provider: 'NOKIA', sinceId: SINCE }, true);
    const by = summary(cs);
    const failed = cs.filter(c => !c.ok);
    const why = [...new Set(failed.map(c => c.answer.match(/errorMsg":\s*"([^"]{0,90})/)?.[1] ?? c.answer.slice(0, 90)))];
    const onts = [...new Set(cs.map(c => c.request?.match(/ALCL[A-Z0-9]{8}/)?.[0]).filter(Boolean))];
    if (!cs.length) { record('EFT109-NOKIA', 'Not tested', 'No provisioning has called NOKIA on this environment.'); test.skip(true, 'no NOKIA call'); }
    const ok = failed.length === 0;
    // The latest NOKIA call that failed, and the latest answered one if any, as Customer Activity shows them.
    const shots = new Shots(page, 'EFT109-NOKIA');
    const lastFail = failed[failed.length - 1];
    const lastOk = [...cs].reverse().find(c => c.ok);
    if (lastFail) await shots.activity(`failed-${lastFail.api.toLowerCase().replace(/_/g, '-')}`, lastFail.accountId, lastFail.id);
    if (lastOk) await shots.activity(`answered-${lastOk.api.toLowerCase().replace(/_/g, '-')}`, lastOk.accountId, lastOk.id);
    record('EFT109-NOKIA', ok ? 'Pass' : 'Fail',
      ok ? `${line(by)} answered.` : `${failed.length} of ${cs.length} NOKIA calls failed (${line(by)}). Errors: ${why.join(' | ')}. ONT(s) used: ${onts.join(', ') || 'none'}.`,
      { summary: by, screenshots: shots.files, calls: cs.map(c => ({ id: c.id, account: c.accountId, api: c.api, ok: c.ok, answer: c.answer.slice(0, 250) })) });
    expect(failed.map(c => `${c.id} ${c.api}`)).toEqual([]);
  });

  for (const p of [
    { provider: 'MOTV', what: 'TV (MOTV) orders', needs: 'a TV contract provisioned on this environment (needs a test ONT), with plan BDL_INT_200MBPS_TV and the QA e-mail (MOTV logs the viewer in with the contract number: no TV box)' },
    { provider: 'PORTAONE', what: 'phone (PortaOne) orders', needs: 'a phone (VoIP) plan with a number from the PortaOne number inventory' },
  ]) {
    test(`${p.provider}: ${p.what} are answered`, async () => {
      const cs = await calls({ provider: p.provider, sinceId: SINCE });
      // History carried over in the database copy: what this provider last answered (any environment).
      const hist = await db(`select id, apiname, accountid, left(regexp_replace(coalesce(response::text,''), '\\s+', ' ', 'g'), 160) r
        from core_engine.activity where merchantname = $1 order by substring(id from 3)::int desc limit 3`, [p.provider]);
      if (!cs.length) {
        record(`EFT109-${p.provider}`, 'Not tested',
          `No ${p.what} on this environment yet: the test contracts had none. Needed: ${p.needs}. Latest answers in the copied data: ${hist.map(h => `${h.apiname} (${h.accountid}): ${clip(h.r, 90)}`).join(' | ')}`,
          { history: hist });
        test.skip(true, `no ${p.provider} call on this environment`);
      }
      const by = summary(cs);
      const failed = cs.filter(c => !c.ok);
      record(`EFT109-${p.provider}`, failed.length ? 'Fail' : 'Pass', `${line(by)}`, { summary: by, calls: cs });
      expect(failed.map(c => c.id)).toEqual([]);
    });
  }
});
