/**
 * The monthly invoice as an AGENT sees it — Core UI, not the database.
 *
 * WHY A UI SPEC WHEN ts-01-invoice-bands ALREADY CHECKS THE INVOICE.
 * They check different things and neither replaces the other:
 *
 *   ts-01-invoice-bands  scans ~2,700 invoices over GraphQL in ~45s and answers
 *                       "does the POPULATION obey the tariff rules". It cannot
 *                       see how a figure is rendered.
 *   this spec           opens ONE invoice in the browser and answers "is the
 *                       DOCUMENT an agent reads correct". It cannot scale.
 *
 * The rendering blind spot is not theoretical. The Amount column prints
 * `144.29999999999998` where the Gross column beside it correctly prints
 * `144.30` — Finding 2 of EXPLORE_invoice-document-vs-coreui, found 2026-08-19
 * and still live on 2026-09-11. A GraphQL read returns `144.3` and can never
 * fail on it. Step 4 below is the standing guard for exactly that.
 *
 * EVERY RENDERED FIGURE IS CHECKED AGAINST GRAPHQL, not against a constant, so
 * this spec cannot drift from the source of truth and does not duplicate the
 * tariff arithmetic that lives in the band sweep and the tariff library.
 *
 * READ-ONLY: opens an existing invoice. No clock move, no billing run, no
 * job_schedule slot, no writes. Unlike ts-06-billing-run in this same project it
 * therefore needs no gate and is safe at any time.
 *
 * ONE TEST PER INVOICE, with named steps and SOFT assertions — the UI navigation
 * is ~60s, so splitting the checks into separate tests would pay that cost four
 * times over and tell us less. See feedback_one_scenario_not_many_cases.
 *
 * Tester: Anh Tran (QC)
 */
import { test, expect } from '../../../../fixtures/page-factory';
import { uiNum, uiDecimals, type UiRow } from '../../../../pages/billing-hub/invoice-detail.page';
import { BillingGqlHelper, energiaKwh, lineName, summaryTotal } from '../../../../helpers/billing-gql.helper';

/**
 * Invoices to read. Both were billed by this suite on a private BDOM, so each is
 * a cohort of one and nothing else can change them.
 *
 *   002796  ACT-100857  220 kWh   14,773.79  ICB only, three energy tracts
 *   002797  ACT-100858   25 kWh    1,943.40  the 30 kWh minimum, no tax rows
 *
 * Two invoices, two very different shapes: one exercises the 201+ block break
 * and a tax row, the other the fixed-charge minimum and the ABSENCE of tax.
 */
// The ids below are a CONVENIENCE, not a requirement. They were billed on dev on
// 2026-09-11 and do not exist on any other tenant, so on rebuilt preprod both
// cases skipped on EVERY billing run - two cases lost permanently to a hardcoded
// fixture (observed repeatedly 2026-09-17).
//
// Each case therefore carries the kWh BAND that defines it. If the configured id
// is absent, the subject is re-resolved from this tenant inside the test, which
// preserves the intent exactly: one invoice in 201-280 (ICB, 201+ block break)
// and one sub-30 (fixed-charge minimum, no tax). Same lesson as the terminal-order
// fallback and the tariff-band seeding - a fixture must be re-derivable.
//
// 2026-09-30: the fixed ids are DEV ids and are used on dev only. Every rebuilt
// tenant restarts numbering at 000001, so on preprod/prod "002796" will one day
// EXIST - as some other customer's invoice - and would be tested against
// ACT-100857's expectations. Elsewhere the subject is resolved by band from the
// start (invoiceId '').
type UiInvoiceCase = { invoiceId: string; account: string; note: string; lo: number; hi: number };
const TENANT = (process.env.TEST_ENV ?? '').trim();
const DEV_CASES: UiInvoiceCase[] = [
  { invoiceId: '002796', account: 'ACT-100857', note: '220 kWh, ICB only, 201+ block break', lo: 201, hi: 280 },
  { invoiceId: '002797', account: 'ACT-100858', note: '25 kWh, 30 kWh minimum, no tax', lo: 0, hi: 30 },
];
const CASES: UiInvoiceCase[] =
  process.env.JASEC_DOC_INVOICE
    ? [{
        invoiceId: process.env.JASEC_DOC_INVOICE,
        account: process.env.JASEC_DOC_ACCOUNT ?? '',
        note: 'supplied via JASEC_DOC_INVOICE',
        lo: 0, hi: Number.MAX_SAFE_INTEGER,
      }]
    : TENANT === 'jasec-dev'
      ? DEV_CASES
      : DEV_CASES.map((c) => ({ ...c, invoiceId: '', account: '' }));

const CENT = 0.02;
const num = (v: unknown) => Number(v ?? 0);
const money = (v: number) => v.toFixed(2);

/** Pick the first header present on a row, so a renamed column degrades to a skip. */
const col = (row: UiRow, ...names: string[]): string | null => {
  for (const n of names) if (n in row) return n;
  return null;
};

const gql = new BillingGqlHelper();

for (const c of CASES) {
  test.describe(`Monthly invoice ${c.invoiceId || `${c.lo}-${c.hi} kWh`} in Core UI — ${c.note}`, () => {
    test(`invoice ${c.invoiceId || `${c.lo}-${c.hi} kWh`} renders correctly for an agent @jasec @billing @invoice-document @tc-139`, async ({
      page, invoiceDetailPage,
    }) => {
      test.setTimeout(240_000);

      // ── the source of truth, first ──────────────────────────────────────
      let truth = c.invoiceId ? await gql.getInvoice(c.invoiceId).catch(() => null) : null;
      let subjectId = c.invoiceId;
      if (!truth || !truth.id) {
        // Re-resolve from THIS tenant before giving up (2026-09-17).
        const found = await gql.findInvoicesInBand(c.lo, c.hi, 8, 200, 1).catch(() => []);
        const prepaid = await gql.filterByAccountCategory(found, 'PREPAID').catch(() => []);
        if (prepaid.length) {
          truth = prepaid[0];
          subjectId = String(truth.id);
          console.log(
            `
[ui-invoice] ${c.invoiceId ? `${c.invoiceId} is not on this tenant; using` : 'resolved by band:'} ${subjectId} `
            + `(${c.lo}-${c.hi} kWh band) instead.
`,
          );
        }
      }
      if (!truth || !truth.id) {
        const why =
          `BLOCKED, not failed: ${c.invoiceId ? `invoice ${c.invoiceId} does not exist` : 'no PREPAID invoice'} `
          + `on this tenant in the ${c.lo}-${c.hi} kWh band. `
          + `These two invoices were billed on dev on 2026-09-11 (ACT-100857 BDOM 18, `
          + `ACT-100858 BDOM 19). On a rebuilt tenant, re-seed with `
          + `run-tarif-e2e.ps1 + run-billing-cycle-e2e.ps1 and pass JASEC_DOC_INVOICE / `
          + `JASEC_DOC_ACCOUNT, or point this spec at any prepaid invoice.`;
        console.log(`\n[ui-invoice] ${why}\n`);
        test.skip(true, why);
        return;
      }
      const account = (subjectId === c.invoiceId && c.account) || String(truth.accountId);
      const dbLines = truth.invoiceSummaryList ?? [];
      const dbTaxes = truth.invoiceTaxList ?? [];
      const dbTotals = summaryTotal(truth);
      const year = Number(String(truth.invoiceDate ?? '').slice(0, 4)) || 2026;
      console.log(
        `[ui-invoice] ${subjectId} truth: total=${truth.total} `
        + `lines=${dbLines.length} taxes=${dbTaxes.length} kWh=${energiaKwh(truth)}`,
      );

      let gridRow: UiRow = {};
      await test.step('1. open the invoice from Billing Hub the way an agent would', async () => {
        gridRow = await invoiceDetailPage.open(account, subjectId, year);
        console.log(`[ui-invoice] grid row: ${JSON.stringify(gridRow)}`);
        expect(Object.keys(gridRow).length, 'the grid row was read').toBeGreaterThan(0);
      });

      await test.step('2. the grid row agrees with the record', async () => {
        const totalCol = col(gridRow, 'Total', 'Invoice Total', 'Amount');
        if (!totalCol) {
          console.log(`[ui-invoice] no total column in the grid; headers=${JSON.stringify(Object.keys(gridRow))}`);
        } else {
          expect
            .soft(uiNum(gridRow[totalCol]), `grid ${totalCol} vs record total ${truth.total}`)
            .toBeCloseTo(num(truth.total), 2);
        }
      });

      let uiLines: UiRow[] = [];
      await test.step('3. the charge lines match the record, line for line', async () => {
        uiLines = await invoiceDetailPage.invoiceLines();
        console.log(`[ui-invoice] rendered ${uiLines.length} lines; headers=${JSON.stringify(Object.keys(uiLines[0] ?? {}))}`);
        expect.soft(uiLines.length, 'rendered line count vs the record').toBe(dbLines.length);

        dbLines.forEach((l: any, i: number) => {
          const r = uiLines[i];
          if (!r) return;
          const nameCol = col(r, 'Name');
          const qtyCol = col(r, 'Quantity', 'Qty');
          const amtCol = col(r, 'Amount');
          if (nameCol) {
            expect.soft(r[nameCol], `line ${i + 1} name`).toBe(String(l.name));
          }
          if (qtyCol) {
            expect
              .soft(uiNum(r[qtyCol]), `line ${i + 1} quantity, UI "${r[qtyCol]}"`)
              .toBeCloseTo(num(l.quantity), 2);
          }
          if (amtCol) {
            expect
              .soft(uiNum(r[amtCol]), `line ${i + 1} amount, UI "${r[amtCol]}"`)
              .toBeCloseTo(num(l.amount), 2);
          }
        });
      });

      await test.step('4. REGRESSION GUARD — no money is rendered with more than 2 decimals', async () => {
        /**
         * Finding 2, and the reason this spec exists. A financial document may
         * not print `144.29999999999998`. The offending column is Amount while
         * Gross beside it is correct, so this checks EVERY money-looking column
         * rather than a named one.
         */
        const MONEY_COLS = ['Amount', 'Gross', 'Unit Price', 'Taxable Amount', 'Total', 'Net'];
        const bad: string[] = [];
        for (const r of uiLines) {
          for (const k of Object.keys(r)) {
            if (!MONEY_COLS.includes(k)) continue;
            if (uiDecimals(r[k]) > 2) bad.push(`line "${r['Name'] ?? '?'}" ${k} = "${r[k]}"`);
          }
        }
        bad.forEach((b) => console.log(`[ui-invoice] OVER-PRECISE: ${b}`));
        expect
          .soft(bad, `money rendered with more than 2 decimals (JEPYP finding 2):\n${bad.join('\n')}`)
          .toEqual([]);
      });

      await test.step('5. the JASEC charge lines are the ones on the document', async () => {
        const names = new Set(uiLines.map((r) => lineName(String(r['Name'] ?? ''))));
        for (const required of ['ENERGIA', 'CVG ENERGIA']) {
          expect
            .soft(names.has(required), `"${required}" is on the rendered invoice; saw ${JSON.stringify([...names])}`)
            .toBe(true);
        }
      });

      await test.step('6. the tax table matches the record, including its ABSENCE', async () => {
        const uiTaxes = await invoiceDetailPage.taxLines();
        console.log(`[ui-invoice] rendered ${uiTaxes.length} tax rows; record has ${dbTaxes.length}`);
        console.log(`[ui-invoice] tax rows as rendered: ${JSON.stringify(uiTaxes)}`);
        expect.soft(uiTaxes.length, 'rendered tax-row count vs the record').toBe(dbTaxes.length);

        dbTaxes.forEach((t: any, i: number) => {
          const r = uiTaxes[i];
          if (!r) return;
          const baseCol = col(r, 'Taxable Amount');
          const amtCol = col(r, 'Amount', 'Tax Amount');
          if (baseCol) {
            expect
              .soft(uiNum(r[baseCol]), `tax ${i + 1} base, UI "${r[baseCol]}"`)
              .toBeCloseTo(num(t.taxableAmount), 2);
          }
          if (amtCol) {
            expect
              .soft(uiNum(r[amtCol]), `tax ${i + 1} amount, UI "${r[amtCol]}"`)
              .toBeCloseTo(num(t.amount), 2);
          }
        });
      });

      await test.step('7. the rendered lines add up to the rendered total', async () => {
        /**
         * The reconciliation an agent performs on a dispute: do the numbers on
         * screen agree with each other? Asserted against the RECORD's subtotal so
         * a rendering error in either place is caught.
         */
        const amtCol = uiLines.length ? col(uiLines[0], 'Amount') : null;
        if (!amtCol) {
          console.log('[ui-invoice] no Amount column; line-sum check skipped');
          return;
        }
        const sum = uiLines.reduce((s, r) => s + (uiNum(r[amtCol]) || 0), 0);
        const expected = num(dbTotals?.summarySubTotal);
        console.log(`[ui-invoice] rendered lines sum to ${money(sum)}; record subtotal ${money(expected)}`);
        expect
          .soft(Math.abs(sum - expected) <= CENT, `rendered lines sum ${money(sum)} vs subtotal ${money(expected)}`)
          .toBe(true);
      });

      await test.step('8. DIAGNOSTIC — can the invoice PDF be obtained from the UI?', async () => {
        /**
         * ts-02-invoice-format states that the PDF "is only available as the
         * attachment" on the invoice email, and gets it over IMAP. If a Download
         * or Print control exists here, that claim is wrong and the format
         * assertions could drop their SMTP dependency entirely — currently a live
         * blocker, since SMTP on dev is down.
         *
         * DIAGNOSTIC ONLY: it reports what controls exist and never fails, so a
         * UI without a download is recorded rather than treated as a defect.
         */
        const buttons = await page.locator('[role="dialog"] button').allInnerTexts().catch(() => []);
        const names = buttons.map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
        console.log(`[ui-invoice] dialog buttons: ${JSON.stringify([...new Set(names)])}`);

        /**
         * MATCH ON TEXT, NOT ROLE NAME. `getByRole('button', {name:/download/i})`
         * found NOTHING while `[role="dialog"] button` innerText clearly listed
         * "Download" — the accessible name is not the visible label here. Trust
         * the text.
         */
        const dl = page.locator('[role="dialog"] button')
          .filter({ hasText: /download|print|pdf|descargar|imprimir/i }).first();
        if (!(await dl.count().catch(() => 0))) {
          console.log('[ui-invoice] NO download/print control in the invoice dialog — '
            + 'the IMAP attachment route in ts-02-invoice-format stands.');
          return;
        }
        const wait = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
        await dl.click().catch(() => undefined);
        const download = await wait;
        console.log(download
          ? `[ui-invoice] DOWNLOAD AVAILABLE: "${download.suggestedFilename()}" — `
            + 'ts-02-invoice-format can source the PDF from the UI and drop IMAP.'
          : '[ui-invoice] a download control exists but fired no download in 15s.');
      });

      await invoiceDetailPage.close();
    });
  });
}
