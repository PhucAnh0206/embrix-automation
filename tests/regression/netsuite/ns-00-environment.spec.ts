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
import { actual, recordOnly, devOnly, blocked, loadState } from '../../../helpers/netsuite/ns-record';

const PG_CFG = 'D:/Dev/products/Embrix/test-cases/netsuite/tools/.pg-coopegsbx.json';

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
  test('ENV-001: reconciliation migrations 10.2 and 10.3 applied', async () => {
    const rows = await snapshotDb(`select version, description, success, installed_on from public.flyway_schema_history where version in ('10.2','10.3') or success = false order by installed_rank`);
    const s = rows.map(r => `${r.version} '${r.description}' success=${r.success} ${new Date(r.installed_on).toISOString().slice(0, 10)}`).join('; ');
    blocked(`coopegsbx3 snapshot: ${s}. The coopegsbx2 app DB is a different DB (Bug_006) — unverified there`);
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

  test('ENV-004: how the finance sync is triggered on coopegsbx2 (record)', async ({ playwright }) => {
    const api = new NsApi(await playwright.request.newContext());
    const inv = loadState('inv208886');
    if (!inv) blocked('run ns-01 first');
    const acts = await api.activitiesFor('208886', inv, undefined);
    recordOnly(`invoice ${inv}: ${acts.map(a => `${a.id} ${a.apiName} ${a.activityDate}`).join(' → ')}. CREATE_INVOICE is logged together with the invoice (real-time), not by a later batch job; handoff §4 saw realTimeFinanceSync=false on the snapshot DB (Bug_006)`);
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

  test('AUTH-002: invalid OAuth1 credentials fail cleanly', async () => {
    devOnly('needs the NetSuite OAuth1 credentials swapped in the finance-gateway config, then restored');
  });

  test('AUTH-003: NetSuite unreachable / timeout is handled and recoverable', async () => {
    devOnly('needs the NetSuite endpoint made unreachable, then restored');
  });
});

test.describe('NetSuite R2 — developer-side cases', () => {
  test('ENG-007-04: an activity-logging failure does not stop the sync outcome from being saved', async () => {
    devOnly('needs a forced failure of the activity insert (fault injection); QA then reads the invoices in Bills');
  });
  test('ENG-007-05: a failed replay does not overwrite a SUCCESS invoice', async () => {
    devOnly('needs a replay of the sync for a SUCCESS invoice (e.g. 0279509), which the UI does not offer (UI-002)');
  });
  test('RPT-003: the 10.2 report indexes do not change report results', async () => {
    devOnly('needs report output compared before/after migration 10.2');
  });
  test('RET-001: EFT-85 provisioning token refresh (UPDATE_WORK_ORDER 401)', async () => {
    devOnly('NET-PROV-AUTH-001 — Jira: root cause = COOPEWEB token out of sync between DB and Vault; fix planned, not yet deployed');
  });
});
