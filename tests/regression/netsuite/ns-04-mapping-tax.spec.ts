/**
 * NetSuite R2 — line-of-business mapping and taxCodes.
 *
 * MAP-002 / MAP-003 re-run on Jeremy's FONATEL (3012830, which also carries a
 * 69.23% exemption → taxCode 9) and PHC (244821) contracts.
 *
 * The exemption table (oracle-01, core_config.tax_exempt_taxcode_map) is driven
 * on ONE QA contract, E1 (partyId 57936), by changing its exemption between
 * manual invoices — the same thing an agent does in Account > Tax Exemption.
 * E1 is unknown to NetSuite, so its invoices end in "contract not found": the
 * payload (what Embrix computed) is what these cases judge.
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { contractBody, qaId, TD } from '../../../helpers/netsuite/ns-data';
import { checkInvoiceHeader, checkItems, format, productTaxCode, round2 } from '../../../helpers/netsuite/ns-oracle';
import { actual, evidence, recordOnly, saveState, blocked, once } from '../../../helpers/netsuite/ns-record';

const E1 = qaId('E1');

test.describe('NetSuite R2 — mapping and taxCodes', () => {
  let api: NsApi;
  let e1Ready = false;

  /** Manual I_INT invoice (+ optional TV) on an account; returns the NetSuite-bound request/response. */
  async function invoiceAndPayload(account: string, withTv = false) {
    const lines = [{ itemId: 'I_INT', serviceType: 'INTERNET', description: 'QA-NS-R2 INTERNET', quantity: 1, unitPrice: 10000 }];
    if (withTv) lines.push({ itemId: 'I_TV', serviceType: 'TV', description: 'QA-NS-R2 TV', quantity: 1, unitPrice: 5000 });
    const id = await api.manualInvoice(account, lines);
    const act = await api.waitForActivity(account, id, 'CREATE_INVOICE');
    const req = parse(act?.request), res = parse(act?.response);
    const inv = await api.invoice(id);
    evidence(`${id}-CREATE_INVOICE`, { activity: act?.id, request: req, response: res });
    return { id, inv, act, req, res, items: (req?.invoice?.items ?? []) as any[] };
  }
  const codes = (items: any[]) => items.map(i => `${i.item}:tc${i.taxCode} ${i.amount}/${i.taxAmount}`).join(' ');
  const product = (items: any[], item = 'I_INT') => items.find(i => i.item === item);

  /** The exemption contract E1, created once per run (any test may be the first to need it). */
  async function ensureE1(): Promise<void> {
    const r = await once('contract:E1', async () => {
      const res = await api.crm('processAccountAndOrder', contractBody({ tag: 'E1', partyId: TD.FONATEL.party }));
      let ok = false;
      for (let i = 0; i < 18 && !ok && res.status === 200; i++) { ok = (await api.invoicesOf(E1)).length > 0; if (!ok) await new Promise(x => setTimeout(x, 10_000)); }
      return { status: res.status, ok, body: res.text.slice(0, 200) };
    });
    e1Ready = r.ok;
    saveState('E1', E1);
    if (!e1Ready) blocked(`E1 not created: HTTP ${r.status} ${r.body}`);
  }

  async function exempt(percent: number | null, opts: { certificate?: string; serviceTypes?: string[] } = {}) {
    await ensureE1();
    return api.setTaxExemption(E1, percent, opts);
  }

  test.beforeAll(async ({ playwright }) => {
    api = new NsApi(await playwright.request.newContext());
  });

  test('MAP-002: FONATEL contract sends department 137 / class 9 / location 131 (and 69.23% → taxCode 9)', async () => {
    const acc = await api.account(TD.FONATEL.account);
    let r;
    try { r = await invoiceAndPayload(TD.FONATEL.account); }
    catch (e) { blocked(`3012830 cannot be invoiced (Bug_007?): ${(e as Error).message}`); }
    const h = r!.req?.invoice ?? {};
    const mm = checkInvoiceHeader(r!.req, acc, r!.inv);
    actual(`invoice ${r!.id} folio ${r!.inv.folioStatus}; dept ${h.department} class ${h.class} loc ${JSON.stringify(h.location)} entity ${JSON.stringify(h.entity)}; ${codes(r!.items)}; header mismatches: ${format(mm) || 'none'}; NetSuite ${JSON.stringify(r!.res)}`);
    expect.soft([h.department, h.class, h.location]).toEqual([137, 9, '131']);
    expect.soft(product(r!.items)?.taxCode, '69.23% exemption → 9').toBe(productTaxCode(acc));
    expect(format(mm)).toBe('');
  });

  test('MAP-003: PHC contract sends department 135 / class 10 / location 131 (not 132)', async () => {
    const acc = await api.account(TD.PHC.account);
    let r;
    try { r = await invoiceAndPayload(TD.PHC.account); }
    catch (e) { blocked(`244821 cannot be invoiced (Bug_008?): ${(e as Error).message}`); }
    const h = r!.req?.invoice ?? {};
    actual(`invoice ${r!.id} folio ${r!.inv.folioStatus}; dept ${h.department} class ${h.class} loc ${JSON.stringify(h.location)} entity ${JSON.stringify(h.entity)}; NetSuite ${JSON.stringify(r!.res)}`);
    expect.soft(h.entity).toBe(TD.PHC.party);
    expect([h.department, h.class, h.location]).toEqual([135, 10, '131']);
  });

  test('MAP-008: partial exemptions map to taxCodes 8 / 9 / 10 / 11 with the right tax', async () => {
    await ensureE1();
    const table: [number, number, number][] = [[38.46, 8, 800], [69.23, 9, 400], [84.62, 10, 200], [92.31, 11, 100]];
    const rows: string[] = []; const bad: string[] = [];
    for (const [pct, code, tax] of table) {
      const stored = await exempt(pct);
      const r = await invoiceAndPayload(E1);
      const it = product(r.items);
      rows.push(`${pct}% (stored ${JSON.stringify(stored?.map((x: any) => x.percent))}) → ${r.id}: I_INT tc${it?.taxCode} tax ${it?.taxAmount}`);
      if (Number(it?.taxCode) !== code || round2(Number(it?.taxAmount)) !== tax) bad.push(`${pct}%: expected tc${code} tax ${tax}`);
      if (format(checkItems(r.items.filter(i => i.item !== 'I_INT'), 7))) bad.push(`${pct}%: levy lines ${codes(r.items)}`);
    }
    actual(rows.join(' | '));
    expect(bad).toEqual([]);
  });

  test('MAP-011: an exemption stored with 6 decimals (84.615385) maps like 84.62 → taxCode 10', async () => {
    await exempt(84.615385);
    const r = await invoiceAndPayload(E1);
    const it = product(r.items);
    actual(`84.615385% → ${r.id}: I_INT tc${it?.taxCode} tax ${it?.taxAmount}; NetSuite ${JSON.stringify(r.res)}`);
    expect.soft(Number(it?.taxCode), 'EFT-92: never 0').not.toBe(0);
    expect(Number(it?.taxCode)).toBe(10);
  });

  test('MAP-009: 100% exemption → taxCode 6 with certificate, 12 without; tax 0', async () => {
    await exempt(100, { certificate: 'QA-NS-R2-CERT-001' });
    const withCert = await invoiceAndPayload(E1);
    await exempt(100);
    const noCert = await invoiceAndPayload(E1);
    const a = product(withCert.items), b = product(noCert.items);
    actual(`with certificate → ${withCert.id}: tc${a?.taxCode} tax ${a?.taxAmount}; without → ${noCert.id}: tc${b?.taxCode} tax ${b?.taxAmount}`);
    expect.soft([Number(a?.taxCode), Number(a?.taxAmount)]).toEqual([6, 0]);
    expect([Number(b?.taxCode), Number(b?.taxAmount)]).toEqual([12, 0]);
  });

  test('MAP-005: an unmapped exemption (50%) fails inside Embrix and never sends taxCode 0', async () => {
    await exempt(50);
    let r: Awaited<ReturnType<typeof invoiceAndPayload>> | undefined; let err = '';
    try { r = await invoiceAndPayload(E1); } catch (e) { err = (e as Error).message; }
    const sent = r?.items ?? [];
    actual(r ? `invoice ${r.id}; ${r.act ? `SENT: ${codes(sent)}; NetSuite ${JSON.stringify(r.res)}` : 'nothing sent'}; report ${(await api.invoiceReport(r.id))?.financeErrorMessage ?? ''}` : `invoice not created: ${err}`);
    expect(sent.filter(i => Number(i.taxCode) === 0), 'never taxCode 0').toEqual([]);
    expect(r?.act, 'nothing should be sent for an unmapped exemption').toBeFalsy();
  });

  test('MAP-012: exemption on Internet only — I_INT gets the reduced code, I_TV stays 7', async () => {
    await exempt(84.62, { serviceTypes: ['INTERNET'] });
    const r = await invoiceAndPayload(E1, true);
    const i = product(r.items, 'I_INT'), t = product(r.items, 'I_TV');
    actual(`${r.id}: ${codes(r.items)}`);
    expect.soft(Number(i?.taxCode)).toBe(10);
    expect(Number(t?.taxCode)).toBe(7);
    saveState('E1reduced', r.id);
  });

  test('CRN-011: a credit on a reduced-rate line keeps the invoice line taxCode (ISP-242)', async () => {
    await exempt(38.46);
    const r = await invoiceAndPayload(E1);
    const lines = await api.invoiceLines(r.id);
    const int = lines.find(l => l.itemId === 'I_INT');
    const beforeAct = new Set((await api.activities(E1, 'CREATE_CREDIT_NOTES')).map(a => a.id));
    await api.processAdjustment({ accountId: E1, userId: 'congeroadmin', source: 'AGENT_CARE', generateCreditNoteNow: true, invoiceId: r.id,
      type: 'INVOICE_LINE_ADJUSTMENT', arType: 'CREDIT', taxRule: 'WITH_TAX', reason: 'DATA_ERROR', notes: 'QA-NS-CRN-011', invoiceLines: [{ index: int?.index, name: int?.name, amount: 1000 }] });
    let cnReq: any;
    for (let k = 0; k < 18 && !cnReq; k++) {
      cnReq = parse((await api.activities(E1, 'CREATE_CREDIT_NOTES')).find(a => !beforeAct.has(a.id))?.request);
      if (!cnReq) await new Promise(x => setTimeout(x, 10_000));
    }
    const ci = (cnReq?.creditMemo?.items ?? []).find((x: any) => x.item === 'I_INT');
    actual(`invoice ${r.id} I_INT tc${product(r.items)?.taxCode}; credit I_INT tc${ci?.taxCode} ${ci?.amount}+${ci?.taxAmount}`);
    expect(cnReq, 'CREATE_CREDIT_NOTES sent').toBeTruthy();
    expect.soft(Number(ci?.taxCode)).toBe(Number(product(r.items)?.taxCode));
    expect(round2(Number(ci?.taxAmount)), '8% of 1,000').toBe(80);
  });

  test.afterAll(async () => {
    if (e1Ready) await api.setTaxExemption(E1, null).catch(() => {});
  });
});

test('INV-004: prepaid electricity invoice and NetSuite (record)', async () => {
  blocked('No prepaid electricity contract exists for CoopeG on coopegsbx2 and none was provided (TD-004). Jira ISP-202: Energy invoices ARE sent; nothing excludes prepaid. Needs a prepaid account from Jeremy.');
});
