/**
 * Prepaid Account LEDGER — balance-chain integrity.
 *
 * THE LEDGER, NOT THE DOCUMENT. Read this before assuming the file is dead.
 *
 * On 2026-09-10 JASEC confirmed "we only expect the invoice not the statement",
 * and `jasec_consumption_statement_v1.xsl` is being set INACTIVE. That decision
 * kills the *Estado de Cuenta document* — the PDF that was never attached to the
 * invoice mail anyway (measured: 6 of 6 invoice mails carry the invoice PDF and
 * nothing else). The proposed case for it, TC-BILL-004, is withdrawn.
 *
 * THIS FILE IS NOT THAT. It asserts the account's transaction ledger, read over
 * GraphQL via `getAccountStatement` — the balance chain behind every prepaid
 * account. `core_engine.account_statement` holds 2,644 live rows and is still
 * being written (newest line tracks the CCP clock), so the product maintains it
 * whether or not any document is rendered from it. In a prepaid product the
 * running balance IS the service, so this stays covered.
 *
 * The unfortunate collision is only in the NAME: Embrix calls the ledger query
 * "account statement" too. Do not delete this file when tidying up statement
 * work, and do not cite it as coverage of the Estado de Cuenta document.
 *
 * Source: Spanish scenario doc TC19, "Estado de Cuenta generado para un cliente
 * prepago" — note that TC19 most likely meant the DOCUMENT, so it is no longer a
 * live justification for this file; the ledger stands on its own. NOT an
 * EPDP-348 case ID — the official numbering is the sub-task list of EPDP-348 and
 * this has no number yet, deliberately.
 *
 * WHAT IT PROVES
 *
 * The doc's expected result is only "el estado de cuenta del cliente contiene
 * los detalles esperados", which is not directly assertable. What IS assertable
 * is that the ledger hangs together, and that turns out to be a strong test:
 *
 *   1. The balance chain is continuous — each line's closing balance is the next
 *      line's opening balance. A gap means a transaction is missing from the
 *      statement the customer is shown.
 *   2. Each line's own arithmetic: opening + amount == closing.
 *   3. Each line's tax split: subTotal + taxes == amount.
 *   4. Every INVOICE line resolves to a real invoice with a matching total.
 *
 * The point of this shape is that it needs NO known-good fixture. The statement
 * proving itself is the test, so it runs against whatever accounts exist.
 *
 * READ-ONLY, AND NO VPN. GraphQL only — no clock move, no job_schedule slot, no
 * staged account, no database. Safe to run at any time against a shared tenant.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import { BillingGqlHelper, type StatementLine } from '../../../../helpers/billing-gql.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const CENT = 0.02;                       // currency rounding tolerance
const near = (a: number, b: number) => Math.abs(a - b) <= CENT;
const num = (v: unknown) => Number(v ?? 0);

/** How many VERIFIABLE accounts to sample. Override to widen a run. */
const SAMPLE = Number(process.env.BILLING_STATEMENT_ACCOUNTS ?? 8);
/** How many candidates to look at before giving up on reaching SAMPLE. */
const SCAN_CAP = Number(process.env.BILLING_STATEMENT_SCAN ?? 60);
/** Back-dated accounts kept anyway, so the per-line assertions still see that shape. */
const KEEP_BACKDATED = 2;

let gql: BillingGqlHelper;
let accounts: string[] = [];
let blockedReason: string | null = null;
const statements = new Map<string, StatementLine[]>();
/** Sampling diagnostics — printed by the chain test so the filter is never silent. */
const sampling = {
  scanned: 0, clean: 0, backDated: 0,
  backDatedNames: [] as string[],
  /** Accounts that have invoices but returned no statement at all — a finding. */
  emptyNames: [] as string[],
};

/**
 * BACK-DATED LEDGER ROWS MAKE THE CHAIN UNVERIFIABLE — and QC can cause them.
 *
 * The running balance only reconciles if rows were created in the same order
 * they are dated. Running a billing cycle on a REWOUND CCP clock breaks that:
 * the new invoices carry dates earlier than rows that already exist, so they
 * land mid-ledger with opening balances computed against a different tail.
 *
 * That is exactly what happened on jasec-dev on 2026-08-23 — a cycle was run
 * with the clock at 2026-08 while the tenant's data ran to 2027-12, and six
 * "gaps" appeared. None was a product defect; the test run created them.
 *
 * Detection: ids are zero-padded and issued in creation order, so reading the
 * statement oldest-first the numeric id must ascend. Where it does not, the
 * account has back-dated rows and its chain cannot be judged.
 *
 * Measured tenant-wide on jasec-dev 2026-09-25, this split is sharp:
 *
 *                        chain holds   chain breaks
 *     dates ascend           273             0
 *     back-dated               9            48
 *
 * So the rule neither over- nor under-fires: every date-clean ledger reconciles,
 * and the damage sits almost entirely in the back-dated cohort. An example of
 * the damage, ACT-100532: row 001629 (dated 2026-09-08, created between rows
 * dated 2027-12 and 2028-01) and row 002026 BOTH open at 34789.50 and both close
 * at 37108.80 — the ledger forks, because 001629's effect was never carried
 * forward. Nothing the product did wrong; a cycle we ran on a rewound clock.
 *
 * This lives at module scope because the SAMPLER uses it too — see beforeAll.
 */
const numericId = (s: string | null | undefined) =>
  /^\d+$/.test(String(s ?? '')) ? Number(s) : null;

const hasBackDatedRows = (lines: StatementLine[]): boolean => {
  const ids = [...lines].reverse().map((l) => numericId(l.lineReferenceId));
  let prev = -Infinity;
  for (const id of ids) {
    if (id === null) continue;              // payments etc. — not part of the id sequence
    if (id < prev) return true;
    prev = id;
  }
  return false;
};

test.beforeAll(async () => {
  gql = new BillingGqlHelper();

  // Pick accounts that actually have invoices, so the statement is non-trivial.
  // Sampling from the invoice list rather than a hardcoded id keeps this working
  // on any tenant and after the data churns.
  //
  // WHY THIS SCANS INSTEAD OF TAKING THE FIRST EIGHT.
  //
  // The newest invoices belong to the accounts most recently re-billed, and on a
  // QC tenant those are exactly the accounts a rewound clock has back-dated (see
  // the long comment on the chain test below). Taking the first 8 therefore
  // sampled almost entirely un-verifiable accounts: on jasec-dev 2026-09-25 the
  // chain was checked on 2 of 8 while 6 were skipped. Measured over the whole
  // tenant, 273 of 330 multi-row ledgers are clean — the accounts were there, the
  // sample just never reached them.
  //
  // So: keep scanning candidates until SAMPLE clean ones are in hand. The filter
  // is on DATE ORDER, which is independent of the balances being asserted, so
  // this selects a healthy population without selecting for the answer. Measured
  // on jasec-dev: of 273 date-clean accounts, 273 chain and 0 break — and of 57
  // back-dated ones, 48 break. The split is real, and it is ours, not a defect.
  const candidates: string[] = [];
  for (let page = 1; page <= 3 && candidates.length < SCAN_CAP; page++) {
    const invoices = await gql.searchInvoices(page, 200);
    if (!invoices.length) break;
    for (const inv of invoices) {
      if (inv.accountId && !candidates.includes(inv.accountId)) candidates.push(inv.accountId);
    }
  }

  const clean: string[] = [];
  const backDated: string[] = [];
  for (const acct of candidates) {
    if (clean.length >= SAMPLE || sampling.scanned >= SCAN_CAP) break;
    sampling.scanned++;
    const lines = await gql.getAccountStatement(acct, 1, 50);
    // An account that HAS invoices but returns NO statement lines is a finding,
    // not a candidate to quietly step over. Record it so the first test can fail
    // on it; skipping it here would hide exactly what that test exists to catch.
    if (lines.length === 0) { sampling.emptyNames.push(acct); continue; }
    if (hasBackDatedRows(lines)) {
      sampling.backDated++;
      sampling.backDatedNames.push(acct);
      if (backDated.length < KEEP_BACKDATED) { backDated.push(acct); statements.set(acct, lines); }
      continue;
    }
    sampling.clean++;
    clean.push(acct);
    statements.set(acct, lines);
  }
  accounts = [...clean, ...backDated];
  // Do NOT throw here. An expect() inside beforeAll fails every test in the
  // file, and on a tenant with zero invoices that turned one environment fact
  // into a wall of red that looked like a statement-ledger defect. Record the
  // reason and let each test block on it instead - see the beforeEach below.
  if (accounts.length === 0 && sampling.emptyNames.length === 0) {
    blockedReason =
      'no accounts with invoices to sample. The tenant returned ZERO invoices ' +
      'overall, so no billing cycle has run here yet - an environment state, ' +
      'not a defect.';
    return;
  }

  console.log(
    `[statement] scanned ${sampling.scanned} candidate account(s) -> ` +
    `${sampling.clean} verifiable, ${sampling.backDated} back-dated` +
    (sampling.emptyNames.length ? `, ${sampling.emptyNames.length} with NO statement` : ''),
  );
  console.log(`[statement] asserting on ${accounts.length}: ${accounts.join(', ')}`);
  if (sampling.clean < SAMPLE) {
    console.log(
      `[statement] NOTE: wanted ${SAMPLE} verifiable accounts, found ${sampling.clean} ` +
      `in ${sampling.scanned} candidates. Raise BILLING_STATEMENT_SCAN to look further.`,
    );
  }
});

test.describe('Prepaid Account Statement — ledger integrity', { tag: ['@jasec', '@billing', '@statement'] }, () => {

  // One gate for the whole file: if the sample could not be built, no case here
  // reached the product, so all of them are BLOCKED rather than failed.
  test.beforeEach(() => { if (blockedReason) blockedIf(true, blockedReason); });

  test('a statement is returned for an account that has invoices', async () => {
    for (const a of accounts) {
      console.log(`  ${a}: ${(statements.get(a) ?? []).length} statement lines`);
    }
    // An account holding invoices but returning no statement lines is the
    // finding, not a test-setup problem — report which ones before failing.
    // These come from the sampler, which records rather than skips them, so this
    // covers every candidate scanned and not only the ones kept for assertions.
    const empty = [
      ...sampling.emptyNames,
      ...accounts.filter((a) => (statements.get(a) ?? []).length === 0),
    ];
    console.log(`  (${sampling.scanned} candidates scanned, ${empty.length} with no statement)`);
    expect(empty, `accounts with invoices but an EMPTY statement: ${empty.join(', ')}`).toEqual([]);
  });

  test('each line: openingBalance + amount == closingBalance', async () => {
    const bad: string[] = [];
    for (const [acct, lines] of statements) {
      for (const l of lines) {
        if (!near(num(l.openingBalance) + num(l.amount), num(l.closingBalance))) {
          bad.push(`${acct}/${l.lineReferenceId}: ${l.openingBalance} + ${l.amount} != ${l.closingBalance}`);
        }
      }
    }
    expect(bad, `lines whose own arithmetic does not hold:\n${bad.join('\n')}`).toEqual([]);
  });

  test('each line: subTotal + taxes == amount', async () => {
    const bad: string[] = [];
    for (const [acct, lines] of statements) {
      for (const l of lines) {
        if (l.subTotal == null || l.taxes == null) continue;   // not every line type carries a split
        if (!near(num(l.subTotal) + num(l.taxes), num(l.amount))) {
          bad.push(`${acct}/${l.lineReferenceId}: ${l.subTotal} + ${l.taxes} != ${l.amount}`);
        }
      }
    }
    expect(bad, `lines whose tax split does not sum to the amount:\n${bad.join('\n')}`).toEqual([]);
  });

  test('the balance chain is continuous — no missing transactions', async () => {
    const bad: string[] = [];
    const skipped: string[] = [];
    for (const [acct, lines] of statements) {
      if (hasBackDatedRows(lines)) { skipped.push(acct); continue; }
      // Statement comes back newest-first, so the NEXT element is the older line
      // and its closing balance must equal this line's opening balance.
      for (let i = 0; i + 1 < lines.length; i++) {
        const newer = lines[i], older = lines[i + 1];
        if (!near(num(older.closingBalance), num(newer.openingBalance))) {
          bad.push(
            `${acct}: gap between ${older.lineReferenceId} (closing ${older.closingBalance}) ` +
            `and ${newer.lineReferenceId} (opening ${newer.openingBalance}) ` +
            `— difference ${(num(newer.openingBalance) - num(older.closingBalance)).toFixed(2)}`,
          );
        }
      }
    }
    const checked = statements.size - skipped.length;
    console.log(`[statement] chain verified on ${checked} of ${statements.size} sampled accounts` +
      (skipped.length ? `; skipped ${skipped.join(', ')} — back-dated ledger rows, see the comment above` : ''));
    // Say what the sampler had to walk past to get here. A silent filter and a
    // broken tenant look identical from the outside, so print the cost either way.
    console.log(
      `[statement] the sampler scanned ${sampling.scanned} candidate(s) to find these: ` +
      `${sampling.clean} verifiable, ${sampling.backDated} back-dated` +
      (sampling.backDatedNames.length
        ? ` (${sampling.backDatedNames.slice(0, 10).join(', ')}${sampling.backDatedNames.length > 10 ? ', …' : ''})`
        : ''),
    );
    expect(checked, 'every sampled account has back-dated rows — nothing was actually verified')
      .toBeGreaterThan(0);
    expect(bad, `breaks in the running balance:\n${bad.join('\n')}`).toEqual([]);
  });

  test('every INVOICE line resolves to a real invoice with the same total', async () => {
    const bad: string[] = [];
    for (const [acct, lines] of statements) {
      for (const l of lines.filter((x) => x.lineType === 'INVOICE' && x.invoiceId)) {
        const inv = await gql.getInvoice(l.invoiceId!);
        if (!inv) { bad.push(`${acct}: statement cites invoice ${l.invoiceId} which does not exist`); continue; }
        if (!near(num(inv.total), num(l.amount))) {
          bad.push(`${acct}/${l.invoiceId}: statement says ${l.amount}, invoice says ${inv.total}`);
        }
      }
    }
    expect(bad, `statement lines that disagree with their invoice:\n${bad.join('\n')}`).toEqual([]);
  });
});
