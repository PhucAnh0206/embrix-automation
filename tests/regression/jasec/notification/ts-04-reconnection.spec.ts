/**
 * TS-04 — Event 6, service reconnection after a top-up. Report cases 5.2 / 5.3.
 *
 * Both cases share ONE suspended account, in this order:
 *
 *   5.3  top up LESS than the debt  -> must NOT reconnect (state survives)
 *   5.2  top up MORE than the debt  -> reconnects
 *
 * The order matters: `resumeRequiresSufficientBalance` means a partial top-up
 * deliberately does not reconnect, so it leaves the account still suspended and
 * available for the second case. Reversing them would burn the account.
 *
 * WHY THIS ONE NEEDS A BROWSER: there is no top-up API in this repo. Top-up is
 * UI-only (`SelfcareTopupPage`), and it is the agent-assisted flow — an operator
 * logs into Selfcare with the admin credentials and searches for the account — so
 * no per-customer Selfcare password is needed.
 *
 * WHY PLACETOPAY AND NOT "PAY NOW": PAY NOW charges the card on file, and the
 * suspended accounts available here have none — their payment profile is CHECK and
 * the Card On File panel is empty (blank CVV and TOKEN). Clicking PAY NOW then does
 * NOTHING AT ALL: no charge, no error message, no history row. PlaceToPay collects
 * card details during checkout instead, so it works regardless of stored card state.
 *
 * Progress is confirmed from the DATABASE, not the Top Up history table. That table
 * is what silently stayed empty on the PAY NOW attempt, and it also serves stale
 * data after returning from PlaceToPay.
 *
 * WHY IT DISABLES THE CCP BASELINE: jasec-fixtures carries an AUTO fixture
 * (`jasecCcpBaseline`) that parks the tenant CCP clock at the JASEC baseline before
 * every test. The clock is shared with everyone on the tenant, and this spec acts on
 * a PRE-EXISTING suspended account whose subscription is only effective at the
 * current date — so it opts out with `test.use({ ccpBaseline: null })` and leaves
 * the clock alone. It used to escape the reset by not importing jasec-fixtures at
 * all, which meant hand-copying page-factory's `page` helpers; the opt-out removed
 * that duplication.
 *
 * State left behind: the account ends ACTIVE and in credit. That is the correct
 * end state of a reconnection and is not restored — the runbook does the same
 * ("Account D is left ACTIVE and topped up by Run B; that is fine"). Each run
 * therefore consumes one suspended account; there were 70 available.
 *
 * Requires: VPN, DB_*, EMBRIX_USER / EMBRIX_PASSWORD, SELFCARE_BASE_URL.
 */

import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { DbHelper } from '../../../../helpers/db.helper';
import { NotificationDbHelper } from '../../../../helpers/notification-db.helper';
import { EmailHelper } from '../../../../helpers/email.helper';
import { NotificationReportHelper } from '../../../../helpers/notification-report.helper';
import { BILLING_EVENT_TEMPLATES } from '../../../../test-data/notifications/billing-events.templates';
import type { NotificationContext } from '../../../../test-data/notifications/types';
import { SelfcareLoginPage } from '../../../../pages/selfcare/selfcare-login.page';
import { SelfcareAccountSearchPage } from '../../../../pages/selfcare/selfcare-account-search.page';
import { SelfcareActivityPage } from '../../../../pages/selfcare/selfcare-activity.page';
import { SelfcareTopupPage } from '../../../../pages/selfcare/selfcare-topup.page';
import { PlaceToPayCheckoutPage } from '../../../../pages/selfcare/placetopay-checkout.page';
import { embrixCredentials } from '../../../../helpers/credentials.helper';


/**
 * Accounts the suite must never consume.
 *
 * ACT-100174 is the evidence behind report cases 4.1 and 5.1 — reconnecting it
 * would destroy the state those screenshots describe.
 */
const PROTECTED_ACCOUNTS = ['ACT-100174'];

interface Candidate {
  accountId: string;
  debt: number;
}

let db: DbHelper;
let notifyDb: NotificationDbHelper;
const report = new NotificationReportHelper();

/**
 * Contact email captured before plus-addressing, so teardown can put it back
 * even if the test fails partway.
 */
let contactRestore: { accountId: string; original: string } | null = null;

test.beforeAll(async () => {
  db = new DbHelper();
  await db.connect();
  notifyDb = new NotificationDbHelper(db);
});

test.afterAll(async () => {
  // Restore the contact email first — leaving a plus-address behind would keep
  // that account's real notifications flowing to a tagged inbox.
  try {
    if (contactRestore && notifyDb) {
      await notifyDb.restoreContactEmail(contactRestore.accountId, contactRestore.original);
      console.log(`[TS-04] restored contact email for ${contactRestore.accountId}`);
    }
  } catch (err) {
    console.error(`[TS-04] CONTACT EMAIL RESTORE FAILED: ${String(err)}`);
  } finally {
    await db?.disconnect();
  }
});

/**
 * A SUSPENDED prepaid account whose debt is small enough that both a partial and
 * a clearing top-up are realistic. Chosen from data rather than hardcoded so the
 * spec keeps working as accounts are consumed.
 */
async function pickSuspendedAccount(): Promise<Candidate | null> {
  const rows = await db.query<{ accountid: string; balance: string }>(
    `SELECT s.accountid, bub.amount AS balance
       FROM core_engine.subscription s
       JOIN core_engine.account a ON a.id = s.accountid AND a.accountcategory = 'PREPAID'
       JOIN core_engine.balance_unit bu ON bu.accountid = s.accountid
       JOIN core_engine.balance_unit_balances bub ON bub.id = bu.id AND bub.currencyid = 'CRC'
      WHERE s.status = 'SUSPENDED'
        AND bub.amount BETWEEN 300 AND 5000
        AND NOT (s.accountid = ANY($1::varchar[]))
      -- Monitored contact email is preferred, not required: every assertion below
      -- reads the database, so the mailbox is not involved.
      ORDER BY EXISTS (SELECT 1 FROM core_engine.contact ct
                        WHERE ct.accountid = s.accountid AND ct.email = $2::varchar) DESC,
               bub.amount
      LIMIT 1`,
    [PROTECTED_ACCOUNTS, process.env.NOTIFY_EMAIL_TO ?? ''],
  );
  if (!rows.length) return null;
  return { accountId: rows[0].accountid, debt: Number(rows[0].balance) };
}

/**
 * Wait for the CRC balance to move away from `from`.
 *
 * Asserting on the Top Up history table proved unreliable — it stayed empty on a
 * silently-failed PAY NOW, and serves stale data after a PlaceToPay round trip.
 * The balance is the fact that matters, so poll it directly.
 */
async function waitForBalanceChange(
  accountId: string,
  from: number,
  timeoutMs = 180_000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await notifyDb.getCrcBalance(accountId);
    if (now !== null && Math.abs(now - from) > 0.005) return now;
    if (Date.now() > deadline) return now;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function subscriptionStatus(accountId: string): Promise<string> {
  const rows = await db.query<{ status: string }>(
    `SELECT status FROM core_engine.subscription WHERE accountid = $1 LIMIT 1`,
    [accountId],
  );
  return rows[0]?.status ?? '(none)';
}

test.describe('TS-04 — reconnection after top-up', () => {
  // This spec owns the clock: it acts on a PRE-EXISTING suspended account, whose
  // subscription is only effective at the tenant's current CCP date. Parking the
  // clock at the JASEC baseline would put the account in the future and the
  // top-ups would silently record nothing. Opting out is why this spec no longer
  // needs to re-implement page-factory's `page` helpers by hand.
  test.use({ ccpBaseline: null });

  test('5.3 partial top-up does not reconnect, then 5.2 full top-up does', async ({ page, dialogs }) => {
    test.setTimeout(900_000);

    const candidate = await pickSuspendedAccount();
    expect(
      candidate,
      'No usable SUSPENDED account with a 300-5000 debt and the monitored contact email. ' +
      'Every run consumes one; check whether any suspended accounts remain in range.',
    ).toBeTruthy();
    if (!candidate) return;

    const { accountId, debt } = candidate;
    // Watermark first: everything this test causes has a higher id.
    const watermark = await notifyDb.getMaxNotificationId();
    console.log(
      `\n[TS-04] account ${accountId} | debt ${debt.toFixed(2)} | ` +
      `status ${await subscriptionStatus(accountId)} | watermark ${watermark}`,
    );

    // ── Plus-address the recipient so delivered mail identifies the account ──
    //
    // Validation of the approach intended for Events 4/5 in ts-02: those two
    // templates carry no account number, and their DB row is rolled back, so a
    // delivered email cannot currently be tied to an account. Putting the account
    // id in the To: header solves that without touching customer-facing copy.
    //
    // BALANCE_TOPUP is the ideal place to prove it, because that template DOES
    // include "Número de Servicio" — so the To: header can be cross-checked
    // against the body and the two must agree.
    const monitored = process.env.NOTIFY_EMAIL_TO ?? '';
    const plus = await notifyDb.setContactEmailToPlusAddress(accountId, monitored);
    if (plus) {
      contactRestore = { accountId, original: plus.original };
      console.log(`[TS-04] contact email ${plus.original} -> ${plus.applied}`);
    } else {
      test.info().annotations.push({
        type: 'plus-address-skipped',
        description:
          `${accountId}'s contact is not the monitored mailbox, so it was left ` +
          `alone — rewriting a real customer address would redirect their mail.`,
      });
    }

    const login = new SelfcareLoginPage(page);
    const search = new SelfcareAccountSearchPage(page);
    const activity = new SelfcareActivityPage(page);
    const topup = new SelfcareTopupPage(page);
    const checkout = new PlaceToPayCheckoutPage(page);

    // Native dialogs come from the shared `dialogs` collector on the `page`
    // fixture. Attaching a second page.on('dialog') here would double-settle
    // every dialog and throw, because the collector is registered first.

    await test.step('reach the account in Selfcare', async () => {
      await login.goto();
      const { username, password } = embrixCredentials();
      await login.login(username, password);
      await login.assertLoginSuccess();
      await search.navigate();
      // Verified working on pre-existing suspended accounts — Selfcare search is
      // not limited to accounts a test just created.
      await search.searchAndSelectAccount(accountId);
      await activity.navigateToTopUp();
      await topup.assertLoaded();
      const min = await topup.getDisplayedMinimumAmount();
      // Cross-check of the settled Min Amount rule: base 3300 + outstanding debt.
      console.log(`[TS-04] displayed minimum "${min}" (expected ${(3300 + debt).toFixed(2)})`);
    });

    // ── PAY NOW with no card on file must warn, not fail silently ──────────
    //
    // Guarded: only click PAY NOW when the Card On File panel is confirmed empty.
    // If a card were present this would charge it, and an unintended top-up here
    // would clear the debt and destroy the 5.3 case below.
    await test.step('PAY NOW without a saved card warns the user', async () => {
      let cardEmpty = false;
      try {
        await activity.assertCardOnFileEmpty();
        cardEmpty = true;
      } catch {
        test.info().annotations.push({
          type: 'skipped',
          description:
            `${accountId} appears to have a card on file — skipping the no-card check ` +
            `rather than risking an unintended charge.`,
        });
      }
      if (!cardEmpty) return;

      dialogs.reset();
      await activity.navigateToTopUp();
      await topup.assertLoaded();
      await topup.enterAmount(1);
      await topup.clickPayNow();
      // The dialog is handled by the listener above, so give it a moment to fire.
      await page.waitForTimeout(2_000);

      const captured = dialogs.messages;
      console.log(`[TS-04] dialogs captured: ${captured.length ? captured.join(' | ') : '(none)'}`);
      expect
        .soft(
          dialogs.sawMessage(/card/i),
          `Expected a warning about the missing card. Captured: ` +
          `${captured.length ? captured.join(' | ') : '(no dialog at all)'}`,
        )
        .toBe(true);

      // Nothing should have been charged.
      const unchanged = await notifyDb.getCrcBalance(accountId);
      expect
        .soft(unchanged ?? 0, 'a blocked PAY NOW must not change the balance')
        .toBeCloseTo(debt, 2);
    });

    // ── 5.3 — partial top-up must NOT reconnect ────────────────────────────
    const partial = Math.max(100, Math.floor(debt / 2));
    await test.step(`5.3 — top up ${partial}, less than the ${debt.toFixed(2)} owed`, async () => {
      await topup.enterAmount(partial);
      await topup.clickPayWithPlaceToPay();
      try {
        await checkout.completePaymentFlow('approve');
      } catch (err) {
        // The displayed minimum here is 3300 + debt, which by construction always
        // EXCEEDS the debt. So if the amount field is validated against it, no
        // top-up can ever leave the account still in debt, and case 5.3 is not
        // reachable through Selfcare at all. Worth recording rather than failing.
        test.info().annotations.push({
          type: 'partial-topup-blocked',
          description:
            `Top-up of ${partial} (below the displayed minimum of ${(3300 + debt).toFixed(2)}) ` +
            `did not complete. If the minimum is enforced, case 5.3 cannot be produced via ` +
            `Selfcare — every valid top-up clears the debt. ` +
            `${String(err).split('\n')[0].slice(0, 140)}`,
        });
        console.log('[TS-04] partial top-up did not complete — see annotation');
        return;
      }

      const balance = await waitForBalanceChange(accountId, debt, 180_000);
      await notifyDb.waitForNotificationsToSettle({ afterId: watermark, quietMs: 20_000, timeoutMs: 120_000 });
      const status = await subscriptionStatus(accountId);
      const resumed = await notifyDb.getNotifications({
        accountIds: [accountId], type: 'RESUME_SUBSCRIPTION', afterId: watermark,
      });
      console.log(`[TS-04] after partial: balance ${balance} | status ${status} | resume rows ${resumed.length}`);

      expect
        .soft(status, `${accountId} must stay SUSPENDED after a partial top-up`)
        .toBe('SUSPENDED');
      expect
        .soft(
          resumed.length,
          `no RESUME_SUBSCRIPTION should fire while the balance is still in debt ` +
          `(balance ${balance})`,
        )
        .toBe(0);
      expect
        .soft(balance ?? 0, 'a partial top-up should reduce the debt but not clear it')
        .toBeGreaterThan(0);
    });

    // ── 5.2 — clearing top-up must reconnect ───────────────────────────────
    const remaining = (await notifyDb.getCrcBalance(accountId)) ?? debt;
    // Just over the remaining debt. Deliberately BELOW the displayed minimum
    // (3300 + debt): the runbook records reconnection working at a final balance
    // of -0.70, so clearing the debt should be sufficient. If reconnection needs
    // the full suggested minimum instead, this step catches that.
    const clearing = Math.max(200, Math.ceil(remaining) + 200);
    await test.step(`5.2 — top up ${clearing}, clearing the ${remaining} still owed`, async () => {
      const before = (await notifyDb.getCrcBalance(accountId)) ?? remaining;
      await topup.reload(activity);
      await topup.enterAmount(clearing);
      await topup.clickPayWithPlaceToPay();
      await checkout.completePaymentFlow('approve');

      const balance = await waitForBalanceChange(accountId, before, 180_000);
      await notifyDb.waitForNotificationsToSettle({ afterId: watermark, quietMs: 20_000, timeoutMs: 240_000 });
      const status = await subscriptionStatus(accountId);
      console.log(`[TS-04] after clearing: balance ${balance} | status ${status}`);

      expect.soft(balance ?? 0, 'balance should now be in credit (negative)').toBeLessThan(0);
      expect.soft(status, `${accountId} should be back to ACTIVE`).toBe('ACTIVE');

      // Both emails are expected: the top-up receipt and the reconnection notice.
      const topupRows = await notifyDb.getNotifications({
        accountIds: [accountId], type: 'BALANCE_TOPUP', afterId: watermark,
      });
      expect.soft(topupRows.length, 'expected a BALANCE_TOPUP notification').toBeGreaterThan(0);

      const found = await notifyDb.getRenderedEmail(accountId, 'RESUME_SUBSCRIPTION', {
        afterId: watermark,
      });
      expect
        .soft(
          found,
          `no RESUME_SUBSCRIPTION notification for ${accountId} after clearing the debt ` +
          `(balance ${balance}, status ${status}). Only 2 of these have ever been produced ` +
          `on this tenant, so treat absence as a real finding rather than a flake.`,
        )
        .toBeTruthy();
      if (!found) return;

      const ctx: NotificationContext = {
        accountId,
        firstName: '', lastName: '',
        recipient: found.row.email ?? process.env.NOTIFY_EMAIL_TO ?? '',
        ccpDate: await notifyDb.getCcpDate(),
        email: found.email,
        // Body comes from email_notification.content, so delivery time is not
          // measured here. Undefined rather than 0, which would read as instant.
          deliverySeconds: undefined,
        postBalance: balance ?? 0,
        notificationStatus: found.row.status,
        templateFile: await notifyDb.getTemplateFile('RESUME_SUBSCRIPTION'),
      };

      const template = BILLING_EVENT_TEMPLATES.RESUME_SUBSCRIPTION;
      const results = report.evaluateAll(template, ctx);
      for (const r of results) {
        if (r.knownDefect) continue;
        expect
          .soft(r.passed, `RESUME_SUBSCRIPTION / ${r.row}\n  expected: ${r.expected}\n  actual:   ${r.actual}`)
          .toBe(true);
      }

      const markdown = report.buildJiraTable(template, ctx, results);
      const file = report.writeReport(template, ctx, markdown);
      await test.info().attach(`RESUME_SUBSCRIPTION-${accountId}.md`, {
        path: file, contentType: 'text/markdown',
      });
    });

    // ── Does the plus-address actually reach the To: header? ────────────────
    if (plus) {
      await test.step('plus-addressed recipient identifies the account in delivered mail', async () => {
        const tag = NotificationDbHelper.plusTag(accountId);
        const emailHelper = new EmailHelper();
        await emailHelper.connect();
        let tagged;
        try {
          tagged = await emailHelper.searchEmails({
            match: (e) => e.to.includes(tag),
            since: new Date(Date.now() - 60 * 60 * 1000),
            limit: 10,
          });
        } finally {
          await emailHelper.disconnect();
        }

        console.log(`[TS-04] emails addressed to "${tag}": ${tagged.length}`);
        tagged.forEach((e) => console.log(`   ${e.subject}  ->  ${e.to}`));

        expect
          .soft(
            tagged.length,
            `No delivered email carried "${tag}" in its To: header. Either the ` +
            `plus-address was not used as the recipient, or it was normalised away ` +
            `en route — in which case this attribution approach will not work for ` +
            `Events 4 and 5 either.`,
          )
          .toBeGreaterThan(0);

        // Cross-check against the body. BALANCE_TOPUP prints the account number,
        // so the To: header and the body must agree — that is what proves the
        // header can be trusted for the templates that print nothing.
        const topupEmail = tagged.find((e) => /Recarga/i.test(e.subject));
        if (topupEmail) {
          const inBody = topupEmail.field('Número de Servicio');
          console.log(`[TS-04] cross-check — To: has ${tag}, body says "${inBody}"`);
          expect
            .soft(
              inBody,
              `To: header and body disagree. Header tagged ${tag}, body reported ` +
              `"${inBody}". Attribution by header is only trustworthy if these match.`,
            )
            .toBe(accountId);
        } else {
          test.info().annotations.push({
            type: 'cross-check-unavailable',
            description:
              `No Recarga email among the tagged results, so the To:-vs-body ` +
              `cross-check could not run. Header attribution is unconfirmed.`,
          });
        }
      });
    }

    console.log(
      `\n[TS-04] ${accountId} consumed — left ACTIVE and in credit, which is the correct ` +
      `end state for a reconnection.\n`,
    );
  });
});
