/**
 * NetSuite R2 — what an agent sees: Bills, Credit/Debit Notes, the Invoicing
 * report, PDFs — plus INV-018 (undo of a manual invoice already in NetSuite).
 *
 * Screens (coopegsbx2, 10-12): /customers/<id>/bills (finance columns + an
 * Action dropdown that acts on the selected row), /customers/<id>/credit-notes,
 * /report/invoicing (Finance Sync Status + Finance Error Message columns).
 */
import { test, expect, Page, Locator } from '@playwright/test';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { TD } from '../../../helpers/netsuite/ns-data';
import { extractPdfText } from '../../../helpers/pdf.helper';
import { actual, evidence, recordOnly, blocked, loadState, once } from '../../../helpers/netsuite/ns-record';

const ACC = TD.DEFAULT.account;
const ERROR_INVOICE = '0279497'; // R1 invoice, ERROR — looked at only, never resubmitted

async function open(page: Page, baseURL: string, path: string) {
  await page.goto(`${baseURL.replace(/\/+$/, '')}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4000);
}

/** Cell text of a row (found by a cell's exact text) under a column header, in the table that has that header. */
async function cell(page: Page, rowKey: string, header: string): Promise<string> {
  const table = page.locator('table', { has: page.locator('th', { hasText: header }) }).last();
  const headers = (await table.locator('th').allInnerTexts()).map(h => h.trim());
  const idx = headers.indexOf(header);
  if (idx < 0) throw new Error(`no column "${header}" (have: ${headers.join(' | ')})`);
  const row = table.locator('tbody tr', { has: page.getByText(rowKey, { exact: true }) }).first();
  const td = row.locator('td').nth(idx);
  // Finance Error Message is rendered in a read-only <textarea>: its text is the value, not innerText.
  const box = td.locator('textarea, input');
  if (await box.count()) return (await box.first().inputValue()).trim();
  return (await td.innerText()).trim();
}

async function actionOptions(page: Page, rowKey: string): Promise<string[]> {
  const row = page.locator('tr', { has: page.getByText(rowKey, { exact: true }) }).first();
  await row.locator('input[type=radio], td').first().click();
  await page.waitForTimeout(800);
  await page.getByText('<Select Action>').last().click();
  await page.waitForTimeout(1000);
  const opts = (await page.locator('[class*="option"]').allInnerTexts()).map(s => s.trim()).filter(Boolean);
  await page.keyboard.press('Escape');
  return opts;
}

/**
 * Opens the document viewer (the invoice / credit-note id is a button that navigates to a page with
 * XML / PDF / DOWNLOAD) and returns the file the DOWNLOAD button saves — the same file an agent gets.
 * (Headless Chrome cannot render the embedded PDF, and the S3 URL refuses direct requests: AccessDenied.)
 */
async function capturePdf(page: Page, trigger: Locator): Promise<{ bytes?: Buffer; how: string; note?: string }> {
  await trigger.click();
  const btn = page.getByRole('button', { name: /^download$/i }); // shown uppercase via CSS; the name is 'Download'
  await btn.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  if (!(await btn.isVisible())) return { how: 'viewer', note: 'no DOWNLOAD button on the viewer page' };
  const dl = page.waitForEvent('download', { timeout: 60_000 }).catch(() => undefined);
  await btn.click();
  const d = await dl;
  if (!d) {
    const err = await page.getByText(/Failed to load PDF document/i).first().innerText().catch(() => '');
    return { how: 'DOWNLOAD', note: err || 'no file within 60 s' };
  }
  const p = await d.path();
  const bytes = p ? require('fs').readFileSync(p) as Buffer : undefined;
  return { bytes, how: `DOWNLOAD ${d.suggestedFilename()} (${bytes?.length ?? 0} bytes)` };
}
const isPdf = (b?: Buffer) => !!b && b.length > 500 && b.subarray(0, 5).toString() === '%PDF-';

test.describe('NetSuite R2 — screens and reports', () => {
  let api: NsApi;
  test.beforeAll(async ({ playwright }) => { api = new NsApi(await playwright.request.newContext()); });

  test('UI-001: Bills shows the finance sync fields for a SUCCESS and an ERROR invoice', async ({ page, baseURL }) => {
    const ok = loadState('inv208886');
    if (!ok) blocked('needs the ns-01 invoice');
    await open(page, baseURL!, `/customers/${ACC}/bills`);
    const read = async (id: string) => ({
      status: await cell(page, id, 'Finance Sync Status'), ref: await cell(page, id, 'Finance Ref Id'),
      ver: await cell(page, id, 'Finance Version'), err: await cell(page, id, 'Finance Error Message'),
    });
    const s = await read(ok), e = await read(ERROR_INVOICE);
    await page.screenshot({ path: evidence('bills', 'screenshot').replace(/\.txt$/, '.png'), fullPage: true });
    actual(`${ok}: ${JSON.stringify(s)} || ${ERROR_INVOICE}: ${JSON.stringify(e)}`);
    expect.soft(s.status).toBe('SUCCESS');
    expect.soft(s.ref).toMatch(/^\d+$/);
    expect.soft(s.ver).toMatch(/^FA\d+/);
    expect.soft(e.status).toBe('ERROR');
    expect.soft(e.err).toContain('Elementos requeridos faltantes en la solicitud: entity');
    expect([s.err, e.ref, e.ver].join('|').toLowerCase(), 'empty values shown blank, not "null"').not.toContain('null');
  });

  test('UI-002: the Bills Action list offers SYNC_INVOICE only on an ERROR invoice', async ({ page, baseURL }) => {
    const ok = loadState('inv208886');
    if (!ok) blocked('needs the ns-01 invoice');
    await open(page, baseURL!, `/customers/${ACC}/bills`);
    const s = await actionOptions(page, ok), e = await actionOptions(page, ERROR_INVOICE);
    actual(`${ok} (SUCCESS): ${s.join(', ')} || ${ERROR_INVOICE} (ERROR): ${e.join(', ')}`);
    expect.soft(s).not.toContain('SYNC_INVOICE');
    expect(e).toContain('SYNC_INVOICE');
  });

  test('INV-005: an already-synced invoice cannot be sent twice (UI half; replay is dev-side)', async ({ page, baseURL }) => {
    const ok = loadState('inv208886');
    if (!ok) blocked('needs the ns-01 invoice');
    await open(page, baseURL!, `/customers/${ACC}/bills`);
    const s = await actionOptions(page, ok);
    actual(`SUCCESS ${ok} offers: ${s.join(', ')}. Replay of the sync for a SUCCESS invoice needs dev (ENG-007-05)`);
    expect(s).not.toContain('SYNC_INVOICE');
    blocked(`UI half PASS (no SYNC_INVOICE on ${ok}); replay half is dev-side`);
  });

  test('RPT-001/002: the Invoicing report filters by Finance Sync Status and shows the error', async ({ page, baseURL }) => {
    const ok = loadState('inv208886');
    if (!ok) blocked('needs the ns-01 invoice');
    const err = await api.invoiceReportByStatus('ERROR', ACC);
    const suc = await api.invoiceReportByStatus('SUCCESS', ACC);
    const pen = await api.invoiceReportByStatus('PENDING', ACC);
    await open(page, baseURL!, '/report/invoicing');
    const headers = (await page.locator('th').allInnerTexts()).map(h => h.trim());
    const e = err.find(r => r.id === ERROR_INVOICE);
    actual(`ERROR filter: ${err.length} rows (has ${ERROR_INVOICE}: ${!!e}, message "${e?.financeErrorMessage}"; has ${ok}: ${err.some(r => r.id === ok)}); SUCCESS filter: ${suc.length} rows (has ${ok}: ${suc.some(r => r.id === ok)}); PENDING filter: ${pen.length} rows (Bug_012); NetSuite id column on screen: ${headers.some(h => /finance ref|netsuite/i.test(h))}`);
    expect.soft(!!e).toBe(true);
    expect.soft(err.some(r => r.id === ok)).toBe(false);
    expect.soft(suc.some(r => r.id === ok)).toBe(true);
    expect.soft(err.every(r => r.financeSyncStatus === 'ERROR') && suc.every(r => r.financeSyncStatus === 'SUCCESS')).toBe(true);
    expect(headers).toEqual(expect.arrayContaining(['Finance Sync Status', 'Finance Error Message']));
  });

  test('RPT-004: the Invoicing report download keeps the sync columns', async ({ page, baseURL }) => {
    await open(page, baseURL!, '/report/invoicing');
    await page.locator('input[name=accountId]').fill(ACC);
    for (const [n, v] of [['startDate', '2027-09-01'], ['endDate', '2027-09-30']]) {
      await page.locator(`input[name=${n}]`).fill(v).catch(() => {});
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: 'SEARCH' }).click();
    await page.waitForTimeout(8000);
    const dl = page.waitForEvent('download', { timeout: 60_000 }).catch(() => undefined);
    await page.getByRole('button', { name: 'DOWNLOAD' }).click();
    const d = await dl;
    if (!d) blocked('DOWNLOAD produced no file within 60 s (date filters are react-datepicker inputs; may need the calendar)');
    const p = await d!.path();
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const ws = wb.worksheets[0];
    const rows: string[][] = [];
    ws.eachRow((r: any) => rows.push((r.values as any[]).slice(1).map(v => String(v?.text ?? v?.result ?? v ?? '').trim())));
    const hi = rows.findIndex(r => r.some(c => /Finance Sync Status/i.test(c)));
    const header = hi >= 0 ? rows[hi] : rows[0] ?? [];
    const data = hi >= 0 ? rows.slice(hi + 1).filter(r => r.some(Boolean)) : [];
    evidence('invoicing-export-header', header.join(' | '));
    actual(`downloaded ${d!.suggestedFilename()} (${rows.length} rows); header has Finance Sync Status: ${/Finance Sync Status/i.test(header.join('|'))}, Finance Error Message: ${/Finance Error Message/i.test(header.join('|'))}, NetSuite id column: ${header.some(h => /finance ref|netsuite/i.test(h))}; data rows ${data.length}`);
    expect.soft(header.join('|')).toMatch(/Finance Sync Status/i);
    expect(header.join('|')).toMatch(/Finance Error Message/i);
  });

  test('CRN-008: a CUSTOMER_SATISFACTION (non-stamping) credit note has a viewable PDF', async ({ page, baseURL }) => {
    const cn = loadState('once:cn:crn008')?.value?.cnId;
    if (!cn) blocked('needs the ns-03 CRN-008 credit note');
    await open(page, baseURL!, `/customers/${ACC}/credit-notes`);
    const row = page.locator('tr', { has: page.getByText(cn, { exact: true }) }).first();
    if (!(await row.count())) blocked(`credit note ${cn} not listed on the Credit/Debit Notes screen`);
    // The credit-note id is a button; 'Details > View' is only a summary dialog, 'Stamping > View' is disabled when not stamped.
    const r = await capturePdf(page, row.getByRole('button', { name: cn, exact: true }));
    if (r.bytes) evidence(`${cn}-pdf-head`, r.bytes.subarray(0, 200).toString('latin1'));
    await page.screenshot({ path: evidence(`${cn}-view`, 'screenshot').replace(/\.txt$/, '.png') });
    actual(`${cn}: ${r.how}; PDF ${isPdf(r.bytes) ? `OK (${r.bytes!.length} bytes)` : `NOT a PDF${r.note ? ` — ${r.note}` : ''}`}`);
    expect(isPdf(r.bytes), 'EFT-86 / Bug_015').toBe(true);
  });

  test('CRN-014: the credit-note PDF shows the referenced invoice and the credit-note date', async ({ page, baseURL }) => {
    // A STAMPED credit note of this round (CoopeG reason 'NC - Error en facturación'); non-stamped ones have no PDF (CRN-008).
    const parent = loadState('inv208886');
    const cn = (await api.creditNotesOf(ACC)).filter(c => c.folioStatus === 'STAMPED' && c.type === 'CREDIT_NOTE' && String(c.notesDate).startsWith('2027')).map(c => c.id).sort().pop();
    if (!cn || !parent) blocked('needs a stamped credit note from this round on 208886 (ns-03 / ADJ-001)');
    await open(page, baseURL!, `/customers/${ACC}/credit-notes`);
    const row = page.locator('tr', { has: page.getByText(cn, { exact: true }) }).first();
    if (!(await row.count())) blocked(`credit note ${cn} not listed`);
    const r = await capturePdf(page, row.getByRole('button', { name: cn, exact: true }));
    if (!isPdf(r.bytes)) blocked(`no PDF for ${cn}: ${r.how} ${r.note ?? ''}`);
    const text = await extractPdfText(r.bytes!);
    evidence(`${cn}-pdf-text`, text);
    const ref = /Factura Referencia[:\s]*([^\n]*)/i.exec(text)?.[1]?.trim();
    const date = /Fecha Documento[:\s]*([^\n]*)/i.exec(text)?.[1]?.trim();
    recordOnly(`${cn} PDF: Factura Referencia "${ref ?? '(not found)'}" (parent ${parent}); Fecha Documento "${date ?? '(not found)'}" (credit-note date = clock 01/09/2027)`);
  });

  test('REG-004: the synced invoice PDF opens and e-mail still works', async ({ page, baseURL }) => {
    const ok = loadState('inv208886');
    if (!ok) blocked('needs the ns-01 invoice');
    await open(page, baseURL!, `/customers/${ACC}/bills`);
    const row = page.locator('tr', { has: page.getByText(ok, { exact: true }) }).first();
    // The invoice id is a button; 'Details > View' opens the Invoice Details editing dialog, not a PDF.
    const r = await capturePdf(page, row.getByRole('button', { name: ok, exact: true }));
    const text = isPdf(r.bytes) ? await extractPdfText(r.bytes!) : '';
    actual(`${ok}: ${r.how}; PDF ${isPdf(r.bytes) ? 'OK' : `NOT a PDF ${r.note ?? ''}`}; mentions 11,475: ${/11[.,]475/.test(text)}. EMAIL_INVOICE verified in ENG-007-01`);
    expect.soft(isPdf(r.bytes)).toBe(true);
    expect(text).toMatch(/11[.,]475/);
  });

  test('INV-018: undoing a manual invoice that is already in NetSuite (record)', async () => {
    const id = await once('undo208886', () => api.manualInvoice(ACC, [{ itemId: 'I_INT', serviceType: 'INTERNET', description: 'QA-NS-R2 UNDO', quantity: 1, unitPrice: 1000 }]));
    const act = await api.waitForActivity(ACC, id, 'CREATE_INVOICE');
    const before = await api.invoice(id);
    const known = new Set((await api.activities(ACC)).map(a => a.id));
    let err = '';
    try { await api.gql(`mutation($i:UndoInvoiceInput!){ undoInvoice(input:$i) { id } }`, { i: { billUnitid: before.billUnitId ?? (await api.invoicesOf(ACC)).find(x => x.id === id)?.billUnitId } }); }
    catch (e) { err = (e as Error).message; }
    await new Promise(x => setTimeout(x, 15_000));
    const after = await api.invoice(id).catch(() => undefined);
    const fresh = (await api.activities(ACC)).filter(a => !known.has(a.id));
    evidence(`${id}-undo`, { syncedAs: parse(act?.response), before, after, undoError: err, newActivities: fresh.map(a => ({ id: a.id, api: a.apiName, req: parse(a.request), res: parse(a.response) })) });
    recordOnly(`invoice ${id} synced as ${JSON.stringify(parse(act?.response)?.data)}; undo → ${err ? `rejected: ${err}` : `invoice now ${after?.status ?? 'gone'}`}; NetSuite calls after undo: ${fresh.filter(a => /CREDIT|INVOICE|CANCEL|VOID/i.test(a.apiName ?? '')).map(a => `${a.id} ${a.apiName}`).join(', ') || 'none'}${!err && !fresh.some(a => /CREDIT|CANCEL|VOID/i.test(a.apiName ?? '')) ? ' — RISK: undone in Embrix but still open in NetSuite' : ''}`);
  });
});
