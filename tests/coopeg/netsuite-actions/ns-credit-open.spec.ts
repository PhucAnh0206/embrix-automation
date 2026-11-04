/**
 * EFT-110 (credit notes, open issue definition): what is left of the client's credit-note tickets, read only.
 *   EFT110-HIST-PDF  EFT-86: the three credit notes of contract 244819 created before the fix (CR-105073/079/088): does their PDF open now?
 *   EFT110-REF       EFT-93 side note: is "Factura Referencia" filled on a stamped credit-note PDF? (empty on CR-105106 in the ticket)
 * Opens the documents the way an agent does (Credit/Debit Notes > credit note > DOWNLOAD); creates nothing.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; npx playwright test --project=dev tests/coopeg/netsuite-actions/ns-credit-open.spec.ts --reporter=line
 */
import { test, Page, Locator } from '@playwright/test';
import * as fs from 'fs';
import { rowAcrossPages } from '../../../helpers/netsuite/ns-ui.helper';
import { extractPdfText } from '../../../helpers/pdf.helper';
import { db, goto, record, Shots } from '../tickets/eft-106/eft-lib';

const HISTORICAL = (process.env.NS_CN_HIST ?? 'CR-105073,CR-105079,CR-105088').split(',');
const STAMPED = (process.env.NS_CN_REF ?? 'CR-105106,CR-105179').split(',');

/** Same as ns-05: the credit-note id opens the viewer; DOWNLOAD saves the file an agent gets. */
async function capturePdf(page: Page, trigger: Locator): Promise<{ bytes?: Buffer; how: string; note?: string }> {
  await trigger.click();
  const btn = page.getByRole('button', { name: /^download$/i });
  await btn.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  if (!(await btn.isVisible())) return { how: 'viewer', note: 'no DOWNLOAD button on the viewer page' };
  const dl = page.waitForEvent('download', { timeout: 60_000 }).catch(() => undefined);
  await btn.click();
  const d = await dl;
  if (!d) return { how: 'DOWNLOAD', note: (await page.getByText(/Failed to load PDF document/i).first().innerText().catch(() => '')) || 'no file within 60 s' };
  const p = await d.path();
  const bytes = p ? fs.readFileSync(p) : undefined;
  return { bytes, how: `DOWNLOAD (${bytes?.length ?? 0} bytes)` };
}
const isPdf = (b?: Buffer) => !!b && b.length > 500 && b.subarray(0, 5).toString() === '%PDF-';

async function open(page: Page, shots: Shots, id: string) {
  const [n] = await db(`select accountid, foliostatus, financesyncstatus, financeversion, reasondescription reason, notesdate from core_engine.notes_unit where id = $1`, [id]).catch(() => []);
  if (!n) return { id, note: 'not found' };
  await goto(page, `/customers/${n.accountid}/credit-notes`);
  await page.locator('tbody tr', { hasText: 'CR-' }).first().waitFor({ timeout: 60_000 }).catch(() => { });
  await page.waitForTimeout(1500);
  const row = await rowAcrossPages(page, id);
  if (!(await row.count())) return { id, ...n, note: 'not listed on Credit/Debit Notes' };
  await shots.take(`${id}-row`);
  const r = await capturePdf(page, row.getByRole('button', { name: id, exact: true }));
  await shots.take(`${id}-viewer`);
  return { id, ...n, pdf: isPdf(r.bytes), how: r.how, note: r.note, bytes: r.bytes };
}

test.use({ viewport: { width: 1800, height: 1000 } });

test('EFT110-HIST-PDF: the credit notes of 244819 created before the fix', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const shots = new Shots(page, 'EFT110-HIST-PDF');
  const out = [];
  for (const id of HISTORICAL) out.push(await open(page, shots, id));
  const ok = out.filter(o => o.pdf).length;
  record('EFT110-HIST-PDF', ok === out.length ? 'Pass' : 'Fail',
    out.map(o => `${o.id} (${o.accountid ?? '?'}, reason ${o.reason ?? '?'}, stamp ${o.foliostatus ?? 'none'}, NetSuite ${o.financesyncstatus ?? '?'} ${o.financeversion ?? ''}): ${o.pdf ? 'PDF opens' : `no PDF – ${o.note ?? o.how}`}`).join(' | '),
    { notes: out.map(({ bytes, ...o }) => o), screenshots: shots.files });
});

test('EFT110-REF: "Factura Referencia" on stamped credit-note PDFs', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const shots = new Shots(page, 'EFT110-REF');
  const out = [];
  for (const id of STAMPED) {
    const o: any = await open(page, shots, id);
    if (o.pdf) {
      const text = await extractPdfText(o.bytes);
      o.ref = /Factura Referencia[:\s]*([^\n]*)/i.exec(text)?.[1]?.trim() ?? '(label not found)';
      const [p] = await db(`select invoiceid referenceid from core_engine.notes_unit where id = $1`, [id]).catch(() => [{}]);
      o.parent = p?.referenceid;
    }
    delete o.bytes;
    out.push(o);
  }
  record('EFT110-REF', 'Recorded',
    out.map(o => `${o.id} (${o.accountid ?? '?'}, stamp ${o.foliostatus ?? 'none'}): ${o.pdf ? `Factura Referencia "${o.ref}"${o.parent ? ` (invoice ${o.parent})` : ''}` : `no PDF – ${o.note ?? o.how}`}`).join(' | '),
    { notes: out, screenshots: shots.files });
});
