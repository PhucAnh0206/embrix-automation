/**
 * NetSuite R2 — cross-cutting checks built from earlier specs' data, and the
 * cases that cannot run yet (each says exactly why, so nothing silently drops).
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { attachUi } from '../../../helpers/netsuite/ns-ui.helper';
import { contractId, isReused } from '../../../helpers/netsuite/ns-data';
import { actual, blocked, needsConfirmation, notApplicable, partPassed, recordOnly, loadState, once } from '../../../helpers/netsuite/ns-record';

test.describe('NetSuite R2 — cross-cutting', () => {
  test('INV-013: every invoice-creation path sends entity and numeric tipoFactura', async ({ playwright, browser }) => {
    const api = new NsApi(await playwright.request.newContext());
    await attachUi(api, browser);
    const paths: [string, string, string | undefined][] = [
      ['manual (UI / manualInvoiceService)', '208886', loadState('inv208886')],
      ['first invoice of processAccountAndOrder', loadState('P1')?.account, loadState('P1')?.invoice],
      ['SYNC_INVOICE resend', loadState('N1')?.account, loadState('N1')?.invoice],
    ];
    const lines: string[] = []; const bad: string[] = [];
    for (const [label, account, invoice] of paths) {
      if (!account || !invoice) { lines.push(`${label}: no data (run ns-01/ns-02 first)`); bad.push(label); continue; }
      const req = parse((await api.activitiesFor(account, invoice, 'CREATE_INVOICE')).at(-1)?.request);
      const acc = await api.account(account);
      lines.push(`${label} ${invoice}: entity ${JSON.stringify(req?.invoice?.entity)} (partyId ${acc.partyId}), tipoFactura ${JSON.stringify(req?.invoice?.tipoFactura)}`);
      if (req?.invoice?.entity !== acc.partyId || req?.invoice?.tipoFactura !== 12) bad.push(label);
    }
    actual(`${lines.join(' | ')} | recurring BDOM job path: not covered — needs a billing-job slot (INV-001)`);
    expect(bad).toEqual([]);
    blocked(`3 of 4 paths OK (${lines.length} checked); the BDOM job path — the one at risk per handoff §4 (service-invoice had an older Engine) — still needs a billing-job slot`);
  });

  test('MAP-010: a Party Id change on the account is used by the next invoice', async ({ playwright, browser }) => {
    const api = new NsApi(await playwright.request.newContext());
    await attachUi(api, browser);
    // A QA contract that bills (no exemption): NS_MAP010_ACCOUNT, else the reused N1, else ns-02's P1. A P1 created
    // through the API without a completed order has no billing cycle and refuses manual invoices (10231729-P1).
    const account = process.env.NS_MAP010_ACCOUNT ?? (isReused('N1') ? contractId('N1') : loadState('P1')?.account);
    if (!account) blocked('needs a QA contract that bills (NS_MAP010_ACCOUNT, NS_REUSE_RUN or the ns-02 P1 contract)');
    const lastInvoice = (await api.invoicesOf(account)).map(i => i.id as string).sort((a, b) => Number(a) - Number(b)).at(-1);
    if (!lastInvoice) blocked(`${account} has no earlier invoice to compare with`);
    const p1 = { account: account!, invoice: lastInvoice! };
    const before: string = (await api.account(p1.account)).partyId ?? '';
    await api.setPartyId(p1.account, '61425');
    try {
      const id = await once('map010', () => api.manualInvoice(p1.account, [{ itemId: 'I_INT', serviceType: 'INTERNET', description: 'QA-NS-R2 MAP-010', quantity: 1, unitPrice: 1000 }]));
      const req = parse((await api.waitForActivity(p1.account, id, 'CREATE_INVOICE'))?.request);
      const old = parse((await api.activitiesFor(p1.account, p1.invoice, 'CREATE_INVOICE')).at(-1)?.request);
      actual(`${p1.account}: partyId ${before} → 61425; new invoice ${id} entity ${JSON.stringify(req?.invoice?.entity)}; earlier invoice ${p1.invoice} still sent as ${JSON.stringify(old?.invoice?.entity)}`);
      expect.soft(old?.invoice?.entity).toBe(before);
      expect(req?.invoice?.entity).toBe('61425');
    } finally {
      await api.setPartyId(p1.account, before);
    }
  });

  test('API-001: the invoice detail API returns the PDF of a new invoice', async ({ playwright, browser }) => {
    const api = new NsApi(await playwright.request.newContext());
    await attachUi(api, browser);
    const inv = loadState<string>('inv208886') ?? (await api.invoicesOf('208886')).filter(i => i.folioStatus === 'STAMPED').sort((a, b) => b.id.localeCompare(a.id))[0]?.id;
    if (!inv) blocked('208886 has no stamped invoice to ask the PDF for');
    // crm-gateway POST /getAccountsInvoices (ISP-220) returns the invoice with its PDF as Base64.
    const r = await api.crm('getAccountsInvoices', { accountId: '208886', invoiceUnitId: inv });
    const find = (o: any): string | undefined => {
      if (!o || typeof o !== 'object') return undefined;
      for (const [k, v] of Object.entries(o)) { if (/base64pdf/i.test(k) && typeof v === 'string') return v; const d = find(v); if (d) return d; }
      return undefined;
    };
    const b64 = find(r.json);
    const head = b64 ? Buffer.from(b64, 'base64').subarray(0, 5).toString('latin1') : '';
    actual(`POST crm-gateway /getAccountsInvoices {accountId 208886, invoiceUnitId ${inv}}: HTTP ${r.status} ${b64 ? `PDF ${Math.round(b64.length * 0.75 / 1024)} KB, starts "${head}"` : JSON.stringify(r.json ?? r.text).slice(0, 300)}`);
    expect.soft(r.json?.status).not.toBe('FAILED');
    expect(head).toBe('%PDF-');
  });

  test('AR-006: NetSuite can grant a grace period on an invoice in collection', async ({ playwright, browser }) => {
    const api = new NsApi(await playwright.request.newContext());
    await attachUi(api, browser);
    // NS_AR006_ACCOUNT (e.g. 798166, Anh's OK) first: a collection that started after the current collection settings.
    // Older units keep the plan of the settings they started with, so a grace can move them earlier (Sandbox data).
    // Then 208886 and the QA contracts (their units have no scheduled action: only the refusal can be checked).
    const accounts = [process.env.NS_AR006_ACCOUNT, '208886', contractId('P1'), contractId('N2'), contractId('N1')].filter(Boolean) as string[];
    const unitsOf = async (acc: string) => (await api.gql(`{ searchCollectionUnits(page:1,size:100,filter:{accountId:"${acc}"}) { id invoiceId status nextActionDate nextAction } }`)).searchCollectionUnits ?? [];
    const units = async () => (await Promise.all(accounts.map(unitsOf))).flat();
    const unitNo = (u: any) => Number(String(u.id).replace(/\D/g, ''));
    const open = (await units()).filter((u: any) => u.status === 'OPEN').sort((a: any, b: any) => unitNo(b) - unitNo(a));
    // NS_AR006_INVOICE: the invoice whose collection started after the current settings (others on 798166 are older).
    const named = process.env.NS_AR006_INVOICE;
    if (named && !open.some((u: any) => u.invoiceId === named && u.nextAction)) blocked(`${named} has no OPEN collection unit with a scheduled action (already granted, or not in collection yet)`);
    const scheduled = named ? open.find((u: any) => u.invoiceId === named) : open.find((u: any) => u.nextAction); // newest unit with a scheduled action
    const target = scheduled ?? open[0];
    if (!target) blocked('208886 has no open collection unit (needs the collection jobs)');
    const r = await api.crm('extendGracePeriod', { invoiceId: target.invoiceId, gracePeriodDays: 5, userId: 'QA-NS' });
    const after = (await units()).find((u: any) => u.id === target.id);
    const txt = `POST crm-gateway /extendGracePeriod {invoiceId ${target.invoiceId}, gracePeriodDays 5}: HTTP ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 200)}; ${target.id} ${target.status}/${target.nextAction ?? 'no action'} ${target.nextActionDate ?? ''} → ${after?.status}/${after?.nextAction ?? 'no action'} ${after?.nextActionDate ?? ''}`;
    if (!scheduled) {
      // Only the refusal can be checked: no invoice of 208886 has a scheduled collection action in this data.
      expect.soft(r.json?.status, 'refused without a scheduled action').toBe('FAILED');
      partPassed(`${txt}. Refusal checked; the grant itself needs an invoice with a scheduled collection action (collection jobs)`);
      return;
    }
    actual(txt);
    expect.soft(r.json?.status).toBe('SUCCESS');
    expect.soft(after?.status).toBe('GRACE_PERIOD_REQUESTED');
    // 5 grace days should not bring the next collection action forward.
    expect(Date.parse(after?.nextActionDate)).toBeGreaterThanOrEqual(Date.parse(target.nextActionDate));
  });

  test('RPT-005: the Credit Notes report shows each credit note\'s NetSuite status', async ({ playwright, browser }) => {
    const api = new NsApi(await playwright.request.newContext());
    await attachUi(api, browser);
    const fields: string[] = ((await api.gql(`{ __type(name:"CreditNoteData") { fields { name } } }`)).__type?.fields ?? []).map((f: any) => f.name);
    const ns = fields.filter(f => /financ|sync|netsuite|erp/i.test(f));
    if (!ns.length) {
      recordOnly(`Credit Notes report data (getCreditNoteReport / CreditNoteData) has no NetSuite fields (${fields.length} fields, none for NetSuite number, sync status or error). Coope's request is not built; scope to confirm`);
      return;
    }
    actual(`Credit Notes report has NetSuite fields: ${ns.join(', ')}`);
  });

  test('INV-016: a double SYNC_INVOICE on one ERROR invoice creates one NetSuite invoice', async () => {
    blocked('needs an ERROR invoice on a contract NetSuite knows (only 0279497 qualifies and must not be resubmitted, handoff §6). New QA contracts always end in "contract not found"');
  });
});

test.describe('NetSuite R2 — cannot run yet', () => {
  const cases: [string, string, 'blocked' | 'confirm' | 'na', string][] = [
    ['CRN-004', 'bulk credit adjustments are sent to NetSuite', 'blocked', 'failed-row handling is pending a decision (R1) and the bulk file format for CoopeG was not provided'],
    ['PAY-002..005', 'underpayment / overpayment / group payment / arrangement', 'confirm', 'ISP-212/213 are REQUIREMENT PENDING — no expected behaviour to test against'],
    ['ACC-001..003', 'accounting (EBS) extract behaviour', 'confirm', 'ISP-207 (turn the EBS extract off) is UNDER ANALYSIS with no decision; an email says Energy only'],
    ['MIG-001', 'invoice / credit-note migration scope', 'confirm', 'ISP-209/211 migration scripts are one-off; ask Jeremy/PM whether they are in this regression'],
    ['PTY-001', 'Party ID bulk update', 'na', 'ISP-208 dropped: CoopeG updates party ids themselves'],
    ['CRM-002', 'a contract update through the API is applied', 'confirm', 'the update payload NetSuite/Coopeweb will send is not defined (only processAccountAndOrder MODIFY exists)'],
  ];
  for (const [id, title, kind, why] of cases) {
    test(`${id}: ${title}`, async () => {
      if (kind === 'blocked') blocked(why);
      else if (kind === 'confirm') needsConfirmation(why);
      else notApplicable(why);
    });
  }
});
