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

/** How many accounts to sample. Override to widen a run. */
const SAMPLE = Number(process.env.BILLING_STATEMENT_ACCOUNTS ?? 8);

let gql: BillingGqlHelper;
let accounts: string[] = [];
let blockedReason: string | null = null;
const statements = new Map<string, StatementLine[]>();

test.beforeAll(async () => {
  gql = new BillingGqlHelper();

  // Pick accounts that actually have invoices, so the statement is non-trivial.
  // Sampling from the invoice list rather than a hardcoded id keeps this working
  // on any tenant and after the data churns.
  const invoices = await gql.searchInvoices(1, 200);
  const seen: string[] = [];
  for (const inv of invoices) {
    if (inv.accountId && !seen.includes(inv.accountId)) seen.push(inv.accountId);
    if (seen.length >= SAMPLE) break;
  }
  accounts = seen;
  // Do NOT throw here. An expect() inside beforeAll fails every test in the
  // file, and on a tenant with zero invoices that turned one environment fact
  // into a wall of red that looked like a statement-ledger defect. Record the
  // reason and let each test block on it instead - see the beforeEach below.
  if (accounts.length === 0) {
    blockedReason =
      'no accounts with invoices to sample. The tenant returned ZERO invoices ' +
      'overall, so no billing cycle has run here yet - an environment state, ' +
      'not a defect.';
    return;
  }

  for (const a of accounts) statements.set(a, await gql.getAccountStatement(a, 1, 50));
  console.log(`[statement] sampled ${accounts.length} accounts: ${accounts.join(', ')}`);
});

test.describe('Prepaid Account Statement — ledger integrity', { tag: ['@jasec', '@billing', '@statement'] }, () => {

  // One gate for the whole file: if the sample could not be built, no case here
  // reached the product, so all of them are BLOCKED rather than failed.
  test.beforeEach(() => { if (blockedReason) blockedIf(true, blockedReason); });

  test('a statement is returned for an account that has invoices', async () => {
    const empty = accounts.filter((a) => (statements.get(a) ?? []).length === 0);
    for (const a of accounts) {
      console.log(`  ${a}: ${(statements.get(a) ?? []).length} statement lines`);
    }
    // An account holding invoices but returning no statement lines is the
    // finding, not a test-setup problem — report which ones before failing.
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
   * account has back-dated rows and its chain is skipped with a note rather than
   * failed. Fresh accounts, and any tenant whose clock has only moved forward,
   * are unaffected and still assert normally.
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
    console.log(`[statement] chain verified on ${checked} of ${statements.size} accounts` +
      (skipped.length ? `; skipped ${skipped.join(', ')} — back-dated ledger rows, see the comment above` : ''));
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
