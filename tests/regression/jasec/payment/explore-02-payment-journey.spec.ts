/**
 * EXPLORATORY — Self Care payment journey (Make Payment → pay → view → verify).
 *
 * NOT PART OF THE OFFICIAL SUITE. No TC numbers: numbering comes from the
 * EPDP-348 sub-task list once a proposal is accepted, and no sub-task covers Make
 * Payment yet. Named `explore-` so it cannot be mistaken for ticketed coverage.
 *
 * SHAPE: one scenario plus two edge cases — deliberately, after a first pass that
 * split the same coverage into ten separate tests.
 *
 *   Scenario 1  the whole journey, 10 named steps, run TWICE (PlaceToPay, Pay Now)
 *   Edge 1      declined card changes nothing        — needs a DIFFERENT CARD
 *   Edge 2      approved charge on a non-CRC account — needs a DIFFERENT ACCOUNT
 *
 * The rule that decides where a check belongs: a defect visible while walking the
 * normal path is a SOFT step inside Scenario 1; a defect that needs different input
 * or a different account cannot be a step in that path and becomes an edge case.
 * Ten separate tests paid the login + account-setup cost ten times over for one
 * journey, and reported one defect per run because a failure stops the test.
 *
 * WHY SOFT CHECKS. Three known defects sit ON the happy path (steps 2, 8, 9). As
 * hard assertions, the first one would abort the journey and hide the other two.
 * `expect.soft` records the failure, lets the journey finish, and reports all three
 * from one run. The test still ends RED — a soft failure is a failure — and the
 * step names in the HTML report say which ones. Same pattern as
 * billing/explore-01-invoice-document.spec.ts.
 *
 * WHERE THE PAYABLE RECORDS COME FROM — traced, not assumed (recon: explore-01):
 *
 *   charges on the account → core_engine.transaction_unit
 *     → end-of-cycle billing job → core_engine.bill_unit
 *     → core_engine.invoice_unit (status ACTIVE, due > 0)
 *     → GraphQL `searchInvoiceUnits` → the "Select Invoices" grid
 *
 * The billing run makes the bill; what is IN it varies. Two kinds on jasec-dev:
 * monthly FIXED CHARGES (4 rows, source BILLING, items I-100003…I-100006 — e.g.
 * 2077.20 + 144.30 + 91.50 + 6.30 = 2,319.30) and RATED CONSUMPTION (many rows, type
 * USAGE source MEDIATION — e.g. ACT-100145's 252 rows → 4.8M CRC). Every bill this
 * suite has paid so far is the fixed-charge kind, because they are the small ones and
 * the target filter picks cheapest-first. Do not read a green journey as proof that a
 * consumption-derived bill pays correctly — that is untested.
 *
 * Make Payment settles invoices. Top Up — one item away in the same dropdown —
 * credits the wallet, writes no invoice and no payment row. They look alike.
 *
 * SIGN CONVENTION, read before touching a balance assertion. JASEC CRC is
 * inverted: NEGATIVE balance = credit the customer can consume, POSITIVE = debt. A
 * payment makes `balance_unit_balances.amount` go DOWN by the amount paid.
 * Customer-facing wording ("your credit went up") is the same event from the other
 * side. Assertions here use the signed DB value only.
 *
 * COST AND IRREVERSIBILITY
 *   • Scenario 1 SETTLES A REAL INVOICE against the PlaceToPay test gateway, once
 *     per channel. The invoice flips to CLOSED and cannot be re-paid, so a full run
 *     consumes two open invoices from the pool.
 *   • Edge 1 fails a payment on purpose and consumes nothing.
 *   • Edge 2 is expected to leave its invoice open (that IS the defect).
 *   • Targets are cheapest-first and capped at PAYMENT_MAX_DUE (default 20,000 CRC)
 *     so a stray run cannot charge one of the multi-million-CRC invoices that heavy
 *     MDR test accounts carry.
 *
 * KNOWN OPEN DEFECTS PINNED HERE (red is the report, not a flake):
 *   • Step 2  — the grid is EMPTY on arrival; `searchInvoiceUnits` never fires on
 *     the Activity-dropdown navigation. A reload fixes it. 7/7 runs, 4 accounts.
 *     Until it is fixed the journey MUST reload to continue, which is exactly why
 *     the check is a step rather than being hidden inside the page object.
 *   • Step 8  — Payment Method / External Id / Currency render BLANK although
 *     core_engine.payment holds all three.
 *   • Step 9  — the payment Id pill opens nothing: no popup, no download, no
 *     request, no console error. `payment.filepath` is NULL on every row on the
 *     tenant, so no receipt is ever generated — the click handler is probably not
 *     the bug. Already reported; pinned so a fix is detected.
 *   • Edge 2  — on a non-CRC account PlaceToPay approves and Embrix records
 *     nothing: no payment, invoice still ACTIVE at full due, balance unmoved, no
 *     error shown. Works on CRC, and Pay Now works on the same USD account.
 *
 * TAGS ARE PADDED (`@edge-1`, `@edge-2`). Playwright's --grep is a substring match:
 * with single-digit tags `--grep "@e1"` also selected `@e10`, which fired a real
 * gateway charge from a run meant to be read-only. Keep tags non-prefixing.
 *
 * PASS / FAIL / BLOCKED. An unmet precondition is reported as a SKIP carrying the
 * reason, never as a failure — a red test means "there is a defect", and "I could not
 * find test data" or "the VPN is down" is a different statement entirely. Three things
 * produce a BLOCKED skip: the database being unreachable, no payable account existing
 * on the environment, and the pool being used up by earlier tests in the same run. The
 * reason text says which, and what to do about it.
 *
 * NOTE ON TEST DATA. This suite FINDS a payable account; it does not create one. On a
 * clean or wiped environment every test is therefore BLOCKED rather than green. That
 * is a deliberate, documented limitation — seeding a prepaid bill means driving the
 * whole account → meter → rating → month-end-billing pipeline, which moves the
 * tenant-global clock and spends a job slot, and would make a payment-screen test fail
 * for billing reasons. See docs/JASEC_SELFCARE_PAYMENT_EXPLORATION.md
 * § "Test data and portability".
 *
 * Requires: VPN (DB), EMBRIX_USER / EMBRIX_PASSWORD via `setup`, SELFCARE_BASE_URL.
 *
 * Owner: Anh Tran (QC)
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { attachToAccountInSelfCare } from '../../../../fixtures/create-prepaid-account.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import {
  findPayableTargets,
  readAccountPaymentState,
  newPayments,
  newAropsPayments,
  moneyEquals,
  parseMoney,
  type AccountPaymentState,
  type PayableTarget,
} from '../../../../helpers/payment-db.helper';

/**
 * Leave the tenant CCP clock alone. Nothing here is date-driven — the invoices
 * already exist — and the clock is shared with everyone else on the environment.
 */
test.use({ ccpBaseline: null });

const OUT_DIR = path.join(process.cwd(), 'artifacts', 'payment-journey');
const MAX_DUE = Number(process.env.PAYMENT_MAX_DUE ?? '20000');

/** The two ways to pay from Make Payment. Same journey, different button. */
const CHANNELS = [
  { key: 'placetopay', label: 'Pay With PlaceToPay', tag: '@ptp' },
  { key: 'paynow', label: 'Pay Now (saved card)', tag: '@paynow' },
] as const;

let db: DbHelper;
let pool: PayableTarget[] = [];
const claimed = new Set<string>();

/**
 * Why the whole file cannot run, if it cannot. Empty string = fine.
 *
 * Set in beforeAll when the database is unreachable, so a dropped VPN reports as
 * BLOCKED instead of failing every test with a connection error.
 */
let environmentBlocker = '';

/**
 * Hand out an account no other test in this run has touched.
 *
 * Returns null rather than throwing: an unmet precondition is BLOCKED, not FAILED,
 * and the caller turns null into a skip with a reason. See `blockedReason`.
 *
 * Sharing an account would be wrong, not just slow: each journey closes an invoice
 * and moves a balance, so a second test on the same account would assert against
 * state the first one created. PAYMENT_ACCOUNT_ID pins one for debugging and is
 * deliberately allowed to repeat.
 */
function tryClaimAccount(): PayableTarget | null {
  if (process.env.PAYMENT_ACCOUNT_ID) {
    const pinned = pool.find((p) => p.accountId === process.env.PAYMENT_ACCOUNT_ID);
    return pinned ?? {
      accountId: process.env.PAYMENT_ACCOUNT_ID!,
      last4cc: '????',
      currency: 'UNKNOWN',
      openInvoiceCount: 1,
      smallestDue: NaN,
    };
  }
  const free = pool.find((p) => !claimed.has(p.accountId));
  if (!free) return null;
  claimed.add(free.accountId);
  return free;
}

/**
 * The BLOCKED message, naming which of the two situations it is.
 *
 * These get conflated otherwise, and they need different actions: "this environment
 * has no test data" is someone's job to fix once, "this run used it all up" just
 * needs the remaining tests run separately.
 */
function blockedReason(): string {
  if (environmentBlocker) return environmentBlocker;

  if (pool.length === 0) {
    return (
      'BLOCKED — no payable account on this environment: no ACTIVE CRC prepaid account ' +
      `has BOTH a saved card AND an unpaid bill under ${MAX_DUE} CRC. ` +
      'This suite FINDS its test data rather than creating it, so a fresh or wiped ' +
      'environment cannot run it. To unblock: (1) create a prepaid account with an ' +
      'order + meter, (2) save a card on it via Self Care → Activity → Manage Payment ' +
      'Profile, (3) give it consumption and run the end-of-cycle billing job. ' +
      'Details in docs/JASEC_SELFCARE_PAYMENT_EXPLORATION.md § "Test data and portability".'
    );
  }

  return (
    `BLOCKED — all ${pool.length} payable account(s) in the pool were consumed by earlier ` +
    'tests in this run. Run the remaining tests separately, raise PAYMENT_MAX_DUE to ' +
    'widen the pool, or run a billing cycle to produce new bills.'
  );
}

/**
 * Report an unmet precondition as BLOCKED: print the reason, then skip.
 *
 * `test.skip(condition, reason)` on its own records the reason as an annotation that
 * the list reporter never prints — so a blocked run showed three bare "skipped" lines
 * with no explanation, which is exactly the confusion this is meant to prevent. The
 * console line puts the reason in the terminal output and the CI log; the annotation
 * still carries it into the HTML report.
 */
function blockUnless(ok: boolean, reason: string): void {
  if (!ok) {
    console.log(`\n[payment] ${reason}\n`);
  }
  test.skip(!ok, reason);
}

/** Persist evidence outside test-results/ — Playwright clears that folder. */
function saveEvidence(name: string, payload: unknown): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return file;
}

/**
 * Wait for the backend to finish writing the payment.
 *
 * The UI acknowledges before core_engine has the row. Poll rather than sleep, so a
 * slow gateway does not read as "no payment was created".
 */
async function waitForNewPayment(
  before: AccountPaymentState,
  accountId: string,
  timeoutMs = 60_000,
): Promise<AccountPaymentState> {
  const deadline = Date.now() + timeoutMs;
  let after = await readAccountPaymentState(db, accountId);
  while (newPayments(before, after).length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    after = await readAccountPaymentState(db, accountId);
  }
  return after;
}

test.beforeAll(async () => {
  db = new DbHelper();

  // A dropped VPN is an environment problem, not a defect in the payment screen.
  // Throwing here marks every test FAILED, which sends whoever reads the report
  // hunting a bug that does not exist — so record it and let each test skip with the
  // reason. (The VPN dropped twice while this suite was being written.)
  try {
    await db.connect();
  } catch (err) {
    environmentBlocker =
      'BLOCKED — cannot reach the database: ' + (err as Error).message +
      '. Check the AWS VPN is connected, then re-run.';
    console.log(`[payment] ${environmentBlocker}`);
    return;
  }

  // CRC only. jasec-dev mixes USD prepaid accounts in with the CRC ones, and on a
  // USD account the PlaceToPay path drops an approved charge (Edge 2) — a journey
  // that drew one would fail for that reason and look like a settlement regression.
  pool = await findPayableTargets(db, {
    maxDue: MAX_DUE, minOpenInvoices: 1, limit: 40, currency: 'CRC',
  });
  console.log(
    pool.length
      ? `[payment] pool of ${pool.length} payable CRC PREPAID account(s) with a saved card, ` +
      `dues ${pool[0].smallestDue} … ${pool[pool.length - 1].smallestDue} CRC (cap ${MAX_DUE})`
      : `[payment] pool is EMPTY (cap ${MAX_DUE} CRC) — every test will report BLOCKED`,
  );
});

test.afterAll(async () => {
  await db?.disconnect();
});

test.describe(
  'EXPLORE — Self Care payment journey',
  { tag: ['@explore', '@jasec', '@payment'] },
  () => {
    // ══════════════════════════════════════════════════════════════════════
    //  SCENARIO 1 — the whole journey, once per payment channel
    // ══════════════════════════════════════════════════════════════════════
    for (const channel of CHANNELS) {
      test(
        `Scenario 1 (${channel.label}) — bill → pay → view → verify`,
        { tag: ['@scenario-1', channel.tag, '@pays'] },
        async ({
          testLogger, selfcareLoginPage, selfcareAccountSearchPage,
          selfcareActivityPage, selfcareMakePaymentPage, selfcarePaymentsPage,
          placeToPayCheckoutPage,
        }, testInfo) => {
          // Unmet precondition = BLOCKED (skipped, reason printed), not FAILED. A red
          // test says "there is a defect"; this says "I could not run".
          const claimed_ = tryClaimAccount();
          blockUnless(claimed_ !== null, blockedReason());
          const target = claimed_!;
          const softFindings: string[] = [];

          // ── Step 1 — an unpaid bill exists ────────────────────────────
          const before = await test.step('1. An unpaid bill exists for the account', async () => {
            const state = await readAccountPaymentState(db, target.accountId);
            testLogger.log(
              `${channel.key} — ${target.accountId} (${state.accountCurrency}, card ****${target.last4cc}): ` +
              `${state.openInvoices.length} open invoice(s), balance ${state.balance}, ` +
              `subscription ${state.subscriptionStatus}`,
            );
            expect(
              state.openInvoices.length,
              'no unpaid bill on the claimed account — nothing to pay',
            ).toBeGreaterThan(0);
            return state;
          });

          const invoice = before.openInvoices[0];

          await attachToAccountInSelfCare(
            { selfcareLoginPage, selfcareAccountSearchPage },
            target.accountId,
          );

          // ── Step 2 — the bill is listed on arrival (KNOWN DEFECT) ─────
          await test.step('2. Make Payment lists the bill on arrival, without a reload', async () => {
            await selfcareActivityPage.navigateToMakePayment();
            await selfcareMakePaymentPage.assertLoaded();

            const onArrival = await selfcareMakePaymentPage.getInvoiceRowCount();
            // ACTIVE invoices, any due — the screen's own filter. See step 3.
            const expectedRows = before.allInvoices.filter((i) => i.status === 'ACTIVE').length;
            testLogger.log(`  step 2 — rows on arrival: ${onArrival} (DB says ${expectedRows})`);

            // SOFT: the defect must not abort the journey, or steps 3-10 never run
            // and this one run reports one defect instead of three.
            expect
              .soft(onArrival, 'bills listed on arrival (searchInvoiceUnits does not fire ' +
                'on the Activity-dropdown navigation — a reload is needed)')
              .toBe(expectedRows);
            if (onArrival !== expectedRows) {
              softFindings.push(
                `step 2: grid empty on arrival (${onArrival} rows vs ${expectedRows} in DB)`,
              );
            }
          });

          // ── Step 3 — the listed bill matches the record ───────────────
          await test.step('3. After a reload, the listed bill matches the invoice record', async () => {
            // The reload is the workaround for step 2. Explicit here rather than
            // buried in the page object, so nobody reads this journey as proof that
            // a customer can pay without it.
            await selfcareMakePaymentPage.reloadToPopulateGrid(selfcareActivityPage);

            const listed = await selfcareMakePaymentPage.getListedInvoices();
            for (const l of listed) {
              testLogger.log(`  step 3 — UI: ${l.invoiceId} ${l.invoiceDate} → ${l.dueDate} ` +
                `amount=${l.amount} due=${l.due}`);
            }

            // Compare against every ACTIVE invoice, not just the ones with due > 0.
            // The screen's own query is
            //   searchInvoiceUnits(filter: {accountId, status: ACTIVE})
            // — no type filter and, notably, NO due > 0 filter. So an ACTIVE invoice
            // with zero or negative due IS listed and offered for payment. Comparing
            // against a due > 0 set would fail this step on such an account for a
            // reason that has nothing to do with the screen. (Today only one negative
            // -due invoice exists on the tenant and no pool account has one, so this
            // is pre-emptive — but the mismatch is real and would be baffling later.)
            const activeInDb = before.allInvoices.filter((i) => i.status === 'ACTIVE');
            // Same set: a bill hidden from the customer cannot be paid, and one
            // listed that is already settled invites a double payment.
            expect(listed.map((l) => l.invoiceId).sort())
              .toEqual(activeInDb.map((i) => i.id).sort());

            const row = listed.find((l) => l.invoiceId === invoice.id)!;
            expect(row.invoiceDate).toBe(invoice.invoicedate);
            expect(row.dueDate).toBe(invoice.duedate);
            expect(moneyEquals(parseMoney(row.amount), invoice.total)).toBeTruthy();
            expect(moneyEquals(parseMoney(row.due), invoice.due)).toBeTruthy();
          });

          // ── Step 4 — selecting the bill ───────────────────────────────
          await test.step('4. Selecting the bill totals it and enables the pay buttons', async () => {
            expect(await selfcareMakePaymentPage.getTotalSelectedToPay()).toBe(0);
            await selfcareMakePaymentPage.assertPayButtonsDisabled();

            await selfcareMakePaymentPage.selectInvoice(invoice.id);

            const total = await selfcareMakePaymentPage.getTotalSelectedToPay();
            testLogger.log(`  step 4 — total selected ${total} vs due ${invoice.due}`);
            await selfcareMakePaymentPage.assertPayButtonsEnabled();
            expect(
              moneyEquals(total, invoice.due),
              `total selected ${total} does not match the bill's due ${invoice.due}`,
            ).toBeTruthy();
          });

          // ── Step 5 — pay ─────────────────────────────────────────────
          const gatewayVerdict = await test.step(`5. Pay with ${channel.label}`, async () => {
            if (channel.key === 'placetopay') {
              await selfcareMakePaymentPage.clickPayWithPlaceToPay();
              const outcome = await placeToPayCheckoutPage.completePaymentAndReadOutcome('approve');
              testLogger.log(`  step 5 — gateway charged "${outcome.chargedText}", ` +
                `verdict "${outcome.verdictText}"`);

              // Settle who owns a downstream failure BEFORE looking at the DB: after
              // a decline, nothing is expected to exist and blaming Embrix is wrong.
              expect(
                outcome.approved,
                `PlaceToPay did not approve (verdict: "${outcome.verdictText}") — ` +
                'the steps below only mean anything after an approval',
              ).toBeTruthy();
              return outcome.verdictText;
            }

            // Pay Now charges the stored token with no redirect, so there is no
            // gateway page to read a verdict from.
            await selfcareMakePaymentPage.clickPayNow();
            return 'n/a (saved token, no redirect)';
          });

          await selfcareMakePaymentPage.waitForPaymentAcknowledged(invoice.id);
          const after = await waitForNewPayment(before, target.accountId);

          // ── Step 6 — the bill is settled ─────────────────────────────
          const payment = await test.step('6. The bill is settled and the payment recorded once', async () => {
            const created = newPayments(before, after);
            const createdAr = newAropsPayments(before, after);
            const settled = after.allInvoices.find((i) => i.id === invoice.id);

            testLogger.log(
              `  step 6 — ${created.length} payment(s) ${created.map((p) => p.id).join(',')}, ` +
              `${createdAr.length} AR row(s); invoice ${invoice.id} → ${settled?.status} ` +
              `due=${settled?.due} lastAr=${settled?.lastaraction}`,
            );

            // Exactly one. Two rows for one charge is the duplicate-payment failure
            // the AC-Jasec-01 POC data already shows three of (P69/P71/P73 share one
            // gateway transaction id against one invoice).
            expect(created, 'expected exactly one new payment row').toHaveLength(1);
            expect(moneyEquals(created[0].amount, invoice.due)).toBeTruthy();
            expect(created[0].invoiceunitid).toBe(invoice.id);
            expect(created[0].status).toBe('CLOSED');
            expect(moneyEquals(created[0].remainingamount, 0)).toBeTruthy();

            // Settled, not merely reduced.
            expect(settled?.status).toBe('CLOSED');
            expect(moneyEquals(settled?.due ?? -1, 0)).toBeTruthy();
            expect(settled?.lastaraction).toBe('PAYMENT');
            expect(after.openInvoices.some((i) => i.id === invoice.id)).toBeFalsy();

            // AR mirror: one PAYMENT row for this invoice, negative = credit.
            expect(createdAr, 'expected exactly one new AR PAYMENT row').toHaveLength(1);
            expect(createdAr[0].invoiceid).toBe(invoice.id);
            expect(moneyEquals(createdAr[0].netamount, -invoice.due)).toBeTruthy();

            return created[0];
          });

          // ── Step 7 — the balance moved by the amount paid ────────────
          await test.step('7. The balance moves by exactly the amount paid', async () => {
            const delta = (after.balance ?? 0) - (before.balance ?? 0);
            testLogger.log(`  step 7 — balance ${before.balance} → ${after.balance} ` +
              `(delta ${delta.toFixed(2)}, paid ${invoice.due})`);

            // Inverted CRC: paying SUBTRACTS, which is the customer's credit going
            // up. Delta 0 means the payment never reached the wallet; −2x means it
            // was applied twice.
            expect(
              moneyEquals(delta, -invoice.due),
              `balance moved by ${delta.toFixed(2)}, expected ${(-invoice.due).toFixed(2)} ` +
              '(negative CRC = customer credit)',
            ).toBeTruthy();
          });

          // ── Step 8 — the payment appears to the customer (KNOWN DEFECT) ──
          const uiRow = await test.step('8. The payment appears in Billing Data → Payments with its details', async () => {
            await selfcarePaymentsPage.navigate();
            await selfcarePaymentsPage.assertPaymentListed(payment.id);

            const row = (await selfcarePaymentsPage.findRow(payment.id))!;
            testLogger.log(`  step 8 — UI row ${JSON.stringify(row)}`);
            testLogger.log(`  step 8 — DB: method=${payment.method} ` +
              `externalTransId=${payment.externaltransid} currency=${payment.sourcecurrencyid}`);

            // These render today and are what makes the grid usable at all.
            expect(moneyEquals(parseMoney(row['Amount']), payment.amount)).toBeTruthy();
            expect(row['Status']).toBe(payment.status);

            // SOFT: all three are populated in core_engine and blank on screen, so a
            // customer cannot tell how they paid or match it to a card statement.
            for (const [column, dbValue] of [
              ['Payment Method', payment.method],
              ['External Id', payment.externaltransid],
              ['Currency', payment.sourcecurrencyid],
            ] as const) {
              expect
                .soft(row[column], `${column} rendered blank; core_engine has "${dbValue}"`)
                .not.toBe('');
              if (!row[column]) softFindings.push(`step 8: ${column} blank (DB has "${dbValue}")`);
            }

            return row;
          });

          // ── Step 9 — the payment document (KNOWN DEFECT) ─────────────
          const probe = await test.step('9. Clicking the payment Id opens the payment document', async () => {
            const result = await selfcarePaymentsPage.probeIdPill(payment.id);
            testLogger.log(
              `  step 9 — pill "${result.clicked}" → popup=${result.popupUrl ?? 'none'} ` +
              `download=${result.download ?? 'none'} docRequests=${result.requests.length} ` +
              `newTabs=${result.newTabCount} consoleErrors=${result.consoleErrors.length}`,
            );
            testLogger.log(`  step 9 — DB filepath=${payment.filepath ?? 'NULL'} ` +
              `folioId=${payment.folioid ?? 'NULL'}`);

            expect(result.clicked, 'no Id pill found on the payment row').toBe(payment.id);

            // SOFT: nothing opens on any channel — no popup, no download, no request,
            // not even a console error. `filepath` is NULL on every payment row on
            // the tenant, so there is nothing to fetch: the fix is likely upstream
            // (no receipt is generated), not in the click handler.
            const opened = !!result.popupUrl || !!result.download ||
              result.requests.length > 0 || result.newTabCount > 0;
            expect
              .soft(opened, 'clicking the payment Id opened nothing — no popup, no download, ' +
                `no document request, no console error (payment.filepath = ${payment.filepath ?? 'NULL'})`)
              .toBeTruthy();
            if (!opened) softFindings.push('step 9: Id pill opened nothing (filepath NULL)');

            return result;
          });

          // ── Step 10 — prepaid side effects, recorded not judged ───────
          await test.step('10. Record what settling a prepaid bill did to the wallet and the service', async () => {
            // Not an assertion. The spec says a prepaid customer already paid via
            // top-ups and gets the month-end invoice for Hacienda reporting — yet
            // the invoice is payable and paying it credits the wallet again. Whether
            // that is intended is JASEC's call, so this records the facts. Do not
            // turn it into an assertion before the team answers.
            testLogger.log(
              `  step 10 — subscription ${before.subscriptionStatus} → ${after.subscriptionStatus}; ` +
              `wallet credited by ${Math.abs((after.balance ?? 0) - (before.balance ?? 0)).toFixed(2)} ` +
              `on top of the top-ups that already paid for this consumption; ` +
              `payment recorded with source=${after.aropsPayments.at(-1)?.source} ` +
              `user=${after.aropsPayments.at(-1)?.userid}`,
            );
          });

          // ── Evidence ─────────────────────────────────────────────────
          const evidence = {
            channel: channel.key,
            account: target,
            gatewayVerdict,
            invoiceBefore: invoice,
            invoiceAfter: after.allInvoices.find((i) => i.id === invoice.id),
            payment,
            uiRow,
            idPillProbe: probe,
            balanceBefore: before.balance,
            balanceAfter: after.balance,
            balanceDelta: (after.balance ?? 0) - (before.balance ?? 0),
            subscriptionBefore: before.subscriptionStatus,
            subscriptionAfter: after.subscriptionStatus,
            softFindings,
          };
          const file = saveEvidence(`scenario-1-${channel.key}-${target.accountId}`, evidence);
          await testInfo.attach(`scenario-1-${channel.key}.json`, {
            body: JSON.stringify(evidence, null, 2),
            contentType: 'application/json',
          });

          // One line saying whether the journey itself worked and which known
          // defects it hit — without this, a soft failure just reads as "red" and
          // "the customer could not pay" looks the same as "a field was blank".
          testLogger.log(
            softFindings.length
              ? `JOURNEY COMPLETED — paid ${invoice.id} successfully, with ${softFindings.length} ` +
              `known defect(s) on the way: ${softFindings.join(' | ')}`
              : 'JOURNEY COMPLETED — clean, no known defects hit',
          );
          testLogger.log(`  evidence: ${file}`);
        },
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    //  EDGE CASES — different input or a different account, so they cannot
    //  be steps of the journey above
    // ══════════════════════════════════════════════════════════════════════

    // ── Edge 1 — a declined card must change nothing ──────────────────────
    // Not a defect: this passes. It needs a card that DECLINES, and Scenario 1 only
    // ever uses one that approves, so a regression here would never show up there.
    test(
      'Edge 1: A declined card leaves the bill open, writes no payment, and does not move the balance',
      { tag: ['@edge-1', '@pays'] },
      async ({
        testLogger, selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareMakePaymentPage, placeToPayCheckoutPage,
      }) => {
        const claimed_ = tryClaimAccount();
        blockUnless(claimed_ !== null, blockedReason());
        const target = claimed_!;

        const before = await readAccountPaymentState(db, target.accountId);
        const invoice = before.openInvoices[0];

        await attachToAccountInSelfCare(
          { selfcareLoginPage, selfcareAccountSearchPage },
          target.accountId,
        );
        await selfcareActivityPage.navigateToMakePayment();
        await selfcareMakePaymentPage.reloadToPopulateGrid(selfcareActivityPage);
        await selfcareMakePaymentPage.selectInvoice(invoice.id);

        await selfcareMakePaymentPage.clickPayWithPlaceToPay();
        const outcome = await placeToPayCheckoutPage.completePaymentAndReadOutcome('deny');

        // Confirm the gateway really declined. Without this the case passes vacuously
        // the day the deny card starts getting approved — and "no payment was
        // written" would then be the real defect, reported as a pass.
        expect(
          outcome.declined,
          `expected PlaceToPay to decline the deny card, got "${outcome.verdictText}"`,
        ).toBeTruthy();

        // Give the backend the same window a successful payment gets, so "nothing was
        // written" cannot just mean "not written yet".
        const after = await waitForNewPayment(before, target.accountId, 30_000);

        testLogger.log(`Edge 1 — ${target.accountId}: gateway said "${outcome.verdictText}" ` +
          `for ${invoice.id}; new payments=${newPayments(before, after).length}, ` +
          `balance ${before.balance} → ${after.balance}`);

        expect(newPayments(before, after), 'a declined card created a payment row').toHaveLength(0);
        expect(newAropsPayments(before, after), 'a declined card created an AR PAYMENT').toHaveLength(0);

        const stillOpen = after.openInvoices.find((i) => i.id === invoice.id);
        expect(stillOpen, `bill ${invoice.id} left the open list after a DECLINED payment`)
          .toBeDefined();
        expect(moneyEquals(stillOpen!.due, invoice.due)).toBeTruthy();
        expect(moneyEquals(after.balance ?? 0, before.balance ?? 0)).toBeTruthy();
      },
    );

    // ── Edge 2 — DEFECT: approved charge dropped on a non-CRC account ─────
    // Needs an account in a different currency, so it cannot be a step of Scenario 1
    // — on the CRC account the journey uses, this path works correctly.
    test(
      'Edge 2: [DEFECT] An approved PlaceToPay charge is recorded, whatever the account currency',
      { tag: ['@edge-2', '@defect', '@pays'] },
      async ({
        testLogger, selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareMakePaymentPage, placeToPayCheckoutPage,
      }, testInfo) => {
        blockUnless(!environmentBlocker, environmentBlocker);

        const nonBase = (
          await findPayableTargets(db, { maxDue: MAX_DUE, minOpenInvoices: 1, limit: 40, currency: null })
        ).filter((t) => t.currency !== 'CRC');

        blockUnless(
          nonBase.length > 0,
          'BLOCKED — no non-CRC prepaid account with a saved card and an unpaid bill on ' +
          'this tenant. This case needs one deliberately: it exists to prove an approved ' +
          'charge is recorded whatever the account currency. A clean environment will not ' +
          'have such an account unless one is made on purpose.',
        );

        const target = nonBase[0];
        const before = await readAccountPaymentState(db, target.accountId);
        const invoice = before.openInvoices[0];
        testLogger.log(`Edge 2 — ${target.accountId} (${target.currency}): paying ${invoice.id} ` +
          `due ${invoice.due}, balance before ${before.balance}`);

        await attachToAccountInSelfCare(
          { selfcareLoginPage, selfcareAccountSearchPage },
          target.accountId,
        );
        await selfcareActivityPage.navigateToMakePayment();
        await selfcareMakePaymentPage.reloadToPopulateGrid(selfcareActivityPage);
        await selfcareMakePaymentPage.selectInvoice(invoice.id);

        await selfcareMakePaymentPage.clickPayWithPlaceToPay();
        const outcome = await placeToPayCheckoutPage.completePaymentAndReadOutcome('approve');

        const after = await waitForNewPayment(before, target.accountId);
        const created = newPayments(before, after);
        const stillOpen = after.openInvoices.find((i) => i.id === invoice.id);

        testLogger.log(
          `Edge 2 — gateway charged "${outcome.chargedText}", verdict "${outcome.verdictText}"; ` +
          `Embrix wrote ${created.length} payment(s); bill ${invoice.id} is ` +
          `${stillOpen ? 'STILL OPEN' : 'closed'}; balance ${before.balance} → ${after.balance}`,
        );

        const evidence = {
          target, gateway: outcome, createdPayments: created,
          invoiceAfter: after.allInvoices.find((i) => i.id === invoice.id),
          balanceBefore: before.balance, balanceAfter: after.balance,
        };
        saveEvidence(`edge-2-${target.accountId}-${invoice.id}`, evidence);
        await testInfo.attach('edge-2-currency-drop.json', {
          body: JSON.stringify(evidence, null, 2),
          contentType: 'application/json',
        });

        expect(
          outcome.approved,
          `gateway did not approve ("${outcome.verdictText}") — this case needs an approval`,
        ).toBeTruthy();

        // THE ASSERTION UNDER REPORT. Reproduced 4/4 on jasec-dev with ACT-100489
        // (USD, invoice 4.46): PlaceToPay returned "Transacción Aprobada" for
        // "$4,46 USD" and Embrix wrote nothing, left the bill ACTIVE at full due,
        // moved no balance, and showed the customer no error. The same flow on a CRC
        // account settles correctly, and Pay Now on THIS account settles correctly —
        // so it is the currency, not the amount and not the account.
        expect(
          created,
          `PlaceToPay approved the charge ("${outcome.chargedText}") but Embrix recorded ` +
          `no payment — the customer is charged and bill ${invoice.id} stays open`,
        ).toHaveLength(1);
        expect(stillOpen, `bill ${invoice.id} is still open after an APPROVED payment`)
          .toBeUndefined();
      },
    );
  },
);
