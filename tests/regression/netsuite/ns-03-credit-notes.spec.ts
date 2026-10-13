/**
 * NetSuite R2 — credit notes (and the invoices they need).
 *
 * Parents:
 *   - the ns-01 invoice on 208886 (state 'inv208886', I_INT 10,000, synced)
 *   - a multi-line invoice on 208886 created here (I_INT 10,000 + I_TV 5,000) → INV-014, CRN-002, ADJ-002
 *   - a rounding invoice on 208886 (I_INT x3 @ 3,333.33) → INV-015
 *   - N2: a new contract with NO partyId (ERROR parent) → ENG-006-03, CRN-007, CRN-013
 *   - ns-02 contracts: N1 (partyId 57936 since CRM-003) → ENG-006-02; P1 (paid) → CRN-009
 *
 * Every credit is checked on the CREATE_CREDIT_NOTES request (exact NetSuite
 * JSON) and on the credit note's own finance sync status.
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse, Activity } from '../../../helpers/netsuite/ns-api.helper';
import { contractBody, qaId, TD } from '../../../helpers/netsuite/ns-data';
import { checkItems, format, round2, LOB_MAP } from '../../../helpers/netsuite/ns-oracle';
import { actual, evidence, recordOnly, saveState, loadState, blocked, once } from '../../../helpers/netsuite/ns-record';

const ACC = TD.DEFAULT.account;

interface CnResult { cn?: any; act?: Activity; req?: any; res?: any; error?: string; }

test.describe('NetSuite R2 — credit notes', () => {
  let api: NsApi;
  let parentId: string;          // ns-01 invoice (synced)
  let parent: any;
  let parentReq: any;            // its CREATE_INVOICE request
  let multiId: string | undefined;
  const N2 = qaId('N2');
  let n2Invoice: string | undefined;
  let n2Cn: CnResult = {};
  let firstCn: CnResult = {};

  /** Runs one adjustment and returns the credit/debit note it produced plus its NetSuite call. */
  async function adjust(accountId: string, input: Record<string, unknown>): Promise<CnResult> {
    const beforeCn = new Set((await api.creditNotesOf(accountId)).map(c => c.id));
    const beforeAct = new Set((await api.activities(accountId, 'CREATE_CREDIT_NOTES')).map(a => a.id));
    try {
      // customReason = CoopeG's real credit reason, which is stamped by Hacienda. Reason codes such as DATA_ERROR or
      // CUSTOMER_SATISFACTION are NOT stamped (and their PDF is empty: EFT-86 / Bug_015) — CRN-008 tests that on purpose.
      await api.processAdjustment({ accountId, userId: 'congeroadmin', source: 'AGENT_CARE', generateCreditNoteNow: true, customReason: 'NC - Error en facturación', ...input });
    } catch (e) { return { error: (e as Error).message }; }
    let cn: any; let act: Activity | undefined;
    for (let i = 0; i < 18 && !(cn && act); i++) {
      cn = cn ?? (await api.creditNotesOf(accountId)).find(c => !beforeCn.has(c.id));
      act = act ?? (await api.activities(accountId, 'CREATE_CREDIT_NOTES')).find(a => !beforeAct.has(a.id));
      if (!(cn && act)) await new Promise(r => setTimeout(r, 10_000));
    }
    if (cn) cn = (await api.creditNotesOf(accountId)).find(c => c.id === cn.id) ?? cn; // fresh sync status
    return { cn, act, req: parse(act?.request), res: parse(act?.response) };
  }
  /** adjust() once per run under `key`; any later call (or restarted worker) re-reads the same CN + activity. */
  async function adjustOnce(key: string, accountId: string, input: Record<string, unknown>): Promise<CnResult> {
    const ids = await once(`cn:${key}`, async () => {
      const r = await adjust(accountId, input);
      return { cnId: r.cn?.id as string | undefined, actId: r.act?.id as string | undefined, error: r.error };
    });
    const cn = ids.cnId ? (await api.creditNotesOf(accountId)).find(c => c.id === ids.cnId) : undefined;
    const act = ids.actId ? (await api.activities(accountId, 'CREATE_CREDIT_NOTES')).find(a => a.id === ids.actId) : undefined;
    return { cn, act, req: parse(act?.request), res: parse(act?.response), error: ids.error };
  }
  const line = (r: CnResult) => `CN ${r.cn?.id ?? 'none'} ${r.cn?.total ?? ''} ${r.cn?.status ?? ''} folio ${r.cn?.folioStatus ?? ''} sync ${r.cn?.financeSyncStatus ?? ''} ${r.cn?.financeErrorMessage ?? ''}; ${r.act?.id ?? 'no CREATE_CREDIT_NOTES'} NetSuite ${JSON.stringify(r.res ?? r.error)}`;

  test.beforeAll(async ({ playwright }) => {
    api = new NsApi(await playwright.request.newContext());
    parentId = loadState('inv208886') ?? '';
    if (parentId) {
      parent = await api.invoice(parentId);
      parentReq = parse((await api.activitiesFor(ACC, parentId, 'CREATE_INVOICE')).pop()?.request);
    }
    // A worker restarted after a failed case re-reads what earlier tests of this run created.
    const run = process.env.NS_RUN_ID;
    const prev = (k: string) => { const h = loadState(`once:${k}`); return h?.run === run ? h.value : undefined; };
    multiId = prev('multi208886') ?? loadState('multi208886');
    if (prev('cn:first')) firstCn = await adjustOnce('first', ACC, {});
    if (prev('contract:N2')) n2Invoice = (await api.invoicesOf(N2))[0]?.id;
    if (prev('cn:n2')) n2Cn = await adjustOnce('n2', N2, {});
  });

  test('ENG-006-01: a credit note sends the account partyId to the Finance Gateway', async () => {
    if (!parent?.financeRefId) blocked(`needs the synced ns-01 invoice (state inv208886=${parentId})`);
    firstCn = await adjustOnce('first', ACC, { invoiceId: parentId, type: 'BILL_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', percent: 10, reason: 'DATA_ERROR', notes: 'QA-NS-CRN-016' });
    saveState('cn208886', firstCn.cn?.id);
    evidence(`${firstCn.cn?.id}-CREATE_CREDIT_NOTES`, firstCn);
    actual(`${line(firstCn)}; entity ${JSON.stringify(firstCn.req?.creditMemo?.entity)}`);
    expect(firstCn.req, 'CREATE_CREDIT_NOTES sent').toBeTruthy();
    expect.soft(firstCn.req.creditMemo.entity).toBe(TD.DEFAULT.party);
    expect(firstCn.res?.error, `NetSuite: ${firstCn.res?.message}`).toBe(false);
  });

  test('CRN-001: invoice-level 10% credit with tax — refNum = invoice NetSuite id, amount = sum of gross', async () => {
    if (!firstCn.req) blocked('ENG-006-01 produced no credit note');
    const m = firstCn.req.creditMemo;
    const gross = round2((m.items ?? []).reduce((s: number, i: any) => s + Number(i.grossAmount), 0));
    actual(`applys ${JSON.stringify(m.applys)}; sum gross ${gross}; invoice ref ${parent.financeRefId}; dept ${m.department} class ${m.class} loc ${m.location}; CN sync ${firstCn.cn?.financeSyncStatus}`);
    expect.soft(m.applys?.length).toBe(1);
    expect.soft(String(m.applys?.[0]?.refNum)).toBe(String(parent.financeRefId));
    expect.soft(round2(Number(m.applys?.[0]?.amount))).toBe(gross);
    expect.soft(gross, '10% of 11,475').toBe(1147.5);
    expect.soft([m.department, m.class, m.location]).toEqual([LOB_MAP.DEFAULT.department, LOB_MAP.DEFAULT.class, '131']);
    expect(firstCn.cn?.financeSyncStatus).toBe('SUCCESS');
  });

  test('CRN-015: every credit line carries the same taxCode as its invoice line', async () => {
    if (!firstCn.req || !parentReq) blocked('needs CRN-001 and the parent payload');
    const inv = Object.fromEntries((parentReq.invoice.items ?? []).map((i: any) => [i.item, i.taxCode]));
    const pairs = (firstCn.req.creditMemo.items ?? []).map((i: any) => [i.item, inv[i.item], i.taxCode]);
    actual(pairs.map((p: any[]) => `${p[0]} invoice ${p[1]} / CN ${p[2]}`).join('; '));
    expect(pairs.filter((p: any[]) => p[1] !== p[2])).toEqual([]);
    expect(format(checkItems(firstCn.req.creditMemo.items, 7))).toBe('');
  });

  test('CRN-016: memo = adjustment Notes; motivoAnulacion = the reason', async () => {
    if (!firstCn.req) blocked('needs CRN-001');
    const m = firstCn.req.creditMemo;
    actual(`memo ${JSON.stringify(m.memo)}; motivoAnulacion ${JSON.stringify(m.motivoAnulacion)}; CN reasonDescription ${firstCn.cn?.reasonDescription}; tranDate ${m.tranDate}`);
    expect.soft(m.memo).toBe('QA-NS-CRN-016');
    expect(m.motivoAnulacion ?? '').not.toBe('');
  });

  test('ENG-006-02: credit notes on two accounts in a row each carry their own partyId', async () => {
    const n1 = loadState('N1');
    if (!n1?.invoice || !parentId) blocked('needs ns-02 N1 and the ns-01 invoice');
    const a = await adjustOnce('eng006-02a', ACC, { invoiceId: parentId, type: 'BILL_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', amount: 100, reason: 'DATA_ERROR', notes: 'QA-NS-ENG-006-02a' });
    const b = await adjustOnce('eng006-02b', n1.account, { invoiceId: n1.invoice, type: 'BILL_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', amount: 100, reason: 'DATA_ERROR', notes: 'QA-NS-ENG-006-02b' });
    evidence('two-accounts', { first: a, second: b });
    actual(`208886: ${line(a)} entity ${JSON.stringify(a.req?.creditMemo?.entity)} || ${n1.account}: ${line(b)} entity ${JSON.stringify(b.req?.creditMemo?.entity)}`);
    expect.soft(a.req?.creditMemo?.entity).toBe(TD.DEFAULT.party);
    expect(b.req?.creditMemo?.entity).toBe(TD.FONATEL.party);
  });

  test('ENG-006-03: credit note on an account without partyId (record)', async () => {
    const r = await once('contract:N2', async () => {
      const res = await api.crm('processAccountAndOrder', contractBody({ tag: 'N2', partyId: null }));
      return { status: res.status };
    });
    for (let i = 0; i < 18 && !n2Invoice; i++) { n2Invoice = (await api.invoicesOf(N2))[0]?.id; if (!n2Invoice) await new Promise(x => setTimeout(x, 10_000)); }
    saveState('N2', { account: N2, invoice: n2Invoice });
    if (!n2Invoice) blocked(`contract N2 not created: HTTP ${r.status}`);
    await api.waitForActivity(N2, n2Invoice!, 'CREATE_INVOICE', 120_000);
    n2Cn = await adjustOnce('n2', N2, { invoiceId: n2Invoice, type: 'BILL_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', amount: 100, reason: 'DATA_ERROR', notes: 'QA-NS-ENG-006-03' });
    evidence('no-party-credit', n2Cn);
    recordOnly(`${line(n2Cn)}; entity present ${n2Cn.req?.creditMemo ? 'entity' in n2Cn.req.creditMemo : 'n/a'} (${JSON.stringify(n2Cn.req?.creditMemo?.entity)}). Expected by analogy with MAP-007: omitted + ERROR stored, CN kept`);
  });

  test('CRN-007: credit note on a parent invoice that never synced (record)', async () => {
    if (!n2Cn.cn && !n2Cn.error) blocked('needs ENG-006-03');
    const rep = n2Invoice ? await api.invoiceReport(n2Invoice) : undefined;
    recordOnly(`parent ${n2Invoice} sync ${rep?.financeSyncStatus}; CREATE_CREDIT_NOTES ${n2Cn.act ? 'SENT' : 'not sent'}; refNum ${JSON.stringify(n2Cn.req?.creditMemo?.applys?.[0]?.refNum)}; parent due ${rep?.invoiceTotal}; ${line(n2Cn)}. ISP-204: "we assume … already synced"`);
  });

  test('CRN-013: a credit note in ERROR can be re-sent once the cause is fixed', async () => {
    if (!n2Cn.cn) blocked('needs the ENG-006-03 credit note');
    await api.setPartyId(N2, TD.FONATEL.party);
    let out: any; let err = '';
    try { out = await api.gql(`mutation{ syncCreditNotes(input:{id:${JSON.stringify(n2Cn.cn.id)}}) { id isError financeRefId message statusCode } }`); }
    catch (e) { err = (e as Error).message; }
    await new Promise(r => setTimeout(r, 10_000));
    const acts = (await api.activities(N2, 'CREATE_CREDIT_NOTES'));
    const after = (await api.creditNotesOf(N2)).find(c => c.id === n2Cn.cn.id);
    recordOnly(`syncCreditNotes(${n2Cn.cn.id}) → ${JSON.stringify(out ?? err)}; CREATE_CREDIT_NOTES calls now ${acts.length} (last entity ${JSON.stringify(parse(acts.at(-1)?.request)?.creditMemo?.entity)}); CN sync ${after?.financeSyncStatus} ${after?.financeErrorMessage ?? ''}. No resend action is documented for credit notes (GAP)`);
  });

  test('CRN-009: credit note on a paid (CLOSED) invoice (record)', async () => {
    const p1 = loadState('P1');
    if (!p1?.invoice) blocked('needs the paid ns-02 P1 invoice');
    const inv = await api.invoice(p1.invoice);
    const r = await adjustOnce('crn009', p1.account, { invoiceId: p1.invoice, type: 'BILL_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', percent: 10, reason: 'DATA_ERROR', notes: 'QA-NS-CRN-009' });
    const zero = (r.req?.creditMemo?.items ?? []).filter((i: any) => Number(i.taxCode) === 0);
    recordOnly(`parent ${p1.invoice} ${inv.status}; ${r.error ? `rejected: ${r.error}` : line(r)}; taxCode 0 lines: ${zero.length}`);
    expect(zero).toEqual([]);
  });

  test('CRN-005: a debit note is NOT sent to NetSuite', async () => {
    if (!parentId) blocked('needs the ns-01 invoice');
    const before = (await api.activities(ACC, 'CREATE_CREDIT_NOTES')).length;
    const r = await adjustOnce('crn005', ACC, { invoiceId: parentId, type: 'BILL_ADJUSTMENT', arType: 'DEBIT', taxRule: 'WITH_TAX', amount: 500, reason: 'DATA_ERROR', notes: 'QA-NS-CRN-005' });
    const after = (await api.activities(ACC, 'CREATE_CREDIT_NOTES')).length;
    actual(`debit note ${r.cn?.id ?? r.error ?? 'none'} (${r.cn?.type ?? ''}); CREATE_CREDIT_NOTES calls ${before} → ${after}`);
    expect(r.error ?? '').toBe('');
    expect(after).toBe(before);
  });

  test('CRN-010: a credit larger than the invoice balance is blocked and nothing is sent', async () => {
    if (!parentId) blocked('needs the ns-01 invoice');
    const inv = await api.invoice(parentId);
    const before = (await api.activities(ACC, 'CREATE_CREDIT_NOTES')).length;
    const r = await adjustOnce('crn010', ACC, { invoiceId: parentId, type: 'BILL_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', amount: round2(Number(inv.total) + 1), reason: 'DATA_ERROR', notes: 'QA-NS-CRN-010' });
    const after = (await api.activities(ACC, 'CREATE_CREDIT_NOTES')).length;
    actual(`credit ${round2(Number(inv.total) + 1)} on due ${inv.due}: ${r.error ? `rejected: ${r.error}` : line(r)}; CREATE_CREDIT_NOTES ${before} → ${after}`);
    expect.soft(r.error, 'Embrix should reject the over-credit').toBeTruthy();
    expect(after).toBe(before);
  });

  test('CRN-012: several credits on one invoice each sync to the same refNum; invoice keeps its NetSuite id', async () => {
    if (!parent?.financeRefId) blocked('needs the synced ns-01 invoice');
    const runs = [] as CnResult[];
    for (const n of ['a', 'b']) runs.push(await adjustOnce(`crn012${n}`, ACC, { invoiceId: parentId, type: 'BILL_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', percent: 5, reason: 'DATA_ERROR', notes: `QA-NS-CRN-012${n}` }));
    const inv = await api.invoice(parentId);
    const rep = await api.invoiceReport(parentId);
    actual(runs.map(line).join(' || ') + ` || invoice ${parentId} due ${inv.due}, ref ${inv.financeRefId}, sync ${rep?.financeSyncStatus} (ENG-007-01: unchanged after credits)`);
    for (const r of runs) {
      expect.soft(String(r.req?.creditMemo?.applys?.[0]?.refNum)).toBe(String(parent.financeRefId));
      expect.soft(r.cn?.financeSyncStatus).toBe('SUCCESS');
    }
    expect.soft(inv.financeRefId, 'invoice NetSuite id unchanged after credits').toBe(parent.financeRefId);
    expect(rep?.financeSyncStatus).toBe('SUCCESS');
  });

  test('CRN-008: a non-stamping reason (CUSTOMER_SATISFACTION) credit note still syncs', async () => {
    if (!parentId) blocked('needs the ns-01 invoice');
    const r = await adjustOnce('crn008', ACC, { invoiceId: parentId, type: 'BILL_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', amount: 200, reason: 'CUSTOMER_SATISFACTION', notes: 'QA-NS-CRN-008' });
    saveState('cnNoStamp', r.cn?.id);
    actual(`${line(r)}. PDF view is checked in ns-05 (UI)`);
    expect(r.cn, 'credit note created').toBeTruthy();
    expect(r.res?.error, 'synced to NetSuite (EFT-86)').toBe(false);
  });

  // ── Multi-line invoice and line-level credits ──────────────────────────
  test('INV-014: a multi-line invoice sends one item per line with the right tax', async () => {
    multiId = await once('multi208886', () => api.manualInvoice(ACC, [
      { itemId: 'I_INT', serviceType: 'INTERNET', description: 'QA-NS-R2 INTERNET', quantity: 1, unitPrice: 10000 },
      { itemId: 'I_TV', serviceType: 'TV', description: 'QA-NS-R2 TV', quantity: 1, unitPrice: 5000 },
    ]));
    saveState('multi208886', multiId);
    const act = await api.waitForActivity(ACC, multiId, 'CREATE_INVOICE');
    const req = parse(act?.request), res = parse(act?.response);
    const inv = await api.invoice(multiId);
    evidence(`${multiId}-CREATE_INVOICE`, { activity: act?.id, request: req, response: res });
    const items = req?.invoice?.items ?? [];
    const gross = round2(items.reduce((s: number, i: any) => s + Number(i.grossAmount), 0));
    actual(`invoice ${multiId} total ${inv.total}; ${items.map((i: any) => `${i.item} ${i.amount} tc${i.taxCode} tax ${i.taxAmount}`).join('; ')}; sum gross ${gross}; NetSuite ${JSON.stringify(res)}`);
    expect.soft(items.map((i: any) => i.item).sort()).toEqual(['I_IMP_911', 'I_IMP_CR', 'I_INT', 'I_TV']);
    expect.soft(format(checkItems(items, 7))).toBe('');
    expect.soft(gross, 'items add up to the invoice total').toBe(round2(Number(inv.total)));
    expect(res?.error).toBe(false);
  });

  test('CRN-002: line credit with tax, 1,000 on the TV line → I_TV 1,000 + 130 = 1,130, taxCode 7', async () => {
    if (!multiId) blocked('needs INV-014');
    const lines = await api.invoiceLines(multiId!);
    const tv = lines.find(l => l.itemId === 'I_TV');
    if (!tv) blocked(`no I_TV line on ${multiId}: ${JSON.stringify(lines)}`);
    const r = await adjustOnce('crn002', ACC, { invoiceId: multiId, type: 'INVOICE_LINE_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', reason: 'DATA_ERROR', notes: 'QA-NS-CRN-002', invoiceLines: [{ index: tv.index, name: tv.name, amount: 1000 }] });
    const items = r.req?.creditMemo?.items ?? [];
    evidence('line-credit-TV', r);
    actual(`${line(r)}; items ${items.map((i: any) => `${i.item} ${i.amount}+${i.taxAmount}=${i.grossAmount} tc${i.taxCode}`).join('; ')}; applys ${JSON.stringify(r.req?.creditMemo?.applys)}`);
    const it = items.find((i: any) => i.item === 'I_TV');
    expect.soft([Number(it?.amount), Number(it?.taxAmount), Number(it?.grossAmount), Number(it?.taxCode)]).toEqual([1000, 130, 1130, 7]);
    expect.soft(round2(Number(r.req?.creditMemo?.applys?.[0]?.amount))).toBe(1130);
    expect(r.res?.error).toBe(false);
  });

  test('CRN-006: SIN_IMPUESTO (WITHOUT_TAX) line credit is created, stamped and synced (EFT-93)', async () => {
    if (!multiId) blocked('needs INV-014');
    const lines = await api.invoiceLines(multiId!);
    const int = lines.find(l => l.itemId === 'I_INT');
    const r = await adjustOnce('crn006', ACC, { invoiceId: multiId, type: 'INVOICE_LINE_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITHOUT_TAX', reason: 'DATA_ERROR', notes: 'QA-NS-CRN-006', invoiceLines: [{ index: int?.index, name: int?.name, amount: 1000 }] });
    evidence('sin-impuesto-credit', r);
    actual(`${r.error ? `rejected: ${r.error}` : line(r)}; taxCodes sent ${(r.req?.creditMemo?.items ?? []).map((i: any) => `${i.item}:${i.taxCode} tax ${i.taxAmount}`).join(' ')} (no rule specified)`);
    expect.soft(r.error ?? '', 'no "Tax data not found"').not.toMatch(/Tax data not found/i);
    expect.soft(r.cn?.folioStatus).toBe('STAMPED');
    expect(r.res?.error).toBe(false);
  });

  test('INV-015: rounding with non-round amounts matches between Embrix and the payload', async () => {
    const id = await once('rounding208886', () => api.manualInvoice(ACC, [{ itemId: 'I_INT', serviceType: 'INTERNET', description: 'QA-NS-R2 ROUNDING', quantity: 3, unitPrice: 3333.33 }]));
    const act = await api.waitForActivity(ACC, id, 'CREATE_INVOICE');
    const req = parse(act?.request), res = parse(act?.response);
    const inv = await api.invoice(id);
    const items = req?.invoice?.items ?? [];
    const gross = round2(items.reduce((s: number, i: any) => s + Number(i.grossAmount), 0));
    evidence(`${id}-CREATE_INVOICE`, { request: req, response: res });
    actual(`invoice ${id} total ${inv.total}; items ${items.map((i: any) => `${i.item} ${i.amount}/${i.taxAmount}/${i.grossAmount}`).join('; ')}; sum gross ${gross}; NetSuite ${JSON.stringify(res)}`);
    expect.soft(format(checkItems(items, 7))).toBe('');
    expect(gross).toBe(round2(Number(inv.total)));
  });

  // ── Credits through the CRM gateway (what Coopeweb calls) ──────────────
  test('ADJ-001: processAdjustment via the CRM gateway creates a credit note that syncs', async () => {
    if (!parentId) blocked('needs the ns-01 invoice');
    const before = new Set((await api.activities(ACC, 'CREATE_CREDIT_NOTES')).map(a => a.id));
    const body = { accountId: ACC, userId: 'congeroadmin', invoiceId: parentId, percent: 5, adjustmentType: 'BILL_ADJUSTMENT', creditDebitType: 'CREDIT', customReason: 'NC - Error en facturación', taxRule: 'WITH_TAX', skipWorkOrder: true, notes: 'QA-NS-ADJ-001' };
    const r = await api.crm('processAdjustment', body);
    await new Promise(x => setTimeout(x, 20_000));
    const act = (await api.activities(ACC, 'CREATE_CREDIT_NOTES')).find(a => !before.has(a.id));
    const res = parse(act?.response);
    evidence('crm-processAdjustment', { request: body, status: r.status, response: r.json ?? r.text, activity: act?.id, netsuite: res });
    actual(`HTTP ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 200)}; ${act?.id ?? 'no CREATE_CREDIT_NOTES'} NetSuite ${JSON.stringify(res)}`);
    expect(act, 'credit note sent to NetSuite').toBeTruthy();
    expect(res?.error).toBe(false);
  });

  test('ADJ-002: getAccountItems lists the items; processAdjustment with itemId credits only that item', async () => {
    if (!multiId) blocked('needs INV-014');
    const items = await api.crm('getAccountItems', { accountId: ACC, invoiceUnitId: multiId });
    const before = new Set((await api.activities(ACC, 'CREATE_CREDIT_NOTES')).map(a => a.id));
    const body = { accountId: ACC, userId: 'congeroadmin', invoiceId: multiId, itemId: 'I_TV', percent: 50, adjustmentType: 'BILL_ADJUSTMENT', creditDebitType: 'CREDIT', customReason: 'NC - Error en facturación', taxRule: 'WITH_TAX', skipWorkOrder: true, notes: 'QA-NS-ADJ-002' };
    const r = await api.crm('processAdjustment', body);
    await new Promise(x => setTimeout(x, 20_000));
    const act = (await api.activities(ACC, 'CREATE_CREDIT_NOTES')).find(a => !before.has(a.id));
    const req = parse(act?.request);
    const sent = (req?.creditMemo?.items ?? []).map((i: any) => `${i.item} ${i.amount}+${i.taxAmount}`);
    evidence('itemId-adjustment', { getAccountItems: items.json ?? items.text, request: body, response: r.json ?? r.text, creditMemo: req });
    actual(`getAccountItems HTTP ${items.status} ${JSON.stringify(items.json ?? items.text).slice(0, 200)}; processAdjustment HTTP ${r.status}; CN items ${sent.join('; ') || 'none'}`);
    expect.soft(items.status).toBe(200);
    expect.soft((req?.creditMemo?.items ?? []).filter((i: any) => i.item !== 'I_TV').map((i: any) => i.item), 'only I_TV credited').toEqual([]);
    expect(Number((req?.creditMemo?.items ?? []).find((i: any) => i.item === 'I_TV')?.amount)).toBe(2500);
  });
});
