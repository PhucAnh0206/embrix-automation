/**
 * Two consecutive billed cycles on ONE prepaid account — the ledger chain, and
 * the included-kWh allowance across the cycle boundary.
 *
 * WHY THESE TWO LIVE TOGETHER. They need the same expensive precondition — an
 * account that has been rated AND billed twice in a row — and nothing else in
 * the suite produces one. They stay SEPARATE TESTS because they assert different
 * things: one is ledger arithmetic, the other is the allowance reset. Merged, a
 * red result would not say which broke.
 *
 * SELF-SEEDING. The account is produced by
 * `_scripts/billing/seed-two-cycle-account.ps1`, which provisions on a free
 * BDOM, then rates and bills two cycles. Pass the result in
 * `JASEC_TWO_CYCLE_ACCOUNT`. With no account given the spec SKIPS with the exact
 * command printed, never fails — an absent precondition is BLOCKED, not a defect.
 *
 * WHY NOT SAMPLE EXISTING ACCOUNTS. The predecessor
 * (`ts-04-account-statement`) picks 8 accounts off the tenant and skips
 * any with back-dated ledger rows. On 2026-09-11 that was 5 of 8, so it reported
 * on 3 — and WE caused the contamination: billing on a rewound CCP clock on
 * 2026-08-23 inserted invoices dated earlier than rows that already existed.
 * A case whose result depends on tenant history is not a regression case. This
 * one brings its own account, so it cannot be starved or poisoned.
 *
 * READ-ONLY once seeded: no clock move, no billing run, no job slot, no browser.
 *
 * Tester: Anh Tran (QC)
 */
import { test, expect } from '@playwright/test';
import { BillingGqlHelper, energiaKwh, lineName, summaryTotal, type InvoiceDoc } from '../../../../helpers/billing-gql.helper';

/** Account with two consecutive BILLED cycles. */
const ACCOUNT = process.env.JASEC_TWO_CYCLE_ACCOUNT ?? '';

/** JASEC includes the first 30 kWh in the monthly fixed charge. */
const MIN_BILLED_KWH = 30;
const CENT = 0.02;

const num = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number, tol = CENT) => Math.abs(a - b) <= tol;
/** Ledger ids are zero-padded and issued in creation order. */
const idNum = (s: unknown) => Number(String(s ?? '').replace(/\D/g, '')) || 0;

const HOW_TO_SEED =
  'Seed one with:  .\\_scripts\\billing\\seed-two-cycle-account.ps1 -Bdom <free>  '
  + 'then re-run with JASEC_TWO_CYCLE_ACCOUNT=<accountId>. '
  + 'Free BDOMs: query core_engine.billing_profile for unused values 1-28.';

const gql = new BillingGqlHelper();

type Cycle = { inv: InvoiceDoc; billedKwh: number; cycleKwh: number | null };

let cycles: Cycle[] = [];
let statement: Awaited<ReturnType<BillingGqlHelper['getAccountStatement']>> = [];
let setupNote = '';

test.beforeAll(async () => {
  if (!ACCOUNT) { setupNote = `no account given. ${HOW_TO_SEED}`; return; }

  statement = await gql.getAccountStatement(ACCOUNT).catch(() => []);
  if (!statement.length) { setupNote = `account ${ACCOUNT} has no ledger lines. ${HOW_TO_SEED}`; return; }

  // Invoice ids come from the ledger, so we never page the whole tenant.
  const invoiceIds = [...new Set(
    statement.filter((l) => String(l.lineType ?? '').toUpperCase() === 'INVOICE')
      .map((l) => String(l.invoiceId ?? l.lineReferenceId ?? '')).filter(Boolean),
  )];

  const docs: InvoiceDoc[] = [];
  for (const id of invoiceIds) {
    const d = await gql.getInvoice(id).catch(() => null);
    if (d?.id) docs.push(d);
  }
  // Oldest cycle first, so "the later cycle" is unambiguous.
  docs.sort((a, b) => String(a.startDate ?? '').localeCompare(String(b.startDate ?? '')));

  for (const inv of docs) {
    cycles.push({
      inv,
      billedKwh: energiaKwh(inv) ?? 0,
      cycleKwh: await gql.cycleKwhForPeriod(ACCOUNT, String(inv.startDate ?? '')),
    });
  }
  console.log(
    `[two-cycle] ${ACCOUNT}: ${statement.length} ledger line(s), ${cycles.length} invoice(s) — `
    + cycles.map((c) => `${c.inv.id} [${c.inv.startDate}..${c.inv.endDate}] billed ${c.billedKwh} kWh, cycle ${c.cycleKwh}`).join(' | '),
  );
  if (cycles.length < 2) setupNote = `account ${ACCOUNT} has only ${cycles.length} billed cycle(s), needs 2. ${HOW_TO_SEED}`;
});

test.describe('Prepaid account across two consecutive billed cycles', () => {
  test('the account ledger balance chain is continuous @jasec @billing @two-cycle @tc-138', async () => {
    if (setupNote) { console.log(`\n[two-cycle] BLOCKED, not failed: ${setupNote}\n`); test.skip(true, setupNote); return; }

    /**
     * BACK-DATED ROWS ARE AN ASSERTION HERE, NOT A SKIP. The predecessor skipped
     * such accounts because it sampled a shared pool it did not control. This
     * account is seeded by us and billed forward, so out-of-order ids mean
     * something really went wrong and must fail.
     */
    const ids = statement.map((l) => idNum(l.lineReferenceId));
    const outOfOrder = ids.filter((v, i) => i + 1 < ids.length && v < ids[i + 1]);
    expect(
      outOfOrder,
      `ledger ids must descend when read newest-first; got ${JSON.stringify(ids)}. `
      + 'Out-of-order ids mean rows were back-dated — on a seeded account that should be impossible.',
    ).toEqual([]);

    // Statement comes back newest-first: the NEXT element is the older line, and
    // its closing balance must equal this line's opening balance.
    const gaps: string[] = [];
    for (let i = 0; i + 1 < statement.length; i++) {
      const newer = statement[i], older = statement[i + 1];
      if (!near(num(older.closingBalance), num(newer.openingBalance))) {
        gaps.push(
          `${older.lineReferenceId} closing ${older.closingBalance} != `
          + `${newer.lineReferenceId} opening ${newer.openingBalance}`,
        );
      }
    }
    expect(gaps, `breaks in the running balance:\n${gaps.join('\n')}`).toEqual([]);

    // Each line's own split must add up.
    const badSplit = statement
      .filter((l) => l.subTotal != null && l.taxes != null)
      .filter((l) => !near(num(l.subTotal) + num(l.taxes), num(l.amount)))
      .map((l) => `${l.lineReferenceId}: ${l.subTotal} + ${l.taxes} != ${l.amount}`);
    expect(badSplit, `tax split does not sum to the amount:\n${badSplit.join('\n')}`).toEqual([]);

    // Every INVOICE line must resolve to a real invoice carrying the same total.
    const unresolved: string[] = [];
    for (const c of cycles) {
      const line = statement.find((l) => String(l.invoiceId ?? l.lineReferenceId) === String(c.inv.id));
      if (!line) { unresolved.push(`${c.inv.id}: no ledger line`); continue; }
      if (!near(num(line.amount), num(c.inv.total)))
        unresolved.push(`${c.inv.id}: ledger ${line.amount} != invoice total ${c.inv.total}`);
    }
    expect(unresolved, `INVOICE lines that do not match their invoice:\n${unresolved.join('\n')}`).toEqual([]);

    console.log(`[two-cycle] ledger chain verified across ${statement.length} line(s), ${cycles.length} invoice(s)`);
  });

  test('unused included kWh do NOT carry over to the next cycle @jasec @billing @two-cycle @tc-139', async () => {
    if (setupNote) { console.log(`\n[two-cycle] BLOCKED, not failed: ${setupNote}\n`); test.skip(true, setupNote); return; }

    /**
     * THE MEASUREMENT. The first 30 kWh are included in the monthly fixed charge
     * and expire at month end. So a cycle that consumed LESS than 30 is still
     * billed exactly 30 — and the NEXT cycle's allowance must be 30 again, not
     * 30 plus whatever went unused.
     *
     * Worked example from the seeded account: 25 kWh consumed in both cycles
     * leaves 5 unused in the first. Correct behaviour bills 30 kWh / 1,943.40 in
     * BOTH. If the 5 carried, the second cycle's minimum would be 35 kWh and the
     * invoice would read 2,267.30 — which is a different number entirely, so
     * this cannot pass by accident.
     */
    const under = cycles.filter((c) => c.cycleKwh !== null && c.cycleKwh < MIN_BILLED_KWH);
    if (under.length < 2) {
      const why =
        `needs 2 cycles that each consumed under ${MIN_BILLED_KWH} kWh; this account has ${under.length}. `
        + `Cycles: ${cycles.map((c) => `${c.inv.id}=${c.cycleKwh} kWh`).join(', ')}. ${HOW_TO_SEED}`;
      console.log(`\n[two-cycle] BLOCKED, not failed: ${why}\n`);
      test.skip(true, why);
      return;
    }

    const bad: string[] = [];
    for (const c of under) {
      if (!near(c.billedKwh, MIN_BILLED_KWH, 0.001)) {
        bad.push(
          `${c.inv.id} consumed ${c.cycleKwh} kWh and billed ${c.billedKwh} kWh — expected exactly `
          + `${MIN_BILLED_KWH}. Billing ${Number(c.cycleKwh) + (c.billedKwh - Number(c.cycleKwh))} suggests the `
          + 'unused allowance carried over from the previous cycle.',
        );
      }
    }
    expect(bad, `the included allowance did not reset:\n${bad.join('\n')}`).toEqual([]);

    // The accumulator is per cycle, so the later cycle must count only its own
    // consumption — it must not open carrying the earlier cycle's leftover.
    const later = under[under.length - 1];
    expect(
      num(later.cycleKwh),
      `the later cycle's accumulator (${later.cycleKwh}) must hold only its own consumption, `
      + `below the ${MIN_BILLED_KWH} kWh minimum`,
    ).toBeLessThan(MIN_BILLED_KWH);

    // Both invoices must charge the same, since both consumed under the minimum.
    const totals = under.map((c) => num(c.inv.total));
    const allSame = totals.every((t) => near(t, totals[0]));
    expect(
      allSame,
      `both sub-minimum cycles must bill the same fixed charge; got ${JSON.stringify(totals)}`,
    ).toBe(true);

    console.log(
      `[two-cycle] allowance reset confirmed: `
      + under.map((c) => `${c.inv.id} consumed ${c.cycleKwh} billed ${c.billedKwh} total ${c.inv.total}`).join(' | '),
    );
  });

  test('the charge lines are present on every cycle @jasec @billing @two-cycle', async () => {
    if (setupNote) { console.log(`\n[two-cycle] BLOCKED, not failed: ${setupNote}\n`); test.skip(true, setupNote); return; }
    const bad: string[] = [];
    for (const c of cycles) {
      const names = new Set((c.inv.invoiceSummaryList ?? []).map((l: any) => lineName(String(l.name ?? ''))));
      for (const required of ['ENERGIA', 'CVG ENERGIA', 'ALUMBRADO PUBLICO']) {
        if (!names.has(required)) bad.push(`${c.inv.id}: missing "${required}" — saw ${JSON.stringify([...names])}`);
      }
    }
    expect(bad, `charge lines missing:\n${bad.join('\n')}`).toEqual([]);
  });
});

/**
 * THE 0-30 kWh FIXED CHARGE, ON A CYCLE THIS SUITE BILLED ITSELF.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE BAND SWEEP. ts-01-invoice-bands answers a
 * different question - 'do the tenant's EXISTING invoices obey the rules' - and
 * because it asserts on history it did not create, it needs a cutoff to excuse
 * invoices issued before the 2026-09-07 rate fix, which were never corrected.
 *
 * That cutoff is an invoice NUMBER (BILLING_FIX_CUTOFF, default 2793 = dev's
 * first post-fix invoice). On jasec-preprod, whose invoices restart at 000001,
 * every invoice fell below it and was excused as 'pre-fix' - so the assertion
 * had no subject and reported BLOCKED while the tenant was in fact billing
 * 2319.30 against an expected 1943.40. The workaround hid the finding.
 *
 * A cycle we bill ourselves needs no cutoff: it is post-fix BY CONSTRUCTION.
 * That is the whole point - there is no marker to keep current, nothing to
 * re-tune when the next rate change lands, and it behaves the same on any
 * tenant regardless of how its invoice numbering happens to run.
 *
 * Seed with:
 *   $env:JASEC_BDOM='<free>'
 *   _scripts/billing/run-billing-cycle-e2e.ps1 -TestEnv <env> -Scenario TC40
 * then pass the account it reports in JASEC_FIXED_CHARGE_ACCOUNT.
 *
 * TC40 rates 25 kWh, deliberately UNDER 30, so the fixed-charge minimum is what
 * is being tested rather than ordinary consumption.
 */
const FIXED_CHARGE_ACCOUNT = process.env.JASEC_FIXED_CHARGE_ACCOUNT ?? '';

/** Diseno Funcional 3.4.1: 30 x (62.69 + -0.58 + 2.67 + 0). */
const EXPECTED_TOTAL_AT_30_KWH = 1943.40;

const HOW_TO_SEED_FIXED =
  'Seed one with:  $env:JASEC_BDOM=<free> ; ' +
  '.\\_scripts\\billing\\run-billing-cycle-e2e.ps1 -TestEnv <env> -Scenario TC40  ' +
  'then re-run with JASEC_FIXED_CHARGE_ACCOUNT=<accountId>. ' +
  'Free BDOMs: query core_engine.billing_profile for unused values 1-28.';

test.describe('Prepaid fixed charge on a freshly billed sub-30 kWh cycle', () => {
  let fixedInv: InvoiceDoc | null = null;
  let fixedNote = '';
  let billedKwh = 0;

  test.beforeAll(async () => {
    if (!FIXED_CHARGE_ACCOUNT) { fixedNote = `no account given. ${HOW_TO_SEED_FIXED}`; return; }
    const lines = await gql.getAccountStatement(FIXED_CHARGE_ACCOUNT).catch(() => []);
    const ids = [...new Set(lines
      .filter((l) => String(l.lineType ?? '').toUpperCase() === 'INVOICE')
      .map((l) => String(l.invoiceId ?? l.lineReferenceId ?? '')).filter(Boolean))];
    if (!ids.length) { fixedNote = `account ${FIXED_CHARGE_ACCOUNT} has no invoice. ${HOW_TO_SEED_FIXED}`; return; }

    // Newest invoice: the cycle this seed just billed.
    const docs: InvoiceDoc[] = [];
    for (const id of ids) { const d = await gql.getInvoice(id).catch(() => null); if (d?.id) docs.push(d); }
    docs.sort((a, b) => idNum(b.id) - idNum(a.id));
    fixedInv = docs[0] ?? null;
    if (!fixedInv) { fixedNote = `no readable invoice on ${FIXED_CHARGE_ACCOUNT}. ${HOW_TO_SEED_FIXED}`; return; }

    billedKwh = energiaKwh(fixedInv) ?? 0;
    console.log(`[fixed-charge] ${FIXED_CHARGE_ACCOUNT}: invoice ${fixedInv.id} ` +
      `[${fixedInv.startDate}..${fixedInv.endDate}] billed ${billedKwh} kWh`);

    // Guard the PREMISE. A cycle over 30 kWh is billed on consumption, not the
    // minimum, so asserting 1943.40 on it would be wrong - and silently so.
    if (billedKwh > MIN_BILLED_KWH) {
      fixedNote =
        `invoice ${fixedInv.id} bills ${billedKwh} kWh, which is ABOVE the ${MIN_BILLED_KWH} kWh ` +
        `minimum, so the fixed charge does not apply to it. Seed with a sub-30 scenario ` +
        `(TC40 rates 25). ${HOW_TO_SEED_FIXED}`;
    }
  });

  test('a sub-30 kWh cycle bills the flat fixed charge @jasec @billing @fixed-charge', async () => {
    if (fixedNote) { console.log(`
[fixed-charge] BLOCKED, not failed: ${fixedNote}
`); test.skip(true, fixedNote); return; }

    const inv = fixedInv!;
    // `summaryTotal()` returns the summary OBJECT, not a number - read
    // `.summarySubTotal` off it. Taking it directly yields NaN, which then
    // compares unequal to everything and reports as a billing defect.
    const st = summaryTotal(inv);
    if (!st) {
      const why = `invoice ${inv.id} has no invoiceSummaryTotal, so there is no subtotal to read.`;
      console.log(`\n[fixed-charge] BLOCKED, not failed: ${why}\n`);
      test.skip(true, why);
      return;
    }
    const subtotal = num(st.summarySubTotal);
    expect(
      near(subtotal, EXPECTED_TOTAL_AT_30_KWH),
      `invoice ${inv.id} on ${FIXED_CHARGE_ACCOUNT} metered ${billedKwh} kWh and subtotals ` +
      `${subtotal}, expected the flat ${EXPECTED_TOTAL_AT_30_KWH}. This cycle was billed by ` +
      `this suite under CURRENT rules, so there is no pre-fix history to excuse it: the ` +
      `rate table this tenant is using produces the wrong monthly fixed charge. ` +
      `Check the four *-MIN-TRUEUP rates against jasec-tariff-lib.sh.`,
    ).toBe(true);
  });

  test('the sub-30 cycle still bills the full 30 kWh @jasec @billing @fixed-charge', async () => {
    if (fixedNote) { test.skip(true, fixedNote); return; }
    // The allowance rule: metering under 30 does not reduce what is billed.
    expect(
      billedKwh,
      `invoice ${fixedInv!.id} bills ${billedKwh} kWh. A cycle metering under ` +
      `${MIN_BILLED_KWH} must still bill ${MIN_BILLED_KWH} - that is what makes the ` +
      `charge FIXED.`,
    ).toBe(MIN_BILLED_KWH);
  });
});
