/**
 * DIAGNOSTIC — why is an approved card charge not recorded? (defect D2)
 *
 * TEMPORARY. This is not a test case and not part of any flow. It is a probe built to
 * identify one specific defect, and it should be DELETED once that defect is
 * understood. It asserts nothing about the product — its output is the evidence.
 *
 * Keep it separate from `explore-03` on purpose: that spec is the end-to-end proof
 * (Phase A + Phase B, new account → consumption → rating → billing run → payable bill).
 * Investigating why B's final step failed is a different activity, not a further phase
 * of the flow.
 *
 * THE DEFECT. The gateway returns "Transacción Aprobada"; Embrix writes no
 * `core_engine.payment` row, leaves the bill ACTIVE at full due, moves no balance, and
 * shows the customer no error. It does not even reach `core_engine.payment_suspense`,
 * which is where unapplicable payments are meant to land with a reason
 * (`PREDATES_ACCOUNT` / `PREDATES_INVOICE` / ...). 8 reproductions on two accounts.
 *
 * WHAT IS ALREADY RULED OUT — each by a run that changed one variable:
 *   1. Account currency. ACT-100651 is CRC and drops. (The first write-up blamed
 *      currency because the only known case then was a USD account.)
 *   2. Card on file / payment-profile method. Saved a card on ACT-100651, taking it
 *      from CHECK/0 cards to CREDIT_CARD/1 card, then paid the same bill through the
 *      same channel. Still dropped. (To redo: Self Care → Activity → Manage Payment
 *      Profile → Save With PlaceToPay, then pay.)
 *   3. Payment channel. Pay Now drops the same bill, and Pay Now settles other bills
 *      fine — including one with the same invoice date. So it is not "the PlaceToPay
 *      redirect path" and not "the invoice date".
 *
 * So the remaining difference is something only the backend can see. Correlation is
 * exhausted; this probe stops guessing and records what the server actually says.
 *
 * HOW IT WORKS. It records every API call the page makes across the whole payment
 * click — full request body, full response, HTTP status — and writes them to
 * artifacts/payment-diagnose/. Uses PAY NOW rather than PlaceToPay: Pay Now fails on
 * the same bill and involves no redirect, so the mutation and its response are one
 * exchange instead of a round trip through a third-party site.
 *
 * TARGET. Defaults to the account/bill left open by explore-03 Phase B, which still
 * reproduces on demand. Override with PAYMENT_ACCOUNT_ID.
 *
 * Requires: VPN (DB), Core UI creds via `setup`, SELFCARE_BASE_URL. Attempts a real
 * charge — which is expected to be approved by the gateway and then lost, so it costs
 * a gateway transaction and settles nothing.
 *
 * Owner: Anh Tran (QC)
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import type { Page } from '@playwright/test';
import { attachToAccountInSelfCare } from '../../../../fixtures/create-prepaid-account.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import { readAccountPaymentState, newPayments } from '../../../../helpers/payment-db.helper';

/** This probe owns nothing time-sensitive; leave the shared clock alone. */
test.use({ ccpBaseline: null });

const OUT_DIR = path.join(process.cwd(), 'artifacts', 'payment-diagnose');
/** The bill explore-03 Phase B produced and failed to settle. Still open, still fails. */
const DEFAULT_ACCOUNT = 'ACT-100651';

/**
 * Which button to press. Pay Now is the better probe — one exchange, no redirect — but
 * it needs a stored card, and the accounts worth probing often have none. `DIAG_CHANNEL=ptp`
 * switches to PlaceToPay for those.
 */
const CHANNEL = (process.env.DIAG_CHANNEL ?? 'paynow').toLowerCase() === 'ptp'
  ? 'placetopay'
  : 'paynow';

let db: DbHelper;

/**
 * Record every API call with its FULL request and response.
 *
 * Deliberately unfiltered and uncapped, unlike the recon helper: the whole point is to
 * find an error that has so far been invisible, so truncating the payload could throw
 * away the answer. Static assets are still skipped.
 */
function recordEverything(page: Page) {
  const calls: any[] = [];

  page.on('request', (req) => {
    const url = req.url();
    if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|eot|ico|map)(\?|$)/i.test(url)) return;
    if (!/^https?:/i.test(url)) return;
    if (req.resourceType() === 'stylesheet') return;

    let body: any = null;
    try {
      body = JSON.parse(req.postData() ?? 'null');
    } catch {
      body = req.postData();
    }

    const call: any = {
      at: new Date().toISOString(),
      method: req.method(),
      url,
      query: typeof body?.query === 'string' ? body.query.replace(/\s+/g, ' ').trim() : null,
      variables: body?.variables ?? null,
      rawBody: typeof body === 'string' ? body : null,
      status: null,
      response: null,
      failure: null,
    };
    calls.push(call);

    req
      .response()
      .then(async (res) => {
        if (!res) {
          call.failure = req.failure()?.errorText ?? 'no response';
          return;
        }
        call.status = res.status();
        try {
          call.response = await res.json();
        } catch {
          call.response = (await res.text().catch(() => '<unreadable>')).slice(0, 4000);
        }
      })
      .catch((e) => { call.failure = String(e?.message ?? e); });
  });

  return calls;
}

test.beforeAll(async () => {
  db = new DbHelper();
  await db.connect();
});

test.afterAll(async () => {
  await db?.disconnect();
});

test.describe(
  'DIAGNOSE — approved charge not recorded (D2)',
  { tag: ['@diagnose', '@jasec', '@payment'] },
  () => {
    test(
      'Capture the payment mutation and its response for a bill that drops the charge',
      { tag: ['@diag-capture', '@pays'] },
      async ({
        page, testLogger, selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareMakePaymentPage, placeToPayCheckoutPage,
      }, testInfo) => {
        test.setTimeout(900_000);

        const accountId = process.env.PAYMENT_ACCOUNT_ID ?? DEFAULT_ACCOUNT;
        const before = await readAccountPaymentState(db, accountId);
        const invoice = before.openInvoices[0];

        expect(
          invoice,
          `BLOCKED — ${accountId} has no open bill. This probe needs one that reproduces ` +
          'the drop; explore-03 Phase B leaves one behind, or set PAYMENT_ACCOUNT_ID.',
        ).toBeTruthy();

        testLogger.log(
          `probing ${accountId} (${before.accountCurrency}): bill ${invoice.id} ` +
          `due ${invoice.due}, balance ${before.balance}, payments so far ${before.payments.length}`,
        );

        const calls = recordEverything(page);

        await attachToAccountInSelfCare(
          { selfcareLoginPage, selfcareAccountSearchPage },
          accountId,
        );
        await selfcareActivityPage.navigateToMakePayment();
        await selfcareMakePaymentPage.reloadToPopulateGrid(selfcareActivityPage);
        await selfcareMakePaymentPage.selectInvoice(invoice.id);

        // Everything before this is navigation noise. The click is the subject.
        const beforeClick = calls.length;
        testLogger.log(`paying ${invoice.id} via ${CHANNEL} (call index ${beforeClick})`);

        if (CHANNEL === 'paynow') {
          await selfcareMakePaymentPage.clickPayNow();
        } else {
          // PlaceToPay for accounts with no stored card — Pay Now has nothing to charge.
          // Costs a redirect round trip, but the page listeners survive navigation so the
          // capture still gets the mutation fired on return.
          await selfcareMakePaymentPage.clickPayWithPlaceToPay();
          const outcome = await placeToPayCheckoutPage.completePaymentAndReadOutcome('approve');
          testLogger.log(`gateway charged "${outcome.chargedText}", verdict "${outcome.verdictText}"`);
        }

        // Let the request settle, plus any follow-up the UI fires. No polling on the
        // DB first: a slow write would make this wait, and the response is what matters.
        await page.waitForTimeout(20_000);

        const duringClick = calls.slice(beforeClick);
        testLogger.log(`captured ${duringClick.length} call(s) during the click`);

        // Anything that is not a clean 200 with no GraphQL `errors` array.
        const suspicious = duringClick.filter(
          (c) => c.status === null || c.status >= 400 || c.failure ||
            (c.response && typeof c.response === 'object' && c.response.errors),
        );

        for (const c of duringClick) {
          const opName = c.query?.match(/(mutation|query)\s+(\w+)/)?.[2]
            ?? c.query?.match(/\{\s*(\w+)\s*\(/)?.[1]
            ?? '(anonymous)';
          testLogger.log(
            `  ${c.method} ${c.status ?? 'ERR'} ${opName} ` +
            `${c.failure ? `FAILURE=${c.failure}` : ''}`,
          );
        }

        if (suspicious.length) {
          testLogger.log(`\n=== ${suspicious.length} SUSPICIOUS CALL(S) ===`);
          for (const c of suspicious) {
            testLogger.log(`  status=${c.status} failure=${c.failure}`);
            testLogger.log(`  query: ${(c.query ?? c.rawBody ?? '').slice(0, 900)}`);
            testLogger.log(`  vars : ${JSON.stringify(c.variables)}`);
            testLogger.log(`  resp : ${JSON.stringify(c.response).slice(0, 2000)}`);
          }
        } else {
          // Also worth knowing: if every call came back 200 with no errors, the backend
          // ACCEPTED the request and dropped the payment silently downstream — which
          // points at async processing rather than a rejected mutation.
          testLogger.log(
            '\n=== NO SUSPICIOUS CALL — every request returned 200 with no GraphQL errors. ' +
            'The API accepted the payment and lost it after responding, so the cause is ' +
            'downstream of the request, not a rejection. ===',
          );
        }

        const after = await readAccountPaymentState(db, accountId);
        const created = newPayments(before, after);
        testLogger.log(
          `DB after: ${created.length} new payment(s); bill ${invoice.id} → ` +
          `${after.allInvoices.find((i) => i.id === invoice.id)?.status}; ` +
          `balance ${before.balance} → ${after.balance}`,
        );

        // Full dump, uncapped — the answer may be in a payload nobody thought to print.
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const file = path.join(OUT_DIR, `d2-capture-${accountId}-${invoice.id}.json`);
        fs.writeFileSync(
          file,
          JSON.stringify(
            {
              accountId,
              channel: CHANNEL,
              currency: before.accountCurrency,
              invoice,
              paymentsBefore: before.payments.length,
              paymentsAfter: after.payments.length,
              createdPayments: created,
              balanceBefore: before.balance,
              balanceAfter: after.balance,
              callsDuringClick: duringClick,
              suspiciousCalls: suspicious,
            },
            null,
            2,
          ),
          'utf-8',
        );
        await testInfo.attach('d2-capture.json', {
          body: fs.readFileSync(file, 'utf-8'),
          contentType: 'application/json',
        });
        testLogger.log(`evidence: ${file}`);

        // Diagnostic, not a test: it passes as long as it captured something to read.
        expect(duringClick.length, 'the click produced no API calls at all').toBeGreaterThan(0);
      },
    );
  },
);
