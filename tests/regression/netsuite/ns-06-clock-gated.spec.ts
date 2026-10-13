/**
 * NetSuite R2 — cases that need the tenant CCP clock moved.
 *
 * The clock is TENANT-WIDE: while it is moved, every coopegsbx2 user and job
 * sees the new date. These cases therefore run only with NS_ALLOW_CLOCK=true,
 * inside a slot agreed with Jeremy, and always put the clock back (finally).
 * Manual invoices only touch the QA test contract; the billing / collection
 * JOB cases (REG-001, INV-001, REG-002, AR-002) bill or collect every due
 * account and push to Coope's NetSuite, so they stay Blocked until a job slot
 * is agreed as well.
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { TD } from '../../../helpers/netsuite/ns-data';
import { actual, evidence, blocked } from '../../../helpers/netsuite/ns-record';

const CLOCK_OK = process.env.NS_ALLOW_CLOCK === 'true';

async function atDate<T>(api: NsApi, date: string, body: () => Promise<T>): Promise<T> {
  const original = await api.ccpDate();
  await api.setCcpDate(date);
  try { return await body(); }
  finally { await api.setCcpDate(original); }
}

async function invoiceAt(api: NsApi, date: string) {
  return atDate(api, date, async () => {
    const id = await api.manualInvoice(TD.DEFAULT.account, [{ itemId: 'I_INT', serviceType: 'INTERNET', description: `QA-NS-R2 ${date}`, quantity: 1, unitPrice: 10000 }]);
    const act = await api.waitForActivity(TD.DEFAULT.account, id, 'CREATE_INVOICE');
    return { id, inv: await api.invoice(id), req: parse(act?.request), res: parse(act?.response) };
  });
}

test.describe('NetSuite R2 — clock-dependent cases', () => {
  let api: NsApi;
  test.beforeAll(async ({ playwright }) => { api = new NsApi(await playwright.request.newContext()); });

  test('INV-010: memo / idProceso / dates follow the invoice date across month and year boundaries', async () => {
    if (!CLOCK_OK) blocked('needs NS_ALLOW_CLOCK=true inside an agreed clock slot (tenant-wide clock)');
    const dec = await invoiceAt(api, '2026-12-01');
    const jan = await invoiceAt(api, '2027-01-01');
    evidence('year-boundary', { dec: dec.req, jan: jan.req });
    const f = (r: any) => `${r.id} ${r.inv.invoiceDate}: memo ${r.req?.invoice?.memo}, mes ${r.req?.invoice?.mes}, annio ${r.req?.invoice?.annio}, idProceso ${r.req?.invoice?.idProceso}, tranDate ${r.req?.invoice?.tranDate}`;
    actual(`${f(dec)} || ${f(jan)}`);
    expect.soft([dec.req?.invoice?.memo, dec.req?.invoice?.idProceso]).toEqual(['Telecomunicaciones DIC-2026', '122026']);
    expect([jan.req?.invoice?.memo, jan.req?.invoice?.idProceso, jan.req?.invoice?.annio]).toEqual(['Telecomunicaciones ENE-2027', '12027', 2027]);
  });

  test('INV-011: an invoice dated outside the open NetSuite period is rejected cleanly', async () => {
    if (!CLOCK_OK) blocked('needs NS_ALLOW_CLOCK=true inside an agreed clock slot (tenant-wide clock)');
    const r = await invoiceAt(api, '2028-01-15');
    const rep = await api.invoiceReport(r.id);
    actual(`${r.id} dated ${r.inv.invoiceDate}: NetSuite ${JSON.stringify(r.res)}; report ${rep?.financeSyncStatus}: ${rep?.financeErrorMessage}; invoice ${rep?.status}`);
    expect.soft(r.res?.message ?? '').toMatch(/período fiscal abierto/i);
    expect.soft(rep?.financeSyncStatus).toBe('ERROR');
    expect(rep?.status).toBe('ACTIVE');
  });

  test('RET-004: EFT-68 retest — changing the CCP date through GraphQL is applied and invoices follow it', async () => {
    if (!CLOCK_OK) blocked('needs NS_ALLOW_CLOCK=true inside an agreed clock slot (tenant-wide clock)');
    const original = await api.ccpDate();
    const r = await invoiceAt(api, '2027-10-01');
    const back = await api.ccpDate();
    actual(`clock ${original} → 2027-10-01 → ${back}; invoice ${r.id} dated ${r.inv.invoiceDate}, tranDate ${r.req?.invoice?.tranDate}`);
    expect.soft(String(r.inv.invoiceDate).slice(0, 10)).toBe('2027-10-01');
    expect(back).toBe(original);
  });

  for (const [id, title, why] of [
    ['INV-001', 'a recurring (BDOM) invoice is sent to NetSuite and gets a NetSuite id', 'billing jobs at the next BDOM'],
    ['REG-001', 'a normal billing cycle still works end to end', 'billing jobs at the next BDOM'],
    ['REG-002', 'collections suspend / reconnect still work', 'collection jobs after an invoice goes overdue'],
    ['AR-002', 'the due-date API rejects an invoice in collection', 'collection jobs to put an own invoice in COLLECTION'],
  ] as const) {
    test(`${id}: ${title}`, async () => {
      blocked(`needs a clock move plus ${why}; jobs run for EVERY due account and push to Coope's NetSuite — needs a slot agreed with Jeremy`);
    });
  }
});
