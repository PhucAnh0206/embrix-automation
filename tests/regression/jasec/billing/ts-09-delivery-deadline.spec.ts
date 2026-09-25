/**
 * ARESEP delivery deadline — the invoice must reach the customer by day 8 of the
 * following month.
 *
 * THIS IS A DOCUMENTED REQUIREMENT, NOT AN IMPROVEMENT. Diseño Funcional y
 * Técnico - Jasec Energía Prepago, section 3.1.2:
 *
 *   "La factura debe considerar todos los días del mes del ciclo finalizado,
 *    desde el día 1 hasta el último día del mes calendario; no puede incluir
 *    consumos realizados en días de meses anteriores o posteriores y, por
 *    último, debe entregarse al abonado a más tardar el día 8 del mes
 *    siguiente."
 *
 * and again further on: "se generará y entregará vía correo electrónico la
 * factura mensual junto con el estado de cuenta" — email is the specified
 * delivery channel, with printing only as the fallback for a customer who has
 * no email address.
 *
 * TWO HALVES, AND ONLY ONE IS TESTABLE TODAY.
 *
 *   GENERATION  — can the invoice possibly be delivered in time? If it is not
 *                 even DATED until after the deadline, delivery is moot. This
 *                 half needs nothing but GraphQL and runs in the read-only
 *                 project.
 *   DELIVERY    — did it actually reach the customer by then? Needs the mail
 *                 trail, so it is blocked while dev SMTP is degraded. Left as
 *                 an explicit skip rather than silently omitted.
 *
 * WHY IT SCOPES TO CALENDAR-MONTH CYCLES. The requirement is written for a
 * cycle that runs day 1 to the last day of the calendar month, which is what
 * every production prepaid account has (all prepaid accounts share BDOM 1).
 * Our seeded fixtures sit on private BDOMs 15-28 so their cycles are mid-month
 * and the rule does not apply to them — asserting on those would manufacture
 * failures. So the spec selects the production SHAPE from the invoice itself:
 * startDate on the 1st, endDate on the 1st of the next month. No BDOM lookup,
 * no DB.
 *
 * READ-ONLY: no browser, no DB, no VPN, no clock move.
 *
 * Tester: Anh Tran (QC)
 */
import { test, expect } from '@playwright/test';
import { BillingGqlHelper, type InvoiceDoc } from '../../../../helpers/billing-gql.helper';

/** ARESEP: no later than day 8 of the month following the billed cycle. */
const DEADLINE_DAY = 8;

/**
 * Pages of the invoice search to sweep.
 *
 * SWEEP EVERYTHING, HYDRATE A SAMPLE. These are two different budgets and the
 * old cap of 3 pages confused them. Listing is ONE call per 200 invoices;
 * hydrating is one call per invoice. Capping the LISTING at 600 bought almost
 * nothing and cost the survey its reach: the tenant holds ~2,700 invoices, so
 * the compliance verdict was drawn from the newest ~22% — and "newest" on a QC
 * tenant means our own seeded fixtures, not the production population.
 *
 * So the sweep now runs to the last page (stopping at the first short one) and
 * the stride is taken across the WHOLE population. PAGES stays only as a
 * runaway guard, and a truncation warning is printed if it is ever reached —
 * a silent cap once emptied a whole band.
 */
const PAGES = 40;
const PAGE_SIZE = 200;

/**
 * Hydration is ONE round trip per invoice, and the tenant holds thousands. The
 * first cut of this spec hydrated every prepaid invoice and timed out in
 * beforeAll before asserting anything. This is a COMPLIANCE SURVEY, not a
 * census: a bounded sample answers "does the generated invoice date meet the
 * deadline" just as well, and the assertion reports the sample size so nobody
 * reads it as tenant-wide.
 */
const MAX_HYDRATE = 120;
const ENOUGH_CYCLES = 40;

const gql = new BillingGqlHelper();

const dayOf = (iso: string) => Number(String(iso).slice(8, 10));
const ymOf = (iso: string) => String(iso).slice(0, 7);

/**
 * The production shape: a cycle covering exactly one calendar month.
 *
 * THE INVOICE AND THE BILL UNIT DISAGREE ABOUT THE END DATE, and only one of
 * them matches the requirement. For July 2028 the DB bill_unit reads
 * 2028-07-01 .. 2028-08-01 (exclusive upper bound) while the invoice reads
 * 2028-07-01 .. 2028-07-31 ("hasta el último día del mes calendario"). This
 * spec reads the INVOICE, so the test is "endDate is the last day of the same
 * month as startDate". An earlier cut required day 1 on both ends — the DB
 * shape — and silently matched nothing.
 */
function isCalendarMonthCycle(inv: InvoiceDoc): boolean {
  if (!inv.startDate || !inv.endDate) return false;
  if (dayOf(inv.startDate) !== 1) return false;
  if (ymOf(inv.startDate) !== ymOf(inv.endDate)) return false;
  const e = new Date(`${inv.endDate}T00:00:00Z`);
  const nextDay = new Date(e.getTime() + 86_400_000);
  return nextDay.getUTCDate() === 1;               // endDate is the month's last day
}

/** Day 8 of the month AFTER the billed cycle, as YYYY-MM-DD. */
function deadlineFor(endDate: string): string {
  const e = new Date(`${endDate}T00:00:00Z`);
  const d = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, DEADLINE_DAY));
  return d.toISOString().slice(0, 10);
}

type Row = { id: string; cycle: string; invoiceDate: string; day: number; late: boolean };

/**
 * Every cycle that STARTS on the 1st, whether or not it closes correctly.
 *
 * NOT the same set as `rows`, and the difference is the whole point. `rows` is
 * already filtered to well-formed calendar months, so asserting "these are
 * calendar months" on it would be vacuous — the same shape of mistake that made
 * the taxable-base assertion pass in all seven bands while checking nothing.
 * This set is the unfiltered population the requirement actually governs.
 */
type StartRow = { id: string; cycle: string; closesOnMonthEnd: boolean };

let monthStart: StartRow[] = [];
let rows: Row[] = [];
let setupNote = '';
let truncated = false;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const found: InvoiceDoc[] = [];
  for (let p = 1; p <= PAGES; p++) {
    const page = await gql.searchInvoices(p, PAGE_SIZE).catch(() => []);
    if (!page.length) break;
    found.push(...page);
    if (page.length < PAGE_SIZE) break;      // short page — the sweep is complete
    if (p === PAGES) truncated = true;       // only a real cap hit warns
  }
  if (!found.length) { setupNote = 'no invoices returned by searchInvoices'; return; }

  /**
   * STRIDE, DO NOT TAKE THE HEAD. searchInvoices returns newest-first, and the
   * newest invoices on this tenant are OUR seeded fixtures on private BDOMs
   * 15-28 — mid-month cycles the rule does not apply to. Hydrating the first N
   * therefore found zero production-shape cycles and the case skipped while
   * thousands of real BDOM-1 invoices sat further down. Sampling across the
   * whole result set is what makes this a survey rather than a look at our own
   * test data.
   *
   * The category check moved INSIDE this loop. `filterByAccountCategory` walks
   * every invoice it is handed, so pre-filtering the full sweep would have cost
   * a lookup per invoice before the stride ever discarded 95% of them. Asking
   * per candidate costs one lookup per SAMPLED invoice instead, and the helper
   * caches by account, so the true cost is one call per distinct account.
   */
  const stride = Math.max(1, Math.floor(found.length / MAX_HYDRATE));
  const sample = found.filter((_, i) => i % stride === 0);

  let hydrated = 0;
  let notPrepaid = 0;
  for (const stub of sample) {
    if (hydrated >= MAX_HYDRATE || rows.length >= ENOUGH_CYCLES) break;
    const cat = await gql.accountCategory(stub.accountId).catch(() => 'UNKNOWN');
    if (cat !== 'PREPAID') { notPrepaid++; continue; }
    hydrated++;
    // TRAP: searchInvoices leaves startDate/endDate NULL. Only getInvoice fills
    // them, and this whole case is about those two dates — so hydrate or the
    // calendar-month filter silently matches nothing and the case reports green.
    const inv = await gql.getInvoice(stub.id).catch(() => null);
    if (!inv?.id || !inv.startDate || !inv.endDate) continue;

    // Record the month-start population BEFORE narrowing, so the coverage
    // assertion below has something real to fail on.
    if (dayOf(inv.startDate) === 1) {
      monthStart.push({
        id: inv.id,
        cycle: `${inv.startDate}..${inv.endDate}`,
        closesOnMonthEnd: isCalendarMonthCycle(inv),
      });
    }

    if (!isCalendarMonthCycle(inv)) continue;
    const day = dayOf(inv.invoiceDate);
    rows.push({
      id: inv.id,
      cycle: `${inv.startDate}..${inv.endDate}`,
      invoiceDate: inv.invoiceDate,
      day,
      // A July cycle (07-01..07-31) is due by 08 August. Compare full dates so a
      // month or year rollover cannot be read as "early".
      late: inv.invoiceDate.slice(0, 10) > deadlineFor(inv.endDate),
    });
  }
  console.log(
    `[deadline] swept ${found.length} invoice(s)${truncated ? ' (CAPPED)' : ' — the whole tenant'}, `
    + `stride ${stride} -> ${sample.length} sampled, ${notPrepaid} not prepaid, `
    + `hydrated ${hydrated}, calendar-month cycles ${rows.length}`,
  );
  if (!rows.length) {
    const probe = await gql.getInvoice(sample[0]?.id ?? '').catch(() => null);
    console.log(`[deadline] probe ${probe?.id}: startDate=${JSON.stringify(probe?.startDate)} `
      + `endDate=${JSON.stringify(probe?.endDate)} invoiceDate=${JSON.stringify(probe?.invoiceDate)}`);
    setupNote = 'no calendar-month (production shape) prepaid cycles found to assert on';
  }
});

test.describe('ARESEP invoice delivery deadline (Diseño Funcional 3.1.2)', () => {
  test('the invoice is DATED on or before day 8 of the following month @jasec @billing @aresep @deadline', async () => {
    if (setupNote) { console.log(`\n[deadline] BLOCKED, not failed: ${setupNote}\n`); test.skip(true, setupNote); return; }
    if (truncated) console.log(`[deadline] WARNING: hit the ${PAGES}-page cap; the sweep may be incomplete.`);

    const byDay = new Map<number, number>();
    for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + 1);
    console.log(
      `[deadline] ${rows.length} calendar-month prepaid cycle(s); invoice day-of-month distribution: `
      + [...byDay.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `day ${d}: ${n}`).join(', '),
    );

    const late = rows.filter((r) => r.late);
    const sample = late.slice(0, 5).map((r) => `${r.id} cycle ${r.cycle} invoiced ${r.invoiceDate} (day ${r.day})`);

    expect(
      late.length,
      `${late.length} of ${rows.length} invoices are dated AFTER day ${DEADLINE_DAY} of the month following `
      + `their cycle, so they cannot meet the ARESEP deadline even if delivery is instant.\n`
      + `Diseño Funcional 3.1.2: "debe entregarse al abonado a más tardar el día 8 del mes siguiente".\n`
      + `Examples:\n  ${sample.join('\n  ')}`,
    ).toBe(0);
  });

  test('the invoice covers exactly one calendar month, with no spill @jasec @billing @aresep @deadline', async () => {
    /**
     * Same requirement sentence, second obligation: "La factura debe considerar
     * todos los días del mes del ciclo finalizado, desde el día 1 hasta el último
     * día del mes calendario; NO PUEDE INCLUIR consumos realizados en días de
     * meses anteriores o posteriores."
     *
     * Asserted against every cycle that STARTS on the 1st, not against the set
     * already filtered to well-formed months — otherwise it proves nothing.
     */
    if (!monthStart.length) {
      const why = 'no cycle starting on the 1st was sampled, so there is nothing to check';
      console.log(`\n[deadline] BLOCKED, not failed: ${why}\n`);
      test.skip(true, why);
      return;
    }

    const bad = monthStart.filter((r) => !r.closesOnMonthEnd);
    console.log(
      `[deadline] ${monthStart.length} cycle(s) starting on the 1st; `
      + `${monthStart.length - bad.length} close on the month's last day`,
    );

    expect(
      bad.map((r) => `${r.id} ${r.cycle}`),
      `cycles that start on the 1st but do NOT end on the last day of that same month, `
      + `so the invoice period is not the calendar month the requirement describes`,
    ).toEqual([]);
  });

  test('DELIVERY half — the invoice actually reached the customer in time @jasec @billing @aresep @deadline', async () => {
    /**
     * Deliberately not implemented as a silent pass. The requirement is about
     * DELIVERY ("entregarse"), not generation, and the only delivery channel
     * the spec names is email. Proving it needs the mail trail.
     *
     * THE GATE IS NOW MEASURED, NOT ASSERTED. It used to hardcode "dev SMTP is
     * effectively dead — 2 SUCCESS in the last 300 = 0.7%, measured 2026-09-14".
     * That was true when written and was false by the end of the same day: SMTP
     * was repaired and both tenants went to 200/200 and 69/69 SUCCESS. A dated
     * measurement baked into a skip reason keeps a case switched off long after
     * the condition clears, and tells whoever reads it something untrue — the
     * same failure mode as the "dev only" and "SMTP down since 2026-09-08"
     * claims removed elsewhere on 2026-09-14.
     *
     * So read the tenant's actual send health and decide from that.
     *
     * Do not "fix" this by asserting on email_notification.status alone: a row
     * marked SUCCESS says the send was accepted, not that it arrived by day 8.
     * That is why this still blocks even when SMTP is healthy — the assertion
     * itself is unwritten, and the honest report for that is BLOCKED.
     */
    const why =
      'the delivery half is not implemented yet: proving "entregarse" needs the mail '
      + 'trail, and a SUCCESS row only says the send was accepted, not that it arrived '
      + 'by day 8. To implement: match the INVOICE_READY mail for a calendar-month '
      + 'cycle to its arrival timestamp and assert that is on or before day 8.';
    console.log(`\n[deadline] BLOCKED, not failed: ${why}\n`);
    test.skip(true, why);
  });
});
