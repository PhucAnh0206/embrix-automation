import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { NotificationDbHelper, type KwhRow } from '../../../../helpers/notification-db.helper';
import { JobScheduleHelper } from '../../../../helpers/job-schedule.helper';
import { ServerHelper } from '../../../../helpers/server-api.helper';
import {
  amountAfter,
  BOMBEROS_FRAGMENT,
  IVA_FRAGMENT,
  tierParagraphCorrect,
} from '../../../../test-data/notifications/billing-events.templates';
import type { NotificationContext } from '../../../../test-data/notifications/types';

/**
 * TS-05 — JEPYP-230 cases 3.7 / 3.8 / 3.9: the tier boundaries of the
 * low-balance email's tax paragraph.
 *
 * WHAT IS UNTESTED AND WHY IT MATTERS. Cases 3.1-3.3 already cover the three
 * paragraph variants, but with 50 / 150 / 350 kWh — all mid-band. Two things are
 * therefore unverified:
 *
 *   3.7  WINDOW SCOPING. The tier must read the CURRENT cycle's kWh, not every
 *        window on the account. kWh accrues monthly, so if it summed all windows
 *        then after a few cycles every customer would sit permanently in the top
 *        tier and the email would always show the IVA paragraph. It cannot be
 *        seen on a fresh account, which is what every other test uses, and
 *        `setKwh` deletes existing rows so no run has EVER had two windows.
 *
 *   3.8  Exactly 100 kWh. The copy says "superior a 100 kWh", and ARESEP charges
 *        ICB from 101 kWh, so `>` is the correct operator. At exactly 100 there
 *        must be NO tax paragraph. `>=` would tell the customer they owe a tax
 *        they do not.
 *
 *   3.9  Exactly 280 kWh. "superior a 280" is false, "superior a 100" is true,
 *        so bomberos appears and IVA does not. ARESEP charges IVA from 281 kWh.
 *
 * These assert the EMAIL COPY, not the tax arithmetic — that was validated
 * separately and closed (TC-MDR-001, doc-exact against Ejemplo-4). A failure
 * here is a misleading sentence, not a wrong charge.
 *
 * ── ACCOUNT SELECTION: WHAT MAKES AN ACCOUNT ABLE TO WARN ────────────────────
 *
 * An account produces a threshold email only if its credit profile carries a
 * `valuethreshold` (core_config.credit_profiles, e.g. "-4000|-2000"). Accounts
 * with no credit profile, or on a profile whose valuethreshold is NULL, return
 * from the credit check before the warning logic runs and are silent no matter
 * how they are staged. On jasec-dev that is 173 of 409 prepaid accounts (42.3%):
 * 166 with no profile at all, 7 on Prepaid Energy Profile (valuethreshold NULL).
 *
 * SUPERSEDED THEORY, kept because the evidence is still cited elsewhere. This
 * spec originally selected "previously-firing" accounts, on the reading that only
 * an account that had warned before would warn again — from schedule JS-100182,
 * where six identically-staged accounts all invoiced 2319.30 and all crossed
 * -2000, yet only ACT-100152 (9 prior fires) sent anything. That correlation was
 * real but not causal: the silent five had no credit profile. An A/B on JS-100199
 * settled it — ACT-100152 itself, moved onto Prepaid Energy Profile, went silent
 * despite 10 prior fires, while ACT-100301 on Default Credit Profile warned.
 * Prior-fire count predicts nothing once the profile is controlled for; this run
 * confirms it, having warned correctly on ACT-100013 and ACT-100017 with ZERO
 * prior fires.
 *
 * So selection is `findThresholdCapableAccounts` (profile-based), and ONE account
 * per scenario is enough — the second was insurance against a phantom. Raise it
 * with JEPYP230_TIER_ACCOUNTS if a run ever needs the redundancy back.
 *
 * The assertion logic needed no changes: `tierParagraphCorrect` in
 * billing-events.templates.ts already compares against the WINDOWED kWh with
 * strict `>`. That is exactly the contract under test — if the engine sums
 * lifetime kWh, our windowed expectation and its rendered paragraph disagree and
 * the check fails.
 */

/**
 * Schedule date. Pin it with JEPYP230_TIER_DATE; otherwise it is resolved at run
 * time against slot availability and threshold-capable accounts — see the date
 * resolution block in the test. There is deliberately no hardcoded fallback: the
 * previous one (2026-11-09) had both slots spent and silently blocked the suite.
 */
const UNRESOLVED = '(unresolved)';
const SCHEDULE_DATE_OVERRIDE = process.env.JEPYP230_TIER_DATE;
let SCHEDULE_DATE = SCHEDULE_DATE_OVERRIDE ?? UNRESOLVED;

/** Staged balance. -2400 crosses the -2000 BASE threshold for any charge 400..2400. */
const STAGED_BALANCE = -2400;

/**
 * The current cycle's window must BRACKET the CCP date, half-open. These
 * accounts bill on day 9, so the cycle containing 2026-11-09 is
 * [2026-11-09, 2026-12-09) and the preceding one is [2026-10-09, 2026-11-09) —
 * which deliberately does NOT contain the CCP date.
 */
function windowsFor(scheduleDate: string) {
  const [y, m] = scheduleDate.split('-').map(Number);
  const day = scheduleDate.split('-')[2];
  const pad = (n: number) => String(n).padStart(2, '0');
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    previous: { startDate: `${prevY}-${pad(prevM)}-${day}`, endDate: scheduleDate },
    current: { startDate: scheduleDate, endDate: `${nextY}-${pad(nextM)}-${day}` },
  };
}

type Scenario = {
  /** Sheet case number. */
  id: string;
  title: string;
  /** kWh the ENGINE should see for the tier decision. */
  effectiveKwh: number;
  /** 'none' | 'bomberos' | 'iva' */
  expectParagraph: 'none' | 'bomberos' | 'iva';
  windows: (w: ReturnType<typeof windowsFor>) => Array<{ kwh: number; startDate: string; endDate: string }>;
  /** Filled at run time from findThresholdCapableAccounts. */
  accounts: string[];
};

const SCENARIOS: Scenario[] = [
  {
    id: '3.7',
    title: 'Tier uses current-cycle consumption, not lifetime',
    effectiveKwh: 60,
    expectParagraph: 'none',
    // 60 previous + 60 current = 120 lifetime, but only 60 in the current cycle.
    // A bomberos paragraph here means the tier summed both windows.
    windows: (w) => [
      { kwh: 60, ...w.previous },
      { kwh: 60, ...w.current },
    ],
    accounts: [],
  },
  {
    id: '3.8',
    title: 'Exactly 100 kWh — lower boundary, NOT above it',
    effectiveKwh: 100,
    expectParagraph: 'none',
    windows: (w) => [{ kwh: 100, ...w.current }],
    accounts: [],
  },
  {
    id: '3.9',
    title: 'Exactly 280 kWh — bomberos yes, IVA no',
    effectiveKwh: 280,
    expectParagraph: 'bomberos',
    windows: (w) => [{ kwh: 280, ...w.current }],
    accounts: [],
  },
];

/**
 * Accounts staged per scenario. ONE, because selection is now profile-based and a
 * capable account is reliable — see the superseded-theory note in the header.
 *
 * It was 2, as insurance against accounts falling silent, and that cost a run: the
 * three scenarios then demanded 6 capable accounts while 2027-11-09 had 5, so the
 * spec failed its capacity guard without testing anything. Capable accounts are
 * the scarce resource here (42.3% of prepaid accounts cannot warn at all), so do
 * not raise this without checking the pool on the target date first.
 */
const ACCOUNTS_PER_SCENARIO = Number(process.env.JEPYP230_TIER_ACCOUNTS ?? 1);

/**
 * Run a subset, e.g. JEPYP230_TIER_CASES=3.8 to retry just the unresolved one.
 * Every re-run costs a fresh schedule slot, and a date only has two, so being
 * able to spend a slot on one case rather than all three matters.
 */
const REQUESTED = (process.env.JEPYP230_TIER_CASES ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Reuse the exact fragments the 3.1-3.3 checks match on, rather than
// re-guessing the Spanish copy — a near-miss string would read as a missing
// paragraph and manufacture a failure.
const BOMBEROS = BOMBEROS_FRAGMENT;
const IVA = IVA_FRAGMENT;

/**
 * The safety gate — same contract as TS-02's, and for the same reason.
 *
 * THIS SPEC MOVES THE TENANT-GLOBAL CCP CLOCK (`setAndVerifyCcpTime` below) and
 * spends a job_schedule slot. For a while it did so with no gate at all, which
 * meant a bare `npx playwright test` — which runs every project — would move the
 * shared clock to whatever date it resolves. That is worse than it sounds: the
 * date is chosen for un-billed accounts, which are often in the PAST, so an
 * accidental full-repo run could drag the clock backward by a year for everyone.
 *
 * So it runs only when the project is named on the command line
 * (`--project=jasec-notification-tiers`, which `npm run test:notification:tiers`
 * passes), or when JEPYP230_TIER_RUN=true is set explicitly.
 *
 * The argv detection lives in playwright.config.ts, NOT here: a spec runs in a
 * WORKER whose process.argv does not carry --project, so checking it here reads
 * false and skips even when explicitly asked for. The config runs in the main
 * process and exports the result as this env var, which workers inherit.
 *
 * Deliberately a SEPARATE flag from JEPYP230_LIVE_RUN: naming one of the two
 * clock-moving projects must not silently enable the other, because they must
 * never run against the same date — TS-02's BILL_CHECK bills every account due
 * that date, which would leave this spec nothing to bill.
 */
const TIER_RUN = process.env.JEPYP230_TIER_RUN === 'true';

let db: DbHelper;
let notifyDb: NotificationDbHelper;
let api: APIRequestContext;
let jobs: JobScheduleHelper;
let serverHelper: ServerHelper;

test.beforeAll(async () => {
  test.skip(
    !TIER_RUN,
    'Tier-boundary run. Ask for it by name (`npm run test:notification:tiers`) or ' +
    'set JEPYP230_TIER_RUN=true — it moves the tenant-global CCP clock and spends ' +
    'a job_schedule slot.',
  );
  db = new DbHelper();
  await db.connect();
  notifyDb = new NotificationDbHelper(db);
  api = await playwrightRequest.newContext();
  jobs = new JobScheduleHelper(api);
  serverHelper = new ServerHelper(api);
});

test.afterAll(async () => {
  await api?.dispose();
  await db?.disconnect();
});

test.describe('TS-05 — threshold email tier boundaries', () => {
  // One billing run over ~100 accounts on this date, plus notification settle.
  test.setTimeout(35 * 60 * 1000);

  test('3.7 / 3.8 / 3.9 — window scoping and the 100 / 280 kWh boundaries', async () => {
    const scenarios = REQUESTED.length
      ? SCENARIOS.filter((s) => REQUESTED.includes(s.id))
      : SCENARIOS;
    expect(scenarios.length, `JEPYP230_TIER_CASES matched no scenario: ${REQUESTED.join(',')}`).toBeGreaterThan(0);

    const needed = scenarios.length * ACCOUNTS_PER_SCENARIO;

    // ── date resolution ──────────────────────────────────────────────────────
    // Resolved at run time unless pinned. A hardcoded default cannot survive:
    // every billing run advances the accounts it touches to the next cycle and
    // spends a slot on that date, so a date that worked once is spent afterwards.
    // The old default 2026-11-09 had both slots consumed long ago, which is what
    // parked these cases — the spec failed on the slot guard, not on the product.
    //
    // A date qualifies when EITHER frequency slot is free (the existing check
    // below picks whichever) and it carries enough threshold-capable accounts.
    // Capability is the binding constraint, so it is checked per candidate rather
    // than assumed from the eligible count.
    if (!SCHEDULE_DATE_OVERRIDE) {
      // FORWARD ONLY. `findScheduleDateCandidates` considers past dates by design
      // (older cycles hold more un-billed accounts), and ranking by richest would
      // actively prefer them — 2026-09-09 has 133 eligible accounts. But the CCP
      // clock is tenant-global and shared, so picking a past date would drag
      // everyone else's clock backward, potentially by a year, as a side effect of
      // a test run. Pin the floor at the current clock and only ever move forward.
      const fromDate = await notifyDb.getCcpDate();
      const seen = new Set<string>();
      const candidates: Array<{ date: string; eligibleCount: number }> = [];
      for (const frequency of ['DAILY', 'SCHEDULED'] as const) {
        for (const c of await notifyDb.findScheduleDateCandidates({
          frequency,
          fromDate,
          minAccounts: needed,
          paymentMethod: 'CHECK',
          contactEmail: process.env.NOTIFY_EMAIL_TO,
        })) {
          if (!seen.has(c.date)) { seen.add(c.date); candidates.push(c); }
        }
      }
      candidates.sort((a, b) => b.eligibleCount - a.eligibleCount);
      console.log(
        `[TS-05] candidate dates (a slot free), richest first: ` +
        (candidates.map((c) => `${c.date}(${c.eligibleCount})`).join(', ') || '(none)'),
      );
      for (const c of candidates) {
        const capable = await notifyDb.findThresholdCapableAccounts(c.date, needed);
        if (capable.length >= needed) { SCHEDULE_DATE = c.date; break; }
        console.log(`[TS-05] ${c.date} skipped — ${capable.length}/${needed} capable accounts`);
      }
      expect(
        SCHEDULE_DATE,
        `No date has a free job_schedule slot AND ${needed} threshold-capable ` +
        `account(s). Checked ${candidates.length} candidate date(s). Capable means the ` +
        `credit profile carries a valuethreshold — on this tenant 42% of prepaid ` +
        `accounts do not. Either assign profiles to more test accounts, lower ` +
        `JEPYP230_TIER_ACCOUNTS, or pin a date with JEPYP230_TIER_DATE.`,
      ).not.toBe(UNRESOLVED);
    }

    const w = windowsFor(SCHEDULE_DATE);
    console.log(`[TS-05] schedule ${SCHEDULE_DATE}, cases ${scenarios.map((s) => s.id).join(' ')}`);
    console.log(`[TS-05] previous window [${w.previous.startDate}, ${w.previous.endDate})`);
    console.log(`[TS-05] current  window [${w.current.startDate}, ${w.current.endDate})`);

    // ── slot availability ────────────────────────────────────────────────────
    // job_schedule is UNIQUE(schedulefrequency, scheduledate) and only DAILY and
    // SCHEDULED exist, so a date has exactly two slots. Check before burning the
    // attempt — this is what parked these cases originally.
    // OPT-IN slot reclaim. A date whose slot was burned by a FAILED run is dead
    // weight — the assertion below just tells you to go and find another date by
    // hand. With JEPYP230_RECLAIM_SLOTS=true we hand that date back first, which
    // deletes only ERROR / SUSPENDED / PENDING schedules (never COMPLETED, never
    // PROCESSING — see NotificationDbHelper.freeScheduleSlot).
    // Default OFF: without the flag this block is skipped and the behaviour below
    // is exactly what it was.
    if (process.env.JEPYP230_RECLAIM_SLOTS === 'true') {
      const freed = await notifyDb.freeScheduleSlot(SCHEDULE_DATE);
      if (freed.length) {
        console.log(
          `[TS-05] reclaimed ${freed.length} spent slot(s) on ${SCHEDULE_DATE}: ` +
          freed.map((f) => `${f.frequency}=${f.id}/${f.status}`).join(' '),
        );
      }
    }

    const slots = await notifyDb.getScheduleSlots(SCHEDULE_DATE);
    console.log(`[TS-05] slots used on ${SCHEDULE_DATE}: ${slots.length ? slots.map((s) => `${s.frequency}=${s.id}/${s.status}`).join(' ') : 'none'}`);
    expect(slots.length, `both job_schedule slots on ${SCHEDULE_DATE} are taken — pick another date via JEPYP230_TIER_DATE`).toBeLessThan(2);
    const frequency = slots.some((s) => s.frequency === 'DAILY') ? 'SCHEDULED' : 'DAILY';

    // ── account selection ────────────────────────────────────────────────────
    // Queried at run time, not hardcoded. Two reasons: a billing run advances
    // every account it touches to the next cycle, so any fixed list goes stale
    // after one use; and only an account whose credit profile carries a
    // valuethreshold can warn, which is a minority of the pool.
    //
    // The (n) beside each account is its prior-fire count, kept as context only —
    // it does NOT gate selection. Seeing capable accounts with (0) warn correctly
    // is the evidence that retired the previously-firing theory.
    const pool = await notifyDb.findThresholdCapableAccounts(SCHEDULE_DATE, needed + 6);
    console.log(
      `[TS-05] threshold-capable pool on ${SCHEDULE_DATE} (${pool.length}): ` +
      pool.map((p) => `${p.accountId}(${p.fires})`).join(' '),
    );
    expect(
      pool.length,
      `Need ${needed} threshold-capable account(s) billable on ${SCHEDULE_DATE}, found ` +
      `${pool.length}. Capable means the credit profile carries a valuethreshold — on ` +
      `this tenant 42% of prepaid accounts do not. Pick a date with more via ` +
      `JEPYP230_TIER_DATE, or lower JEPYP230_TIER_ACCOUNTS.`,
    ).toBeGreaterThanOrEqual(needed);

    scenarios.forEach((s, i) => {
      s.accounts = pool
        .slice(i * ACCOUNTS_PER_SCENARIO, (i + 1) * ACCOUNTS_PER_SCENARIO)
        .map((p) => p.accountId);
    });
    const all = scenarios.flatMap((s) => s.accounts);

    const restore: Record<string, { balance: number | null; kwh: KwhRow[] }> = {};
    try {
      // ── record originals BEFORE touching anything ──────────────────────────
      for (const a of all) {
        restore[a] = {
          balance: await notifyDb.getCrcBalance(a),
          kwh: await notifyDb.getKwhRows(a),
        };
        console.log(`[TS-05] ${a} original balance ${restore[a].balance}, ${restore[a].kwh.length} kWh row(s)`);
      }

      // ── CCP clock ─────────────────────────────────────────────────────────
      // Backward moves are allowed on dev/preprod and are needed here: these
      // accounts' required_scheduledate is in the past relative to the current
      // CCP. setAndVerifyCcpTime polls because the mutation applies async.
      await serverHelper.setAndVerifyCcpTime(SCHEDULE_DATE);
      const ccpDate = await notifyDb.getCcpDate();
      expect(ccpDate, 'CCP must equal the schedule date or BILL_CHECK selects nothing').toBe(SCHEDULE_DATE);

      // ── stage ─────────────────────────────────────────────────────────────
      for (const s of scenarios) {
        for (const a of s.accounts) {
          await notifyDb.setCrcBalance(a, STAGED_BALANCE);
          await notifyDb.setKwhWindows(a, s.windows(w));
          // Prove the engine will see what the scenario intends. A mismatch here
          // means the window does not bracket the CCP date, and the tier check
          // downstream would be measuring the wrong thing.
          const seen = await notifyDb.getKwhInWindow(a, SCHEDULE_DATE);
          expect(
            seen,
            `${a}: kWh visible in the CCP window should be ${s.effectiveKwh} for case ${s.id}, got ${seen}`,
          ).toBe(s.effectiveKwh);
          console.log(`[TS-05] ${a} staged for ${s.id}: balance ${STAGED_BALANCE}, kWh in window ${seen}`);
        }
      }

      const batch = await notifyDb.getBatchSizeBilling();
      console.log(`[TS-05] batchSizeBilling = ${batch} (left as configured)`);

      // ── run ───────────────────────────────────────────────────────────────
      const watermark = await notifyDb.getMaxNotificationId();
      console.log(`[TS-05] watermark ${watermark}`);

      const scheduleId = await jobs.createSchedule({
        scheduleDate: SCHEDULE_DATE,
        frequency,
        jobs: JobScheduleHelper.billingJobs(),
      });
      const result = await jobs.processSchedule(scheduleId);
      console.log(`[TS-05] schedule ${scheduleId} -> ${result.status}`);
      // ERROR is not a failure: any account crossing its credit limit throws
      // after its notifications are already out. Assert on notifications only.

      const settled = await notifyDb.waitForNotificationsToSettle({ afterId: watermark });
      console.log(`[TS-05] ${settled} new notification(s)`);

      // ── assert, per scenario ──────────────────────────────────────────────
      const silent: string[] = [];
      const outcomes: Array<{ id: string; account: string; verdict: string }> = [];

      for (const s of scenarios) {
        for (const a of s.accounts) {
          const found = await notifyDb.getRenderedEmail(a, 'CREDIT_THRESHOLD_BREACH', { afterId: watermark });
          if (!found) {
            // Bug 3.4, not a tier failure. Recorded, and only fatal for a
            // scenario if BOTH its accounts stayed silent.
            silent.push(a);
            outcomes.push({ id: s.id, account: a, verdict: 'no email (bug 3.4)' });
            continue;
          }

          const kwhInWindow = await notifyDb.getKwhInWindow(a, SCHEDULE_DATE);
          const bomberos = found.email.contains(BOMBEROS);
          const iva = found.email.contains(IVA);
          const actual = bomberos && iva ? 'bomberos + IVA'
            : bomberos ? 'bomberos'
              : iva ? 'IVA'
                : 'none';

          // Assert through the SHARED rule, not a local copy. An earlier version
          // of this spec re-derived `>` / `>=` here, which put two
          // implementations of the ARESEP boundary in the repo — precisely the
          // thing cases 3.8 and 3.9 exist to pin down. The scenario's intended
          // kWh is already pinned separately by the pre-run
          // `expect(seen).toBe(s.effectiveKwh)` above, so this loses no coverage.
          const ok = tierParagraphCorrect({
            email: found.email,
            kwhInWindow,
          } as NotificationContext);

          outcomes.push({ id: s.id, account: a, verdict: `${actual} (kWh in window ${kwhInWindow})` });

          // Soft, so every scenario reports even when an earlier one fails.
          expect
            .soft(
              ok,
              `Case ${s.id} — ${s.title}\n` +
              `  account          ${a} (${found.row.id})\n` +
              `  kWh in window    ${kwhInWindow} (scenario intends ${s.effectiveKwh})\n` +
              `  expected         ${s.expectParagraph} tax paragraph\n` +
              `  rendered         ${actual}\n` +
              (s.id === '3.7' && bomberos
                ? `  DIAGNOSIS        a bomberos paragraph at 60 kWh in-window means the tier ` +
                `summed BOTH windows (60 + 60 = 120). The tier must be scoped to the current cycle.\n`
                : '') +
              (s.id === '3.8' && bomberos
                ? `  DIAGNOSIS        exactly 100 kWh produced a tax paragraph, so the comparison ` +
                `is >= 100 rather than > 100. ARESEP charges ICB from 101 kWh.\n`
                : '') +
              (s.id === '3.9' && iva
                ? `  DIAGNOSIS        exactly 280 kWh produced the IVA paragraph, so the comparison ` +
                `is >= 280 rather than > 280. ARESEP charges IVA from 281 kWh.\n`
                : ''),
            )
            .toBe(true);

          // Free re-check of 3.5 on the same emails — 16 of these 18 accounts
          // rendered "Saldo actual ₡." with no figure on 2026-10-09, so this run
          // is also the broadest 3.5 sample we have had.
          const balanceShown = amountAfter(found.email.text, 'Saldo actual') !== '';
          expect
            .soft(balanceShown, `3.5 re-check — ${a} (${found.row.id}) rendered "Saldo actual" with no figure`)
            .toBe(true);
        }
      }

      console.log('\n[TS-05] ── outcomes');
      for (const o of outcomes) console.log(`   ${o.id}  ${o.account.padEnd(12)} ${o.verdict}`);
      if (silent.length) {
        console.log(`\n[TS-05] silent accounts (bug 3.4 evidence): ${silent.join(' ')}`);
        test.info().annotations.push({
          type: 'bug-3.4',
          description: `${silent.length}/${all.length} eligible accounts crossed the threshold and produced no email: ${silent.join(' ')}`,
        });
      }

      // A scenario is only unresolved if BOTH its accounts went silent.
      for (const s of scenarios) {
        const bothSilent = s.accounts.every((a) => silent.includes(a));
        expect
          .soft(
            bothSilent,
            `Case ${s.id} is UNRESOLVED — both ${s.accounts.join(' and ')} produced no threshold ` +
            `email, so the tier could not be observed. Blocked by bug 3.4, not a tier failure.`,
          )
          .toBe(false);
      }
    } finally {
      console.log('\n[TS-05] restoring...');
      for (const [a, orig] of Object.entries(restore)) {
        if (orig.balance !== null) await notifyDb.setCrcBalance(a, orig.balance).catch(() => { });
        await notifyDb.restoreKwhRows(a, orig.kwh).catch(() => { });
      }
      console.log('[TS-05] restore complete');
    }
  });
});
