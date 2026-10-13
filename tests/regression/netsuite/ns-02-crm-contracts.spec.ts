/**
 * NetSuite R2 — what Coopeweb / NetSuite send INTO Embrix through the CRM
 * gateway, and the first invoices that come out of it.
 *
 * Contracts created here (all QA-ANH-NS-R2-<stamp>-*):
 *   P1  billing-only, partyId 57936         → CRM-001, CRM-005, INV-002, INV-012, CRM-004, PAY-001
 *   N1  billing-only, NO partyId             → INV-007, ENG-007-02, MAP-007, CRM-003, ENG-007-03, AR-001/004/005
 *   I1  INTERCOMPANY, partyId 57936          → CRN-003, RET-002 (intercompany half)
 *   X*  invalid partyId variants             → CRM-006
 * New contracts are unknown to NetSuite, so "No se ha encontrado un contrato…"
 * is the EXPECTED NetSuite answer for them (INV-002 / INV-012), not a defect.
 * Contact data is non-deliverable (example.com, phone 00000000) because paying
 * a first invoice triggers a Coopeweb work order / SMS (Bug_014).
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { contractBody, qaId, TD } from '../../../helpers/netsuite/ns-data';
import { checkItems, format } from '../../../helpers/netsuite/ns-oracle';
import { actual, evidence, recordOnly, saveState, loadState, blocked, once } from '../../../helpers/netsuite/ns-record';

const CONTRACT_NOT_FOUND = /No se ha encontrado un contrato/i;
const MISSING_ENTITY = /faltantes en la solicitud: entity/i;

test.describe('NetSuite R2 — contracts and inbound APIs via CRM gateway', () => {
  let api: NsApi;
  const P1 = qaId('P1'), N1 = qaId('N1'), I1 = qaId('I1');
  const firstInvoice: Record<string, string | undefined> = {};

  async function create(tag: string, opts: Parameters<typeof contractBody>[0]) {
    const r = await api.crm('processAccountAndOrder', contractBody(opts));
    evidence(`processAccountAndOrder-${tag}`, { request: contractBody(opts), status: r.status, response: r.json ?? r.text });
    return r;
  }
  /** Creates the contract once per run and returns { status, body, invoice }. */
  async function contract(tag: string, opts: Parameters<typeof contractBody>[0]) {
    return once(`contract:${tag}`, async () => {
      const r = await create(tag, opts);
      const invoice = r.status === 200 ? await waitFirstInvoice(qaId(tag)) : undefined;
      return { status: r.status, body: r.json ?? r.text, invoice };
    });
  }
  async function waitFirstInvoice(accountId: string): Promise<string | undefined> {
    for (let i = 0; i < 18; i++) {
      const inv = (await api.invoicesOf(accountId))[0];
      if (inv) return inv.id;
      await new Promise(r => setTimeout(r, 10_000));
    }
    return undefined;
  }

  test.beforeAll(async ({ playwright }) => {
    api = new NsApi(await playwright.request.newContext());
    // A worker restarted after a failed case picks up this run's contracts.
    for (const t of ['P1', 'N1', 'I1']) {
      const hit = loadState(`once:contract:${t}`);
      if (hit?.run === process.env.NS_RUN_ID) firstInvoice[t] = hit.value.invoice;
    }
  });

  // ── P1: the normal Coopeweb contract ──────────────────────────────────
  test('CRM-001: processAccountAndOrder (billing-only) creates account, order and first invoice', async () => {
    const r = await contract('P1', { tag: 'P1', partyId: TD.FONATEL.party });
    const acc = await api.account(P1).catch(() => undefined);
    firstInvoice.P1 = r.invoice;
    saveState('P1', { account: P1, invoice: firstInvoice.P1 });
    actual(`HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}; account ${acc?.status ?? 'NOT FOUND'}; first invoice ${firstInvoice.P1 ?? 'none'}`);
    expect(r.status, 'HTTP status').toBe(200);
    expect(acc?.status).toBe('ACTIVE');
    expect(firstInvoice.P1, 'first invoice generated').toBeTruthy();
  });

  test('CRM-005: the partyId sent in the request is stored on the account', async () => {
    const acc = await api.account(P1).catch(() => undefined);
    if (!acc) blocked('CRM-001 created no account');
    actual(`account ${P1} partyId ${acc?.partyId}`);
    expect(acc?.partyId).toBe(TD.FONATEL.party);
  });

  test('INV-002: first ONE_TIME invoice is stamped and sent with entity = partyId, tipoFactura 12', async () => {
    if (!firstInvoice.P1) blocked('CRM-001 produced no first invoice');
    const inv = await api.invoice(firstInvoice.P1!);
    const act = await api.waitForActivity(P1, firstInvoice.P1!, 'CREATE_INVOICE');
    const req = parse(act?.request), res = parse(act?.response);
    evidence(`${firstInvoice.P1}-CREATE_INVOICE`, { activity: act?.id, request: req, response: res });
    actual(`invoice ${inv.id} type ${inv.type} folio ${inv.folioStatus}; ${act?.id}: entity ${JSON.stringify(req?.invoice?.entity)}, tipoFactura ${JSON.stringify(req?.invoice?.tipoFactura)}; NetSuite ${JSON.stringify(res)}`);
    expect.soft(inv.folioStatus, 'stamped').toBe('STAMPED');
    expect.soft(req?.invoice?.entity).toBe(TD.FONATEL.party);
    expect.soft(req?.invoice?.tipoFactura).toBe(12);
    expect.soft(format(checkItems(req?.invoice?.items, 7)), 'items').toBe('');
    expect(res?.error === false || CONTRACT_NOT_FOUND.test(res?.message ?? ''), `unexpected NetSuite answer ${JSON.stringify(res)}`).toBe(true);
  });

  test('INV-012: NetSuite "contract not found" is stored verbatim and the invoice is kept', async () => {
    if (!firstInvoice.P1) blocked('no first invoice');
    const act = (await api.activitiesFor(P1, firstInvoice.P1!, 'CREATE_INVOICE')).pop();
    const res = parse(act?.response);
    const rep = await api.invoiceReport(firstInvoice.P1!);
    actual(`NetSuite: ${res?.message ?? JSON.stringify(res)}; report ${rep?.financeSyncStatus}: ${rep?.financeErrorMessage}; invoice ${rep?.status}`);
    if (res?.error === false) { recordOnly(`NetSuite ACCEPTED the brand-new contract ${P1} (no 'contract not found'): ${JSON.stringify(res)}`); return; }
    expect.soft(rep?.financeSyncStatus).toBe('ERROR');
    expect.soft(rep?.financeErrorMessage).toBe(res?.message);
    expect(rep?.status).toBe('ACTIVE');
  });

  test('CRM-004: payment term of an API-created contract (Bug_009 NET_500?)', async () => {
    const acc = await api.account(P1).catch(() => undefined);
    if (!acc) blocked('CRM-001 created no account');
    const inv = firstInvoice.P1 ? await api.invoice(firstInvoice.P1) : undefined;
    recordOnly(`account paymentTerm ${JSON.stringify(acc?.paymentProfiles?.map((p: any) => p.paymentTerm))}; first invoice ${inv?.invoiceDate} due ${inv?.dueDate} (term ${inv?.paymentTerm}). Jira examples: due = invoice date + 15 (NET_15)`);
  });

  // ── N1: contract without partyId ──────────────────────────────────────
  test('INV-007: no partyId → invoice kept ACTIVE, sync ERROR with NetSuite message verbatim', async () => {
    const r = await contract('N1', { tag: 'N1', partyId: null });
    firstInvoice.N1 = r.invoice;
    saveState('N1', { account: N1, invoice: firstInvoice.N1 });
    if (!firstInvoice.N1) blocked(`processAccountAndOrder without partyId: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const act = await api.waitForActivity(N1, firstInvoice.N1!, 'CREATE_INVOICE');
    const res = parse(act?.response);
    const rep = await api.invoiceReport(firstInvoice.N1!);
    evidence(`${firstInvoice.N1}-CREATE_INVOICE`, { activity: act?.id, request: parse(act?.request), response: res });
    actual(`invoice ${firstInvoice.N1} ${rep?.status}; ${rep?.financeSyncStatus}: ${rep?.financeErrorMessage}; NetSuite ${JSON.stringify(res)}`);
    expect.soft(rep?.status).toBe('ACTIVE');
    expect.soft(rep?.financeSyncStatus).toBe('ERROR');
    expect(rep?.financeErrorMessage).toBe(res?.message);
  });

  test('ENG-007-02: the ERROR and its diagnostic message are still there on a later read', async () => {
    if (!firstInvoice.N1) blocked('no N1 invoice');
    await new Promise(r => setTimeout(r, 30_000));
    const rep = await api.invoiceReport(firstInvoice.N1!);
    const inv = await api.invoice(firstInvoice.N1!);
    actual(`30 s later: ${rep?.financeSyncStatus}: ${rep?.financeErrorMessage}; ref ${inv.financeRefId ?? 'empty'}; invoice ${inv.status}`);
    expect.soft(rep?.financeSyncStatus).toBe('ERROR');
    expect.soft(rep?.financeErrorMessage ?? '').toMatch(MISSING_ENTITY);
    expect.soft(inv.financeRefId ?? null).toBeNull();
    expect(inv.status).toBe('ACTIVE');
  });

  test('MAP-007: without partyId the entity field is omitted (not "" and not null)', async () => {
    if (!firstInvoice.N1) blocked('no N1 invoice');
    const req = parse((await api.activitiesFor(N1, firstInvoice.N1!, 'CREATE_INVOICE')).pop()?.request);
    actual(`entity present: ${req?.invoice ? 'entity' in req.invoice : '?'} value ${JSON.stringify(req?.invoice?.entity)}`);
    expect(req?.invoice && 'entity' in req.invoice ? req.invoice.entity : '(omitted)').toBe('(omitted)');
  });

  test('CRM-003: a direct edit in Embrix (Party Id) sends nothing back to NetSuite', async () => {
    if (!firstInvoice.N1) blocked('no N1 contract');
    const before = new Set((await api.activities(N1)).map(a => a.id));
    await api.setPartyId(N1, TD.FONATEL.party);
    await new Promise(r => setTimeout(r, 30_000));
    const fresh = (await api.activities(N1)).filter(a => !before.has(a.id));
    const outbound = fresh.filter(a => /FINANCE|NETSUITE|CUSTOMER/i.test(`${a.apiName} ${a.request ?? ''}`.slice(0, 400)));
    actual(`new activities after edit: ${fresh.map(a => `${a.id} ${a.apiName}`).join(', ') || 'none'}`);
    expect(outbound.map(a => `${a.id} ${a.apiName}`)).toEqual([]);
  });

  test('ENG-007-03: after the cause is fixed, SYNC_INVOICE re-sends and the stored outcome is replaced', async () => {
    if (!firstInvoice.N1) blocked('no N1 invoice');
    const out = await api.syncInvoice(firstInvoice.N1!);
    await new Promise(r => setTimeout(r, 10_000));
    const act = (await api.activitiesFor(N1, firstInvoice.N1!, 'CREATE_INVOICE')).pop();
    const req = parse(act?.request), res = parse(act?.response);
    const rep = await api.invoiceReport(firstInvoice.N1!);
    evidence(`${firstInvoice.N1}-resend`, { syncInvoice: out, activity: act?.id, request: req, response: res, report: rep });
    actual(`syncInvoice → ${JSON.stringify(out)}; resent entity ${JSON.stringify(req?.invoice?.entity)}; report ${rep?.financeSyncStatus}: ${rep?.financeErrorMessage ?? ''}`);
    expect.soft(req?.invoice?.entity, 'resend uses the new partyId').toBe(TD.FONATEL.party);
    expect.soft(rep?.financeErrorMessage ?? '', 'old "missing entity" error replaced').not.toMatch(MISSING_ENTITY);
    if (res?.error === false) {
      expect.soft(rep?.financeSyncStatus).toBe('SUCCESS');
      expect(rep?.financeErrorMessage ?? '').toBe('');
    } else {
      expect(rep?.financeSyncStatus).toBe('ERROR');
      expect(rep?.financeErrorMessage).toBe(res?.message);
    }
  });

  test('INV-008: R1 invoice 0279507 (QA-ANH-NS-002) re-sent once after Party Id is set', async () => {
    const before = await api.invoiceReport('0279507');
    if (before?.financeSyncStatus !== 'ERROR') blocked(`0279507 is ${before?.financeSyncStatus}, not ERROR`);
    await api.setPartyId('QA-ANH-NS-002', TD.FONATEL.party);
    const out = await api.syncInvoice('0279507');
    await new Promise(r => setTimeout(r, 10_000));
    const acts = await api.activitiesFor('QA-ANH-NS-002', '0279507', 'CREATE_INVOICE');
    const last = acts.at(-1);
    const req = parse(last?.request), res = parse(last?.response);
    const after = await api.invoiceReport('0279507');
    const inv = await api.invoice('0279507');
    evidence('0279507-resend', { syncInvoice: out, activities: acts.map(a => a.id), request: req, response: res, report: after });
    actual(`before ${before?.financeSyncStatus}: ${before?.financeErrorMessage}; syncInvoice → ${JSON.stringify(out)}; entity ${JSON.stringify(req?.invoice?.entity)}; after ${after?.financeSyncStatus}: ${after?.financeErrorMessage ?? ''}; ref ${inv.financeRefId ?? 'empty'}`);
    expect.soft(req?.invoice?.entity).toBe(TD.FONATEL.party);
    expect.soft(after?.financeErrorMessage ?? '').not.toMatch(MISSING_ENTITY);
    if (res?.error === false) {
      expect.soft(after?.financeSyncStatus).toBe('SUCCESS');
      expect(inv.financeRefId).toBe(String(res?.data?.id).replace(/\.0$/, ''));
    } else {
      // QA-ANH-NS-002 is unknown to NetSuite: the new answer must replace the old one.
      expect(after?.financeErrorMessage).toBe(res?.message);
    }
  });

  // ── Inbound due-date API (ISP-203) ─────────────────────────────────────
  test('AR-001: extendInvoiceDueDate moves the due date of an ACTIVE invoice', async () => {
    if (!firstInvoice.N1) blocked('no N1 invoice');
    const inv = await api.invoice(firstInvoice.N1!);
    const target = new Date(Date.parse(String(inv.dueDate).slice(0, 10)) + 10 * 86400_000).toISOString().slice(0, 10);
    const r = await api.crm('extendInvoiceDueDate', { invoiceId: firstInvoice.N1, invoiceNotes: 'QA-NS-R2 AR-001', dueDate: target });
    const after = await api.invoice(firstInvoice.N1!);
    evidence('extendInvoiceDueDate', { request: { invoiceId: firstInvoice.N1, dueDate: target }, status: r.status, response: r.json ?? r.text });
    actual(`HTTP ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 200)}; due ${inv.dueDate} → ${after.dueDate}; notes ${after.invoiceNotes}`);
    expect.soft(r.json?.status).toBe('SUCCESS');
    expect.soft(String(r.json?.statusCode)).toBe('0');
    expect.soft(String(after.dueDate).slice(0, 10)).toBe(target);
    expect(after.invoiceNotes ?? '').toContain('AR-001');
  });

  test('AR-003: extendInvoiceDueDate rejects an unknown invoice', async () => {
    const r = await api.crm('extendInvoiceDueDate', { invoiceId: 'QA-DOES-NOT-EXIST', invoiceNotes: 'QA-NS-R2 AR-003', dueDate: '2027-12-01' });
    actual(`HTTP ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 250)}`);
    expect(r.json?.status).toBe('FAILED');
  });

  test('AR-004: extendInvoiceDueDate rejects a past date and a malformed date, without DB internals', async () => {
    if (!firstInvoice.N1) blocked('no N1 invoice');
    const before = (await api.invoice(firstInvoice.N1!)).dueDate;
    const past = await api.crm('extendInvoiceDueDate', { invoiceId: firstInvoice.N1, invoiceNotes: 'QA-NS-R2 AR-004 past', dueDate: '2020-01-01' });
    const afterPast = (await api.invoice(firstInvoice.N1!)).dueDate;
    const bad = await api.crm('extendInvoiceDueDate', { invoiceId: firstInvoice.N1, invoiceNotes: 'QA-NS-R2 AR-004 bad', dueDate: '31/12/2027' });
    const afterBad = (await api.invoice(firstInvoice.N1!)).dueDate;
    actual(`past 2020-01-01 → ${JSON.stringify(past.json ?? past.text).slice(0, 160)}, due ${before} → ${afterPast}; '31/12/2027' → ${JSON.stringify(bad.json ?? bad.text).slice(0, 200)}, due → ${afterBad}`);
    if (String(afterPast) !== String(before)) {
      // Put the QA invoice back so later cases read a sane due date.
      await api.crm('extendInvoiceDueDate', { invoiceId: firstInvoice.N1, invoiceNotes: 'QA-NS-R2 AR-004 restore', dueDate: String(before).slice(0, 10) });
    }
    expect.soft(past.json?.status, 'past date (Bug_004)').toBe('FAILED');
    expect.soft(String(afterPast), 'due date unchanged by past date').toBe(String(before));
    expect.soft(bad.json?.status, 'malformed date').toBe('FAILED');
    expect(JSON.stringify(bad.json ?? bad.text), 'no raw DB error (Bug_005)').not.toMatch(/PSQLException|org\.postgresql/i);
  });

  // ── Payments sent by NetSuite (applyPayment) ───────────────────────────
  test('PAY-001: applyPayment for the full amount closes the invoice and sends nothing to NetSuite', async () => {
    if (!firstInvoice.P1) blocked('no P1 invoice');
    const inv = await api.invoice(firstInvoice.P1!);
    const before = new Set((await api.activities(P1)).map(a => a.id));
    const r = await api.crm('applyPayment', { paymentDate: '', paymentSource: 'BCR',
      allocationData: [{ accountId: P1, invoiceId: firstInvoice.P1, currency: 'CRC', amount: inv.due }] });
    await new Promise(r2 => setTimeout(r2, 20_000));
    const after = await api.invoice(firstInvoice.P1!);
    const fresh = (await api.activities(P1)).filter(a => !before.has(a.id));
    evidence('applyPayment', { request: { invoiceId: firstInvoice.P1, amount: inv.due }, status: r.status, response: r.json ?? r.text, newActivities: fresh.map(a => ({ id: a.id, api: a.apiName })) });
    actual(`HTTP ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 160)}; invoice ${inv.status}/${inv.due} → ${after.status}/${after.due}; new activities: ${fresh.map(a => a.apiName).join(', ') || 'none'}`);
    const sideEffects = fresh.filter(a => /WORK_ORDER|SMS|NOTIF/i.test(a.apiName ?? ''));
    if (sideEffects.length) actual(`Bug_014 side effect still present: ${sideEffects.map(a => `${a.id} ${a.apiName}`).join(', ')}`);
    expect.soft(after.status).toBe('CLOSED');
    expect(fresh.filter(a => /CREATE_PAYMENT/i.test(a.apiName ?? '')).map(a => a.id), 'no payment sync to NetSuite (EFT-56)').toEqual([]);
  });

  test('AR-005: extendInvoiceDueDate on a paid invoice, and with empty notes', async () => {
    if (!firstInvoice.P1 || !firstInvoice.N1) blocked('needs P1 (paid) and N1 invoices');
    const paid = await api.crm('extendInvoiceDueDate', { invoiceId: firstInvoice.P1, invoiceNotes: 'QA-NS-R2 AR-005', dueDate: '2027-12-01' });
    const empty = await api.crm('extendInvoiceDueDate', { invoiceId: firstInvoice.N1, invoiceNotes: '', dueDate: '2027-12-02' });
    // NEVER send long notes here again: on 2026-10-12 a 1,200-char note was ACCEPTED and appended, and the
    // Invoicing report (temp table varchar(1000)) then failed for EVERY query on coopegsbx2 (Bug_016). Notes
    // only ever append (API and GraphQL), so the invoice can't be repaired without a DB fix.
    const all = [paid, empty].map(x => JSON.stringify(x.json ?? x.text).slice(0, 160));
    recordOnly(`paid invoice → ${all[0]}; empty notes → ${all[1]}; long notes → not re-sent (Bug_016: a 1,200-char note is accepted and breaks the Invoicing report)`);
    expect(all.join(' '), 'no raw DB error').not.toMatch(/PSQLException|org\.postgresql/i);
  });

  // ── Intercompany ───────────────────────────────────────────────────────
  test('CRN-003: intercompany first invoice → automatic credit note synced with a valid taxCode (never 0)', async () => {
    const r = await contract('I1', { tag: 'I1', partyId: TD.FONATEL.party, accounttype: 'INTERCOMPANY' });
    firstInvoice.I1 = r.invoice;
    saveState('I1', { account: I1, invoice: firstInvoice.I1 });
    if (!firstInvoice.I1) blocked(`INTERCOMPANY contract not created: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    let cns: any[] = [];
    for (let i = 0; i < 12 && !cns.length; i++) { cns = await api.creditNotesOf(I1); if (!cns.length) await new Promise(x => setTimeout(x, 10_000)); }
    const cnActs = await api.activities(I1, 'CREATE_CREDIT_NOTES');
    const req = parse(cnActs.at(-1)?.request), res = parse(cnActs.at(-1)?.response);
    evidence('intercompany-CREATE_CREDIT_NOTES', { creditNotes: cns, activity: cnActs.at(-1)?.id, request: req, response: res });
    const codes = (req?.creditMemo?.items ?? []).map((i: any) => `${i.item}:${i.taxCode}`);
    actual(`credit notes ${cns.map(c => `${c.id} ${c.total} ${c.financeSyncStatus}`).join(', ') || 'none'}; taxCodes ${codes.join(' ') || 'n/a'}; NetSuite ${JSON.stringify(res)}`);
    expect(cns.length, 'automatic intercompany credit note').toBeGreaterThan(0);
    expect(req, 'CREATE_CREDIT_NOTES sent').toBeTruthy();
    expect(format(checkItems(req.creditMemo.items, 7)), 'taxCodes (EFT-91)').toBe('');
  });

  test('RET-002: EFT-91/92 retest — no taxCode 0 (intercompany half; exempt half in MAP-008/011)', async () => {
    const st = loadState('I1');
    if (!st?.invoice) blocked('CRN-003 did not produce an intercompany invoice');
    const req = parse((await api.activities(st.account, 'CREATE_CREDIT_NOTES')).at(-1)?.request);
    const zero = (req?.creditMemo?.items ?? []).filter((i: any) => Number(i.taxCode) === 0);
    actual(`intercompany CN items with taxCode 0: ${zero.length}. Exempt invoices (EFT-92): MAP-008 / MAP-011`);
    expect(req).toBeTruthy();
    expect(zero).toEqual([]);
  });

  // ── Invalid partyId values ─────────────────────────────────────────────
  test('CRM-006: processAccountAndOrder with invalid partyId values', async () => {
    const variants: [string, string][] = [['X1', ''], ['X2', 'ABC'], ['X3', ' 57936 ']];
    const lines: string[] = [];
    for (const [tag, party] of variants) {
      const r = await contract(tag, { tag, partyId: party });
      const acc = r.status === 200 ? await api.account(qaId(tag)).catch(() => undefined) : undefined;
      const invId = r.invoice;
      const req = invId ? parse((await api.waitForActivity(qaId(tag), invId, 'CREATE_INVOICE', 90_000))?.request) : undefined;
      lines.push(`${JSON.stringify(party)} → HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}; stored partyId ${JSON.stringify(acc?.partyId)}; entity sent ${JSON.stringify(req?.invoice?.entity)}`);
    }
    recordOnly(lines.join(' || '));
  });
});
