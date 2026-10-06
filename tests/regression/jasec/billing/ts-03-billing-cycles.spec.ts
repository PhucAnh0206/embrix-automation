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
import { blockedIf } from '../../../../helpers/blocked.helper';

/**
 * Account with two consecutive BILLED cycles.
 *
 * `let`, not `const`: when the caller supplies nothing, the subject is
 * RE-RESOLVED from this tenant in `beforeAll` rather than the whole describe
 * skipping. See `resolveTwoCycleAccount` for why that is safe.
 */
let ACCOUNT = process.env.JASEC_TWO_CYCLE_ACCOUNT ?? '';
/**
 * Whether ACCOUNT was SUPPLIED (seeded by us) rather than resolved off the
 * tenant. The ledger-order assertion depends on it: back-dated rows on a seeded
 * account are a defect, on a borrowed one they are our own history.
 */
const ACCOUNT_SUPPLIED = ACCOUNT.trim() !== '';

/**
 * Find a PREPAID account on THIS tenant carrying at least two billed cycles.
 *
 * WHY. `run-suite.ps1 -Block billing` seeds these subjects and exports them, so
 * the block is complete when driven that way. A bare
 * `npx playwright test --project=jasec-billing-read` sets nothing, and all five
 * cases in this file then skipped — a green 66/17 that had silently judged
 * nothing here. Coverage should not depend on which command started the run.
 *
 * WHY IT IS SAFE TO TAKE AN ARBITRARY ACCOUNT. Every case below already guards
 * its own premise and reports BLOCKED, not FAILED, when the subject does not
 * satisfy it — the ledger-chain assertion holds for any account, and the
 * carry-over case checks for itself that two cycles came in under 30 kWh.
 * Verified on jasec-preprod 2026-09-23: with ACT-100008 (an ordinary 5-invoice
 * account, not purpose-built) the two general cases PASS and the carry-over case
 * blocks with "needs 2 cycles that each consumed under 30 kWh; this account
 * has 0". A resolved subject can therefore recover coverage but cannot
 * manufacture a failure.
 *
 * A SUPPLIED ACCOUNT ALWAYS WINS, so the seeded path is bit-for-bit unchanged.
 *
 * Grouping happens BEFORE the category lookup on purpose: `accountCategory` is
 * one GraphQL round trip per distinct account, so filtering 200 invoices first
 * would cost up to 200 calls to find one subject.
 */
async function resolveTwoCycleAccount(g: BillingGqlHelper): Promise<string> {
  // Prefer an account whose ledger is in order: a back-dated one can only
  // BLOCK the chain case (see there), so taking it first would give up
  // coverage another account could provide. Bounded - one statement read each.
  let backDatedFallback = '';
  let probes = 0;
  const MAX_PROBES = 20;
  for (let page = 1; page <= 4; page++) {
    const batch = await g.searchInvoices(page, 200).catch(() => []);
    if (!batch.length) break;

    const byAccount = new Map<string, number>();
    for (const inv of batch) {
      const id = String(inv.accountId ?? '');
      if (id) byAccount.set(id, (byAccount.get(id) ?? 0) + 1);
    }
    // Most invoices first: the best chance of two comparable consecutive cycles.
    const candidates = [...byAccount.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    for (const id of candidates) {
      if ((await g.accountCategory(id).catch(() => '')) !== 'PREPAID') continue;
      if (probes >= MAX_PROBES) return backDatedFallback || id;
      probes++;
      const lines = await g.getAccountStatement(id).catch(() => []);
      if (!ledgerBackDated(lines)) return id;
      if (!backDatedFallback) backDatedFallback = id;
    }
  }
  return backDatedFallback;
}

/**
 * The ids the order rule applies to: INVOICE lines only. Invoice numbers are issued in creation order; a
 * SETTLEMENT line (prepaid settlement, 2026-10-05) carries the id of the invoice it SETTLES, and an invoice
 * billed before the fix is settled later - on prod ACT-100071 invoice 000055 was settled together with
 * 000062 a cycle later, so its settlement sits above 000062's invoice line and read as "back-dated".
 */
const orderedIds = (lines: Array<{ lineReferenceId?: unknown; lineType?: unknown }>) =>
  lines.filter((l) => String(l.lineType ?? '').toUpperCase() !== 'SETTLEMENT').map((l) => idNum(l.lineReferenceId));

/** Same predicate the chain case asserts: invoice ids must descend when read newest-first. */
function ledgerBackDated(lines: Array<{ lineReferenceId?: unknown; lineType?: unknown }>): boolean {
  const ids = orderedIds(lines);
  return ids.some((v, i) => i + 1 < ids.length && v < ids[i + 1]);
}

/** JASEC includes the first 30 kWh in the monthly fixed charge. */
const MIN_BILLED_KWH = 30;
const CENT = 0.02;

const num = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number, tol = CENT) => Math.abs(a - b) <= tol;
/** Ledger ids are zero-padded and issued in creation order. */
const idNum = (s: unknown) => Number(String(s ?? '').replace(/\D/g, '')) || 0;

/**
 * Invoices issued before the 2026-09-07 rate fix were never corrected — a
 * business decision, team note 2026-09-10 — so they cannot be held to the
 * current line structure. Same constant, same default and same preprod
 * exception as ts-01: 2793 is a jasec-dev invoice NUMBER, and preprod restarted
 * its numbering at 000001, so applying dev's number there would excuse every
 * invoice and leave the assertion with no subject at all.
 */
// Default is "dev only" (2026-09-30) - see the same constant in ts-01.
const TENANT = (process.env.TEST_ENV ?? '').trim();
const FIRST_POST_FIX_INVOICE = Number(
  process.env.BILLING_FIX_CUTOFF ?? (TENANT === 'jasec-dev' ? '2793' : '1'),
);

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
  if (!ACCOUNT) {
    ACCOUNT = await resolveTwoCycleAccount(gql).catch(() => '');
    if (ACCOUNT) {
      console.log(
        `\n[two-cycle] no account supplied; resolved ${ACCOUNT} from this tenant. `
        + `Seed a purpose-built one for the carry-over case: ${HOW_TO_SEED}\n`,
      );
    }
  }
  if (!ACCOUNT) { setupNote = `no account given, and none could be resolved from this tenant. ${HOW_TO_SEED}`; return; }

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
  test('the account ledger balance chain is continuous @jasec @billing @two-cycle @tc-143', async () => {
    if (setupNote) { console.log(`\n[two-cycle] BLOCKED, not failed: ${setupNote}\n`); test.skip(true, setupNote); return; }

    /**
     * BACK-DATED ROWS ARE AN ASSERTION HERE, NOT A SKIP - on a SUPPLIED account.
     * The predecessor skipped such accounts because it sampled a shared pool it
     * did not control. A seeded account is billed forward, so out-of-order ids
     * mean something really went wrong and must fail.
     *
     * A RESOLVED account is exactly that shared pool. Billing on a rewound CCP
     * clock back-dates rows, and ts-04 measured 57 such ledgers on jasec-dev, all
     * ours. Failing one of those would manufacture a defect from our own test
     * history, so it is BLOCKED instead - `resolveTwoCycleAccount` already
     * prefers accounts without back-dated rows, so this only fires when none was
     * found.
     */
    const ids = orderedIds(statement);
    const outOfOrder = ids.filter((v, i) => i + 1 < ids.length && v < ids[i + 1]);
    if (blockedIf(!ACCOUNT_SUPPLIED && outOfOrder.length > 0,
      `resolved account ${ACCOUNT} has back-dated ledger rows (${JSON.stringify(ids)}), `
      + `which on a borrowed account is clock-rewind history, not a defect. ${HOW_TO_SEED}`)) return;
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
    // Match the INVOICE line itself: since prepaid settlement (2026-10-05) each invoice also has a
    // SETTLEMENT line carrying the same invoice id and minus the total, and it sits NEWER in the ledger,
    // so a lookup by id alone found the settlement and read -1943.4 against 1943.4 (preprod 2026-10-06).
    const unresolved: string[] = [];
    for (const c of cycles) {
      const line = statement.find((l) => String(l.lineType ?? '').toUpperCase() === 'INVOICE'
        && String(l.invoiceId ?? l.lineReferenceId) === String(c.inv.id));
      if (!line) { unresolved.push(`${c.inv.id}: no ledger line`); continue; }
      if (!near(num(line.amount), num(c.inv.total)))
        unresolved.push(`${c.inv.id}: ledger ${line.amount} != invoice total ${c.inv.total}`);
    }
    expect(unresolved, `INVOICE lines that do not match their invoice:\n${unresolved.join('\n')}`).toEqual([]);

    console.log(`[two-cycle] ledger chain verified across ${statement.length} line(s), ${cycles.length} invoice(s)`);
  });

  test('unused included kWh do NOT carry over to the next cycle @jasec @billing @two-cycle @tc-144', async () => {
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
    /**
     * THESE CYCLES ARE HISTORY, SO THE PRE-FIX CUTOFF APPLIES HERE TOO.
     *
     * Unlike the fixed-charge case further down, this test asserts on an
     * account it did not bill — and when JASEC_TWO_CYCLE_ACCOUNT is unset it
     * auto-resolves whatever account the tenant offers. On jasec-dev 2026-09-25
     * that resolved ACT-100442, and three different shapes from one staged
     * rollout sat side by side on it:
     *
     *   002648  ENERGIA 69.24 + ALP 3.05 + ALP-CVG + KWH-CVG 4.81   (old rates)
     *   002686  ENERGIA 62.69 + ALP 2.67, NO CVG line at all        (mid-fix)
     *   002831  ENERGIA 62.69 + ALP 2.67 + KWH-CVG -17.40           (correct)
     *
     * The two mid-fix invoices failed this assertion for missing CVG ENERGIA.
     * That is uncorrected history, not a live defect, and it is exactly what
     * ts-01's cutoff exists to excuse — this test simply never applied it.
     */
    const bad: string[] = [];
    const preFix: string[] = [];
    for (const c of cycles) {
      if (idNum(c.inv.id) < FIRST_POST_FIX_INVOICE) { preFix.push(String(c.inv.id)); continue; }
      const names = new Set((c.inv.invoiceSummaryList ?? []).map((l: any) => lineName(String(l.name ?? ''))));
      for (const required of ['ENERGIA', 'CVG ENERGIA', 'ALUMBRADO PUBLICO']) {
        if (!names.has(required)) bad.push(`${c.inv.id}: missing "${required}" — saw ${JSON.stringify([...names])}`);
      }
    }

    const checked = cycles.length - preFix.length;
    console.log(
      `[two-cycle] charge lines asserted on ${checked} of ${cycles.length} cycle(s)`
      + (preFix.length ? `; ${preFix.length} predate ${FIRST_POST_FIX_INVOICE} and are EXCLUDED as pre-fix: ${preFix.join(', ')}` : ''),
    );
    // Refuse to report green on an empty subject. ts-01 hit exactly this on
    // preprod — every invoice excused as "pre-fix" while the tenant was in fact
    // billing the wrong amount, and the workaround hid the finding.
    if (checked === 0) {
      const why =
        `every cycle on this account predates ${FIRST_POST_FIX_INVOICE}, so there is no `
        + `post-fix invoice to check the charge lines on. ${HOW_TO_SEED}`;
      console.log(`\n[two-cycle] BLOCKED, not failed: ${why}\n`);
      test.skip(true, why);
      return;
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
/** `let` for the same reason as ACCOUNT above: resolved when nothing is supplied. */
let FIXED_CHARGE_ACCOUNT = process.env.JASEC_FIXED_CHARGE_ACCOUNT ?? '';
/** A supplied account was billed by us under current rules; a resolved one may not be. */
const FIXED_CHARGE_SUPPLIED = FIXED_CHARGE_ACCOUNT.trim() !== '';

/**
 * Find a PREPAID account on THIS tenant whose newest invoice bills at or under
 * the 30 kWh minimum — which is exactly what these two cases are about.
 *
 * Same reasoning as `resolveTwoCycleAccount`: a supplied account wins, and the
 * premise guard below (`billedKwh > MIN_BILLED_KWH` marks the run BLOCKED)
 * catches a subject that does not qualify, so resolution cannot turn a healthy
 * tenant into a failure. Verified on jasec-preprod 2026-09-23: ACT-100008,
 * newest invoice 000122 billing 30 kWh, passes both cases.
 *
 * The band search is the same one ts-07-invoice-document uses for its sub-30
 * subject, so the two specs agree on what "the fixed-charge band" means.
 */
async function resolveFixedChargeAccount(g: BillingGqlHelper): Promise<string> {
  // No early stop: `enough` cut the scan at the first 10 matches in SCAN order,
  // which is not invoice order, so they could all be 2319.30-era invoices.
  // Resolving to one of those and asserting 1943.40 blamed the current rules for
  // uncorrected history. Four pages is four requests; the category lookups are
  // bounded by taking the 10 newest post-fix matches.
  const found = await g.findInvoicesInBand(0, MIN_BILLED_KWH, 4, 200).catch(() => []);
  const postFix = found
    .filter((inv) => idNum(inv.id) >= FIRST_POST_FIX_INVOICE)
    .sort((a, b) => idNum(b.id) - idNum(a.id))
    .slice(0, 10);
  const prepaid = await g.filterByAccountCategory(postFix, 'PREPAID').catch(() => []);
  // Newest first: the most recently billed cycle is the least likely to have
  // been disturbed by anything since.
  prepaid.sort((a, b) => idNum(b.id) - idNum(a.id));
  return prepaid.length ? String(prepaid[0].accountId ?? '') : '';
}

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
    if (!FIXED_CHARGE_ACCOUNT) {
      FIXED_CHARGE_ACCOUNT = await resolveFixedChargeAccount(gql).catch(() => '');
      if (FIXED_CHARGE_ACCOUNT) {
        console.log(`\n[fixed-charge] no account supplied; resolved ${FIXED_CHARGE_ACCOUNT} from this tenant.\n`);
      }
    }
    if (!FIXED_CHARGE_ACCOUNT) {
      fixedNote = `no account given, and no sub-${MIN_BILLED_KWH} kWh prepaid invoice could be found on this tenant. ${HOW_TO_SEED_FIXED}`;
      return;
    }
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

    // A RESOLVED subject was not billed by us, so it is only fair game if it was
    // issued under the current rates. A supplied one is post-fix by construction.
    if (!FIXED_CHARGE_SUPPLIED && idNum(fixedInv.id) < FIRST_POST_FIX_INVOICE) {
      fixedNote =
        `resolved account ${FIXED_CHARGE_ACCOUNT}'s newest invoice ${fixedInv.id} predates ` +
        `${FIRST_POST_FIX_INVOICE}, so it carries uncorrected pre-fix charges. ${HOW_TO_SEED_FIXED}`;
      return;
    }

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
      `${subtotal}, expected the flat ${EXPECTED_TOTAL_AT_30_KWH}. This cycle was ` +
      (FIXED_CHARGE_SUPPLIED ? `billed by this suite` : `issued at or after ${FIRST_POST_FIX_INVOICE}`) +
      ` under CURRENT rules, so there is no pre-fix history to excuse it: the ` +
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
