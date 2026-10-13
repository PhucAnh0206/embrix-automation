/**
 * NetSuite R2 — invoice sync on the DEFAULT test contract 208886 (partyId 74003).
 *
 * ONE fresh manual invoice (I_INT x1 @ 10,000 → 11,475.00) feeds every case in
 * this file, the same way R1 did with 0279497 — which must never be resubmitted.
 * The invoice id is saved for ns-03 (credit notes), which credits it.
 *
 * Cases: RET-003, INV-003, MAP-006, MAP-001, MAP-004, INV-017, AUTH-001,
 *        ENG-007-01, INV-006, INV-009, REG-003
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse, Activity } from '../../../helpers/netsuite/ns-api.helper';
import { checkInvoiceHeader, checkItems, format, addDays, productTaxCode, round2 } from '../../../helpers/netsuite/ns-oracle';
import { actual, evidence, recordOnly, saveState, blocked, once } from '../../../helpers/netsuite/ns-record';

const ACCOUNT = '208886';
const PARTY = '74003';

test.describe('NetSuite R2 — DEFAULT contract 208886: manual invoice sync', () => {
  let api: NsApi;
  let account: any;
  let invoiceId: string;
  let invoice: any;
  let act: Activity | undefined;
  let req: any;
  let res: any;

  test.beforeAll(async ({ playwright }) => {
    api = new NsApi(await playwright.request.newContext());
    account = await api.account(ACCOUNT);
    // once(): a worker restarted after a failed case reuses this run's invoice.
    invoiceId = await once('inv208886', () => api.manualInvoice(ACCOUNT, [{ itemId: 'I_INT', serviceType: 'INTERNET', description: 'QA-NS-R2 INTERNET', quantity: 1, unitPrice: 10000 }]));
    saveState('inv208886', invoiceId);
    act = await api.waitForActivity(ACCOUNT, invoiceId, 'CREATE_INVOICE');
    invoice = await api.invoice(invoiceId);
    req = parse(act?.request);
    res = parse(act?.response);
    // NetSuite's answer can lag the activity row; give the report a moment to settle.
    await new Promise(r => setTimeout(r, 5_000));
  });

  test('RET-003: CREATE_INVOICE carries entity = partyId and numeric tipoFactura 12', async () => {
    expect(act, `no CREATE_INVOICE activity for ${invoiceId} within 3 min`).toBeTruthy();
    evidence(`${invoiceId}-CREATE_INVOICE`, { activity: act?.id, request: req, response: res });
    actual(`invoice ${invoiceId}, ${act!.id}: entity=${JSON.stringify(req?.invoice?.entity)}, tipoFactura=${JSON.stringify(req?.invoice?.tipoFactura)}; NetSuite: ${JSON.stringify(res)}`);
    expect.soft(req.invoice.entity, 'entity').toBe(PARTY);
    expect.soft(req.invoice.tipoFactura, 'tipoFactura must be the NUMBER 12').toBe(12);
    expect(res?.error, `NetSuite rejected: ${res?.message}`).toBe(false);
  });

  test('INV-003: manual invoice total 11,475.00 and payload per oracle-04/05, synced', async () => {
    const mm = [...checkInvoiceHeader(req, account, invoice), ...checkItems(req?.invoice?.items, productTaxCode(account))];
    const rep = await api.invoiceReport(invoiceId);
    actual(`total ${invoice.total}; report ${rep?.financeSyncStatus} ${rep?.financeErrorMessage ?? ''}; payload mismatches: ${mm.length ? format(mm) : 'none'}`);
    expect.soft(round2(invoice.total), 'invoice total (MATH-01)').toBe(11475);
    expect.soft(format(mm), 'payload vs oracle').toBe('');
    expect(rep?.financeSyncStatus).toBe('SUCCESS');
  });

  test('MAP-006: entity = the account partyId (string)', async () => {
    actual(`account partyId ${account.partyId}; payload entity ${JSON.stringify(req?.invoice?.entity)}`);
    expect(account.partyId).toBe(PARTY);
    expect(req?.invoice?.entity).toBe(String(account.partyId));
  });

  test('MAP-001: DEFAULT sends department 15 / class 104 / location "131"', async () => {
    const h = req?.invoice ?? {};
    actual(`department ${h.department}, class ${h.class}, location ${JSON.stringify(h.location)}`);
    expect([h.department, h.class, h.location]).toEqual([15, 104, '131']);
  });

  test('MAP-004: I_INT taxCode 7 @13%, CR 1% / 911 0.75% taxCode 5, no I_IMP_IVA, never 0', async () => {
    const items = req?.invoice?.items ?? [];
    const mm = checkItems(items, 7);
    actual(items.map((i: any) => `${i.item} ${i.amount} tc${i.taxCode} tax ${i.taxAmount} gross ${i.grossAmount}`).join('; ') + (mm.length ? ` | ${format(mm)}` : ''));
    expect(items.map((i: any) => i.item).sort()).toEqual(['I_IMP_911', 'I_IMP_CR', 'I_INT']);
    expect(format(mm)).toBe('');
  });

  test('INV-017: due date = invoice date + 15 days, in Bills and in the payload', async () => {
    const want = addDays(String(invoice.invoiceDate), 15);
    actual(`invoiceDate ${invoice.invoiceDate}, dueDate ${invoice.dueDate}, paymentTerm ${invoice.paymentTerm}; payload tranDate ${req?.invoice?.tranDate} fechaVencimiento ${req?.invoice?.fechaVencimiento}`);
    expect.soft(String(invoice.dueDate).slice(0, 10)).toBe(want);
    expect(req?.invoice?.fechaVencimiento).toBe(want.split('-').reverse().join('/'));
  });

  test('AUTH-001: NetSuite answers with a business response, not an authentication error', async () => {
    actual(`response ${JSON.stringify(res)}`);
    expect(res, 'no response stored').toBeTruthy();
    expect(JSON.stringify(res)).not.toMatch(/401|unauthori[sz]ed|INVALID_LOGIN|signature/i);
  });

  test('ENG-007-01: SUCCESS keeps its finance reference after refresh, email, regenerate', async () => {
    const before = await api.invoice(invoiceId);
    const rep0 = await api.invoiceReport(invoiceId);
    const steps: string[] = [`after sync: ${rep0?.financeSyncStatus} ref ${before.financeRefId} ver ${before.financeVersion}`];
    expect(rep0?.financeSyncStatus).toBe('SUCCESS');
    expect.soft(before.financeRefId, 'Finance Ref Id = NetSuite data.id').toBe(String(res?.data?.id).replace(/\.0$/, ''));
    expect.soft(before.financeVersion, 'Finance Version = tranId').toBe(res?.data?.tranId);
    for (const [label, step] of [
      ['refresh', async () => {}],
      ['EMAIL_INVOICE', () => api.emailInvoice(ACCOUNT, invoiceId)],
      ['REGENERATE_INVOICE', () => api.regenerateInvoice(invoiceId)],
    ] as const) {
      try { await step(); } catch (e) { steps.push(`${label} call failed: ${(e as Error).message}`); continue; }
      const after = await api.invoice(invoiceId);
      const rep = await api.invoiceReport(invoiceId);
      steps.push(`after ${label}: ${rep?.financeSyncStatus} ref ${after.financeRefId} ver ${after.financeVersion}`);
      expect.soft(rep?.financeSyncStatus, `status after ${label}`).toBe('SUCCESS');
      expect.soft(after.financeRefId, `ref after ${label}`).toBe(before.financeRefId);
      expect.soft(after.financeVersion, `version after ${label}`).toBe(before.financeVersion);
    }
    // The credit-note step of ENG-007-01 is re-checked at the end of ns-03.
    actual(steps.join(' → '));
  });

  test('INV-006: Finance Ref Id = response data.id and Finance Version = tranId', async () => {
    const inv = await api.invoice(invoiceId);
    actual(`ref ${inv.financeRefId} / data.id ${res?.data?.id}; version ${inv.financeVersion} / tranId ${res?.data?.tranId}`);
    expect(inv.financeRefId).toBe(String(res?.data?.id).replace(/\.0$/, ''));
    expect(inv.financeVersion).toBe(res?.data?.tranId);
  });

  test('INV-009: order of Hacienda stamping (CREATE_XML_INVOICE) vs NetSuite sync (CREATE_INVOICE)', async () => {
    const acts = await api.activitiesFor(ACCOUNT, invoiceId);
    if (!acts.length) blocked('no activities found for the invoice');
    const order = acts.map(a => `${a.id} ${a.apiName}`).join(' → ');
    evidence(`${invoiceId}-activity-order`, order);
    const ix = (n: string) => acts.findIndex(a => a.apiName === n);
    recordOnly(`${order}. ${ix('CREATE_XML_INVOICE') < ix('CREATE_INVOICE') ? 'Stamping first (ISP-239)' : 'NetSuite sync logged BEFORE stamping (Bug_010)'}`);
  });

  test('REG-003: the new invoice is stamped by Hacienda (JARS)', async () => {
    const inv = await api.invoice(invoiceId);
    actual(`folioStatus ${inv.folioStatus}`);
    expect(inv.folioStatus).toBe('STAMPED');
  });
});
