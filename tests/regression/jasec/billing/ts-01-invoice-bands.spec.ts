/**
 * Monthly invoice — all seven consumption bands.
 *
 * Source: Spanish scenario doc TC20–TC26, "Facturación de cliente que consume una
 * cantidad de kWh entre …". Those scenario-doc numbers are NOT EPDP-348 case IDs.
 * The official EPDP-348 cases are TC-131..137, one per band, tagged @tc-131..137
 * via BANDS[].tc (updated 2026-10-08; this line used to say they had none yet).
 *
 * ── WHERE EVERY NUMBER IN THIS FILE COMES FROM ────────────────────────────
 *
 * The tenant's own configuration is the authority, not the Spanish doc. From
 * `core_config.config_tax_product_taxes` on jasec-dev (verified 2026-08-24):
 *
 *     BOM  1.75%   accumulatorid KWH   min 100   max 1750   ADDITIONAL_TAX
 *     IVA 13.00%   accumulatorid KWH   min 280   max null   MAIN_TAX
 *
 * with no start/end date window on either. The scenario doc (TC24/TC25/TC26)
 * and `JASEC-knowledge.md` agree. Above 1750 kWh the ICB base is CAPPED at the
 * 1750-equivalent amount — measured at exactly 130,253 on this tenant.
 *
 *   Taxable base = ENERGIA + CVG ENERGIA + CVG ALUMBRADO PUBLICO.
 *   **ALUMBRADO PUBLICO (ALP "sin CVG") is EXCLUDED** — stated verbatim in every
 *   band's Resultado Esperado as "la suma de (ENE + ENE CVG + ALP CVG)".
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  FOUR TRAPS. EVERY ONE OF THESE PRODUCED A FALSE DEFECT REPORT.
 *  Read before changing an assertion. Full write-up in
 *  `Regression testing/EPDP-348_JASEC-Test/EXPLORE_billing-read-graphql/`.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. kWh IS THE SUM OF THE TARIFF BLOCKS, NOT THE LARGEST ONE.
 *    Lines are split per block (`ENERGIA|KWH|0|30`, `|30|200`, `|200|0`) and each
 *    carries only its own slice. Using max() under-reported consumption by the
 *    lower blocks (typically 200 kWh) and pushed invoices a band too low, which
 *    generated three separate "tax applied below the threshold" defects — all
 *    false. Guarded by a no-network unit test at the top of this file.
 *
 * 2. THRESHOLDS READ THE CYCLE ACCUMULATOR, AND THERE IS ONE PER CYCLE.
 *    The config above keys on the KWH accumulator. When an account is billed more
 *    than once in a cycle it diverges from the invoice: `000187` bills 130 kWh
 *    while its accumulator stood at 2,094.52, so its IVA is correct. Banding by
 *    the invoice's own kWh reported that as a defect.
 *
 *    But "the" accumulator does not exist. An account carries a row per cycle,
 *    and sometimes several rows within one cycle. Reading whichever came back
 *    last gave ACT-100164 a cycle of 83.78 kWh (its 2027-12 window) against a
 *    2,634 kWh invoice from 2026-07 — nonsense in the opposite direction, caught
 *    by the `sanity` test below. ACT-100084 needs its three rows SUMMED to reach
 *    the 586.7 its invoice billed.
 *
 *    So: match the accumulator to the invoice's bill period on `startDate`
 *    (`cycleKwhForPeriod`). When no accumulator covers that period the cycle is
 *    UNKNOWN — fall back to the invoice's own kWh and treat cycle-dependent rules
 *    as unverifiable, never as failures.
 *
 * 3. PREPAID ONLY. The thresholds are a prepaid rule. Over all 1,453 invoices
 *    with an ENERGIA line: prepaid 0–30 kWh is 1379/1379 untaxed, postpaid 0–30
 *    is 41/41 taxed — a different tariff. Dropping the filter reported those 41
 *    as defects. DO NOT REMOVE `filterByAccountCategory`.
 *
 * 4. BILLING DOES NOT RE-RATE, AND THIS SPEC CANNOT SEE WHEN TAX WAS COMPUTED.
 *    `BILL_CHECK` / `INVOICE_CHECK` consolidate `transaction_unit` rows produced
 *    by rating earlier, so a brand-new invoice can carry tax computed weeks ago
 *    under an older build. On jasec-dev, 13 invoices still carry pre-fix output
 *    from the IVA defect fixed 2026-08-19; grouping by
 *    `invoice_tax_detail.createddate` splits with zero exceptions.
 *
 *    GraphQL exposes no tax-computation date (`InvoiceTax` has none, and
 *    `getTaxDetailReport` returns only `billEndDate`), so THIS SPEC CANNOT
 *    DISTINGUISH A LIVE THRESHOLD BUG FROM STALE RATING OUTPUT. The presence
 *    checks are therefore gated behind BILLING_STRICT_THRESHOLDS and skipped by
 *    default, reporting their findings to the log instead of failing.
 *
 *    Turn strict mode on only when you know the population is freshly rated —
 *    e.g. immediately after staging accounts. Otherwise confirm any finding with:
 *      SELECT accountid, taxcategory, createddate FROM core_engine.invoice_tax_detail
 *      WHERE accountid = '<id>';
 *
 * ── WHAT IS ASSERTED UNCONDITIONALLY ──────────────────────────────────────
 *
 * Everything that is true regardless of WHEN the tax was computed: line
 * arithmetic, totals reconciliation, required charge lines, the RATE of any tax
 * that is present, the composition of its taxable base, and the ICB cap. A tax
 * present at the wrong rate or on the wrong base is a real defect on any build.
 *
 * ── THE 0–30 EXPECTED TOTAL ───────────────────────────────────────────────
 *
 * 2319.30, not the 1932.75 printed in scenario doc TC20's Resultado Esperado.
 * That doc contradicts its own Pasos a Ejecutar ("cargos fijos por 30 kWh el cual
 * es de 2319.30 CRC"); 1932.75 is 25 x 77.31, i.e. billing only what was consumed
 * instead of the 30 kWh minimum. The system bills 2319.30 on 1,420 invoices.
 * Confirmed with the QC owner. Raise the doc line; do not change this constant.
 *
 * READ-ONLY, NO VPN. GraphQL only — no clock move, no job_schedule slot, no
 * staged account. Every band already has invoices on jasec-dev.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import {
  BillingGqlHelper, energiaKwh, lineName, summaryTotal, type InvoiceDoc,
} from '../../../../helpers/billing-gql.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const CENT = 0.02;
const near = (a: number, b: number) => Math.abs(a - b) <= CENT;
const num = (v: unknown) => Number(v ?? 0);

/**
 * Tolerance for a taxable base, which can run to hundreds of thousands of CRC.
 * A flat two-cent window flags 0.38 on a base of 267,544 — that is 0.00014%, i.e.
 * intermediate rounding inside the engine, not a pricing error. Scale with the
 * magnitude and keep the cent floor for small invoices.
 */
const nearBase = (actual: number, expected: number) =>
  Math.abs(actual - expected) <= Math.max(CENT, Math.abs(expected) * 0.0001);

/** Tolerance for a tax RATE. Rates are fractions stored to 6 decimals. */
const nearRate = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-6;

/**
 * The ICB base above 1750 kWh: the taxable base (ENE + CVG ENE + CVG ALP) of
 * exactly 1750 kWh under the current tariff. Equals `_agg_tax_base 1750` in
 * `_scripts/calc/jasec-tariff-lib.sh` (130253.000000), and 25 invoices on
 * jasec-dev carry exactly this base. A tariff change moves it - re-derive it
 * from the lib, do not re-measure it from the product.
 */
const ICB_CAP_BASE = 130253;

/** Per-band invoices to assert on. Rare bands hold fewer than this anyway. */
const SAMPLE = Number(process.env.BILLING_BAND_SAMPLE ?? 10);
/**
 * Pages of 200 to scan.
 *
 * RAISED 8 -> 20 on 2026-09-10. The old comment said "1,527 invoices exist, so 8
 * covers the tenant" - it stopped being true. By 2026-09-10 the tenant held 2,676,
 * so the scan saw 1,600 of them and SILENTLY MISSED THE NEWEST 1,076. The freshly
 * billed 60,000 kWh invoice (002792) was invisible and the 50001+ band reported
 * "asserting on 0" as though the band had no data, rather than as though the scan
 * had been truncated. A cap tuned to a row count is a cap that expires.
 *
 * 20 pages = 4,000 invoices. When even that is not enough the run now SAYS SO
 * (see the truncation warning at the scan) instead of quietly under-reporting.
 */
const PAGES = Number(process.env.BILLING_BAND_PAGES ?? 20);
/** Accounts to resolve category + accumulator for. Bounds the GraphQL cost. */
const ACCOUNT_BUDGET = Number(process.env.BILLING_ACCOUNT_BUDGET ?? 120);
/** See trap 4. Off by default — the tax-computation date is not visible here. */
// '1' or 'true'. It accepted only '1', so BILLING_STRICT_THRESHOLDS=true silently ran
// the LENIENT mode (prod build 2, 2026-10-02).
const STRICT = ['1', 'true'].includes(String(process.env.BILLING_STRICT_THRESHOLDS ?? '').trim().toLowerCase());

const STRICT_OFF_REASON =
  'threshold presence is not asserted by default: GraphQL exposes no tax-computation ' +
  'date, so a mismatch cannot be told apart from pre-fix rating output that billing ' +
  'merely carried forward (trap 4). Findings are printed above. Set ' +
  'BILLING_STRICT_THRESHOLDS=1 when the population is known to be freshly rated.';

const REQUIRED_LINES = ['ENERGIA', 'CVG ENERGIA', 'ALUMBRADO PUBLICO'];
/**
 * First invoice issued AFTER the two sub-30 fixes landed (2026-09-10):
 * the CVG ENERGIA true-up now always applies, and INVOICE_CHECK now accepts the
 * negative line. 002793 was the first invoice rendered under both.
 *
 * WHY A CUTOFF AT ALL. Billing never re-rates, so an invoice cannot be judged by
 * a rule that post-dates it. The team's 2026-09-10 note is explicit that the 8
 * invoices at 1,960.80 and the older ones at 2,319.30 were NOT corrected, and that
 * how to correct them is a business decision. Asserting the new rule against them
 * keeps this suite permanently red for history nobody intends to change, and a
 * permanently red case stops being read.
 *
 * So: assert the rule on invoices issued under it, and REPORT the rest. The
 * reporting matters - it is the visible count of uncorrected history, which is
 * exactly the input to that business decision.
 *
 * Override with BILLING_FIX_CUTOFF if a later rule change needs a new line.
 */
/**
 * 2793 IS A jasec-dev INVOICE NUMBER, so it must not be the preprod default.
 *
 * preprod was rebuilt 2026-09-09 and restarted its numbering at 000001, so EVERY
 * preprod invoice is below 2793 and every post-fix assertion here excused itself
 * as "pre-fix". Observed 2026-09-16: "no POST-FIX 30 kWh invoice in the sample -
 * all 10 predate 2793", while preprod was in fact billing 1,943.40 correctly.
 * The cutoff exists to protect UNCORRECTED HISTORY from a newer rule; preprod has
 * no such history before its rebuild, so 1 is the honest boundary there.
 *
 * Fourth instance of a dev constant applied to preprod (see also
 * FIRST_V5_INVOICE in ts-02, JASEC_CYCLE_CHARGE in the notification suite).
 * Any cutoff expressed as an invoice NUMBER has to be per tenant.
 */
// 2026-09-30: default flipped to "dev only". The old form named the one tenant
// that should NOT use 2793 (preprod), so every NEW tenant - JASEC prod first -
// silently inherited dev's number and excused all of its invoices. Only dev
// has the uncorrected pre-fix history; every other tenant asserts everything.
const TENANT = (process.env.TEST_ENV ?? '').trim();
const FIRST_POST_FIX_INVOICE = Number(
  process.env.BILLING_FIX_CUTOFF ?? (TENANT === 'jasec-dev' ? '2793' : '1'),
);

/** Split a sample into invoices issued under the current rules, and older ones. */
function splitAtFix<T extends { inv: InvoiceDoc }>(cands: T[]): { post: T[]; pre: T[] } {
  const post: T[] = [];
  const pre: T[] = [];
  for (const c of cands) {
    const n = Number(String(c.inv.id).replace(/\D/g, ''));
    // An unparseable id is treated as CURRENT, so a naming change fails loudly
    // rather than silently excusing every invoice from the check.
    if (Number.isFinite(n) && n > 0 && n < FIRST_POST_FIX_INVOICE) pre.push(c);
    else post.push(c);
  }
  return { post, pre };
}

/** Print the uncorrected-history sample without failing on it. */
function reportPreFix<T extends { inv: InvoiceDoc }>(
  pre: T[], what: string, detail: (c: T) => string,
): void {
  if (!pre.length) return;
  console.log(
    `[pre-fix] ${pre.length} invoice(s) predate ${FIRST_POST_FIX_INVOICE} and are EXCLUDED from the ` +
    `${what} assertion - they were issued under the old rules and were never corrected ` +
    `(business decision, team note 2026-09-10):\n  ` +
    pre.map((c) => `${c.inv.id}: ${detail(c)}`).join('\n  '),
  );
}

/** Required on every invoice, whole-cycle or slice. ALP is capped; these are not. */
const ENERGY_LINES = ['ENERGIA', 'CVG ENERGIA'];
/** The taxable base excludes ALUMBRADO PUBLICO. */
const BASE_LINES = ['ENERGIA', 'CVG ENERGIA', 'CVG ALUMBRADO PUBLICO'];

interface Band {
  name: string; lo: number; hi: number;
  icb: boolean; iva: boolean;
  /** Above 1750 kWh the ICB base stops growing. */
  icbCapped?: boolean;
  /** Scenario-doc case this band comes from. */
  doc: string;
  /**
   * EPDP-348 sub-task number, used as the `@tc-nnn` tag. A bare string, so the
   * renumber tool (which matches `TC-nn` / `@tc-nn`) never sees it: UPDATE BY HAND
   * on every renumber. Was 2 behind on 2026-10-01; must equal the INDEX row.
   */
  tc: string;
}

const BANDS: Band[] = [
  { name: '0-30',       lo: 0,     hi: 30,       icb: false, iva: false, doc: 'TC20', tc: '131' },
  { name: '31-100',     lo: 31,    hi: 100,      icb: false, iva: false, doc: 'TC21', tc: '132' },
  { name: '101-200',    lo: 101,   hi: 200,      icb: true,  iva: false, doc: 'TC22', tc: '133' },
  { name: '201-280',    lo: 201,   hi: 280,      icb: true,  iva: false, doc: 'TC23', tc: '134' },
  { name: '281-1750',   lo: 281,   hi: 1750,     icb: true,  iva: true,  doc: 'TC24', tc: '135' },
  { name: '1751-50000', lo: 1751,  hi: 50000,    icb: true,  iva: true,  doc: 'TC25', tc: '136', icbCapped: true },
  { name: '50001+',     lo: 50001, hi: Infinity, icb: true,  iva: true,  doc: 'TC26', tc: '137', icbCapped: true },
];

/**
 * The prepaid monthly fixed charge: ANY cycle consuming 0..30 kWh bills this flat.
 *
 *   "Diseno Funcional y Tecnico - Cuentas, Pricing & Taxation.docx" 3.4.1:
 *   "para un cliente prepago el cargo fijo mensual seria de 1943,40 CRC"
 *
 * 30 x the block-1 unit rates, which is how `run-mdr-fixedcharge.sh` derives it
 * (it prints `1943.40 = 30 x (62.69 + -0.58 + 2.67 + 0)`):
 *
 *   ENERGIA            30 x  62.69 =  1880.70
 *   CVG ENERGIA        30 x  -0.58 =   -17.40   <- a CREDIT
 *   ALUMBRADO PUBLICO  30 x   2.67 =    80.10
 *   CVG ALP            30 x   0.00 =     0.00
 *                                    --------
 *                                     1943.40
 *
 * WAS 2319.30 until 2026-09-08, which was WRONG: the four *-MIN-TRUEUP rates were
 * seeded at 77.31/kWh instead of 64.78 on 2026-06-04/05 (and CVG ENERGIA inverted
 * from a credit to a charge), so every sub-30 cycle billed 30 x 77.31 = 2319.30.
 * 2,345 invoices on jasec-dev still carry that figure. The rates were corrected on
 * dev 2026-09-07, so asserting 2319.30 now fails for the wrong reason.
 *
 * KNOWN OPEN DISCREPANCY, restated 2026-09-08: EIGHT sub-30 invoices on dev total
 * 1960.80, which is 30 x (62.69 + 2.67) - the CVG ENERGIA credit line posts 0.00
 * instead of -17.40, leaving them exactly 17.40 high. Superseded 2026-10-08: those
 * eight predate FIRST_POST_FIX_INVOICE, so splitAtFix() now EXCLUDES them from the
 * subtotal assertion and reportPreFix() only prints them (uncorrected history, a
 * business decision). A NEW invoice at 1960.80 still fails, and that failure is the
 * point. Do not "fix" it by moving the constant.
 *
 * DO NOT read that as "the true-up never fires" - an earlier version of this comment
 * implied it and it is FALSE. TC53 re-run on a clean account (ACT-100831) on
 * 2026-09-08 bills 1943.40 with all four true-up lines and
 * `TRUEUP_CVG_ENE actual=-17.4000`. The same offer produces -17.40 on one
 * zero-consumption cycle (bill unit 4928) and 0.00 on another (bill unit 4901),
 * with identical ACTIVE discount units and a single `discount_offer_aud` revision -
 * so it is runtime state, not configuration.
 */
const EXPECTED_TOTAL_AT_30_KWH = 1943.40;
/**
 * JASEC prepaid includes the first 30 kWh in the monthly fixed charge, so a cycle
 * that metered LESS is still billed 30. An invoice may therefore lawfully exceed
 * its own cycle accumulator, but only up to this figure.
 */
const MIN_BILLED_KWH = 30;

/** An invoice plus the consumption figures the thresholds are judged against. */
interface Candidate {
  inv: InvoiceDoc;
  /** kWh this invoice billed — sum of its ENERGIA blocks. */
  invoiceKwh: number;
  /** Cycle-to-date kWh from the KWH accumulator. Null when unavailable. */
  cycleKwh: number | null;
  /** What the band is decided on: the accumulator, else the invoice. */
  bandKwh: number;
  /**
   * True when this invoice bills the whole cycle, i.e. the account was billed
   * once. Several rules only hold in that case — see `WHOLE-CYCLE ONLY` below.
   */
  wholeCycle: boolean;
}

/**
 * WHOLE-CYCLE ONLY — why two assertions are conditional.
 *
 * When an account is billed more than once in a cycle, each invoice carries a
 * SLICE and two otherwise-sound rules stop holding. Both were observed on
 * ACT-100145, which was billed twice (`000160` then `000351`):
 *
 *   ALUMBRADO PUBLICO is capped at ~50,000 units. `000160` billed qty
 *   49,999.995 and exhausted the cap, so `000351` has no ALP line at all. That
 *   is the cap working, not a missing charge line.
 *
 *   The taxable base on a slice is not the slice's own line total. `000160`
 *   bills 66,266 of a 129,445 kWh cycle and its IVA base (1,413,787.22, spread
 *   over 62 detail rows from several rating events) is far below its
 *   ENE+ENECVG total of 5,034,771.86.
 *
 * Asserting either on a part-cycle invoice produces a false defect, so both are
 * skipped there and the count is logged.
 */
const partCycleNote = (cands: Candidate[]) => {
  const n = cands.filter((c) => !c.wholeCycle).length;
  return n ? ` (${n} part-cycle invoice(s) excluded — see WHOLE-CYCLE ONLY)` : '';
};

let gql: BillingGqlHelper;
const buckets = new Map<string, Candidate[]>();
/** Invoices the scan saw at all. Zero means the tenant has never billed. */
let scanned = 0;

/**
 * An empty tenant is not a defect. Preprod has never run a billing cycle
 * (`searchInvoiceUnits` returns 0), so every band is empty there. Say so
 * explicitly rather than leaving "no invoices in the band" to be misread.
 */
const noDataHint = () => scanned === 0
  ? ' — NOTE: this tenant returned ZERO invoices in total, so no billing cycle has run here yet.'
    + ' That is an environment state, not a product defect.'
  : '';

const taxableBase = (inv: InvoiceDoc): number =>
  (inv.invoiceSummaryList ?? [])
    .filter((l) => BASE_LINES.includes(lineName(l.name)))
    .reduce((a, l) => a + num(l.amount), 0);

const taxesOf = (inv: InvoiceDoc, cat: 'BOM' | 'IVA') =>
  (inv.invoiceTaxList ?? []).filter((t) => t.taxCategory === cat);

/** Consistent label so every failure message says which figure was used. */
const label = (c: Candidate) =>
  `${c.inv.id} (${c.inv.accountId}, invoice ${c.invoiceKwh} kWh` +
  (c.cycleKwh !== null && !near(c.cycleKwh, c.invoiceKwh) ? `, cycle ${c.cycleKwh} kWh` : '') + ')';

test.beforeAll(async () => {
  gql = new BillingGqlHelper();

  // ONE scan for all seven bands — a per-band scan would page the tenant seven
  // times, and Playwright re-runs beforeAll after each failure.
  const all: InvoiceDoc[] = [];
  let truncated = false;
  for (let page = 1; page <= PAGES; page++) {
    const batch = await gql.searchInvoices(page, 200);
    if (!batch.length) break;
    all.push(...batch);
    // A full last page means there is very likely more behind it. Say so — a
    // truncated scan makes a band look EMPTY rather than unscanned, which reads
    // as "no data for this band" and hides a freshly billed invoice. That is
    // exactly what happened on 2026-09-10 at the old 8-page cap.
    if (page === PAGES && batch.length === 200) truncated = true;
  }
  scanned = all.length;
  console.log(`[scan] ${scanned} invoices visible on this tenant`);
  if (truncated) {
    console.log(
      `[scan] *** TRUNCATED at the ${PAGES}-page cap. There are more invoices than this ` +
      `run looked at, so a band reporting "asserting on 0" may simply be unscanned ` +
      `rather than empty. Re-run with BILLING_BAND_PAGES=<higher> before drawing any ` +
      `conclusion from an empty band.`,
    );
  }

  // Only invoices carrying an ENERGIA line can be banded at all.
  const energy = all
    .map((inv) => ({ inv, invoiceKwh: energiaKwh(inv) }))
    .filter((x): x is { inv: InvoiceDoc; invoiceKwh: number } => x.invoiceKwh !== null);

  /**
   * STRATIFY BEFORE RESOLVING ACCOUNTS, or the rare bands starve.
   *
   * 1,379 of ~1,450 invoices sit at 0–30 kWh, so any "first N invoices" cut is
   * almost entirely the bottom band and the 1751+ bands come back empty. Pick
   * accounts per band first, using the account's largest invoice as a cheap
   * proxy for its accumulator, then resolve only those.
   */
  /**
   * STRATIFY BY THE NEWEST INVOICE'S kWh — the same invoice that will be judged.
   *
   * This used to stratify by `Math.max(...)` over ALL the account's invoices while
   * the later selection keeps only the NEWEST one. Two different invoices, so an
   * account whose consumption has since dropped is filed under a band it can no
   * longer supply, and then matches nothing:
   *
   *   ACT-100831  max 105 kWh (002781)  -> filed under 101-200
   *               newest 30 kWh (002793) -> not in 101-200, and never offered to 0-30
   *   ACT-100825  max 220 kWh (002760)  -> filed under 201-280
   *               newest 35 kWh (002784) -> not in 201-280, and never offered to 31-100
   *
   * That is why 201-280 read as empty, and why the three post-fix invoices at
   * 1,943.40 were invisible on the day the fix landed. Both are the same fault.
   * File each account under the band its CURRENT invoice belongs to.
   */
  const newestInvoiceNo = new Map<string, number>();
  const byAccount = new Map<string, number>();
  for (const { inv, invoiceKwh } of energy) {
    const n = Number(String(inv.id).replace(/\D/g, ''));
    if (!Number.isFinite(n)) continue;
    if (n >= (newestInvoiceNo.get(inv.accountId) ?? -1)) {
      newestInvoiceNo.set(inv.accountId, n);
      byAccount.set(inv.accountId, invoiceKwh);
    }
  }

  /**
   * PREFER THE NEWEST ACCOUNTS — a regression suite must look at current behaviour.
   *
   * This used to iterate `byAccount` in Map order, which is INSERTION order, which
   * is the order the scan returned — oldest first. So each band filled its quota
   * from the OLDEST accounts on the tenant and never reached the recent ones.
   *
   * That is backwards, and on 2026-09-11 it hid the thing under test: the sub-30
   * fixes landed and produced invoices 002793/4/5 at the correct 1,943.40, but all
   * ten 0-30 candidates were pre-fix invoices from the 2,319.30 era. The band
   * reported the OLD figures as though nothing had been fixed.
   *
   * Rank each account by its NEWEST invoice number and take from the top.
   * `newestInvoiceNo` is built above, alongside the band stratification, so the
   * two always agree on which invoice "newest" means.
   */
  const accountsNewestFirst = [...byAccount.entries()]
    .sort((a, c) => (newestInvoiceNo.get(c[0]) ?? 0) - (newestInvoiceNo.get(a[0]) ?? 0));

  const chosen = new Set<string>();
  for (const b of BANDS) {
    let picked = 0;
    for (const [acct, maxKwh] of accountsNewestFirst) {
      if (picked >= SAMPLE * 2 || chosen.size >= ACCOUNT_BUDGET) break;
      if (chosen.has(acct) || maxKwh < b.lo || maxKwh > b.hi) continue;
      chosen.add(acct);
      picked++;
    }
  }

  // Category + accumulator for all of them, batched — see primeAccounts.
  await gql.primeAccounts([...chosen]);

  /**
   * ONE INVOICE PER ACCOUNT — the newest.
   *
   * The accumulator read here is TODAY's value, so it only describes the account's
   * latest cycle. Applying it to an older invoice is meaningless: with strict mode
   * on, ACT-100395's five historical 30 kWh invoices were each judged against a
   * 290 kWh accumulator and reported as missing ICB. They are not — the invoices
   * predate the consumption.
   *
   * Keeping only the newest invoice also stops one chatty account filling a whole
   * bucket; before this, the 281-1750 sample was two accounts repeated five times.
   */
  const newestPerAccount = new Map<string, { inv: InvoiceDoc; invoiceKwh: number }>();
  for (const row of energy) {
    const prev = newestPerAccount.get(row.inv.accountId);
    const newer = !prev
      || String(row.inv.invoiceDate ?? '') > String(prev.inv.invoiceDate ?? '')
      || (String(row.inv.invoiceDate ?? '') === String(prev.inv.invoiceDate ?? '') && row.inv.id > prev.inv.id);
    if (newer) newestPerAccount.set(row.inv.accountId, row);
  }
  /**
   * SORT NEWEST FIRST — sampling fault #4, and a sibling of the account-ranking
   * fault fixed above. `accountsNewestFirst` ranks which ACCOUNTS get chosen, but
   * this list was left in `newestPerAccount` insertion order, which is scan order.
   * The band loop below breaks at `SAMPLE`, so each band filled its 10 slots from
   * the OLDEST chosen accounts and a freshly billed invoice could never get in
   * once a band was full.
   *
   * Measured 2026-09-11: after billing invoice 002797 (ACT-100858, the newest
   * invoice on the tenant and a genuine sub-30 cycle at 1,943.40), the 0-30 band
   * still reported `asserting on 10` with all ten predating 2793, so the assertion
   * stayed BLOCKED for want of a subject it already had. 002796 reached the
   * 201-280 band only because that band had no competition for the slot.
   *
   * Ranking by the same numeric invoice key as `newestInvoiceNo` keeps choosing
   * and sampling in agreement.
   */
  const invNo = (id: string) => Number(String(id).replace(/\D/g, '')) || 0;
  const latest = [...newestPerAccount.values()].sort(
    (a, b) => invNo(b.inv.id) - invNo(a.inv.id),
  );

  /**
   * HYDRATE THE BILL PERIOD — trap 5, and it silently voided two assertions.
   *
   * `searchInvoiceUnits` (the PAGED query this sweep scans with) returns
   * `startDate` and `endDate` as **null for every invoice**, even though both are
   * in the selection set. Only `getInvoiceUnitById` populates them. Measured
   * 2026-09-11: page 1 came back with `startDate=null` on all five rows, while a
   * direct fetch of the same invoice 002725 gave `2028-07-01`.
   *
   * Consequence, before this fix: `cycleKwhForPeriod(acct, null)` returned null on
   * its own `!periodStart` guard, so `wholeCycle` was FALSE for all 42 candidates
   * in all 7 bands. That made
   *   - the taxable-base assertion run on ZERO invoices and pass vacuously, and
   *   - the structure assertion fall back to the relaxed ENERGY_LINES set
   *     everywhere instead of REQUIRED_LINES,
   * while banding quietly fell back to the invoice's own kWh. The giveaway was
   * `drifted` printing 0 at the same time as N part-cycle exclusions — only
   * possible if cycleKwh was null, never if it merely disagreed.
   *
   * So re-fetch each candidate individually. Bounded by ACCOUNT_BUDGET and cached
   * across bands, and the hydrated doc replaces the paged one so every downstream
   * assertion sees a real period.
   */
  const hydrated = new Map<string, InvoiceDoc>();
  const hydrate = async (inv: InvoiceDoc): Promise<InvoiceDoc> => {
    const key = String(inv.id);
    if (!hydrated.has(key)) hydrated.set(key, await gql.getInvoice(key));
    return hydrated.get(key) ?? inv;
  };

  for (const b of BANDS) {
    const cands: Candidate[] = [];
    for (const { inv: paged, invoiceKwh } of latest) {
      if (cands.length >= SAMPLE) break;
      if (!chosen.has(paged.accountId)) continue;
      if ((await gql.accountCategory(paged.accountId)) !== 'PREPAID') continue;  // trap 3
      const inv = await hydrate(paged);                                          // trap 5
      // Accumulator for THIS invoice's bill period, not "the" accumulator — an
      // account has one row per cycle and today's is usually a different one.
      const cycleKwh = await gql.cycleKwhForPeriod(inv.accountId, inv.startDate); // trap 2
      const bandKwh = cycleKwh ?? invoiceKwh;
      const wholeCycle = cycleKwh !== null && near(cycleKwh, invoiceKwh);
      if (bandKwh >= b.lo && bandKwh <= b.hi)
        cands.push({ inv, invoiceKwh, cycleKwh, bandKwh, wholeCycle });
    }
    buckets.set(b.name, cands);

    const drifted = cands.filter((c) => c.cycleKwh !== null && !near(c.cycleKwh, c.invoiceKwh)).length;
    console.log(
      `[band ${b.name}] asserting on ${cands.length}` +
      (drifted ? ` (${drifted} billed more than once in the cycle — banded on the accumulator)` : ''),
    );
  }
  if (!STRICT) console.log(`\n[threshold presence] REPORT-ONLY. ${STRICT_OFF_REASON}\n`);
});

for (const b of BANDS) {
  test.describe(`Monthly invoice — ${b.name} kWh (scenario doc ${b.doc})`,
    { tag: ['@jasec', '@billing', `@band-${b.name}`, `@tc-${b.tc}`] }, () => {

    // Every test in this band loops over the band's invoices. With none, each
    // loop ran zero times and the test PASSED having checked nothing - 37 such
    // passes on the empty JASEC prod tenant (2026-09-30). One guard here covers
    // every sibling, including ones added later.
    test.beforeEach(() => {
      const inv = buckets.get(b.name) ?? [];
      blockedIf(inv.length === 0, `no PREPAID invoices in the ${b.name} kWh band on this tenant${noDataHint()}`);
    });

    test('band has prepaid invoices to assert on', async () => {
      const inv = buckets.get(b.name) ?? [];
      // An empty band means this tenant has never issued an invoice in this kWh
      // range - there is nothing to check, so the band is UNPROVEN, not wrong.
      // Reported as a failure it read as 'invoice banding is broken', which on a
      // tenant with zero invoices overall accuses a billing run that never
      // happened. The sibling tests in this describe already iterate an empty
      // list and pass vacuously, so this gate is the only honest place to say so.
      if (blockedIf(inv.length === 0,
        `no PREPAID invoices in the ${b.name} kWh band on this tenant${noDataHint()}`)) return;
      expect(inv.length).toBeGreaterThan(0);
    });

    test('structure: the JASEC charge lines are present', async () => {
      // POST-FIX ONLY. The CVG ENERGIA line was absent on invoices issued before
      // 2026-09-10 (the CVG true-up posted 0.00 and a zero line is not rendered).
      // Those invoices were never corrected - the team's 2026-09-10 note calls
      // that a business decision - so holding them to the current rule keeps this
      // permanently red for history nobody intends to change. Assert the rule
      // where the rule applied; report the rest.
      const allCands = buckets.get(b.name) ?? [];
      const { post: cands, pre } = splitAtFix(allCands);
      reportPreFix(pre, 'charge lines', (c) =>
        `[${[...new Set((c.inv.invoiceSummaryList ?? []).map((l) => lineName(l.name)))].join(', ')}]`);
      const bad: string[] = [];
      for (const c of cands) {
        const names = (c.inv.invoiceSummaryList ?? []).map((l) => lineName(l.name));
        // ALUMBRADO PUBLICO is capped, so a part-cycle invoice can legitimately
        // have none left to bill. The energy lines are required on every invoice.
        const required = c.wholeCycle ? REQUIRED_LINES : ENERGY_LINES;
        const missing = required.filter((r) => !names.includes(r));
        if (missing.length) {
          bad.push(`${label(c)}: missing ${missing.join(', ')} — has [${[...new Set(names)].join(', ')}]`);
        }
      }
      console.log(`[${b.name}] structure checked on ${cands.length}${partCycleNote(cands)}`);
      expect(bad, `invoices missing charge lines the scenario doc requires:\n${bad.join('\n')}`).toEqual([]);
    });

    test('arithmetic: quantity x unitPrice == amount, and the totals reconcile', async () => {
      const bad: string[] = [];
      for (const { inv } of buckets.get(b.name) ?? []) {
        for (const l of inv.invoiceSummaryList ?? []) {
          if (!near(num(l.quantity) * num(l.unitPrice), num(l.amount)))
            bad.push(`${inv.id} line ${l.index}: ${l.quantity} x ${l.unitPrice} != ${l.amount}`);
        }
        const st = summaryTotal(inv);
        if (!st) { bad.push(`${inv.id}: no invoiceSummaryTotal`); continue; }
        const lineSum = (inv.invoiceSummaryList ?? []).reduce((a, l) => a + num(l.amount), 0);
        const taxSum = (inv.invoiceTaxList ?? []).reduce((a, t) => a + num(t.amount), 0);
        if (!near(lineSum, num(st.summarySubTotal)))
          bad.push(`${inv.id}: lines ${lineSum.toFixed(2)} != subtotal ${st.summarySubTotal}`);
        if (!near(taxSum, num(st.taxSubTotal)))
          bad.push(`${inv.id}: taxes ${taxSum.toFixed(2)} != taxSubTotal ${st.taxSubTotal}`);
        if (!near(num(st.summarySubTotal) + num(st.taxSubTotal), num(st.total)))
          bad.push(`${inv.id}: subtotal + tax != total (${st.total})`);
        if (!near(num(inv.total), num(st.total)))
          bad.push(`${inv.id}: header total ${inv.total} != printed ${st.total}`);
      }
      expect(bad, `arithmetic problems:\n${bad.join('\n')}`).toEqual([]);
    });

    test('sanity: an invoice never bills more kWh than the cycle accumulated', async () => {
      // Catches a banding figure that is nonsense in the other direction — the
      // accumulator is the cycle total, so a single invoice cannot exceed it.
      //
      // ONE LAWFUL EXCEPTION: the 30 kWh monthly minimum. A cycle that metered
      // less is still billed 30, so the invoice legitimately exceeds its own
      // accumulator. Invoice 002797 (ACT-100858) is exactly that - cycle 25 kWh,
      // invoice 30 kWh, 1,943.40. This assertion was INERT until the bill period
      // was hydrated (cycleKwh was always null), so the exception never had to be
      // stated; the moment cycleKwh became real it failed on CORRECT behaviour.
      // Same false failure the (g) guard in ts-06-billing-run.spec.ts had.
      const bad: string[] = [];
      for (const c of buckets.get(b.name) ?? []) {
        if (c.cycleKwh === null) continue;
        const ceiling = Math.max(c.cycleKwh, MIN_BILLED_KWH);
        if (c.invoiceKwh > ceiling + CENT)
          bad.push(
            `${label(c)}: invoice kWh ${c.invoiceKwh} exceeds ${ceiling} ` +
            `(accumulator ${c.cycleKwh}, monthly minimum ${MIN_BILLED_KWH})`,
          );
      }
      expect(bad, `invoice consumption above the cycle accumulator:\n${bad.join('\n')}`).toEqual([]);
    });

    /* Rate and base are true whenever a tax is present, on any build. Hard. */
    test('any ICB present is charged at 1.75%, any IVA at 13%', async () => {
      const bad: string[] = [];
      for (const c of buckets.get(b.name) ?? []) {
        // NOT `near()`: that is a two-CENT window meant for money, and on a rate
        // it accepted any ICB from 0% to 3.75% and any IVA from 11% to 15%, so it
        // could not catch a wrong rate. Rates are stored to 6 decimals; every row
        // on jasec-dev reads exactly 0.017500 / 0.130000 (302 rows, 2026-09-29).
        for (const t of taxesOf(c.inv, 'BOM'))
          if (!nearRate(num(t.taxRate), 0.0175)) bad.push(`${label(c)}: ICB rate ${t.taxRate}, expected 0.0175`);
        for (const t of taxesOf(c.inv, 'IVA'))
          if (!nearRate(num(t.taxRate), 0.13)) bad.push(`${label(c)}: IVA rate ${t.taxRate}, expected 0.13`);
      }
      expect(bad, `wrong tax rate:\n${bad.join('\n')}`).toEqual([]);
    });

    test('taxable base == ENERGIA + CVG ENERGIA + CVG ALUMBRADO PUBLICO (ALP excluded)', async () => {
      const cands = buckets.get(b.name) ?? [];
      // A slice's base is not its own line total, so whole-cycle only.
      const whole = cands.filter((c) => c.wholeCycle);
      // PRE-FIX INVOICES CANNOT BE JUDGED BY THIS RULE. Billing never re-rates, so
      // an invoice issued before the tax-base fix carries the old base for ever.
      // 002073 (ACT-100004) is the live example: base 4,612.89 against a computed
      // 23,503.02, a 18,890.13 gap. Its sibling assertions (charge lines, the
      // 30 kWh subtotal) already split at FIRST_POST_FIX_INVOICE; this one never
      // did, because it was inert until the bill period was hydrated and so never
      // had the chance to fail. Every POST-fix invoice checked passes the rule.
      const { post, pre } = splitAtFix(whole);
      reportPreFix(pre, 'taxable base', (c) =>
        [...taxesOf(c.inv, 'BOM'), ...taxesOf(c.inv, 'IVA')]
          .map((t) => `${t.taxCategory} base ${t.taxableAmount}`)
          .join(' | ') || '(no tax rows)');
      const bad: string[] = [];
      for (const c of post) {
        const expected = taxableBase(c.inv);
        for (const t of [...taxesOf(c.inv, 'BOM'), ...taxesOf(c.inv, 'IVA')]) {
          // Above 1750 kWh the ICB base is deliberately capped and will be
          // lower than the computed base — checked by its own test below.
          if (b.icbCapped && t.taxCategory === 'BOM') continue;
          if (!nearBase(num(t.taxableAmount), expected)) {
            bad.push(`${label(c)} ${t.taxCategory}: base ${t.taxableAmount} != ENE+ENECVG+ALPCVG ` +
                     `${expected.toFixed(2)} (difference ${(num(t.taxableAmount) - expected).toFixed(2)})`);
          }
        }
      }
      console.log(`[${b.name}] taxable base checked on ${post.length}${partCycleNote(cands)}`);
      expect(bad, `taxable base does not match the documented rule:\n${bad.join('\n')}`).toEqual([]);
    });

    if (b.icbCapped) {
      test('ICB base is CAPPED at the 1750 kWh amount, not the full consumption', async () => {
        const bad: string[] = [];
        for (const c of buckets.get(b.name) ?? []) {
          const icb = taxesOf(c.inv, 'BOM');
          if (!icb.length) continue;                       // absence handled by the presence test
          const full = taxableBase(c.inv);
          if (num(icb[0].taxableAmount) >= full - CENT)
            bad.push(`${label(c)}: ICB base ${icb[0].taxableAmount} is NOT capped — equals the full base ${full.toFixed(2)}`);
        }
        expect(bad, `ICB cap not applied above 1750 kWh:\n${bad.join('\n')}`).toEqual([]);

        // "Below the full base" alone accepts ANY reduction, so assert the cap
        // VALUE too - on whole-cycle post-fix invoices only. A slice of a cycle
        // billed twice carries only part of the base, and pre-fix invoices were
        // capped under the old rates (108,854.36 / 129,492.80 / 133,035 on
        // jasec-dev, all below 2793) and were never re-rated.
        const { post, pre } = splitAtFix((buckets.get(b.name) ?? []).filter((c) => c.wholeCycle));
        reportPreFix(pre, 'ICB cap value', (c) =>
          taxesOf(c.inv, 'BOM').map((t) => `ICB base ${t.taxableAmount}`).join(' | ') || '(no ICB row)');
        const wrongCap: string[] = [];
        let judged = 0;
        for (const c of post) {
          const icb = taxesOf(c.inv, 'BOM');
          if (!icb.length) continue;
          judged++;
          if (!nearBase(num(icb[0].taxableAmount), ICB_CAP_BASE))
            wrongCap.push(`${label(c)}: ICB base ${icb[0].taxableAmount}, expected the 1750 kWh cap ${ICB_CAP_BASE}`);
        }
        console.log(`[${b.name}] ICB cap value checked on ${judged}`);
        expect(wrongCap, `ICB base is capped at the wrong amount:\n${wrongCap.join('\n')}`).toEqual([]);
      });
    }

    /* Presence against the threshold — gated, see trap 4. */
    for (const [cat, want, rule] of [
      ['BOM', b.icb, 'ICB above 100 kWh'],
      ['IVA', b.iva, 'IVA above 280 kWh'],
    ] as Array<['BOM' | 'IVA', boolean, string]>) {
      test(`${cat} is ${want ? 'APPLIED' : 'NOT applied'} — ${rule}${STRICT ? '' : ' (report-only)'}`, async () => {
        const bad: string[] = [];
        for (const c of buckets.get(b.name) ?? []) {
          const has = taxesOf(c.inv, cat).length > 0;
          if (has !== want) bad.push(`${label(c)}: ${cat} ${has ? 'applied' : 'MISSING'}, banded on ${c.bandKwh} kWh`);
        }
        if (bad.length) console.log(`[${b.name}] ${cat} threshold mismatches:\n  ${bad.join('\n  ')}`);
        test.skip(!STRICT, STRICT_OFF_REASON);
        expect(bad, `${cat} does not match the threshold rule:\n${bad.join('\n')}`).toEqual([]);
      });
    }

    if (b.name === '0-30') {
      test(`an invoice billing exactly 30 kWh subtotals ${EXPECTED_TOTAL_AT_30_KWH} CRC`, async () => {
        const at30 = (buckets.get(b.name) ?? []).filter((c) => c.invoiceKwh === 30);
        // Same reasoning as the band gate above: no 30 kWh invoice means the
        // 1943.4 subtotal was never computed here, not that it is wrong.
        if (blockedIf(at30.length === 0,
          `no invoice billing exactly 30 kWh in the sample${noDataHint()}`)) return;

        // BILLING NEVER RE-RATES, so an invoice cannot be judged by a rule that
        // post-dates it. Split the sample and assert only the post-fix half.
        const { post, pre } = splitAtFix(at30);
        reportPreFix(pre, 'subtotal', (c) => String(summaryTotal(c.inv)?.summarySubTotal));
        // UNMET PRECONDITION, NOT A FAILURE. The fix landed 2026-09-10 and the
        // post-fix invoices (002793/4/5) are correct at 1,943.40 - verified in SQL -
        // but none of them belongs to a 0-30 CYCLE: ACT-100831's cycle consumed
        // 105 kWh, so its 30 kWh true-up invoice is a slice of a 101-200 cycle and
        // is banded there. Until a fresh zero-consumption cycle is billed there is
        // simply nothing here to judge, and failing on that would report absent test
        // data as a product defect.
        const noPostFix =
          `BLOCKED, not failed: no POST-FIX 30 kWh invoice in the sample - all ${at30.length} ` +
          `predate ${FIRST_POST_FIX_INVOICE}. The sub-30 fixes ARE in (002793/4/5 all bill ` +
          `1,943.40 with CVG -17.40), but none sits in a 0-30 CYCLE, so this assertion has ` +
          `no subject. To cover it, bill a fresh zero-consumption cycle on a private BDOM: ` +
          `run-tarif-e2e.ps1 -DocTc TC40 -Bdom <free> -StageCredit 5000, then ` +
          `run-billing-cycle-e2e.ps1 -UseAccount <acct> -StageCredit 0. ` +
          `DO NOT read this as the fix being absent.`;
        if (post.length === 0) console.log(`\n[0-30] ${noPostFix}\n`);
        test.skip(post.length === 0, noPostFix);

        const bad = post
          .filter((c) => !near(num(summaryTotal(c.inv)?.summarySubTotal), EXPECTED_TOTAL_AT_30_KWH))
          .map((c) => `${c.inv.id}: subtotal ${summaryTotal(c.inv)?.summarySubTotal} != ${EXPECTED_TOTAL_AT_30_KWH}`);
        expect(bad, `POST-FIX 30 kWh invoices not charging the minimum:\n${bad.join('\n')}`).toEqual([]);
      });
    }
  });
}
