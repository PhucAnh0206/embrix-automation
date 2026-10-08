/**
 * EXPLORATORY PROOF — make a payable bill exist from nothing, then pay it.
 *
 * NOT A TEST CASE. No TC number, and not intended to become part of any suite. This
 * exists to answer one question that every other payment test only ever *inferred*:
 *
 *     can we drive the chain FORWARD — new account → meter reading → rating →
 *     billing run → payable bill → paid — or do we merely observe bills that
 *     someone else's work left lying on the environment?
 *
 * explore-01/02 answer "where does a payable bill come from" by tracing BACKWARDS from
 * existing records. The linkage is real (foreign keys, not timing correlation), so the
 * trace is strong — but nothing in those specs ever *made* a bill appear. This does.
 *
 * TWO PHASES, deliberately separate tests
 *   Phase A  create the account, give it credit, make it consume electricity, and
 *            prove the consumption was rated.
 *   Phase B  bill that consumption, prove a payable bill appeared, and pay it.
 *
 * They are split because each phase runs for several minutes and each must fit inside
 * one foreground invocation — long background runs get killed on this machine. Phase A
 * writes a handoff file that Phase B reads, so the two can run in separate processes,
 * minutes or hours apart. `PROVE_ACCOUNT_ID` overrides the handoff to re-run Phase B
 * against an account Phase A already prepared.
 *
 * WHAT IT COSTS — read before running
 *   • Creates a real account, order and meter through the Core UI (~2-3 min).
 *     The CRM gateway is NOT used: it makes an account in ~3s but silently never
 *     attaches the meter, and without a `service_provision` type=METER row nothing
 *     rates.
 *   • Tops up for real against the PlaceToPay test gateway.
 *   • Loads a real MDR file through the real loader on the jumphost, over SSH.
 *   • MOVES THE TENANT CCP CLOCK to the account's required schedule date, and SPENDS
 *     ONE of the two `job_schedule` slots available on that date. Both are shared with
 *     everyone else on the environment. Routine on dev; do not point this at anything
 *     precious.
 *   • Pays the resulting bill for real.
 *
 * FINDING FOUND BY BUILDING THIS — the declared initial meter reading is ignored.
 * The order takes a "lectura inicial" and stores it on
 * `core_engine.service_provision.flexattr1` (12,300 kWh for the test data here), but
 * RATING DOES NOT USE IT. It takes the delta against
 * `core_mediation.energy_cdr_detail`, which is empty for a newly provisioned meter,
 * so previous = 0 and the FIRST reading is rated in full. Measured on ACT-100650
 * (2026-08-26): first reading 12,325 kWh was rated as 12,325 kWh of consumption
 * instead of 25, taking the account from 20,000 CRC in credit to 1,070,793 CRC in
 * debt. In production that is a customer being billed for the meter's entire lifetime
 * odometer on their first invoice. Worth raising — either the order's initial reading
 * must seed the mediation baseline, or the first reading after installation has to be
 * treated as a baseline and rated at zero. A4 works around it by reading mediation's
 * own position and adding to that.
 *
 * WHY THE CLOCK MOVE IS UNAVOIDABLE. `BILL_CHECK` bills an account only when the
 * schedule's date equals that account's `required_scheduledate` EXACTLY —
 * `billing_profile.nextaccountingdate + get_future_cycle_date(accountid)`. A brand-new
 * account's date is next cycle, so either the clock goes there or the account is not
 * billed at all. There is no "bill just this account, now" button.
 *
 * Requires: VPN (DB), Core UI creds via `setup`, SELFCARE_BASE_URL, and ssh access to
 * the loader host (`embrix-dev` in ~/.ssh/config, override with MDR_SSH_HOST).
 *
 * Owner: Anh Tran (QC)
 */

import * as fs from 'fs';
import * as path from 'path';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import {
  createPrepaidAccountWithOrder,
  attachToAccountInSelfCare,
  type PrepaidAccountWithOrderRow,
} from '../../../../fixtures/create-prepaid-account.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import { MdrRemoteHelper } from '../../../../helpers/mdr-remote.helper';
import { JobScheduleHelper } from '../../../../helpers/job-schedule.helper';
import { ServerHelper } from '../../../../helpers/server-api.helper';
import { NotificationDbHelper } from '../../../../helpers/notification-db.helper';
import {
  readAccountPaymentState,
  newPayments,
  newAropsPayments,
  moneyEquals,
} from '../../../../helpers/payment-db.helper';

/** This spec owns the clock itself — the fixture must not reset it underneath. */
test.use({ ccpBaseline: null });

const OUT_DIR = path.join(process.cwd(), 'artifacts', 'payment-proof');
const HANDOFF = path.join(OUT_DIR, 'proof-handoff.json');

/** kWh to consume. Small on purpose: block 1 (0-30 kWh), no ICB, no IVA — the
 *  cheapest consumption that still produces rated usage to bill. */
const KWH_TO_CONSUME = 25;
/** Top-up first, generously. A prepaid account with no credit may have its reading
 *  PARKED rather than rated (the credit-limit path), which would look like a
 *  mediation failure. 20,000 CRC against ~1,600 CRC of consumption is ample. */
const TOPUP_AMOUNT = 20000;

interface Handoff {
  accountId: string;
  provisioningId: string;
  /** What the ORDER declared as the meter's starting position. Ignored by rating. */
  declaredInitialReadingKwh: number;
  /** What mediation thinks the meter is at. Filled in at A4. */
  meterPositionBefore: number | null;
  /** The absolute reading actually submitted. Filled in at A4. */
  submittedReadingKwh: number | null;
  createdAt: string;
}

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const baseRow: PrepaidAccountWithOrderRow = JSON.parse(fs.readFileSync(dataFile, 'utf-8'))[0];

let db: DbHelper;
let api: APIRequestContext;

function saveArtifact(name: string, payload: unknown): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return file;
}

/**
 * Gate. Every test here skips unless `PAYMENT_PROOF_RUN=true`, so a bare
 * `npx playwright test` cannot move the tenant clock or spend a job slot by
 * accident. NOTE (2026-10-08): there is NO `jasec-payment-proof` project and
 * playwright.config.ts does not set PAYMENT_PROOF_RUN - no Playwright project
 * matches payment/ at all. These payment specs are diagnostics, not wired to any
 * project; add a project before running them.
 */
const PROOF_RUN = process.env.PAYMENT_PROOF_RUN === 'true';

test.beforeAll(async () => {
  test.skip(
    !PROOF_RUN,
    'Forward proof of the billing chain. Run it deliberately with PAYMENT_PROOF_RUN=true.\n' +
    '  The payment specs are not wired to any Playwright project (diagnostics) - add a\n' +
    '  project matching payment/ before running, then --grep "@proof-a" or "@proof-b".\n' +
    'It creates an account + order + meter, loads a real MDR file, MOVES THE TENANT ' +
    'CCP CLOCK, spends a job_schedule slot, and pays the bill it produces.',
  );
  db = new DbHelper();
  await db.connect();
  api = await playwrightRequest.newContext();
});

test.afterAll(async () => {
  await db?.disconnect();
  await api?.dispose();
});

test.describe(
  'EXPLORE — prove a payable bill can be produced from nothing',
  { tag: ['@explore', '@jasec', '@payment', '@proof'] },
  () => {
    // ══════════════════════════════════════════════════════════════════════
    //  PHASE A — new account → credit → consumption → rated
    // ══════════════════════════════════════════════════════════════════════
    test(
      'Phase A: a brand-new account consumes electricity and the usage is rated',
      { tag: ['@proof-a'] },
      async ({
        page, testLogger, screenshotHelper,
        searchAccountsPage, createAccountPage, orderManagementPage,
        selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        selfcareTopupPage, placeToPayCheckoutPage,
      }, testInfo) => {
        // Account creation through the UI plus a PlaceToPay round trip plus mediation
        // does not fit the default 10 minutes.
        test.setTimeout(1_500_000);

        const mdr = new MdrRemoteHelper(testLogger);
        const available = await mdr.isAvailable();
        expect(
          available,
          'BLOCKED — the MDR loader is not reachable over ssh. Check the VPN and that ' +
          '`ssh embrix-dev` works, or set MDR_SSH_HOST.',
        ).toBeTruthy();

        // ── A1 — create the account, order and meter ──────────────────
        //
        // Resumable on purpose. This phase runs for minutes and the expensive part is
        // the first step; a failure later should not force a fresh account. Set
        // PROVE_ACCOUNT_ID and PROVE_METER_ID to reuse one an earlier run built.
        const created = await test.step('A1. Create a prepaid account with an order and a meter', async () => {
          const resumeAccount = process.env.PROVE_ACCOUNT_ID;
          const resumeMeter = process.env.PROVE_METER_ID;
          if (resumeAccount && resumeMeter) {
            testLogger.log(`A1 — RESUMING on ${resumeAccount} / meter ${resumeMeter} ` +
              '(PROVE_ACCOUNT_ID + PROVE_METER_ID set; nothing created)');
            return { accountId: resumeAccount, orderId: '(resumed)', provisioningId: resumeMeter };
          }
          const result = await createPrepaidAccountWithOrder(
            page, searchAccountsPage, createAccountPage,
            orderManagementPage, screenshotHelper, baseRow, testLogger,
          );
          testLogger.log(`A1 — account ${result.accountId}, order ${result.orderId}, ` +
            `meter ${result.provisioningId}`);
          return result;
        });

        // Write the handoff NOW, not at the end: the account exists from here on, and
        // losing its id to a later failure means paying for a new one. The reading is
        // filled in after A4, which is where it is decided.
        const handoff: Handoff = {
          accountId: created.accountId,
          provisioningId: created.provisioningId,
          declaredInitialReadingKwh: Number(baseRow.meter.lecturaInicialKwh),
          meterPositionBefore: null,
          submittedReadingKwh: null,
          createdAt: new Date().toISOString(),
        };
        const writeHandoff = () => {
          fs.mkdirSync(OUT_DIR, { recursive: true });
          fs.writeFileSync(HANDOFF, JSON.stringify(handoff, null, 2), 'utf-8');
        };
        writeHandoff();
        testLogger.log(`A1 — handoff written to ${HANDOFF}`);

        // ── A2 — baseline: nothing to pay, and the meter is really attached ──
        await test.step('A2. Baseline: no bills, no payments, meter provisioned', async () => {
          const state = await readAccountPaymentState(db, created.accountId);
          testLogger.log(`A2 — invoices=${state.allInvoices.length} payments=${state.payments.length} ` +
            `balance=${state.balance} subscription=${state.subscriptionStatus}`);

          // The whole point of the proof: start from nothing. Must hold even on a
          // resumed account — if either exists, this account has been billed before
          // and can prove nothing about a first bill.
          expect(state.allInvoices, 'this account already has invoices').toHaveLength(0);
          expect(state.payments, 'this account already has payments').toHaveLength(0);

          // Without this row nothing rates, and the failure looks like a mediation
          // problem rather than a missing order step.
          const meterRows = await db.query<any>(
            `SELECT sp.id, sp.provisioningid, sp.type
               FROM core_engine.service_provision sp
              WHERE sp.provisioningid = $1`,
            [created.provisioningId],
          );
          testLogger.log(`A2 — service_provision rows for meter: ${JSON.stringify(meterRows)}`);
          expect(
            meterRows.some((r: any) => r.type === 'METER'),
            `no service_provision type=METER row for ${created.provisioningId} — rating ` +
            'cannot happen. The order flow is what creates it; the CRM gateway does not.',
          ).toBeTruthy();

          // Eligibility for a future billing run needs a PENDING bill unit.
          const pending = await db.query<any>(
            `SELECT id, status, to_char(startdate,'YYYY-MM-DD') sd, to_char(enddate,'YYYY-MM-DD') ed
               FROM core_engine.bill_unit WHERE accountid = $1`,
            [created.accountId],
          );
          testLogger.log(`A2 — bill units: ${JSON.stringify(pending)}`);
        });

        // ── A3 — give it credit ───────────────────────────────────────
        await test.step(`A3. Top up ${TOPUP_AMOUNT} CRC so consumption can be rated`, async () => {
          const start = await readAccountPaymentState(db, created.accountId);
          if ((start.balance ?? 0) < 0) {
            testLogger.log(`A3 — already in credit (${start.balance}); skipping the top-up`);
            return;
          }

          await attachToAccountInSelfCare(
            { selfcareLoginPage, selfcareAccountSearchPage },
            created.accountId,
          );
          await selfcareActivityPage.navigateToTopUp();
          await selfcareTopupPage.assertLoaded();
          await selfcareTopupPage.enterAmount(TOPUP_AMOUNT);

          // PlaceToPay rather than Pay Now: this account has no saved card and the
          // proof does not need one.
          await selfcareTopupPage.clickPayWithPlaceToPay();
          await placeToPayCheckoutPage.completePaymentFlow('approve');

          // The DATABASE is the oracle, not the Top Up history table.
          // `assertPaymentSuccess()` polls that table, which does not re-fetch after
          // the PlaceToPay round trip (SelfcareTopupPage.reload exists for exactly
          // this), and it reported "no history rows" for a top-up that had in fact
          // landed — core_engine already showed -20,000 CRC. Asserting the UI here
          // would fail this proof on a known display staleness rather than on
          // anything to do with billing.
          // Inverted CRC: credit is NEGATIVE.
          await expect
            .poll(async () => (await readAccountPaymentState(db, created.accountId)).balance ?? 0,
              { timeout: 120_000, intervals: [5_000] })
            .toBeLessThanOrEqual(-TOPUP_AMOUNT);

          const after = await readAccountPaymentState(db, created.accountId);
          testLogger.log(`A3 — balance after top-up: ${after.balance} (negative = credit)`);
        });

        // ── A4 — consume electricity through the real pipeline ────────
        let submittedReading = 0;
        await test.step('A4. Submit a meter reading so exactly the intended kWh is rated', async () => {
          // Read the meter's position FROM MEDIATION, and add the consumption to that.
          //
          // This is the trap that caught the first run of this proof. The order
          // declares an initial reading (12,300 kWh here, stored on
          // `service_provision.flexattr1`), and it is tempting to submit
          // declared + 25. But rating does not look at that field: it takes the delta
          // against `core_mediation.energy_cdr_detail`, which for a NEW meter is
          // EMPTY — previous = 0. Submitting 12,325 therefore rated 12,325 kWh, not
          // 25: ACT-100650 went from 20,000 CRC in credit to 1,070,793 CRC in DEBT off
          // a single first reading. See the note in the file header — that behaviour
          // is a finding in its own right, not just a test bug.
          const posRows = await db.query<any>(
            `SELECT COALESCE(MAX(kwhinboundtotal), 0)::float8 AS pos
               FROM core_mediation.energy_cdr_detail
              WHERE meterdeviceid = $1
                AND (status = 'MOVED_TO_FDR' OR status IS NULL)`,
            [created.provisioningId],
          );
          const position = posRows[0]?.pos ?? 0;
          submittedReading = position + KWH_TO_CONSUME;

          handoff.meterPositionBefore = position;
          handoff.submittedReadingKwh = submittedReading;
          writeHandoff();

          testLogger.log(
            `A4 — mediation has the meter at ${position} kWh; order declared ` +
            `${baseRow.meter.lecturaInicialKwh} kWh (ignored by rating). Submitting ` +
            `${submittedReading} so the rated delta is exactly ${KWH_TO_CONSUME} kWh.`,
          );

          const out = await mdr.submitReading(created.provisioningId, submittedReading);
          await testInfo.attach('a4-mdr-loader-output.txt', {
            body: out, contentType: 'text/plain',
          });

          // The loader prints the delta it will rate. If that is not what we asked
          // for, everything downstream is measuring the wrong thing.
          const willRate = out.match(/will rate:\s*([\d.]+)/)?.[1];
          testLogger.log(`A4 — loader says it will rate ${willRate} kWh`);
          expect(
            Number(willRate),
            `loader will rate ${willRate} kWh, expected ${KWH_TO_CONSUME}`,
          ).toBeCloseTo(KWH_TO_CONSUME, 2);
        });

        // ── A5 — prove it was rated ──────────────────────────────────
        await test.step('A5. The consumption was rated into usage transactions', async () => {
          // Poll: mediation then rating are asynchronous.
          await expect
            .poll(
              async () => {
                const rows = await db.query<any>(
                  `SELECT count(*)::int AS n FROM core_engine.transaction_unit
                    WHERE accountid = $1 AND type = 'USAGE' AND source = 'MEDIATION'`,
                  [created.accountId],
                );
                return rows[0]?.n ?? 0;
              },
              { timeout: 300_000, intervals: [10_000] },
            )
            .toBeGreaterThan(0);

          const txns = await db.query<any>(
            `SELECT type, source, itemid, grossamount::text, to_char(startdate,'YYYY-MM-DD') sd
               FROM core_engine.transaction_unit
              WHERE accountid = $1 ORDER BY type, itemid`,
            [created.accountId],
          );
          for (const t of txns) {
            testLogger.log(`  A5 — ${t.type}/${t.source} ${t.itemid ?? ''} ${t.grossamount}`);
          }

          const state = await readAccountPaymentState(db, created.accountId);
          testLogger.log(`A5 — balance after ${KWH_TO_CONSUME} kWh: ${state.balance} ` +
            '(less credit than before = consumption was charged)');

          // Still in credit. 25 kWh in block 1 is roughly 1,600 CRC against a 20,000
          // CRC top-up, so a POSITIVE balance here means far more than 25 kWh was
          // rated — which is exactly what the meter-baseline trap in A4 produces.
          expect(
            state.balance ?? 0,
            `balance is ${state.balance} — positive means the account is in DEBT, so much ` +
            `more than ${KWH_TO_CONSUME} kWh was rated. Check the delta the loader reported.`,
          ).toBeLessThan(0);

          // Still nothing payable: consumption alone does not produce a bill. That is
          // the billing run's job, and it is the point of Phase B.
          expect(
            state.openInvoices,
            'an invoice appeared before any billing run — the model is not what we think',
          ).toHaveLength(0);
        });

        await testInfo.attach('proof-handoff.json', {
          body: JSON.stringify(handoff, null, 2), contentType: 'application/json',
        });

        testLogger.log(
          `PHASE A COMPLETE — account ${created.accountId} has rated consumption and NO bill. ` +
          `Handoff written to ${HANDOFF}. Run Phase B next (--grep "@proof-b").`,
        );
      },
    );

    // ══════════════════════════════════════════════════════════════════════
    //  PHASE B — billing run → payable bill → paid
    // ══════════════════════════════════════════════════════════════════════
    test(
      'Phase B: the billing run turns that consumption into a payable bill, and it can be paid',
      { tag: ['@proof-b'] },
      async ({
        testLogger, selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareMakePaymentPage, placeToPayCheckoutPage,
      }, testInfo) => {
        test.setTimeout(1_500_000);

        // ── B0 — pick up where Phase A left off ──────────────────────
        const accountId = await test.step('B0. Read the account Phase A prepared', async () => {
          const pinned = process.env.PROVE_ACCOUNT_ID;
          if (pinned) {
            testLogger.log(`B0 — using PROVE_ACCOUNT_ID=${pinned}`);
            return pinned;
          }
          expect(
            fs.existsSync(HANDOFF),
            `BLOCKED — no handoff at ${HANDOFF}. Run Phase A first (--grep "@proof-a"), ` +
            'or set PROVE_ACCOUNT_ID to an account it already prepared.',
          ).toBeTruthy();
          const h: Handoff = JSON.parse(fs.readFileSync(HANDOFF, 'utf-8'));
          testLogger.log(`B0 — handoff: account ${h.accountId}, meter ${h.provisioningId}, ` +
            `reading ${h.submittedReadingKwh} kWh, prepared ${h.createdAt}`);
          return h.accountId;
        });

        const before = await readAccountPaymentState(db, accountId);
        const jobs = new JobScheduleHelper(api, testLogger);
        const serverHelper = new ServerHelper(api, testLogger);
        const notifyDb = new NotificationDbHelper(db, testLogger);

        // ── B1 — find the ONLY date that will bill this account ──────
        const scheduleDate = await test.step("B1. Resolve the account required schedule date", async () => {
          const required = await notifyDb.getRequiredScheduleDate(accountId);
          const ccpNow = await notifyDb.getCcpDate();
          testLogger.log(`B1 — required_scheduledate=${required}, CCP now=${ccpNow}`);
          expect(
            required,
            'no billing profile / required schedule date for this account',
          ).toBeTruthy();

          // BILL_CHECK matches the schedule date EXACTLY against each account's
          // required_scheduledate. Any other date bills everyone except this account.
          const slots = await notifyDb.getScheduleSlots(required!);
          testLogger.log(`B1 — existing slots on ${required}: ${JSON.stringify(slots)}`);
          return required!;
        });

        // ── B2 — move the clock and run the billing jobs ─────────────
        const status = await test.step('B2. Move CCP to that date and run BILL_CHECK → BILL_CC → INVOICE_CHECK', async () => {
          const ccpNow = await notifyDb.getCcpDate();
          if (ccpNow !== scheduleDate) {
            testLogger.log(`B2 — moving CCP ${ccpNow} → ${scheduleDate}`);
            await serverHelper.setAndVerifyCcpTime(scheduleDate);
          } else {
            testLogger.log(`B2 — CCP already at ${scheduleDate}`);
          }

          // A date holds at most TWO schedules — one per frequency — enforced by
          // `job_schedule_schedulefrequency_scheduledate_key`. The account's required
          // date is fixed, so if both slots are taken the run cannot happen at all.
          // First attempt at ACT-100651 hit exactly this: 2026-10-09 already had
          // DAILY:COMPLETED and SCHEDULED:ERROR. A spent-but-FAILED slot is
          // reclaimable; a COMPLETED one is not, because its accounts really were
          // billed.
          let frequency: 'SCHEDULED' | 'DAILY' | null = null;
          for (const candidate of ['SCHEDULED', 'DAILY'] as const) {
            const taken = (await notifyDb.getScheduleSlots(scheduleDate))
              .filter((sl) => sl.frequency === candidate);
            if (!taken.length) {
              frequency = candidate;
              break;
            }
            testLogger.log(`B2 — ${candidate} slot on ${scheduleDate} is ` +
              `${taken.map((t) => t.status).join('/')}; trying to reclaim it`);
            const freed = await notifyDb.freeScheduleSlot(scheduleDate, { frequency: candidate });
            if (freed.length) {
              testLogger.log(`B2 — reclaimed ${candidate}: ` +
                freed.map((f) => `${f.id}(${f.status})`).join(', '));
              frequency = candidate;
              break;
            }
          }

          expect(
            frequency,
            `BLOCKED — both job_schedule slots on ${scheduleDate} are taken and neither ` +
            'is reclaimable (a COMPLETED slot is never reclaimed). That date is the ONLY ' +
            'one that bills this account, so the proof cannot run today. Either wait for ' +
            'the next cycle date or free a slot by hand.',
          ).not.toBeNull();

          // All three jobs on ONE schedule. `insert_jobs` splits accounts by payment
          // method — BILL_CHECK takes CHECK, BILL_CC takes CREDIT_CARD — and an
          // account on the wrong job is silently not billed. INVOICE_CHECK must come
          // last: run before BILL_CHECK it produces empty invoices.
          const id = await jobs.createSchedule({
            scheduleDate,
            frequency: frequency!,
            jobs: JobScheduleHelper.billingJobsAllPaymentMethods(),
            // scheduleName is a FOREIGN KEY into core_config.config_job, which holds
            // exactly one row on this tenant: name='DAILY'. A descriptive name like
            // 'PROOF-FROM-ROOT' fails the FK. Leave it to the helper default.
          });
          const result = await jobs.processSchedule(id);
          testLogger.log(`B2 — schedule ${result.id} (${frequency}) finished with ` +
            `status ${result.status}`);
          return result.status;
        });

        // ── B3 — THE PROOF: a payable bill now exists ────────────────
        const invoice = await test.step('B3. A payable bill now exists that did not exist before', async () => {
          await expect
            .poll(
              async () => (await readAccountPaymentState(db, accountId)).allInvoices.length,
              { timeout: 300_000, intervals: [10_000] },
            )
            .toBeGreaterThan(before.allInvoices.length);

          const after = await readAccountPaymentState(db, accountId);
          const seen = new Set(before.allInvoices.map((i) => i.id));
          const fresh = after.allInvoices.filter((i) => !seen.has(i.id));

          for (const i of fresh) {
            testLogger.log(`  B3 — new invoice ${i.id}: status=${i.status} total=${i.total} ` +
              `due=${i.due} ${i.invoicedate} → ${i.duedate}`);
          }

          expect(fresh.length, 'the billing run produced no new invoice').toBeGreaterThan(0);
          const payable = fresh.find((i) => i.status === 'ACTIVE' && i.due > 0);
          expect(
            payable,
            `the billing run made ${fresh.length} invoice(s) but none is payable ` +
            `(ACTIVE with due > 0): ${JSON.stringify(fresh)}`,
          ).toBeTruthy();
          return payable!;
        });

        // ── B4 — show what is IN the bill ───────────────────────────
        await test.step('B4. The bill contains the rated consumption from Phase A', async () => {
          const rows = await db.query<any>(
            `SELECT t.type, t.source, t.itemid, t.grossamount::text AS gross
               FROM core_engine.invoice_unit iu
               JOIN core_engine.transaction_unit t
                 ON t.billunitid = iu.billunitid AND t.accountid = iu.accountid
              WHERE iu.id = $1 AND iu.accountid = $2
              ORDER BY t.type, t.itemid`,
            [invoice.id, accountId],
          );
          for (const r of rows) {
            testLogger.log(`  B4 — ${r.type}/${r.source} ${r.itemid ?? ''} ${r.gross}`);
          }

          const mediation = rows.filter((r: any) => r.source === 'MEDIATION');
          const billing = rows.filter((r: any) => r.source === 'BILLING');
          testLogger.log(
            `B4 — bill ${invoice.id} total ${invoice.total}: ` +
            `${mediation.length} rated-consumption row(s), ${billing.length} fixed-charge row(s)`,
          );

          // This is the link the backward trace could only infer: the usage rated in
          // Phase A is inside the bill the billing run produced in Phase B.
          expect(
            mediation.length,
            'the bill contains no MEDIATION rows — the rated consumption from Phase A ' +
            'did not make it into the bill, so the chain is NOT proven',
          ).toBeGreaterThan(0);
        });

        // ── B5 — pay it ─────────────────────────────────────────────
        await test.step('B5. The bill is visible in Self Care and can be paid', async () => {
          await attachToAccountInSelfCare(
            { selfcareLoginPage, selfcareAccountSearchPage },
            accountId,
          );
          await selfcareActivityPage.navigateToMakePayment();
          // Reload: the grid does not fetch on the dropdown navigation (the defect
          // explore-02 step 2 pins). Without this it shows "No record has found!".
          await selfcareMakePaymentPage.reloadToPopulateGrid(selfcareActivityPage);

          const listed = await selfcareMakePaymentPage.getListedInvoices();
          testLogger.log(`B5 — Self Care lists: ${listed.map((l) => l.invoiceId).join(', ')}`);
          expect(
            listed.some((l) => l.invoiceId === invoice.id),
            `the new bill ${invoice.id} is not offered for payment in Self Care`,
          ).toBeTruthy();

          await selfcareMakePaymentPage.selectInvoice(invoice.id);
          await selfcareMakePaymentPage.clickPayWithPlaceToPay();
          const outcome = await placeToPayCheckoutPage.completePaymentAndReadOutcome('approve');
          testLogger.log(`B5 — gateway charged "${outcome.chargedText}", ` +
            `verdict "${outcome.verdictText}"`);
          expect(outcome.approved, `gateway did not approve: ${outcome.verdictText}`).toBeTruthy();
        });

        // ── B6 — settled, and the money landed ──────────────────────
        await test.step('B6. The bill is settled and the balance moved by the amount paid', async () => {
          const beforePay = await readAccountPaymentState(db, accountId);
          await expect
            .poll(
              async () => {
                const now = await readAccountPaymentState(db, accountId);
                return now.payments.length;
              },
              { timeout: 120_000, intervals: [5_000] },
            )
            .toBeGreaterThan(before.payments.length);

          const after = await readAccountPaymentState(db, accountId);
          const created = newPayments(before, after);
          const settled = after.allInvoices.find((i) => i.id === invoice.id);

          testLogger.log(
            `B6 — ${created.length} payment(s) ${created.map((p) => p.id).join(',')}; ` +
            `invoice ${invoice.id} → ${settled?.status} due=${settled?.due}; ` +
            `balance ${beforePay.balance} → ${after.balance}`,
          );

          expect(created, 'expected exactly one payment for the new bill').toHaveLength(1);
          expect(moneyEquals(created[0].amount, invoice.due)).toBeTruthy();
          expect(settled?.status).toBe('CLOSED');
          expect(moneyEquals(settled?.due ?? -1, 0)).toBeTruthy();
          expect(newAropsPayments(before, after)).toHaveLength(1);

          const evidence = {
            accountId,
            scheduleDate,
            scheduleStatus: status,
            invoice,
            payment: created[0],
            balanceBefore: beforePay.balance,
            balanceAfter: after.balance,
          };
          const file = saveArtifact(`proof-${accountId}`, evidence);
          await testInfo.attach('proof.json', {
            body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
          });

          testLogger.log(
            `PROOF COMPLETE — a payable bill was produced from a brand-new account by ` +
            `rating a meter reading and running the billing job, then paid. Evidence: ${file}`,
          );
        });
      },
    );
  },
);
