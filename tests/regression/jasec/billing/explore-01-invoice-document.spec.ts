/**
 * EXPLORATORY SPIKE — the invoice as a DOCUMENT, read through Core UI.
 *
 * NOT A TICKETED TEST CASE. There is no EPDP sub-task for billing or invoicing,
 * so this carries no TC number on purpose: it exists to find out whether the
 * area is worth covering, and what it costs. Give it a TC number only when a
 * Jira sub-task exists to match. Deliberately named `explore-` rather than
 * `ts-NN-` so it cannot be mistaken for part of the official suite.
 *
 * JEPYP-230 case 7.3: "PDF matches the system — period, line items, subtotal,
 * total match what Core UI shows." That sentence cannot be verified from the
 * database, because "what Core UI shows" is the other half of the comparison.
 * Existing coverage (embrixPlatform TC-21) opens the Invoice Lines / Tax Lines /
 * Invoice Summary tabs and asserts nothing inside them; this spec reads them.
 *
 * READ-ONLY BY DESIGN.
 *   - No clock move. No billing run. No job_schedule slot. No staging.
 *   - It opens an invoice that ALREADY EXISTS and compares the rendered figures
 *     against core_engine.
 * That is deliberate: the expensive, irreversible half (staging seven accounts
 * and firing one billing schedule to produce invoices for the seven consumption
 * bands of doc TC20-TC26) is a separate case. This one has to be runnable at any
 * time, on any tenant, without asking anyone's permission — otherwise it will
 * not get run.
 *
 * Target selection: BILLING_INVOICE_ID picks one explicitly, otherwise the most
 * structurally complete recent PREPAID invoice is chosen automatically (most tax
 * lines, then most summary lines) and logged, so a run stays reproducible.
 *
 * DATES ARE READ AS TEXT (`to_char`). node-postgres parses a `date` column into a
 * JS Date at LOCAL midnight, so formatting it with toISOString() prints the
 * previous day east of Greenwich. That produced a phantom one-day mismatch
 * against Core UI on the first run of this spec. Never compare a rendered date
 * against a Date object here — compare text to text.
 *
 * Requires: VPN (DB), EMBRIX_USER / EMBRIX_PASSWORD via the `setup` project.
 *
 * Owner: Anh Tran (QC)
 */

import { test, expect } from '../../../../fixtures/page-factory';
// `Page` comes from Playwright, not page-factory: page-factory only AUGMENTS the
// interface (declare module '@playwright/test'), it does not re-export the type.
// Importing it from there resolved to an error type, which made every callback
// parameter below an implicit `any`.
import type { Page } from '@playwright/test';
import type { InvoicePage } from '../../../../pages/billing-hub/Bulk-operations/invoices.page';
import { DbHelper } from '../../../../helpers/db.helper';
import { SHORT_WAIT, MEDIUM_WAIT } from '../../../../helpers/timeouts.helper';

const num = (v: unknown): number => Number(v ?? 0);
const money = (v: number) => v.toFixed(2);

/** Strip currency symbols and thousands separators from a rendered cell. */
const uiNum = (s: string): number => {
  const cleaned = String(s ?? '').replace(/[^\d.\-]/g, (m) => (m === ',' ? '' : ''));
  const withCommas = String(s ?? '').replace(/[^\d.,\-]/g, '').trim();
  const out = Number(withCommas.replace(/,/g, ''));
  return Number.isNaN(out) ? Number(cleaned) : out;
};

/** How many decimal places a rendered figure actually shows. */
const decimals = (s: string): number => {
  const m = String(s ?? '').trim().match(/\.(\d+)$/);
  return m ? m[1].length : 0;
};

interface DbInvoice {
  header: any;
  lines: any[];
  taxes: any[];
  totals: any;
  billUnit: any;
}

let db: DbHelper;
let inv: DbInvoice;
let invoiceId: string;

test.beforeAll(async () => {
  db = new DbHelper();
  await db.connect();   // fails fast if the VPN is down

  invoiceId = process.env.BILLING_INVOICE_ID ?? '';
  if (!invoiceId) {
    const picked = await db.query(`
      SELECT iu.id,
             (SELECT count(*) FROM core_engine.invoice_summary s WHERE s.id = iu.id) lines,
             (SELECT count(*) FROM core_engine.invoice_tax  x WHERE x.id = iu.id) taxes
      FROM core_engine.invoice_unit iu
      JOIN core_engine.account a ON a.id = iu.accountid
      WHERE a.accountcategory = 'PREPAID' AND iu.total <> 0
      ORDER BY taxes DESC, lines DESC, iu.invoicedate DESC
      LIMIT 1`);
    invoiceId = picked[0]?.id;
    console.log(`[EXPLORE] auto-selected invoice ${invoiceId} (${picked[0]?.lines} lines, ${picked[0]?.taxes} tax lines)`);
  } else {
    console.log(`[EXPLORE] invoice ${invoiceId} from BILLING_INVOICE_ID`);
  }
  expect(invoiceId, 'no invoice available to test').toBeTruthy();

  const [header] = await db.query(`
    SELECT iu.id, iu.accountid, iu.billunitid, iu.invoicetype, iu.total, iu.due,
           iu.status, iu.foliostatus, iu.filepath,
           to_char(iu.invoicedate, 'YYYY-MM-DD') invoicedate,
           to_char(iu.duedate,     'YYYY-MM-DD') duedate,
           a.accountcategory, a.accounttype
    FROM core_engine.invoice_unit iu
    LEFT JOIN core_engine.account a ON a.id = iu.accountid
    WHERE iu.id = $1`, [invoiceId]);
  expect(header, `invoice ${invoiceId} not found`).toBeTruthy();

  inv = {
    header,
    lines: await db.query(
      `SELECT index, name, quantity, unitprice, amount, gross, taxcode, invoicesummarytype,
              to_char(appliedstart,'YYYY-MM-DD') appliedstart,
              to_char(appliedend,'YYYY-MM-DD')   appliedend
       FROM core_engine.invoice_summary WHERE id = $1 ORDER BY index`, [invoiceId]),
    taxes: await db.query(
      `SELECT index, taxcode, taxcategory, taxtype, taxrate, taxableamount, exemptamount, amount
       FROM core_engine.invoice_tax WHERE id = $1 ORDER BY index`, [invoiceId]),
    totals: (await db.query(
      `SELECT summarysubtotal, taxsubtotal, total, sofatotal
       FROM core_engine.invoice_summary_total WHERE id = $1`, [invoiceId]))[0],
    billUnit: (await db.query(
      `SELECT id, type, status, total,
              to_char(startdate,'YYYY-MM-DD') startdate,
              to_char(enddate,'YYYY-MM-DD')   enddate
       FROM core_engine.bill_unit WHERE id = $1`, [header.billunitid]))[0],
  };

  console.log(
    `[EXPLORE] ${invoiceId} | account ${inv.header.accountid} (${inv.header.accountcategory}) | ` +
    `total ${money(num(inv.header.total))} | ${inv.lines.length} lines | ${inv.taxes.length} tax lines | ` +
    `invoiced ${inv.header.invoicedate} due ${inv.header.duedate} | ` +
    `period ${inv.billUnit?.startdate}..${inv.billUnit?.enddate}`);
});

test.afterAll(async () => { await db?.disconnect(); });

/**
 * Search Billing Center for the target invoice and return its grid row as a
 * header-name -> cell-text map, with the detail dialog left open.
 *
 * Shared by both tests rather than duplicated: the navigation is ~40s and the
 * selectors are the fragile part, so there should be exactly one copy of them.
 */
async function openInvoice(page: Page, invoicePage: InvoicePage): Promise<Record<string, string>> {
  await page.navigateToHome();
  await invoicePage.navigateViaNav();
  await page.waitForTimeout(SHORT_WAIT);

  /**
   * The grid's startDate / endDate filter the BILL PERIOD, not the invoice date —
   * the columns are literally "Bill Start Date" / "Bill End Date". Searching
   * invoiceDate..invoiceDate returns "No records found" for an invoice that
   * certainly exists, because its period closes before the invoice is dated.
   *
   * The window is deliberately wide: this tenant's CCP clock has been pushed as
   * far as 2027-12, so anything anchored on "today" finds nothing.
   */
  const invYear = Number(inv.header.invoicedate.slice(0, 4));
  const from = `${invYear - 1}-01-01`;
  const to = `${invYear + 1}-12-31`;

  const start = page.locator(`//input[@name='startDate']`).first();
  const end = page.locator(`//input[@name='endDate']`).first();
  if (await start.isVisible().catch(() => false)) {
    await start.fill(from);
    await end.fill(to);
    // Read back what the control ACCEPTED. A date picker that reformats or
    // silently rejects the value is the likeliest cause of an empty grid, and it
    // is invisible unless read back.
    console.log(`[EXPLORE] typed ${from}..${to} -> control holds ` +
      `"${await start.inputValue()}".."${await end.inputValue()}"`);
  }
  await invoicePage.searchBystartDateandEndDateAccount(inv.header.accountid);
  await invoicePage.clickSearchButton();
  await page.waitForTimeout(MEDIUM_WAIT);

  const grid = page.locator('table').first();
  const headers = (await grid.locator('thead th').allInnerTexts()).map((h) => h.trim());
  const rowCount = await page.locator('table tbody tr').count();
  expect(rowCount, `no invoice rows for account ${inv.header.accountid}`).toBeGreaterThan(0);

  const row = page.locator('table tbody tr').filter({ hasText: invoiceId }).first();
  expect(await row.count(), `invoice ${invoiceId} not in the grid for its account`).toBeGreaterThan(0);

  const cells = await row.locator('td').allInnerTexts();
  const map: Record<string, string> = {};
  headers.forEach((h, i) => { map[h] = (cells[i] ?? '').trim(); });

  // td[2]'s View opens the invoice detail; td[1]'s is the stamping popup.
  const viewButtons = row.getByRole('button', { name: /^View$/i });
  const nButtons = await viewButtons.count();
  expect(nButtons, 'no View button on the invoice row').toBeGreaterThan(0);
  await viewButtons.nth(nButtons > 1 ? 1 : 0).click();
  await page.locator('[role="dialog"]').waitFor({ state: 'visible' });
  await page.waitForTimeout(SHORT_WAIT);

  return map;
}

/** Read a dialog table as an array of header-name -> cell-text maps. */
async function readDialogTable(page: Page, index: number): Promise<Record<string, string>[]> {
  const table = page.locator('[role="dialog"] table').nth(index);
  if (!(await table.count())) return [];
  const headers = (await table.locator('thead th').allInnerTexts()).map((h) => h.trim());
  const rows = table.locator('tbody tr');
  const out: Record<string, string>[] = [];
  for (let i = 0; i < await rows.count(); i += 1) {
    const cells = await rows.nth(i).locator('td').allInnerTexts();
    const m: Record<string, string> = {};
    headers.forEach((h, j) => { m[h] = (cells[j] ?? '').trim(); });
    out.push(m);
  }
  return out;
}

test.describe('EXPLORE — invoice document in Core UI', () => {
  /**
   * Diagnostics, kept permanently.
   *
   * The dialog's DOM is documented nowhere and TC-135 addresses it only by button
   * name. This prints what is actually rendered and attaches it to the report, so
   * when the UI is restyled THIS is the test that tells you how, instead of five
   * assertions failing with no context.
   */
  test('discovery — dump the invoice detail dialog as rendered', async ({ page, invoicePage }) => {
    test.setTimeout(240_000);
    const gridRow = await openInvoice(page, invoicePage);

    console.log('\n[EXPLORE] ===== grid row =====');
    Object.entries(gridRow).filter(([, v]) => v !== '')
      .forEach(([k, v]) => console.log(`  ${k.padEnd(24)} "${v}"`));
    test.info().annotations.push({
      type: 'grid-row',
      description: Object.entries(gridRow).filter(([, v]) => v !== '')
        .map(([k, v]) => `${k} = ${v}`).join('\n'),
    });

    const dialog = page.locator('[role="dialog"]');
    for (const tab of ['Invoice Summary', 'Invoice Lines', 'Tax Lines']) {
      const btn = page.getByRole('button', { name: tab });
      if (!(await btn.count())) { console.log(`[EXPLORE] tab "${tab}" NOT PRESENT`); continue; }
      await btn.first().click();
      await page.waitForTimeout(SHORT_WAIT);
      const nTables = await dialog.locator('table').count();
      let dump = '';
      for (let i = 0; i < nTables; i += 1) {
        const rows = await readDialogTable(page, i);
        dump += `--- table ${i} (${rows.length} rows) ---\n`
          + rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      }
      console.log(`\n[EXPLORE] ===== tab: ${tab} =====\n${dump}`);
      test.info().annotations.push({ type: `tab-${tab.replace(/\s+/g, '-').toLowerCase()}`, description: dump.slice(0, 4000) });
    }

    await page.screenshot({ path: `test-results/explore-invoice-${invoiceId}.png`, fullPage: true });
  });

  /**
   * Case 7.3 proper — every figure Core UI renders must match core_engine.
   *
   * Soft assertions throughout: the point of the case is a complete picture of
   * what does and does not line up in one run. A hard failure on the first
   * mismatch would hide the rest, and this is a reporting case as much as a
   * gating one.
   */
  test('rendered figures match core_engine (JEPYP-230 report case 7.3)', async ({ page, invoicePage }) => {
    test.setTimeout(240_000);
    const g = await openInvoice(page, invoicePage);

    // ── header: the four numbers and two dates an agent reads off the grid ──
    expect.soft(uiNum(g['Invoice Total']), `Invoice Total: UI "${g['Invoice Total']}"`)
      .toBeCloseTo(num(inv.header.total), 2);
    expect.soft(uiNum(g['Invoice Summary Total']), `Invoice Summary Total: UI "${g['Invoice Summary Total']}"`)
      .toBeCloseTo(num(inv.totals.summarysubtotal), 2);
    expect.soft(g['Invoice Date'], 'Invoice Date').toBe(inv.header.invoicedate);
    expect.soft(g['Due Date'], 'Due Date').toBe(inv.header.duedate);
    expect.soft(g['Bill Start Date'], 'Bill Start Date vs bill_unit.startdate').toBe(inv.billUnit.startdate);

    /**
     * Bill End Date: the UI renders the period end INCLUSIVE, the database stores
     * it EXCLUSIVE. bill_unit.enddate = 2026-09-01 renders as 2026-08-31.
     *
     * Asserting equality would fail forever on a presentation convention, so the
     * check accepts either and records which one is in force — because the choice
     * is not cosmetic: it decides whether "Dias facturados" on the invoice reads
     * 31 or 32, and that figure is on the fiscal document.
     */
    const dbEnd = inv.billUnit.enddate;
    const dbEndMinus1 = new Date(new Date(`${dbEnd}T00:00:00Z`).getTime() - 86400000)
      .toISOString().slice(0, 10);
    const endConvention = g['Bill End Date'] === dbEnd ? 'exclusive (matches DB)'
      : g['Bill End Date'] === dbEndMinus1 ? 'inclusive (DB end minus one day)'
        : 'NEITHER';
    console.log(`[EXPLORE] Bill End Date: UI "${g['Bill End Date']}" vs DB ${dbEnd} -> ${endConvention}`);
    test.info().annotations.push({
      type: 'period-end-convention',
      description: `UI "${g['Bill End Date']}", bill_unit.enddate ${dbEnd} -> ${endConvention}. `
        + `Period length is ${endConvention.startsWith('inclusive') ? 'one day shorter' : 'as stored'} `
        + `when read off the UI, which is what "Dias facturados" has to agree with.`,
    });
    expect.soft(g['Bill End Date'],
      `Bill End Date "${g['Bill End Date']}" is neither bill_unit.enddate (${dbEnd}) nor its inclusive form (${dbEndMinus1})`)
      .toMatch(new RegExp(`^(${dbEnd}|${dbEndMinus1})$`));

    /**
     * The grid splits tax into "Additional Tax" (ICB / BOM) and "Main Tax"
     * (IVA), so each should carry its own category's amount — not the sum.
     */
    const icb = inv.taxes.filter((t) => t.taxcategory === 'BOM')
      .reduce((s, t) => s + num(t.amount), 0);
    const iva = inv.taxes.filter((t) => t.taxcategory === 'IVA')
      .reduce((s, t) => s + num(t.amount), 0);
    console.log(`[EXPLORE] DB tax split: ICB(BOM)=${money(icb)} IVA=${money(iva)} ` +
      `| UI Additional="${g['Additional Tax Amount']}" Main="${g['Main Tax Amount']}" ` +
      `| UI rates Additional="${g['Additional Tax Rate']}" Main="${g['Main Tax Rate']}"`);
    if (icb > 0) {
      expect.soft(uiNum(g['Additional Tax Amount']),
        `Additional Tax Amount should be the ICB/BOM amount ${money(icb)}, UI shows "${g['Additional Tax Amount']}"`)
        .toBeCloseTo(icb, 2);
    }
    expect.soft(uiNum(g['Main Tax Amount']),
      `Main Tax Amount should be the IVA amount ${money(iva)}, UI shows "${g['Main Tax Amount']}"`)
      .toBeCloseTo(iva, 2);

    // ── tax lines: the dialog's own tax table ──
    await page.getByRole('button', { name: 'Tax Lines' }).first().click();
    await page.waitForTimeout(SHORT_WAIT);
    const dialogTables = await page.locator('[role="dialog"] table').count();
    let uiTax: Record<string, string>[] = [];
    for (let i = 0; i < dialogTables; i += 1) {
      const rows = await readDialogTable(page, i);
      if (rows.length && 'Taxable Amount' in rows[0]) { uiTax = rows; break; }
    }
    expect.soft(uiTax.length, 'tax-line count in the dialog').toBe(inv.taxes.length);
    inv.taxes.forEach((t, i) => {
      const r = uiTax[i];
      if (!r) return;
      expect.soft(uiNum(r['Taxable Amount']),
        `tax ${i + 1} (${t.taxcategory}) taxable base: UI "${r['Taxable Amount']}"`)
        .toBeCloseTo(num(t.taxableamount), 2);
      expect.soft(uiNum(r['Amount']), `tax ${i + 1} (${t.taxcategory}) amount: UI "${r['Amount']}"`)
        .toBeCloseTo(num(t.amount), 2);
    });

    /**
     * The reconciliation an agent actually has to perform on a dispute: does the
     * tax base shown equal the sum of the taxable lines shown? On invoice 000187
     * it does not (6,211.00 vs 8,438.80) and both figures are on screen.
     */
    const taxableLineSum = inv.lines
      .filter((l) => l.taxcode && l.taxcode !== 'NA')
      .reduce((s, l) => s + num(l.amount), 0);
    inv.taxes.forEach((t) => {
      const base = num(t.taxableamount);
      const reconcilable = Math.abs(base - taxableLineSum) <= 0.01;
      console.log(`[EXPLORE] ${t.taxcategory} base ${money(base)} vs taxable lines ${money(taxableLineSum)} ` +
        `-> ${reconcilable ? 'reconciles' : `DOES NOT reconcile (delta ${money(base - taxableLineSum)})`}`);
    });
    test.info().annotations.push({
      type: 'tax-reconciliation',
      description: `taxable lines sum to ${money(taxableLineSum)}; bases: `
        + inv.taxes.map((t) => `${t.taxcategory}=${money(num(t.taxableamount))}`).join(', '),
    });

    // ── lines: the printed document body ──
    await page.getByRole('button', { name: 'Invoice Summary' }).first().click();
    await page.waitForTimeout(SHORT_WAIT);
    /**
     * Two tables in this tab carry Name + Amount headers: the EDITABLE line grid,
     * whose cells are <input> elements (so innerText is empty), and the read-only
     * summary table. Matching on headers alone picks the editable one and every
     * name assertion then compares against "". Require a non-empty Name in the
     * first row so the read-only table is the one selected.
     */
    let uiLines: Record<string, string>[] = [];
    for (let i = 0; i < await page.locator('[role="dialog"] table').count(); i += 1) {
      const rows = await readDialogTable(page, i);
      if (rows.length && 'Name' in rows[0] && 'Amount' in rows[0] && rows[0]['Name']) {
        uiLines = rows;
        console.log(`[EXPLORE] read ${rows.length} rendered lines from dialog table ${i}`);
        break;
      }
    }
    expect.soft(uiLines.length, 'line count in the dialog').toBe(inv.lines.length);
    inv.lines.forEach((l, i) => {
      const r = uiLines[i];
      if (!r) return;
      expect.soft(r['Name'], `line ${l.index} name`).toBe(l.name);
      expect.soft(uiNum(r['Quantity']), `line ${l.index} quantity: UI "${r['Quantity']}"`)
        .toBeCloseTo(num(l.quantity), 2);
      expect.soft(uiNum(r['Amount']), `line ${l.index} amount: UI "${r['Amount']}"`)
        .toBeCloseTo(num(l.amount), 2);
    });

    /**
     * Money must never render with more than 2 decimal places.
     *
     * Not pedantry: the Invoice Lines tab renders the Amount column straight from
     * a JS number, so 144.3 arrives as "144.29999999999998". Any figure with >2
     * decimals on a financial document is wrong regardless of its value.
     */
    const overPrecise: string[] = [];
    for (let i = 0; i < await page.locator('[role="dialog"] table').count(); i += 1) {
      for (const row of await readDialogTable(page, i)) {
        for (const [col, val] of Object.entries(row)) {
          if (/amount|price|total|gross|discount/i.test(col) && decimals(val) > 2) {
            overPrecise.push(`table ${i} "${col}" = "${val}"`);
          }
        }
      }
    }
    overPrecise.forEach((o) => console.log(`[EXPLORE] over-precise: ${o}`));
    expect.soft(overPrecise,
      `money rendered with more than 2 decimals: ${overPrecise.join('; ')}`).toEqual([]);
  });
});
