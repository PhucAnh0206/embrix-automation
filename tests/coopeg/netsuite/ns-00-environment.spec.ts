/**
 * NetSuite R2 — environment, authentication and the developer-side cases.
 *
 * ENV-001/002 read the coopegsbx3 snapshot DB (read-only, same guards as
 * tools/ro-query.js). Bug_006: that is NOT the DB the coopegsbx2 app uses, so
 * a DB fact alone cannot pass a case about the app. ENV-002 is judged on the
 * app's behaviour (payloads from ns-01/ns-04) with the DB as corroboration.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { NsApi } from '../../../helpers/netsuite/ns-api.helper';
import { NsSandbox } from '../../../helpers/netsuite/ns-sandbox.helper';
import { actual, recordOnly, devOnly, blocked, loadState } from '../../../helpers/netsuite/ns-record';
import { suiteDir } from '../../../helpers/netsuite/suite-dir';

// coopegsbx2's own database is coopegsbx-dev-db (.pg-coopegsbx-dev.json, found 10-23); NS_PG picks another.
const PG_CFG = `${suiteDir()}/tools/.pg-${process.env.NS_PG || 'coopegsbx-dev'}.json`;

async function snapshotDb<T = any>(sql: string): Promise<T[]> {
  if (!/^\s*select\b/i.test(sql)) throw new Error('read-only: SELECT only');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg');
  const c = new Client({ ...JSON.parse(fs.readFileSync(PG_CFG, 'utf8')), port: 5432, ssl: { rejectUnauthorized: false },
    options: '-c default_transaction_read_only=on -c statement_timeout=60000' });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}

test.describe('NetSuite R2 — environment', () => {
  // The develop build applies the NetSuite DB changes by SQL, not as Flyway 10.2 / 10.3 (reconciliation branch only).
  test('ENV-001: the NetSuite database changes are in place, no failed upgrade', async () => {
    const failed = await snapshotDb(`select version, description from public.flyway_schema_history where success = false`);
    const cols = await snapshotDb(`select table_name, column_name from information_schema.columns where table_schema = 'core_engine'
      and table_name in ('invoice_unit','notes_unit') and column_name in ('financesyncstatus','financeerrormessage','financerefid','financeversion')`);
    actual(`failed upgrades: ${failed.length}; NetSuite columns: ${cols.map(r => `${r.table_name}.${r.column_name}`).join(', ')}`);
    expect(failed).toEqual([]);
    expect(cols.length).toBe(8);
  });

  test('ENV-002: NetSuite mapping configuration has the expected values', async () => {
    const dept = await snapshotDb(`select accounttype, departmentint from core_config.account_type_department_map order by 1`);
    const cls = await snapshotDb(`select accounttype, classint from core_config.account_type_class_map order by 1`);
    const tax = await snapshotDb(`select taxcodeint from core_config.tax_exempt_taxcode_map order by 1`);
    const map = await snapshotDb(`select sourcename, canonicalname from core_config.gateway_api_requestmap where id='GID-100077' and sourcename in ('invoice.entity','invoice.tipoFactura')`);
    const d = Object.fromEntries(dept.map(r => [r.accounttype, r.departmentint]));
    const c = Object.fromEntries(cls.map(r => [r.accounttype, r.classint]));
    actual(`snapshot DB: dept ${JSON.stringify(d)} class ${JSON.stringify(c)} taxcodes ${tax.map(r => r.taxcodeint).join(',')}; requestmap ${map.map(r => `${r.sourcename}<-${r.canonicalname}`).join(', ')}. App behaviour: see MAP-001..004/008/009 payloads (coopegsbx2)`);
    expect(d).toEqual({ DEFAULT: 15, FONATEL: 137, PHC: 135 });
    expect(c).toEqual({ DEFAULT: 104, FONATEL: 9, PHC: 10 });
    expect(tax.map(r => r.taxcodeint)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(map.length).toBe(2);
  });

  test('ENV-003: services answer (QA part); restart/startup logs are dev-side', async ({ playwright, baseURL }) => {
    const req = await playwright.request.newContext();
    const api = new NsApi(req);
    const ui = await req.get(baseURL!);
    const ccp = await api.ccpDate();
    const crm = await api.crm('extendInvoiceDueDate', { invoiceId: 'QA-DOES-NOT-EXIST', invoiceNotes: 'health', dueDate: '2027-12-01' });
    blocked(`QA part OK — core-ui HTTP ${ui.status()}, GraphQL CCP ${ccp}, crm-gateway HTTP ${crm.status}. Dev part pending: restart + startup logs, and confirm jobs-common AND service-invoice run the corrected Engine (handoff §4)`);
  });

  test('ENV-004: the NetSuite real-time sync switch is on (realTimeFinanceSync)', async ({ playwright }) => {
    const api = new NsApi(await playwright.request.newContext());
    const d = await api.gql(`{ s: getCcpPropertyByName(name:"realTimeFinanceSync") { value } p: getCcpPropertyByName(name:"paymentFinanceSync") { value } }`);
    actual(`realTimeFinanceSync = ${d.s?.value}; paymentFinanceSync = ${d.p?.value} (payments are not sent to NetSuite by design)`);
    // ISP-202: invoices and credit notes go to NetSuite in real time. With the switch off nothing is sent (Bug_023).
    expect(d.s?.value, 'realTimeFinanceSync').toBe('true');
  });
});

test.describe('NetSuite R2 — authentication and security', () => {
  test('AUTH-004: no NetSuite credentials, tokens or signatures in Customer Activity', async ({ playwright }) => {
    const api = new NsApi(await playwright.request.newContext());
    const acts = [...await api.activities('208886', 'CREATE_INVOICE'), ...await api.activities('208886', 'CREATE_CREDIT_NOTES')];
    const leaks = acts.filter(a => /oauth_|consumer_?(key|secret)|token_?secret|oauth_signature|authorization\s*["':]|HMAC-SHA256/i.test(`${a.request} ${a.response}`));
    actual(`${acts.length} NetSuite activities scanned on 208886; ${leaks.length} contain credential-like text${leaks.length ? `: ${leaks.map(a => a.id).join(', ')}` : ''}`);
    expect(leaks.map(a => a.id)).toEqual([]);
  });

  // AUTH-002 (wrong NetSuite credentials) and AUTH-003 (NetSuite unreachable) removed from the suite (team, 10-25).
});

test.describe('NetSuite R2 — developer-side cases', () => {
  test('ENG-007-04: an activity-logging failure does not stop the sync outcome from being saved', async () => {
    devOnly('needs a forced failure of the activity insert (fault injection); QA then reads the invoices in Bills');
  });
  // The replay itself is Dev's (the UI does not offer it on a SUCCESS invoice): done on 0279698 (798166), refused with
  // "Already in NetSuite: FA586029". QA reads the outcome in Embrix and in the NetSuite sandbox (read only).
  test('ENG-007-05: a failed replay does not overwrite a SUCCESS invoice', async ({ playwright, browser }) => {
    const [acc, inv] = (process.env.NS_ENG00705 ?? '798166:0279698').split(':');
    const api = new NsApi(await playwright.request.newContext());
    const rep = await api.invoiceReport(inv);
    const unit = await api.invoice(inv);
    const sends = (await api.activitiesFor(acc, inv, 'CREATE_INVOICE')).length;
    const sb = await NsSandbox.open(browser);
    const ns = await sb.search(unit.financeVersion).finally(() => sb.close());
    actual(`${inv}: sync ${rep?.financeSyncStatus}, NetSuite number ${unit.financeVersion}, ${sends} CREATE_INVOICE call(s); NetSuite search ${unit.financeVersion}: TOTAL ${ns.total} — ${ns.rows.map(r => r.text).join(' | ')}`);
    expect(rep?.financeSyncStatus).toBe('SUCCESS');
    expect(sends, 'sent once').toBe(1);
    expect(ns.total, 'one invoice in NetSuite').toBe(1);
    expect(ns.rows[0]?.text.replace(/,/g, '')).toContain(Number(unit.total).toFixed(2));
  });
  test('RPT-003: the 10.2 report indexes do not change report results', async () => {
    devOnly('needs report output compared before/after migration 10.2');
  });
  // RET-001 (EFT-85, provisioning sign-in refresh) is out of the NetSuite round (Dev, 10-25): removed from the suite.
});
