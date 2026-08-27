/**
 * TS-02 — JEPYP-230 live staged billing run. Sections 1, 3, 4, 5 and 7.
 *
 * This is the TRIGGER half of the notification suite. TS-03 verifies rendered
 * bodies that already exist; this spec makes them exist — measure each account's
 * X and C, stage the balance bands, fire one billing schedule, then assert every
 * event including the checks TS-03 has to skip (amounts against the formulas,
 * tier paragraph against staged kWh, exactly-one-threshold-email counts).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SPEC CHANGES THE ENVIRONMENT AND SOME OF IT CANNOT BE UNDONE.
 *
 *   - It moves the tenant-global CCP clock FORWARD. There is no way back, and
 *     the clock is shared with everyone else testing on the tenant.
 *   - It consumes one of the TWO job_schedule slots on the target date.
 *   - It bills the staged accounts, which advances their nextaccountingdate and
 *     closes their PENDING bill units. Restoring balances does NOT restore
 *     eligibility — those accounts cannot be retested for that period.
 *   - BLAST RADIUS IS THE WHOLE DATE, NOT THE SEVEN ACCOUNTS. BILL_CHECK selects
 *     every account whose required_scheduledate equals scheduleDate, so all of
 *     them are billed and invoiced, not just the ones staged here. On jasec-dev
 *     that was 60+ accounts for a single date. Nothing in this spec can narrow
 *     it — that is how the job selects work. Pick the date accordingly.
 *
 * So it is gated behind JEPYP230_LIVE_RUN=true and skips otherwise. Never remove
 * that gate: a bare `npx playwright test` must not be able to move the clock.
 *
 *   JEPYP230_LIVE_RUN=true npm run test:notification:live
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Originals are written to test-results/jepyp230-restore.json BEFORE anything is
 * staged, so a crashed run can still be reversed by hand. The runbook has no
 * backup table and the discovery queries do not preserve prior values.
 *
 * Requires: VPN, DB_* env, EMBRIX_USER / EMBRIX_PASSWORD.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { NotificationDbHelper, type EligibleAccount } from '../../../../helpers/notification-db.helper';
import { JobScheduleHelper } from '../../../../helpers/job-schedule.helper';
import { ServerHelper } from '../../../../helpers/server-api.helper';
import { NotificationReportHelper } from '../../../../helpers/notification-report.helper';
import { EmailHelper } from '../../../../helpers/email.helper';
import {
  branchFor, stageFor, stageForThreshold, postBalance, willCrossZero,
  crossesThreshold, tierForKwh, DEFAULT_THRESHOLDS,
  type BillingEvent, type KwhTier,
} from '../../../../helpers/notification-bands';
import {
  BILLING_EVENT_TEMPLATES,
  amountAfter,
  EXHAUSTED_FRAGMENT,
} from '../../../../test-data/notifications/billing-events.templates';
import type { NotificationContext } from '../../../../test-data/notifications/types';

/**
 * The safety gate.
 *
 * This spec must never fire by accident, because it moves a shared clock that
 * cannot be moved back. It runs only when the live project was asked for BY NAME
 * on the command line (`--project=jasec-notification-live`, which is what
 * `npm run test:notification:live` passes), or when JEPYP230_LIVE_RUN=true is set
 * explicitly.
 *
 * So a bare `npx playwright test` — which otherwise runs every project — reaches
 * these tests and skips them all. Verified, not assumed: see the gate check in
 * the run log.
 *
 * Deliberately not requiring the caller to export an env var: that needed
 * `cross-env` to stay portable, and a dependency is a poor trade for a gate.
 * Naming the project IS the explicit intent we want to require.
 *
 * The argv detection lives in playwright.config.ts, NOT here. A spec runs in a
 * WORKER process whose `process.argv` does not carry `--project`, so checking it
 * here read false and skipped the whole suite even when explicitly asked for.
 * The config runs in the main process and exports the result as this env var,
 * which workers inherit.
 */
const LIVE = process.env.JEPYP230_LIVE_RUN === 'true';

/** Slot to use. SCHEDULED leaves DAILY free for whoever else needs the date. */
const FREQUENCY = (process.env.JEPYP230_FREQUENCY as 'DAILY' | 'SCHEDULED') ?? 'SCHEDULED';

/**
 * Floor for `batchSizeBilling` during a run — NOT a target.
 *
 * At the default of 5, Office365 refuses the parallel SMTP connections and the
 * notifications land as FAILED (rendered fine, never delivered), so the run has to
 * raise it. But it must NOT overwrite a value someone set deliberately: an earlier
 * version of this file hard-set 60, which silently overwrote a dev-configured 100
 * on every run and invalidated a batch-size comparison we had reported. Only raise
 * when the configured value is BELOW the floor, and say so when it happens.
 */
const BATCH_SIZE_FLOOR = 60;

const restoreFile = path.join(process.cwd(), 'test-results', 'jepyp230-restore.json');

/** One staged account and what it is supposed to produce. */
interface StagedAccount {
  accountId: string;
  event: BillingEvent;
  /** Event 3 only. */
  tier?: KwhTier;
  kwh?: number;
  /**
   * Case 3.5 — stage the balance but deliberately leave the account with NO KWH
   * accumulator rows. Such an account renders the <=100 kWh branch, and the open
   * defect is that it renders the label with no balance figure.
   */
  noKwh?: boolean;
  X: number;
  C: number;
  stagedBalance: number;
  post: number;
  originalBalance: number;
  originalKwhRows: number;
  /** Contact email before plus-addressing, for restore. Null = left untouched. */
  originalContactEmail?: string | null;
}

interface RunPlan {
  ccpDate: string;
  scheduleDate: string;
  accounts: StagedAccount[];
  originalBatchSize: string;
  /** Max email_notification id BEFORE the run — scopes every later assertion. */
  notificationWatermark: string;
}

let api: APIRequestContext;
let db: DbHelper;
let notifyDb: NotificationDbHelper;
let jobs: JobScheduleHelper;
let serverHelper: ServerHelper;
const report = new NotificationReportHelper();

let plan: RunPlan;
let scheduleId = '';

/**
 * Recover the run plan after a worker restart.
 *
 * Playwright restarts the worker process when a test fails, and module-level state
 * does not survive that — so a failure in an early assertion made every later test
 * fail instantly with "no run plan" rather than running. The plan is already
 * written to disk before staging, so reload it rather than losing the run.
 */
function requirePlan(): RunPlan | null {
  if (plan) return plan;
  try {
    if (fs.existsSync(restoreFile)) {
      plan = JSON.parse(fs.readFileSync(restoreFile, 'utf-8')) as RunPlan;
      console.log(`[TS-02] reloaded run plan from ${restoreFile} after a worker restart`);
      return plan;
    }
  } catch (err) {
    console.error(`[TS-02] could not reload the run plan: ${String(err)}`);
  }
  return null;
}

test.beforeAll(async () => {
  test.skip(
    !LIVE,
    'Live staged billing run. Set JEPYP230_LIVE_RUN=true to enable — it moves the ' +
    'tenant CCP clock forward irreversibly and consumes a job_schedule slot.',
  );
  api = await playwrightRequest.newContext();
  db = new DbHelper();
  await db.connect();
  notifyDb = new NotificationDbHelper(db);
  jobs = new JobScheduleHelper(api);
  serverHelper = new ServerHelper(api);
});

/**
 * Restore runs HERE, not as a final test.
 *
 * As a serial test it never executed: a hard assertion in step 4 threw, and
 * Playwright skips the remaining tests in a serial group — so the staged
 * balances and the raised batchSizeBilling were left behind and had to be undone
 * by hand. Teardown must not be contingent on the assertions passing.
 *
 * Guarded on `plan` so a failure during planning (before anything was written)
 * does not try to restore values it never captured.
 */
test.afterAll(async () => {
  try {
    if (plan && db) {
      for (const a of plan.accounts) {
        await notifyDb.setCrcBalance(a.accountId, a.originalBalance);
        // Only clear KWH rows this run created; leave pre-existing ones alone.
        if (a.kwh !== undefined && a.originalKwhRows === 0) {
          await notifyDb.clearKwh(a.accountId);
        }
        // Put the recipient back — a plus-address left behind would keep that
        // account's real notifications flowing to a tagged inbox.
        if (a.originalContactEmail) {
          await notifyDb.restoreContactEmail(a.accountId, a.originalContactEmail);
        }
      }
      await notifyDb.setBatchSizeBilling(Number(plan.originalBatchSize) || 5);
      console.log(
        `
[TS-02] restored ${plan.accounts.length} balances and ` +
        `batchSizeBilling=${plan.originalBatchSize}.
` +
        `        NOT reversible: the spent ${FREQUENCY} slot on ${plan.scheduleDate}, ` +
        `the billed accounts' advanced cycle, and the CCP clock.
`,
      );
    }
  } catch (err) {
    // Never let restore failure mask the test result — but make it loud, because
    // the environment is now dirty and test-results/jepyp230-restore.json is the
    // only record of the original values.
    console.error(`
[TS-02] RESTORE FAILED: ${String(err)}
` +
      `        Replay it by hand from test-results/jepyp230-restore.json
`);
  } finally {
    await db?.disconnect();
    await api?.dispose();
  }
});

// Steps 1-3 are a genuine chain: no plan, no staging; no staging, no run. Serial
// so a failure stops the chain instead of running the next step on bad state.
test.describe('TS-02 — staged billing run', () => {
  test.describe.configure({ mode: 'serial' });

  test('step 1 — preflight, pick the date, align the clock, build the plan', async () => {
    const [{ db_name }] = await db.query<{ db_name: string }>('SELECT current_database() AS db_name');
    const startingCcp = await notifyDb.getCcpDate();
    const originalBatchSize = await notifyDb.getBatchSizeBilling();

    console.log(`\n[TS-02] database ${db_name} | CCP ${startingCcp} | batchSizeBilling ${originalBatchSize}`);

    // Every template must be mapped, or the matching event silently sends
    // nothing — indistinguishable from a logic bug.
    for (const type of Object.keys(BILLING_EVENT_TEMPLATES)) {
      const subject = await notifyDb.getConfiguredSubject(type);
      expect(subject, `no ACTIVE PREPAID correspondence_template_list row for ${type}`).toBeTruthy();
    }

    // ── Pick the date ourselves ──────────────────────────────────────────
    // The schedule date is NOT a parameter a human looks up: a run is only
    // possible on a date where enough accounts resolve their own
    // required_scheduledate AND the slot is free. Discover it, earliest first,
    // so the clock moves as little as possible. JEPYP230_SCHEDULE_DATE still
    // overrides for a deliberate re-run.
    // OPT-IN slot reclaim, default OFF — with the flag unset everything below
    // behaves exactly as before. See NotificationDbHelper.freeScheduleSlot: it
    // only ever deletes ERROR / SUSPENDED / PENDING schedules, never COMPLETED
    // (those accounts really were billed) and never PROCESSING (a live job).
    const reclaimSlots = process.env.JEPYP230_RECLAIM_SLOTS === 'true';

    let scheduleDate = process.env.JEPYP230_SCHEDULE_DATE ?? '';
    if (scheduleDate && reclaimSlots) {
      // A pinned date is a deliberate re-run, which is exactly the case where the
      // previous attempt burned the slot.
      const freed = await notifyDb.freeScheduleSlot(scheduleDate, { frequency: FREQUENCY });
      if (freed.length) {
        console.log(
          `[TS-02] reclaimed spent ${FREQUENCY} slot on pinned date ${scheduleDate}: ` +
          freed.map((f) => `${f.id}/${f.status}`).join(' '),
        );
      }
    }
    if (!scheduleDate) {
      // No date floor: the CCP clock may be moved either way on dev/preprod, so
      // the best date is the one with the most un-billed accounts, not the
      // nearest. Older cycles are often much richer — 2026-09-09 had 112
      // eligible accounts against 84 on the current date.
      const usable = await notifyDb.findScheduleDateCandidates({
        frequency: FREQUENCY,
        minAccounts: 7,
        paymentMethod: 'CHECK',
        contactEmail: process.env.NOTIFY_EMAIL_TO,
        reclaim: reclaimSlots,
      });
      console.log(
        `[TS-02] usable dates (${FREQUENCY} slot free), best first: ` +
        (usable.map((u) => `${u.date}(${u.eligibleCount})`).join(', ') || '(none)'),
      );
      expect(
        usable.length,
        `No usable schedule date. A date needs >= 7 eligible accounts AND a free ` +
        `${FREQUENCY} slot. Either advance the accounts' cycle or free a slot ` +
        `(delete a spent schedule, children first).`,
      ).toBeGreaterThan(0);
      scheduleDate = usable[0].date;
    }

    // ── Align the clock ourselves ────────────────────────────────────────
    // Either direction is allowed on dev/preprod. Asserted rather than assumed
    // because setCcpTime is applied asynchronously — setAndVerifyCcpTime polls
    // until the server agrees.
    if (scheduleDate !== startingCcp) {
      const dir = scheduleDate > startingCcp ? 'forward' : 'BACKWARD';
      console.log(`[TS-02] moving CCP ${startingCcp} -> ${scheduleDate} (${dir})`);
      await serverHelper.setAndVerifyCcpTime(scheduleDate);
    } else {
      console.log(`[TS-02] CCP already at ${scheduleDate} — no clock move needed`);
    }
    const ccpDate = await notifyDb.getCcpDate();
    expect(ccpDate, 'CCP date did not settle on the schedule date').toBe(scheduleDate);

    const candidates = await notifyDb.findEligibleAccounts({
      scheduleDate,
      paymentMethod: 'CHECK',
      contactEmail: process.env.NOTIFY_EMAIL_TO,
      limit: 60,
    });

    console.log(`[TS-02] ${candidates.length} eligible accounts for scheduleDate ${scheduleDate}`);
    expect(
      candidates.length,
      `No eligible accounts for ${scheduleDate}. An account is eligible only when ` +
      `required_scheduledate == scheduleDate exactly; accounts billed by a previous ` +
      `run have advanced a cycle.`,
    ).toBeGreaterThanOrEqual(7);

    // Three accounts carry the Event 3 tiers and cannot double as 1A–1C/4+5,
    // because Event 3 is decided by kWh AND by which threshold is crossed.
    const wanted: Array<{
      event: BillingEvent; tier?: KwhTier; kwh?: number; noKwh?: boolean;
    }> = [
      { event: 'PREPAID_SUFFICIENT_CREDIT' },
      { event: 'PREPAID_INSUFFICIENT_CREDIT' },
      { event: 'PREPAID_OVERAGE' },
      { event: 'CREDIT_LIMIT_BREACH' },
      { event: 'CREDIT_THRESHOLD_BREACH', tier: 'BASE', kwh: 50 },
      { event: 'CREDIT_THRESHOLD_BREACH', tier: 'BASE', kwh: 150 },
      { event: 'CREDIT_THRESHOLD_BREACH', tier: 'HIGH', kwh: 350 },
      // Case 3.5 — same staging as the base tier, but no KWH rows at all.
      // kwh 0 (not undefined) so the tier assertions still resolve to BASE and
      // the expected tax paragraph is "none".
      { event: 'CREDIT_THRESHOLD_BREACH', tier: 'BASE', kwh: 0, noKwh: true },
    ];

    const accounts: StagedAccount[] = [];
    const pool = [...candidates];

    /**
     * Thresholds per account, resolved once. Selection needs them, and so does
     * staging a few lines later.
     */
    const thresholdCache = new Map<string, Awaited<ReturnType<typeof notifyDb.getAccountThresholds>>>();
    const thresholdsFor = async (accountId: string) => {
      if (!thresholdCache.has(accountId)) {
        thresholdCache.set(accountId, await notifyDb.getAccountThresholds(accountId));
      }
      return thresholdCache.get(accountId)!;
    };

    /**
     * Index of the first candidate that can actually carry an Event 3.
     *
     * IT IS NOT ENOUGH TO ASK FOR kwhRows === 0. A threshold account also has to
     * have credit-limit thresholds, and on this tenant 173 of 409 prepaid accounts
     * (42.3%) do not — 166 with no credit profile at all, 7 on Prepaid Energy
     * Profile whose valuethreshold is NULL. Picking positionally walked straight
     * into ACT-100392 (no profile) and failed the plan on the invalid-test-data
     * guard, which is the guard working but the selection wasting a run.
     *
     * The guard below is kept as a backstop rather than removed: it should now be
     * unreachable, and if it ever fires again something changed underneath.
     */
    const pickCapableIdx = async (requireZeroKwh: boolean): Promise<number> => {
      for (let i = 0; i < pool.length; i++) {
        if (requireZeroKwh && pool[i].kwhRows !== 0) continue;
        if (await thresholdsFor(pool[i].accountId)) return i;
      }
      return -1;
    };

    /**
     * CREDIT_LIMIT_BREACH NEEDS A CREDIT PROFILE TOO — not just Event 3.
     *
     * Missed on the first pass, and the run demonstrated it: ACT-100386 was staged
     * at -500 against C=2319.30, so it crossed into +1819.30 of debt, and nothing
     * happened. It has creditprofilename = NULL, so there is no credit limit to
     * breach: no breach, no suspension (it stayed ACTIVE), the invoice persisted,
     * and the positive post-charge balance took the 1C branch and sent
     * PREPAID_OVERAGE instead.
     *
     * That is the product behaving correctly for the config, and it is the same
     * 42.3% gap that constrains Event 3 — dev's note that these accounts "would
     * never be suspended for running out either" is exactly this. Unlike Event 3
     * the breach does NOT need zero kWh rows, so it can use a profiled account
     * that Event 3 cannot.
     */
    const needsCreditProfile = (e: BillingEvent) =>
      e === 'CREDIT_THRESHOLD_BREACH' || e === 'CREDIT_LIMIT_BREACH';

    /**
     * PLAN THE CONSTRAINED EVENTS FIRST — this is a scarce-resource allocation,
     * not a formality.
     *
     * An Event 3 account must have zero kWh rows AND credit-limit thresholds. On
     * scheduleDate 2027-09-09 only 4 of the 73 eligible accounts satisfy both
     * (55 have zero kWh but no thresholds, 12 have neither). Events 1A/1B/1C and
     * 4+5 will take literally any eligible account — but they were planned first
     * and each takes pool[0], i.e. the lowest account id, which is exactly where
     * the threshold-capable accounts live. They ate all four, and planning then
     * failed with "no eligible account with zero kWh rows AND credit-limit
     * thresholds is left" while four had been available a moment earlier.
     *
     * Selection order only; `accounts` is sorted back into declaration order
     * afterwards so the plan and the report stay stable.
     */
    // Most-constrained first: Event 3 needs a profile AND zero kWh rows, the
    // breach needs only a profile, everything else takes any account at all.
    const constraintRank = (e: BillingEvent) =>
      e === 'CREDIT_THRESHOLD_BREACH' ? 0 : e === 'CREDIT_LIMIT_BREACH' ? 1 : 2;
    const ordered = [...wanted].sort((a, b) => constraintRank(a.event) - constraintRank(b.event));

    /**
     * Event 3 slots this environment could not supply. Reported, never silent.
     *
     * WHY THIS DEGRADES INSTEAD OF FAILING. Four Event 3 accounts are wanted, and
     * the candidate pool cannot supply them: of the 60 eligible accounts on
     * 2027-09-09 that also carry paymentMethod CHECK and the notification contact
     * email, only 3 have credit-limit thresholds at all and only 2 of those also
     * have zero kWh rows (ACT-100151, ACT-100152). That is the 42.3% no-credit-
     * profile config gap intersected with the narrow test-account filter.
     *
     * Failing the plan over it blocked TWELVE manual cases that have nothing to do
     * with thresholds — 1.1-1.4, 4.1/4.2, 5.1, 6.1/6.2, 7.1 and 9.1 all ride on
     * this same run. So stage what the environment supports, and say loudly what
     * was dropped. A silent cap would read as "section 3 covered" when it was not.
     *
     * Still fails hard when NOTHING can be staged: that means section 3 is no
     * longer testable here at all, which should be red rather than annotated.
     */
    const skippedForCapacity: string[] = [];

    for (const w of ordered) {
      // Event 3 needs an account whose kWh we fully control AND that is capable of
      // warning at all.
      const idx = needsCreditProfile(w.event)
        ? await pickCapableIdx(w.event === 'CREDIT_THRESHOLD_BREACH')
        : 0;
      if (needsCreditProfile(w.event) && idx < 0) {
        skippedForCapacity.push(
          w.event === 'CREDIT_THRESHOLD_BREACH'
            ? `${w.event} tier=${w.tier} kWh=${w.kwh}${w.noKwh ? ' (noKwh — case 3.5)' : ''}`
            : `${w.event} (cases 4.1/4.2/5.1)`,
        );
        continue;
      }
      expect(idx, `ran out of eligible accounts while planning ${w.event}`).toBeGreaterThanOrEqual(0);
      const acct: EligibleAccount = pool.splice(idx, 1)[0];

      const X = await notifyDb.getX(acct.accountId);

      // C from the most recent NON-ZERO invoice. An in-debt account can be
      // invoiced 0.00, and taking the latest invoice then measures C as zero and
      // collapses every band derived from it.
      let C = await notifyDb.getCycleCharge(acct.accountId);
      if (C == null) {
        // No non-zero invoice ever. Fall back to the tenant default rather than
        // aborting, but say so — the bands are then predicted, not measured.
        C = Number(process.env.JASEC_CYCLE_CHARGE ?? 2319.30);
        const history = await notifyDb.getInvoiceTotals(acct.accountId, 4);
        test.info().annotations.push({
          type: 'C-estimated',
          description:
            `${acct.accountId} has no non-zero invoice (history: ` +
            `${history.map((h) => `${h.date}=${h.total}`).join(', ') || 'none'}). ` +
            `Using tenant default C=${C}. Verify the band if this account's event misses.`,
        });
        console.log(`[TS-02] ${acct.accountId}: C estimated at ${C} (no non-zero invoice)`);
      }
      expect(C, `C must be positive for ${acct.accountId}`).toBeGreaterThan(0);

      // Stage from the account's OWN thresholds, not the module defaults.
      //
      // Staging is derived from the threshold (staged = threshold - 400), so a
      // tenant configured with different values would be staged at a balance that
      // never crosses: no email fires, and the 3.4 check would then report a
      // product defect that does not exist. Dev confirmed production must assign a
      // profile with thresholds, but not that every tenant uses -4000|-2000.
      //
      // Null means the account cannot warn at all — invalid test data, caught here
      // at PLAN time rather than after a billing period has been spent.
      let thresholds;
      if (w.tier) {
        thresholds = await thresholdsFor(acct.accountId);
        expect(
          thresholds,
          `${acct.accountId} has no credit-limit thresholds, so it can never produce a ` +
          `threshold email. That is invalid test data, not a defect — pick accounts ` +
          `with findThresholdCapableAccounts().`,
        ).toBeTruthy();
        if (thresholds!.base !== DEFAULT_THRESHOLDS.base || thresholds!.high !== DEFAULT_THRESHOLDS.high) {
          console.log(
            `[TS-02] ${acct.accountId}: profile "${thresholds!.profile}" carries ` +
            `${thresholds!.raw}, which differs from the tenant default ` +
            `${DEFAULT_THRESHOLDS.high}|${DEFAULT_THRESHOLDS.base} — staging against the account's own values.`,
          );
        }
      }

      const stagedBalance = w.tier
        ? stageForThreshold(w.tier, thresholds ?? undefined)
        : stageFor(w.event, X, C);
      const post = postBalance(stagedBalance, C);

      // Fail the PLAN, not the run. A band that lands in the wrong event costs a
      // billing period, and the accounts cannot be reused for it.
      if (w.event === 'PREPAID_SUFFICIENT_CREDIT' || w.event === 'PREPAID_INSUFFICIENT_CREDIT') {
        expect(
          branchFor(stagedBalance, X, C),
          `${acct.accountId} staged at ${stagedBalance} (X=${X}, C=${C}) would not produce ${w.event}`,
        ).toBe(w.event);
      }
      if (w.event === 'CREDIT_LIMIT_BREACH') {
        expect(
          willCrossZero(stagedBalance, C),
          `${acct.accountId} must CROSS zero to trip the breach — already-positive ` +
          `accounts take the early return and produce Event 1C instead`,
        ).toBe(true);
      }
      if (w.tier) {
        expect(
          crossesThreshold(stagedBalance, C, w.tier, thresholds ?? undefined),
          `${acct.accountId} staged at ${stagedBalance} with C=${C} does not cross the ` +
          `${w.tier} threshold, so the tier correctly suppresses it and nothing sends`,
        ).toBe(true);
        expect(tierForKwh(w.kwh!), 'planned kWh does not match the planned tier').toBe(w.tier);
      }

      accounts.push({
        accountId: acct.accountId,
        event: w.event,
        tier: w.tier,
        kwh: w.kwh,
        noKwh: w.noKwh,
        X, C, stagedBalance, post,
        originalBalance: acct.balance,
        originalKwhRows: acct.kwhRows,
      });
    }

    if (skippedForCapacity.length) {
      const staged = accounts.filter((a) => needsCreditProfile(a.event)).length;
      const msg =
        `CREDIT-PROFILE-DEPENDENT EVENTS PARTIALLY STAGED: ${staged} of ` +
        `${skippedForCapacity.length + staged} slots filled. Not staged: ` +
        `${skippedForCapacity.join('; ')}. Cause: only an account whose credit profile ` +
        `carries a valuethreshold can warn or breach, and few candidates on ` +
        `${scheduleDate} have one. Remedy: assign such a profile to more test accounts, ` +
        `or widen the candidate filter.`;
      test.info().annotations.push({ type: 'coverage-reduced', description: msg });
      console.log(`\n[TS-02] ⚠ ${msg}\n`);
      expect(
        staged,
        `no credit-profile-dependent event could be staged at all on ${scheduleDate} — ` +
        `sections 3, 4 and 5 are not testable in this environment. ${msg}`,
      ).toBeGreaterThan(0);
    }

    // Selection ran constrained-first; restore declaration order so the plan, the
    // console summary and the report read in the same order as `wanted`.
    accounts.sort(
      (a, b) =>
        wanted.findIndex((w) => w.event === a.event && w.kwh === a.kwh && w.tier === a.tier) -
        wanted.findIndex((w) => w.event === b.event && w.kwh === b.kwh && w.tier === b.tier),
    );

    // Captured last, immediately before staging, so nothing this run emits can
    // predate it.
    const notificationWatermark = await notifyDb.getMaxNotificationId();
    console.log(`[TS-02] notification watermark: ${notificationWatermark}`);

    plan = { ccpDate, scheduleDate, accounts, originalBatchSize, notificationWatermark };

    // Written BEFORE staging so a crash still leaves a reversible record.
    fs.mkdirSync(path.dirname(restoreFile), { recursive: true });
    fs.writeFileSync(restoreFile, JSON.stringify(plan, null, 2), 'utf-8');
    await test.info().attach('jepyp230-restore.json', { path: restoreFile, contentType: 'application/json' });

    console.log('\n[TS-02] run plan');
    for (const a of plan.accounts) {
      console.log(
        `   ${a.accountId.padEnd(14)} ${a.event.padEnd(28)} ` +
        `X=${a.X} C=${a.C} stage=${a.stagedBalance} post=${a.post}` +
        (a.kwh ? ` kWh=${a.kwh} (${a.tier})` : ''),
      );
    }
  });

  test('step 2 — stage balances and kWh', async () => {
    expect(plan, 'no run plan — step 1 must pass first').toBeTruthy();

    // Respect a higher configured value; only lift it off the floor if needed.
    const configuredBatch = Number(await notifyDb.getBatchSizeBilling()) || 0;
    if (configuredBatch < BATCH_SIZE_FLOOR) {
      await notifyDb.setBatchSizeBilling(BATCH_SIZE_FLOOR);
      console.log(
        `[TS-02] batchSizeBilling ${configuredBatch} is below the floor — raised to ` +
        `${BATCH_SIZE_FLOOR} for this run`,
      );
    } else {
      console.log(`[TS-02] batchSizeBilling left at its configured ${configuredBatch}`);
    }

    for (const a of plan.accounts) {
      if (a.noKwh) {
        // Case 3.5 needs the account to have NO rows. It was chosen with
        // kwhRows === 0, but clear anyway so a re-run on a reused account is
        // still valid.
        const cleared = await notifyDb.clearKwh(a.accountId);
        console.log(`[TS-02] ${a.accountId}: left with NO KWH rows (cleared ${cleared}) for case 3.5`);
      } else if (a.kwh !== undefined) {
        // Window must bracket the CCP date and enddate is EXCLUSIVE. Cycle
        // boundaries, so the band is the one the engine reads.
        const start = firstOfMonth(plan.ccpDate);
        const end = firstOfNextMonth(plan.ccpDate);
        await notifyDb.setKwh(a.accountId, a.kwh, start, end);
      }
      await notifyDb.setCrcBalance(a.accountId, a.stagedBalance);

      // Plus-address the recipient so delivered mail identifies the account.
      //
      // This is the only way Events 4 and 5 can be verified at all: their
      // email_notification row is rolled back (defect 4.2 — dev confirmed the
      // send sits OUTSIDE the transaction, so a CREDIT_LIMIT_EXCEEDED throw
      // rolls back everything except the email, which cannot be unsent) so the
      // database shows nothing, and neither template prints an account number,
      // so a delivered email cannot otherwise be tied back. Proven in ts-04, where a
      // Servicio Reconectado email — which also prints no account number — was
      // correctly attributed by its To: header.
      //
      // Declines unless the contact is already the monitored mailbox, so a real
      // customer address is never rewritten.
      const plus = await notifyDb.setContactEmailToPlusAddress(
        a.accountId, process.env.NOTIFY_EMAIL_TO ?? '',
      );
      a.originalContactEmail = plus ? plus.original : null;
      if (plus) console.log(`[TS-02] ${a.accountId} recipient -> ${plus.applied}`);
    }

    // Re-verify from the pool AFTER writing. The runbook lost a session to
    // staging inside an uncommitted transaction that read back perfectly and
    // then vanished; this confirms the values are actually visible.
    for (const a of plan.accounts) {
      expect(await notifyDb.getCrcBalance(a.accountId), `${a.accountId} balance did not persist`)
        .toBeCloseTo(a.stagedBalance, 2);
      if (a.noKwh) {
        // Must be NULL: that absence is the condition case 3.5 tests.
        expect(
          await notifyDb.getKwhInWindow(a.accountId, plan.ccpDate),
          `${a.accountId} should have NO kWh in the CCP window for case 3.5`,
        ).toBeNull();
      } else if (a.kwh !== undefined) {
        expect(
          await notifyDb.getKwhInWindow(a.accountId, plan.ccpDate),
          `${a.accountId} kWh is not visible in the CCP window — the engine would ` +
          `fall back to the newest window instead of the staged band`,
        ).toBeCloseTo(a.kwh, 2);
      }
    }

    // RE-PERSIST THE PLAN — staging added fields step 1 could not know.
    //
    // `originalContactEmail` is set above, but the restore file was written at the
    // END OF STEP 1, so the on-disk copy never had it. That mattered more than it
    // looks: step 4c fails on the open 9.1 defect on essentially every run, which
    // restarts the worker, and step 5 then reloads the plan FROM DISK. The
    // reloaded accounts had no `originalContactEmail`, so the entire Events 4 / 5
    // mail-attribution block — the only way those two events can be verified at
    // all, since 4.2 means they have no DB row — was skipped in silence. No
    // failure, no annotation, just missing coverage.
    fs.writeFileSync(restoreFile, JSON.stringify(plan, null, 2), 'utf-8');
  });

  test('step 3 — run the billing schedule', async () => {
    expect(requirePlan(), 'no run plan — step 1 must have produced one').toBeTruthy();
    // BILL_CHECK + INVOICE_CHECK run for every account on the date, then the
    // notifications are written asynchronously afterwards. Both need room.
    test.setTimeout(1_500_000);

    // Stale rows of the same type collide on batch ids.
    const cleared = await notifyDb.clearStaleJobs('BILL_CHECK');
    if (cleared) console.log(`[TS-02] cleared ${cleared} stale BILL_CHECK job rows`);

    scheduleId = await jobs.createSchedule({
      scheduleDate: plan.scheduleDate,
      frequency: FREQUENCY,
      jobs: JobScheduleHelper.billingJobs(),
    });

    const result = await jobs.processSchedule(scheduleId);
    console.log(`[TS-02] schedule ${scheduleId} finished with status ${result.status}`);

    // ERROR is EXPECTED here, not a failure: the account staged to cross its
    // credit limit throws CURRENCY_CREDIT_LIMIT_EXCEEDED after its Events 4+5
    // notifications have already been sent. Assert on notifications instead.
    test.info().annotations.push({
      type: 'schedule',
      description: `${scheduleId} on ${plan.scheduleDate} (${FREQUENCY}) -> ${result.status}`,
    });

    // Do not assert until the table stops growing — notifications land after the
    // job returns, and a half-populated read reports late events as missing.
    const settled = await notifyDb.waitForNotificationsToSettle({
      afterId: plan.notificationWatermark,
      onTick: (n) => console.log(`[TS-02] notifications from this run: ${n}`),
    });
    console.log(`[TS-02] notifications settled at ${settled} rows`);

    // ── CREDIT_LIMIT_ACTIONS — required for Event 5 (case 5.1) ────────────
    //
    // Suspension does NOT come from BILL_CHECK. It comes from this job, which the
    // runbook's §6 wording obscures and which none of its scripts include. Every
    // SUSPEND_SUBSCRIPTION row on this tenant is dated to a CREDIT_LIMIT_ACTIONS
    // run (2026-09-09, 2026-10-10) and none to a billing date — so without this
    // phase, case 5.1 can never be exercised and a missing suspension looks like a
    // defect when it is simply a job that never ran.
    //
    // Uses the DAILY slot on the same date; billing took SCHEDULED. No clock move.
    const claSlots = await notifyDb.getScheduleSlots(plan.scheduleDate);
    if (claSlots.some((sl) => sl.frequency === 'DAILY')) {
      test.info().annotations.push({
        type: 'cla-skipped',
        description:
          `DAILY slot on ${plan.scheduleDate} is already used ` +
          `(${claSlots.find((sl) => sl.frequency === 'DAILY')?.id}), so ` +
          `CREDIT_LIMIT_ACTIONS could not run. Case 5.1 is not covered by this run.`,
      });
      console.log('[TS-02] DAILY slot taken — skipping CREDIT_LIMIT_ACTIONS');
      return;
    }

    const claId = await jobs.createSchedule({
      scheduleDate: plan.scheduleDate,
      frequency: 'DAILY',
      jobs: JobScheduleHelper.creditLimitActionsJobs(),
    });
    const claResult = await jobs.processSchedule(claId);
    console.log(`[TS-02] CREDIT_LIMIT_ACTIONS ${claId} -> ${claResult.status}`);

    const claSettled = await notifyDb.waitForNotificationsToSettle({
      afterId: plan.notificationWatermark,
      onTick: (n) => console.log(`[TS-02] notifications after CLA: ${n}`),
    });
    console.log(`[TS-02] settled at ${claSettled} rows after CREDIT_LIMIT_ACTIONS`);
    test.info().annotations.push({
      type: 'credit-limit-actions',
      description: `${claId} on ${plan.scheduleDate} (DAILY) -> ${claResult.status}`,
    });
  });

});

// Assertions on what the run produced. NOT serial: these do not depend on each
// other, and each guards on `plan`, so one failing must not hide the others. This
// is the fix for the reorder not being enough — with everything in one serial
// group, a soft failure in the invoice check skipped the per-event assertions.
test.describe('TS-02 — assertions on the completed run', () => {
  test('step 4 — Event 7 invoice notification fired', async () => {
    expect(requirePlan(), 'no run plan — step 1 must have produced one').toBeTruthy();
    // INVOICE_READY keys on entityid (the invoice) and carries a NULL email, and
    // its accountid is sometimes a customer number rather than an ACT- id — so
    // it is checked by recency across the run rather than per account.
    const rows = await notifyDb.getNotifications({
      type: 'INVOICE_READY',
      afterId: plan.notificationWatermark,
    });
    console.log(`[TS-02] INVOICE_READY rows from this run: ${rows.length}`);
    expect
      .soft(rows.length, 'no INVOICE_READY notifications — did INVOICE_CHECK run after BILL_CHECK?')
      .toBeGreaterThan(0);
  });

  /**
   * Event 7 invoice artifact — SKELETON.
   *
   * Report cases 7.2 / 7.4 assert PDF CONTENT, which cannot be verified while
   * stamping is on: generation waits on tax-authority validation and emits a
   * ~15-byte stub (`%PDF-1.4` with no `%%EOF`). That is configuration, not a
   * renderer bug, so the content assertions must SKIP rather than fail.
   *
   * The gate is the ARTIFACT ITSELF, not a config flag — I could not find a
   * reliable global stamping property, and `foliostatus` per invoice is a better
   * signal anyway (null = never stamped, STAMPED = registered). Self-detecting
   * also means the day stamping is turned off, this starts asserting with no
   * code change.
   *
   * TO FINISH when stamping is off: fetch the PDF via `filepath` (it is NOT in
   * `invoicebase64pdf` — that column is NULL on every invoice on this tenant),
   * extract with helpers/pdf.helper.ts `fetchAndExtractPdfText`, and assert the
   * four fields the manual pass found broken:
   *   - identification shows the ACCOUNT's id, not JASEC's 3007045087
   *   - service address matches the account's address (was dropped entirely)
   *   - "Días facturados" is populated (was blank; 57 for the ISP-282 case)
   *   - energy table line descriptions are not pipe-packed
   */
  test('step 4b — Event 7 invoice artifact (PDF content deferred while stamping is on)', async () => {
    expect(requirePlan(), 'no run plan — step 1 must have produced one').toBeTruthy();

    const invoices = await notifyDb.getInvoiceArtifacts({ ccpDate: plan.scheduleDate });
    console.log(`[TS-02] invoices created in the last 2h: ${invoices.length}`);
    expect
      .soft(invoices.length, 'no invoice_unit rows — INVOICE_CHECK did not produce invoices')
      .toBeGreaterThan(0);
    if (!invoices.length) return;

    const withPath = invoices.filter((i) => i.filepath);
    const stamped = invoices.filter((i) => i.folioStatus === 'STAMPED');

    const summary =
      `invoices ${invoices.length} | with filepath ${withPath.length} | ` +
      `STAMPED ${stamped.length} | base64 present ${invoices.filter((i) => i.hasBase64Pdf).length}`;
    console.log(`[TS-02] ${summary}`);
    test.info().annotations.push({ type: 'invoice-artifacts', description: summary });

    for (const inv of invoices.slice(0, 5)) {
      console.log(
        `   ${inv.id} | ${String(inv.accountId).padEnd(14)} | total ${inv.total} | ` +
        `folio ${inv.folioStatus ?? 'null'} | ${inv.filepath ? 'has filepath' : 'NO filepath'}`,
      );
    }

    // NOT asserted: `filepath` is NULL on all 675 invoices ever created on this
    // tenant, so requiring it tests an invariant that has never held. Rendered
    // output is not reachable from invoice_unit at all here — neither filepath nor
    // invoicebase64pdf is ever populated — so PDF retrieval needs the document
    // service, and there is nothing to assert from the database until stamping is
    // off. Recorded as diagnostics instead.
    test.info().annotations.push({
      type: 'artifact-state',
      description:
        `filepath populated: ${withPath.length}/${invoices.length} · ` +
        `STAMPED: ${stamped.length} · base64: ${invoices.filter((i) => i.hasBase64Pdf).length}. ` +
        `All three are expected to be 0 on this tenant while stamping is on.`,
    });

    test.info().annotations.push({
      type: 'deferred',
      description:
        'PDF CONTENT NOT ASSERTED. Stamping gates generation, so the file is a ~15-byte ' +
        'stub. Report cases 7.2 / 7.4 stay Pending until stamping is off; the skeleton ' +
        'above then needs only the fetch-and-extract body filled in.',
    });
  });
  /**
   * Case 9.1 — no SMTP failures in this run.
   *
   * `email_notification.status = FAILED` means the body rendered and was written,
   * then SMTP refused to send it. The customer gets nothing. Expected is zero.
   *
   * Carries a knownDefect note so a nonzero count REPORTS without holding the
   * whole suite red while the issue is open — remove it once the rate is reliably
   * zero and this becomes blocking.
   *
   * The per-type split is logged deliberately: it is what revealed that raising
   * batchSizeBilling from 60 to 100 eliminated INVOICE_READY failures (18/324 ->
   * 0/78) while leaving PREPAID_OVERAGE untouched (5/466 -> 1/113). An aggregate
   * percentage averages two different failure modes together and hides that.
   */
  test('step 4c — 9.1 no SMTP failures in this run', async () => {
    expect(requirePlan(), 'no run plan — step 1 must have produced one').toBeTruthy();

    const rows = await notifyDb.getNotifications({ afterId: plan.notificationWatermark });
    const failed = rows.filter((r) => r.status === 'FAILED');
    const batchSize = await notifyDb.getBatchSizeBilling();

    // Per type, so a change in one is not masked by the others.
    const byType = new Map<string, { total: number; failed: number }>();
    for (const r of rows) {
      const e = byType.get(r.type) ?? { total: 0, failed: 0 };
      e.total += 1;
      if (r.status === 'FAILED') e.failed += 1;
      byType.set(r.type, e);
    }

    console.log(`\n[TS-02] 9.1 — batchSizeBilling=${batchSize} | ${failed.length}/${rows.length} FAILED`);
    for (const [type, e] of [...byType.entries()].sort()) {
      if (!e.failed) continue;
      console.log(`   ${type.padEnd(30)} ${e.failed}/${e.total}`);
    }
    failed.forEach((f) => console.log(`   FAILED: ${f.accountId} / ${f.type}`));

    test.info().annotations.push({
      type: 'smtp-delivery',
      description:
        `batchSizeBilling=${batchSize}; ${failed.length} of ${rows.length} FAILED` +
        (failed.length
          ? ` — ${failed.map((f) => `${f.accountId}/${f.type}`).join(', ')}`
          : ''),
    });

    // `description` is NULL on every FAILED row, so no reason is recoverable from
    // the database. Say so rather than leaving the reader to wonder.
    if (failed.length && failed.every((f) => !(f as any).description)) {
      test.info().annotations.push({
        type: 'no-failure-reason',
        description:
          'No failure reason available: email_notification.description is NULL on ' +
          'every FAILED row. Diagnosing these needs the app SMTP log until that ' +
          'column is populated.',
      });
    }

    expect
      .soft(
        failed.length,
        `9.1 — ${failed.length} notification(s) rendered but were never delivered ` +
        `at batchSizeBilling=${batchSize}: ` +
        `${failed.map((f) => `${f.accountId}/${f.type}`).join(', ')}`,
      )
      .toBe(0);
  });

  test('step 5 — assert every staged event', async () => {
    expect(requirePlan(), 'no run plan — step 1 must have produced one').toBeTruthy();

    for (const a of plan.accounts) {
      await test.step(`${a.event} — ${a.accountId}`, async () => {
        const found = await notifyDb.getRenderedEmail(a.accountId, a.event, {
          afterId: plan.notificationWatermark,
        });

        if (!found) {
          // CREDIT_LIMIT_BREACH is NEVER written to email_notification (report
          // defect 4.2 — 13 emails arrived on 2026-10-09 with zero rows). The
          // suspension that shares its handler IS logged, so verify the path
          // through that instead of demanding a row that cannot exist.
          if (a.event === 'CREDIT_LIMIT_BREACH') {
            const suspend = await notifyDb.getRenderedEmail(a.accountId, 'SUSPEND_SUBSCRIPTION', {
              afterId: plan.notificationWatermark,
            });
            test.info().annotations.push({
              type: 'known-defect',
              description:
                `4.2 — no CREDIT_LIMIT_BREACH row for ${a.accountId} (expected; never logged). ` +
                `SUSPEND_SUBSCRIPTION from the same handler: ${suspend ? 'PRESENT' : 'ALSO ABSENT'}.`,
            });

            // ── Events 4 and 5 verified by DELIVERED MAIL, not by DB row ──────
            //
            // The row is rolled back by design-consequence (4.2), so the database
            // can never confirm these. Dev confirmed the email itself IS sent.
            // Header attribution is what makes it checkable per account.
            if (a.originalContactEmail) {
              const tag = NotificationDbHelper.plusTag(a.accountId);
              const mail = new EmailHelper();
              await mail.connect();
              let tagged;
              try {
                tagged = await mail.searchEmails({
                  match: (e) => e.to.includes(tag),
                  since: new Date(Date.now() - 2 * 60 * 60 * 1000),
                  limit: 20,
                });
              } finally {
                await mail.disconnect();
              }
              const subjects = tagged.map((e) => e.subject);
              console.log(`[TS-02] mail tagged ${tag}: ${subjects.join(' | ') || '(none)'}`);

              expect
                .soft(
                  subjects.some((x) => /Saldo Agotado/i.test(x)),
                  `Event 4 — no "Saldo Agotado" email delivered to ${tag}. ` +
                  `Delivered mail is the ONLY way to verify this event: the ` +
                  `email_notification row is rolled back. Subjects seen: ` +
                  `${subjects.join(' | ') || '(none)'}`,
                )
                .toBe(true);

              // ── Amended 4.1 — body wording, minimum, and ordering ───────────
              //
              // The CREDIT_LIMIT_BREACH template already requires the future-tense
              // fragment and the minimum, but that check NEVER RUNS: the row does
              // not exist (defect 4.2), so ts-03 skips the whole type. Case 6.2
              // below reads this body too, but only when Event 5 also arrived —
              // which is now the uncommon case. So without this block, Event 4 is
              // verified by SUBJECT ALONE on a normal run.
              //
              // Future tense is the point of the amendment: the customer is warned
              // the service WILL be suspended, because at this moment it has not
              // been. The ordering check below is the same claim, observed.
              const exhaustedMail = tagged.find((e) => /Saldo Agotado/i.test(e.subject));
              if (exhaustedMail) {
                // Split into an accent-free claim plus an accent-TOLERANT tense
                // check, deliberately NOT a compare against EXHAUSTED_FRAGMENT.
                //
                // That constant has never been validated against a real body: its
                // check set is skipped on every run because CREDIT_LIMIT_BREACH rows
                // do not exist (4.2), and the template lives on static storage, not
                // in the DB. It reads "será suspendido" while the manual sheet writes
                // "sera suspendido", and normalizeValue does NOT strip accents -- so
                // an exact compare could red on correct copy over one accent.
                // .contains() is still used for the whitespace/&nbsp; normalisation
                // that raw .includes() lacks.
                expect
                  .soft(
                    exhaustedMail.contains('ha agotado su saldo'),
                    `Amended 4.1 — "Saldo Agotado" body for ${a.accountId} does not say ` +
                    `the balance is exhausted. Expected wording along the lines of ` +
                    `"${EXHAUSTED_FRAGMENT}".`,
                  )
                  .toBe(true);

                expect
                  .soft(
                    /ser[\u00e1a] suspendido/i.test(exhaustedMail.text.replace(/[\s\u00a0]+/g, ' ')),
                    `Amended 4.1 — "Saldo Agotado" body for ${a.accountId} is not in the ` +
                    `FUTURE tense. It must warn the service WILL be suspended, because at ` +
                    `this moment it has not been.`,
                  )
                  .toBe(true);

                const min4 =
                  amountAfter(exhaustedMail.text, 'Monto mínimo a recargar') ||
                  amountAfter(exhaustedMail.text, 'recarga mínima de');
                expect
                  .soft(
                    Boolean(min4),
                    `Amended 4.1 — "Saldo Agotado" body for ${a.accountId} states no ` +
                    `minimum recharge amount.`,
                  )
                  .toBe(true);

                const suspendedForOrder = tagged.find((e) => /Servicio Suspendido/i.test(e.subject));
                if (suspendedForOrder) {
                  expect
                    .soft(
                      exhaustedMail.receivedAt.getTime() <= suspendedForOrder.receivedAt.getTime(),
                      `Amended 4.1 — "Saldo Agotado" must reach ${tag} BEFORE ` +
                      `"Servicio Suspendido": it warns the service WILL be suspended. ` +
                      `Got ${exhaustedMail.receivedAt.toISOString()} vs ` +
                      `${suspendedForOrder.receivedAt.toISOString()}.`,
                    )
                    .toBe(true);
                }
              }


              // ── Event 5 — gated on the CALLBACK, not on CREDIT_LIMIT_ACTIONS ─────
              //
              // Amended case 5.1: "Servicio Suspendido" fires ONLY when the
              // provisioning callback confirms the disconnect command reached the
              // meter. It is NOT sent at breach, and NOT when CREDIT_LIMIT_ACTIONS
              // runs. This block used to demand the email right after that job,
              // which reds the run even when the product behaved correctly.
              //
              // core_oms.order_provisioning is an empty stub on dev, so there is no
              // callback trail to wait on. The observable proof that the callback
              // landed is the subscription actually moving to SUSPENDED, plus the
              // SUSPEND_SUBSCRIPTION row the same handler writes.
              //
              // Note this account may legitimately never suspend: defect 4.2 rolls
              // the breach back INCLUDING the balance movement, leaving the account
              // in credit with nothing to suspend it (verified 2026-08-27 on
              // ACT-100286, left at -CRC 20,776.67). That is a blocked precondition,
              // not a failure, so it is annotated rather than asserted.
              //
              // Reading SUSPENDED as "suspended during THIS run" is safe only
              // because findEligibleAccounts stages ACTIVE subscriptions only. If
              // that selection ever admits an already-suspended account, this gate
              // would demand an email from a suspension that predates the run.
              const subStatus = await notifyDb.getSubscriptionStatus(a.accountId);
              const suspendRow = await notifyDb.getRenderedEmail(a.accountId, 'SUSPEND_SUBSCRIPTION', {
                afterId: plan.notificationWatermark,
              });
              const callbackLanded = subStatus === 'SUSPENDED' || Boolean(suspendRow);

              if (!callbackLanded) {
                test.info().annotations.push({
                  type: 'blocked',
                  description:
                    `Event 5 not due for ${a.accountId}: no disconnect callback landed ` +
                    `(subscription ${subStatus ?? 'unknown'}, no SUSPEND_SUBSCRIPTION row ` +
                    `after ${plan.notificationWatermark}). Amended 5.1 fires the email on ` +
                    `the callback, so there is nothing to assert. Subjects seen: ` +
                    `${subjects.join(' | ') || '(none)'}`,
                });
                console.log(
                  `[TS-02] Event 5 skipped for ${a.accountId} — no callback ` +
                  `(subscription ${subStatus ?? 'unknown'})`,
                );
              } else {
                const suspendMail = tagged.find((e) => /Servicio Suspendido/i.test(e.subject));

                expect
                  .soft(
                    Boolean(suspendMail),
                    `Event 5 — subscription is ${subStatus} for ${a.accountId}, so the ` +
                    `disconnect callback landed and "Servicio Suspendido" was due, but no ` +
                    `such email reached ${tag}. Subjects seen: ` +
                    `${subjects.join(' | ') || '(none)'}`,
                  )
                  .toBe(true);

                // Amended 5.1 also requires the body to state the suspension TIME
                // and the MINIMUM RECHARGE. Both are already asserted by the
                // SUSPEND_SUBSCRIPTION template check set in
                // billing-events.templates.ts (rows "Suspension time" and
                // "Monto minimo present"), which ts-03 replays straight from the
                // DB row. That set also owns the ruling that 12:00:00 AM is the
                // CORRECT render, because CCP time is date-only -- so duplicating
                // the content checks here could only ever disagree with it. This
                // leg asserts DELIVERY; ts-03 owns the body.
              }

              test.info().annotations.push({
                type: 'mail-attribution',
                description: `${a.accountId} (${tag}) received: ${subjects.join(' | ') || 'nothing'}`,
              });

              // ── Case 6.2 — the minimum must AGREE across Events 4 and 5 ────
              //
              // Each template already checks its own figure against X + post, so
              // why cross-check? Because minimumEqualsFormulaCheck deliberately
              // accepts [x, x*3, x/3] to absorb the unresolved 45-vs-15 kWh basis
              // (report case 6.3). Event 4 could therefore render on one basis and
              // Event 5 on the other, and BOTH would pass their own check while
              // telling the customer two different amounts. Only comparing them
              // catches that.
              //
              // It can only be done here: Event 4 has no email_notification row
              // (defect 4.2), so the pair exists solely as delivered mail, and
              // only the plus-addressed tag ties either one to an account.
              //
              // Verified manually over IMAP on 2026-08-14 — ACT-100382 and
              // ACT-100237 each rendered ₡4.492,30 on both sides.
              const minIn = (e: { text: string }) =>
                amountAfter(e.text, 'recarga mínima de') ||
                amountAfter(e.text, 'Monto mínimo a recargar');
              const digitsOnly = (s: string) => s.replace(/[^\d]/g, '');

              const agotado = tagged.find((e) => /Saldo Agotado/i.test(e.subject));
              const suspendido = tagged.find((e) => /Servicio Suspendido/i.test(e.subject));

              if (agotado && suspendido) {
                const m4 = minIn(agotado);
                const m5 = minIn(suspendido);
                console.log(
                  `[TS-02] 6.2 ${tag}: Saldo Agotado=${m4 || '(none)'} | ` +
                  `Servicio Suspendido=${m5 || '(none)'}`,
                );
                expect
                  .soft(
                    Boolean(m4 && m5),
                    `6.2 — a minimum figure is missing for ${a.accountId}: ` +
                    `Saldo Agotado=${m4 ?? '(none)'}, Servicio Suspendido=${m5 ?? '(none)'}`,
                  )
                  .toBe(true);
                if (m4 && m5) {
                  expect
                    .soft(
                      digitsOnly(m4) === digitsOnly(m5),
                      `6.2 — the two emails quote DIFFERENT minimums for ${a.accountId}: ` +
                      `Saldo Agotado ${m4} vs Servicio Suspendido ${m5}. Each can still ` +
                      `pass its own formula check, which tolerates the 3x / ÷3 kWh-basis ` +
                      `variant, so this cross-check is the only thing that catches it.`,
                    )
                    .toBe(true);
                }
                test.info().annotations.push({
                  type: 'case-6.2',
                  description:
                    `${a.accountId}: Saldo Agotado ${m4 ?? '-'} / Servicio Suspendido ${m5 ?? '-'}`,
                });
              } else {
                // Not a failure: the missing-email case is already asserted above.
                test.info().annotations.push({
                  type: 'case-6.2-not-cross-checked',
                  description:
                    `${a.accountId}: only ${agotado ? 'Saldo Agotado' : suspendido ? 'Servicio Suspendido' : 'neither'} ` +
                    `was delivered, so the two minimums could not be compared.`,
                });
              }
            }

            // ── Case 1.4 — a zero-crosser must NOT get an Inicio de Mes email ──
            // Documented as deliberate: Event 1C only reaches accounts already in
            // debt when the run starts, so an account that crosses during the run
            // is suspended without ever being told the month started.
            const inicioTypes = [
              'PREPAID_SUFFICIENT_CREDIT', 'PREPAID_INSUFFICIENT_CREDIT', 'PREPAID_OVERAGE',
            ];
            const inicio = (await notifyDb.getNotifications({
              accountIds: [a.accountId], afterId: plan.notificationWatermark,
            })).filter((r) => inicioTypes.includes(r.type));
            expect
              .soft(
                inicio.length,
                `1.4 — ${a.accountId} crossed from credit into debt and must receive NO ` +
                `Inicio de Mes email, but got: ${inicio.map((r) => r.type).join(', ')}`,
              )
              .toBe(0);

            // Be honest about WHY it passed. With the exception flag on, this
            // account gets no notification rows at all, so "no Inicio de Mes" is
            // trivially true and proves nothing. It only becomes a real assertion
            // once the account is actually processed.
            const anyRows = await notifyDb.getNotifications({
              accountIds: [a.accountId], afterId: plan.notificationWatermark,
            });
            if (!anyRows.length) {
              test.info().annotations.push({
                type: 'vacuous-pass',
                description:
                  `1.4 passed VACUOUSLY for ${a.accountId} — it produced no notification ` +
                  `rows whatsoever, so the absence of an Inicio de Mes email is not ` +
                  `evidence. Real coverage needs throwCreditLimitBreachException = false.`,
              });
            }

            // ── Case 5.1 — assert what the CONFIGURATION says should happen ────
            //
            // `throwCreditLimitBreachException` decides this entirely, so read it
            // rather than assuming. With it TRUE (JASEC) the breach throws, the
            // account's billing rolls back, the balance returns to credit, and
            // CREDIT_LIMIT_ACTIONS correctly finds nothing to suspend — dev
            // confirmed on 2026-08-13 that this is by design. Asserting SUSPENDED
            // there made the suite permanently red on a non-defect.
            //
            // With it FALSE (CoopeG) the charge persists and the account really is
            // suspended. Written both ways so it flips itself if the flag changes.
            const behaviour = await notifyDb.getCreditLimitBreachBehaviour();
            const status = await db.query<{ status: string }>(
              `SELECT status FROM core_engine.subscription WHERE accountid = $1 LIMIT 1`,
              [a.accountId],
            );
            const subStatus = status[0]?.status ?? '(none)';
            const invoiced = await notifyDb.getInvoiceTotals(a.accountId, 1);
            const invoicedThisRun = invoiced.some((i) => i.date === plan.scheduleDate);

            console.log(
              `[TS-02] 5.1 — ${a.accountId} status ${subStatus} | ` +
              `throwCreditLimitBreachException=${behaviour.raw} | ` +
              `invoiced this run: ${invoicedThisRun}`,
            );
            test.info().annotations.push({
              type: 'credit-limit-config',
              description:
                `throwCreditLimitBreachException=${behaviour.raw}; ${a.accountId} ` +
                `status=${subStatus}, invoiced=${invoicedThisRun}, ` +
                `credit-limit row=${'absent'}, suspension row=${suspend ? 'present' : 'absent'}`,
            });

            if (behaviour.throwsException) {
              // Rollback path — all three absences are EXPECTED here.
              expect
                .soft(
                  subStatus,
                  `With throwCreditLimitBreachException=true the charge rolls back, so ` +
                  `${a.accountId} should remain ACTIVE — there is no debt for ` +
                  `CREDIT_LIMIT_ACTIONS to act on. Got ${subStatus}.`,
                )
                .toBe('ACTIVE');
              expect
                .soft(
                  invoicedThisRun,
                  `With the exception flag on, the rollback should leave NO invoice for ` +
                  `${a.accountId}. One appearing would mean the charge persisted.`,
                )
                .toBe(false);
              // The emails still go out — already asserted above via mail attribution.
            } else {
              // No exception — the charge persists, so the full chain should run.
              expect
                .soft(
                  subStatus,
                  `With throwCreditLimitBreachException=false the charge persists, so ` +
                  `${a.accountId} should be SUSPENDED after CREDIT_LIMIT_ACTIONS. ` +
                  `Got ${subStatus}.`,
                )
                .toBe('SUSPENDED');
              expect
                .soft(invoicedThisRun, `${a.accountId} should have been invoiced`).toBe(true);
              expect
                .soft(
                  found,
                  `With the flag off there is no rollback, so a CREDIT_LIMIT_BREACH row ` +
                  `SHOULD now exist for ${a.accountId} — this is the check that closes 4.2.`,
                )
                .toBeTruthy();
            }
            return;
          }

          // Case 3.4 is the COUNT of threshold emails, and zero violates it just
          // as much as two. This branch used to `return` before the count
          // assertion further down ever ran, so a missing threshold email was
          // reported as generic silence and never attributed to 3.4 — which is
          // the filed bug. Attribute it here instead.
          if (a.event === 'CREDIT_THRESHOLD_BREACH') {
            // Separate BAD TEST DATA from a real defect before blaming the product.
            // An account whose credit profile has no CRC valuethreshold can never
            // warn — the credit check returns before the threshold logic runs. 166
            // prepaid accounts on dev are in that state, and reporting their silence
            // as a bug is exactly the invalid report filed on 2026-08-13. Dev
            // confirmed production MUST assign a profile carrying -4000|-2000.
            const thresholds = await notifyDb.getAccountThresholds(a.accountId);
            if (!thresholds) {
              expect(
                thresholds,
                `${a.accountId} has no usable credit-limit threshold, so it CANNOT produce\n` +
                `  a threshold email however it is staged. That is invalid test data, not a\n` +
                `  defect. Select accounts with findThresholdCapableAccounts(), which now\n` +
                `  filters on the credit profile.`,
              ).toBeTruthy();
              return;
            }
            expect
              .soft(
                0,
                `Case 3.4 — ${a.accountId} should receive EXACTLY ONE threshold email, got 0.\n` +
                `  Its profile "${thresholds.profile}" DOES carry thresholds (${thresholds.raw}),\n` +
                `  so the account is capable and this silence is a real defect.`,
              )
              .toBe(1);
            return;
          }

          // Soft, so one silent event does not abort the remaining accounts.
          expect
            .soft(
              found,
              `No ${a.event} notification for ${a.accountId}. Silence has four causes ` +
              `that look identical: wrong balance band, a missing template row, a ` +
              `suppressed tier crossing, or the job erroring before creatNotification.`,
            )
            .toBeTruthy();
          return;
        }

        // OBSERVED post-charge balance, not the predicted one. C is measured from
        // the PREVIOUS invoice, and this run proved that is not always the charge
        // applied: ACT-100188 was invoiced 0.00, so its balance never moved and
        // every amount derived from the predicted post was wrong by exactly C.
        // Case 3.6 reference value: staged balance + what this run actually
        // invoiced. Preferred over a live balance read, which teardown can already
        // have reverted after a worker restart - that is what produced the false
        // 1A/1B/1C balance failures on 2027-05-09. Fall back to the live read only
        // when this run produced no invoice (the credit-limit account gets none).
        const invoices = await notifyDb.getInvoiceTotals(a.accountId, 6);
        const thisRunInvoice = invoices.find((i) => i.date === plan.scheduleDate);
        const observedBalance = await notifyDb.getCrcBalance(a.accountId);
        const observedPost = thisRunInvoice
          ? Number((a.stagedBalance + Number(thisRunInvoice.total)).toFixed(2))
          : (observedBalance ?? a.post);
        if (thisRunInvoice) {
          console.log(
            `[TS-02] ${a.accountId}: invoice ${thisRunInvoice.id} total ` +
            `${thisRunInvoice.total} -> reference balance ${observedPost}`,
          );
        } else {
          // Say so loudly. 3.6 is BLOCKING as of 2026-08-14, so a silent fall back
          // to the live balance is now dangerous: teardown can already have
          // restored it, which would make a real regression pass. Seen for real —
          // invoices land under a DIFFERENT date than the schedule when an
          // account's cycle has been shifted, so this lookup finds nothing even
          // though the account was charged normally.
          console.log(
            `[TS-02] ${a.accountId}: NO invoice dated ${plan.scheduleDate} ` +
            `(most recent: ${invoices.slice(0, 3).map((i) => `${i.date}=${i.total}`).join(', ') || 'none'}). ` +
            `Falling back to the live balance ${observedBalance} — case 3.6 is being ` +
            `checked against a weaker reference for this account.`,
          );
          test.info().annotations.push({
            type: 'weak-3.6-reference',
            description:
              `${a.accountId}: no invoice on ${plan.scheduleDate}, so 3.6 compared ` +
              `against a live balance read rather than staged + invoice total.`,
          });
        }
        if (Math.abs(observedPost - a.post) > 0.01) {
          test.info().annotations.push({
            type: 'charge-differed',
            description:
              `${a.accountId}: predicted post ${a.post} but observed ${observedPost} ` +
              `(predicted C=${a.C}, actual charge ${(observedPost - a.stagedBalance).toFixed(2)}). ` +
              `Asserting against the observed value.`,
          });
        }

        const ctx: NotificationContext = {
          accountId: a.accountId,
          firstName: '', lastName: '',
          recipient: found.row.email ?? process.env.NOTIFY_EMAIL_TO ?? '',
          ccpDate: plan.ccpDate,
          email: found.email,
          // Body comes from email_notification.content, so delivery time is not
          // measured here. Undefined rather than 0, which would read as instant.
          deliverySeconds: undefined,
          X: a.X, C: a.C,
          stagedBalance: a.stagedBalance,
          postBalance: observedPost,
          // For case 3.5 the engine sees no rows, and the <=100 branch applies —
          // so 0, not null, which is what makes the tier expectation resolve to
          // "no tax paragraph" instead of "unknown".
          kwhInWindow: a.noKwh ? 0 : (a.kwh ?? null),
          notificationStatus: found.row.status,
          templateFile: await notifyDb.getTemplateFile(a.event),
        };

        // Full template this time — contextual checks included, which is the
        // whole point of the live run.
        const template = BILLING_EVENT_TEMPLATES[a.event];
        const results = report.evaluateAll(template, ctx);

        for (const r of results) {
          if (r.knownDefect) continue;
          expect
            .soft(r.passed, `${a.event} / ${a.accountId} / ${r.row}\n  expected: ${r.expected}\n  actual:   ${r.actual}`)
            .toBe(true);
        }

        const markdown = report.buildJiraTable(template, ctx, results);
        const file = report.writeReport(template, ctx, markdown);
        await test.info().attach(`${a.event}-${a.accountId}.md`, { path: file, contentType: 'text/markdown' });

        // Event 3's pass condition is the COUNT. 2 means isThresholdForTier
        // failed to suppress the threshold this account's tier does not expect.
        if (a.event === 'CREDIT_THRESHOLD_BREACH') {
          const n = await notifyDb.countNotifications(a.accountId, a.event, plan.notificationWatermark);
          expect
            .soft(n, `${a.accountId} should receive EXACTLY ONE threshold email, got ${n}`)
            .toBe(1);
        }
      });
    }
  });


});

function firstOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

function firstOfNextMonth(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
