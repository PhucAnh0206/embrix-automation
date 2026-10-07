/**
 * The credit breach and its recovery — point 6 of the 2026-09-15 E2E guide.
 *
 * JASEC prepaid runs "Option A": a reading the balance cannot fund is REFUSED,
 * not billed into debt. The reading is PARKED, nothing is charged, the customer
 * is notified, and a later top-up lets the parked reading be REPLAYED so nothing
 * is lost.
 *
 * Run as ONE scenario with named steps, because every step depends on the state
 * the previous one left:
 *
 *   seed a contract -> top up -> rate a small reading -> send a reading the
 *   balance cannot fund -> assert it parked and charged nothing -> top up ->
 *   the operator replays it from the Core UI -> assert it rated for exactly the tariff
 *
 * THE REPLAY IS DONE ON SCREEN since 2026-10-06, as an operator does it: Billing Hub >
 * Usage > Suspended/Failed Batches > search the MDR file > Reprocess (was the
 * processUsageRecords API). The screen shows the parked batch before, and must not
 * list it after. The top-ups stay on the API (decision 2026-10-06). The database
 * stays the backing record: the parked row leaves the in-flight table and the
 * processed row carries the consumption.
 *
 * ── MUTATING ───────────────────────────────────────────────────────────────
 * Seeds an account, drops real MDR files through the loader, and moves balances.
 * Gated behind JASEC_USAGE_RUN=true. Needs SSH to the control server AND the DB,
 * therefore the VPN. Test A also needs a browser (Core UI session).
 *
 *     $env:JASEC_USAGE_RUN='true'
 *     npx playwright test --project=jasec-usage-run
 *
 * WHY THIS IS NEW COVERAGE. The breach NOTIFICATION is covered (TC-79/79/80 in
 * the notification block). The USAGE-RECORD half never was: nothing in the suite
 * asserts that the reading parks, that nothing is charged, or that it can be
 * replayed — `processUsageRecords` appears in no other file. The tariff scripts
 * actively STAGE CREDIT to stop a breach happening, so this path has never been
 * exercised deliberately.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '../../../../fixtures/page-factory';
import { DbHelper } from '../../../../helpers/db.helper';
import { MdrRemoteHelper } from '../../../../helpers/mdr-remote.helper';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { OrderOutcomeHelper } from '../../../../helpers/order-outcome.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';
import { AgentScreens, screenDateTime } from '../../../../helpers/agent-screens.helper';

const RUN_ENABLED = String(process.env.JASEC_USAGE_RUN ?? '').trim().toLowerCase() === 'true';

/** Huy's recarga inicial: the 1,943.40 fixed charge plus 15 kWh. */
const INITIAL_TOPUP = 3300;
/** First reading — small enough that 3,300 CRC funds it. 20 kWh = 1,295.60. */
const FIRST_READING = 20;
/** Second reading. Consumption = 180 kWh, far more than the balance can fund. */
const BREACH_READING = 200;
/** Enough to cover the replay comfortably. */
const RECOVERY_TOPUP = 20000;

const money = (n: number) => Math.round(n * 100) / 100;

/** "HH:MM" or "HH:MM:SS" -> minutes since midnight. */
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Real Costa Rica wall-clock time, "HH:MM:SS".
 *
 * The suspension exception window is evaluated by the product against CR LOCAL
 * TIME, not against the CCP clock — moving the CCP clock does not affect it, so
 * no amount of seeding can fake this. Costa Rica has not observed DST since
 * 1992, but this goes through Intl rather than a hardcoded UTC-6 so it stays
 * correct if that ever changes.
 */
function costaRicaNow(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Costa_Rica',
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
}

/**
 * Is `now` inside [start, end)? JASEC's window is 20:00:00 -> 08:00:00, which
 * WRAPS MIDNIGHT — a naive `start <= t < end` reads that as "never". Both
 * shapes are handled.
 */
function insideWindow(now: string, start: string, end: string): boolean {
  if (start === end) return false;
  const [t, s, e] = [toMin(now), toMin(start), toMin(end)];
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** Whole minutes from `now` forward to `target`, wrapping past midnight. */
const minutesUntil = (now: string, target: string) =>
  ((toMin(target) - toMin(now)) % 1440 + 1440) % 1440;

/**
 * A Costa Rica wall time rendered in THIS machine's timezone, so a BLOCKED
 * message can say when to come back without making the reader do the
 * arithmetic. Only the modulo-24 difference matters for a time of day, so the
 * raw offset needs no normalising.
 */
function crToLocal(crTime: string): string {
  const localNow = new Intl.DateTimeFormat('en-GB', {
    hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  const diff = toMin(localNow) - toMin(costaRicaNow());
  const t = ((toMin(crTime) + diff) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * The run needs headroom: the case polls for a suspension, a notification and a
 * resume, each up to 3 minutes. Starting 5 minutes before the window opens
 * would half-run and then fail for the wrong reason.
 */
const REQUIRED_HEADROOM_MIN = 30;

/** Costa Rica calendar date parts, as the product sees them. */
function costaRicaDate(): { iso: string; mmdd: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Costa_Rica',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const iso = `${get('year')}-${get('month')}-${get('day')}`;
  return { iso, mmdd: iso.slice(5), weekday: get('weekday') };
}

/**
 * The window is not the only deferral. The dev team confirmed 2026-09-14 that
 * SUBSCRIPTION_SUSPENSION also defers ALL DAY on weekends and Costa Rican public
 * holidays. Missing that turns a correct deferral into a FAIL for the wrong
 * reason — which is exactly what happened on 2026-09-15 (Día de la
 * Independencia).
 *
 * Fixed-date feriados de pago obligatorio. INCOMPLETE BY CONSTRUCTION:
 *   - Jueves/Viernes Santo are movable (Semana Santa) and are not here.
 *   - Ley 9875 shifts some observances to the nearest Monday, so the nominal
 *     date below can be a working day and the Monday after can be the holiday.
 * Blocking on a nominal date only costs a skip; the reverse costs a false FAIL,
 * so the failure message below names this explicitly rather than pretending the
 * list is authoritative.
 */
const CR_FIXED_HOLIDAYS: Record<string, string> = {
  '01-01': 'Año Nuevo',
  '04-11': 'Juan Santamaría',
  '05-01': 'Día del Trabajo',
  '07-25': 'Anexión del Partido de Nicoya',
  '08-02': 'Virgen de los Ángeles',
  '08-15': 'Día de la Madre',
  '09-15': 'Día de la Independencia',
  '12-01': 'Abolición del Ejército',
  '12-25': 'Navidad',
};

/** Poll until `probe` returns a value, or give up. Re-queries every time. */
async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null>,
  timeoutMs = 180_000,
  intervalMs = 5_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() >= deadline) {
      console.log(`  timed out after ${timeoutMs / 1000}s waiting for ${label}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test.describe('JASEC usage — credit breach, park and replay (MUTATING)', {
  tag: ['@jasec', '@usage', '@breach', '@tc-57'],
}, () => {
  test.setTimeout(20 * 60 * 1000);

  test('a reading the balance cannot fund is parked, charges nothing, and replays losslessly', async ({
    page, usagePage, customerManagementPage, billsPage,
  }) => {
    blockedIf(
      !RUN_ENABLED,
      'JASEC_USAGE_RUN is not "true". This spec seeds an account, drops real MDR ' +
      'files and moves balances, so it never runs by accident.',
    );

    const logger = new TestLogger('ts-06-credit-breach-park-replay');
    const db = new DbHelper(logger);
    await db.connect();

    try {
      const mdr = new MdrRemoteHelper(logger);
      blockedIf(
        !(await mdr.isAvailable()),
        'the MDR loader tree is not reachable over SSH — cannot submit a reading. ' +
        'Check the VPN and the embrix-dev ssh alias.',
      );

      const seed = new PrepaidSeedHelper(logger);

      // ── step 1: a fresh, rateable contract ──────────────────────────
      /**
       * Seeded rather than borrowed. A shared account carries an accumulator
       * history that changes which tariff block a reading lands in, which makes
       * a correct charge look wrong — the single most common false FAIL in this
       * area.
       */
      const suffix = uniqueRunSuffix();
      const meter = assertQaMeter(`M-QAUSG-${suffix}`);
      const { accountId, orderId } = await seed.seed({
        meter,
        customerId: `E2EBREACH-${suffix}`,
        name: `E2EBREACH ${suffix}`,
      });
      console.log(`\n  seeded ${accountId} / ${orderId} / meter ${meter}\n`);

      const problems = await new OrderOutcomeHelper(logger).readAndVerify(accountId, {
        meter, bundleId: 'B-100000-E',
      });
      expect(problems, 'the seeded contract is not rateable, so the rest proves nothing').toEqual([]);

      const balance = async () => money(await db.getAccountBalance(accountId));

      // ── step 2: initial credit ──────────────────────────────────────
      await seed.topUp(accountId, INITIAL_TOPUP);
      /**
       * INVERTED SIGN. A credit is NEGATIVE in CRC on JASEC. A positive balance
       * means the customer owes money.
       */
      expect(await balance(), 'a 3,300 top-up must read as -3300.00 credit').toBe(-INITIAL_TOPUP);

      const processedRows = async () => db.query<any>(
        `SELECT id, quantity::float8 AS quantity FROM core_usage.file_detail_record_processed
          WHERE provisioningid = $1 AND status = 'PROCESSED'`,
        [meter],
      );

      // ── step 2b: baseline ───────────────────────────────────────────
      // A fresh meter's FIRST reading is its baseline and rates 0 kWh by design
      // (confirmed by the team on JASEC prod, 2026-09-30). Without this the
      // 20 kWh below was the baseline, charged nothing, and failed step 3.
      // The readings below are absolute and assume the meter starts at 0. A declared
      // start (flexattr16) would make the baseline go backwards - BLOCK, do not guess.
      const declared = await db.getDeclaredStartReading(meter);
      blockedIf(declared !== 0, `${meter} has a declared start reading of ${declared} kWh; this case assumes 0.`);
      await mdr.submitReading(meter, declared);
      const baselined = await waitFor('the baseline reading to process', async () => {
        const rows = await processedRows();
        return rows.length ? rows : null;
      });
      expect(baselined, 'the 0 kWh baseline reading never processed').not.toBeNull();
      const baselineCount = baselined!.length;

      // ── step 3: a reading the balance CAN fund ──────────────────────
      await mdr.submitReading(meter, FIRST_READING);
      const firstRated = await waitFor('the first reading to rate', async () => {
        const rows = await processedRows();
        return rows.length > baselineCount ? rows : null;
      });
      expect(firstRated, `the first ${FIRST_READING} kWh reading never rated`).not.toBeNull();

      const afterFirst = await balance();
      console.log(`  after ${FIRST_READING} kWh: balance ${afterFirst}`);
      expect(afterFirst, 'rating the first reading must consume credit').toBeGreaterThan(-INITIAL_TOPUP);

      // ── step 4: a reading the balance CANNOT fund ───────────────────
      const out = await mdr.submitReading(meter, BREACH_READING);
      const mdrFile = out.match(/MDR_PREPAGO_\d{8}-\d{6}\.csv/)?.[0];
      expect(mdrFile, 'could not read the MDR file name out of the loader output').toBeTruthy();
      console.log(`  breach file: ${mdrFile}`);

      const parked = await waitFor('the reading to park', async () => {
        const rows = await db.query<any>(
          `SELECT id, perfbatchid, status, errorcode, errormsg, accountid,
                  provisioningid, quantity::float8 AS quantity
             FROM core_usage.file_detail_record
            WHERE provisioningid = $1 AND errorcode = 'CURRENCY_CREDIT_LIMIT_EXCEEDED'`,
          [meter],
        );
        return rows.length ? rows[0] : null;
      });

      expect(
        parked,
        `the ${BREACH_READING} kWh reading did not park with CURRENCY_CREDIT_LIMIT_EXCEEDED — ` +
        `Option A requires an unfundable reading to be REFUSED, not billed into debt`,
      ).not.toBeNull();

      console.log(`  parked: ${parked.id} ${parked.status}/${parked.errorcode} quantity ${parked.quantity}`);
      expect(parked.status, 'a parked reading is SUSPENDED').toBe('SUSPENDED');
      expect(parked.errormsg ?? '', 'the error must name the breach amount').toMatch(
        /Credit Limit .* for the Currency CRC exceeded by amount/i,
      );

      /**
       * TRAP 1 — which account a parked row names depends on countHeldUsageInCreditCheck.
       *
       * OFF (the original behaviour): `accountid` is NULL. The whole insert is part of the
       * transaction the breach exception rolls back, so the row is written without its
       * resolved account (0 of 1,078 in-flight rows on jasec-dev carried one). Search by
       * `provisioningid` (the meter) or by `usageid`.
       *
       * ON (the "reconnect without top-up" fix, engine e5a26f9, 2026-10-07): the refused
       * charge is KEPT on the row - `accountid`, `serviceunitid` and `netvalue` = the charge
       * the balance could not cover - so the reconnect checks can count it. Written by a
       * separate update just after the park, so wait for it rather than read once.
       */
      const heldOn = await db.isHeldUsageCountedInCreditCheck();
      if (heldOn) {
        const kept = await waitFor('the held charge on the parked row', async () => {
          const r = await db.query<any>(
            `SELECT accountid, netvalue::float8 AS netvalue FROM core_usage.file_detail_record
              WHERE provisioningid = $1 AND id = $2`, [meter, parked.id]);
          return r[0]?.accountid && r[0]?.netvalue != null ? r[0] : null;
        }, 60_000);
        console.log(`  held charge kept: ${kept?.netvalue} on ${kept?.accountid}`);
        expect(kept?.accountid, 'with countHeldUsageInCreditCheck on, the parked row must name its account').toBe(accountId);
        expect(
          kept?.netvalue,
          `the held charge must be MORE than the ${-afterFirst} of credit left - that is why the reading was refused`,
        ).toBeGreaterThan(-afterFirst);
      } else {
        expect(
          parked.accountid,
          'a parked row carries no accountid (countHeldUsageInCreditCheck off)',
        ).toBeNull();
      }

      /**
       * TRAP 2 — `quantity` on a parked row is the meter READING, not the
       * consumption, because the delta update was rolled back with everything
       * else. Here the meter already sits at 20, so a reading of 200 is a
       * consumption of 180 — and the parked row must show 200.
       */
      expect(
        parked.quantity,
        `a parked row carries the READING (${BREACH_READING}), not the consumption ` +
        `(${BREACH_READING - FIRST_READING}) — the delta update was rolled back`,
      ).toBe(BREACH_READING);

      // ── step 5: nothing was charged ─────────────────────────────────
      expect(
        await balance(),
        'a breach must charge NOTHING — the balance may not move',
      ).toBe(afterFirst);

      // ── step 6: the customer was notified ───────────────────────────
      /**
       * This row is the fix from the week of 2026-09-08. It used to be written
       * inside the transaction the breach rolls back, so the customer got the
       * email and the database showed nothing. It now commits separately.
       *
       * Status is FAILED while SMTP is down — that is the environment, not this
       * behaviour, so the assertion is on the ROW, never on delivery.
       */
      const notified = await waitFor('the CREDIT_LIMIT_BREACH notification', async () => {
        const rows = await db.query<any>(
          `SELECT id, type, status FROM core_engine.email_notification
            WHERE accountid = $1 AND type = 'CREDIT_LIMIT_BREACH'`,
          [accountId],
        );
        return rows.length ? rows : null;
      }, 120_000);

      expect(
        notified,
        'no CREDIT_LIMIT_BREACH row was written — the audit trail for the breach is missing',
      ).not.toBeNull();
      console.log(`  notified: ${(notified ?? []).map((n: any) => `${n.id}/${n.status}`).join(', ')}`);

      // ── step 7: recover — top up (API), then the operator replays the batch ON SCREEN ──
      await seed.topUp(accountId, RECOVERY_TOPUP);
      const beforeReplay = await balance();
      console.log(`  after recovery top-up: balance ${beforeReplay}`);

      const batchFilter = page.locator('input[name="batchId"]');
      await test.step(`Core UI: ${mdrFile} is listed on Suspended/Failed Batches, and the operator reprocesses it`, async () => {
        await page.navigateToHome();
        await usagePage.navigateViaNav();
        const row = await usagePage.findSuspendedBatch(mdrFile!);
        console.log(`  Suspended/Failed Batches (filter "${await batchFilter.inputValue()}"): ` +
          `${row ? (await row.innerText()).replace(/\s+/g, ' ').slice(0, 140) : 'NOT LISTED'}`);
        expect(row, `the parked batch ${mdrFile} is not on the Suspended/Failed Batches screen - an operator cannot see or replay it`).not.toBeNull();
        await usagePage.reprocessSuspendedBatch(row!);
      });

      // ── step 8: nothing was lost ────────────────────────────────────
      const afterReplay = await waitFor('the replay to settle on the balance', async () => {
        const b = money(await db.getAccountBalance(accountId));
        return b !== beforeReplay ? b : null;
      }, 120_000);

      expect(afterReplay, 'the replay did not charge the balance').not.toBeNull();
      const charged = money((afterReplay as number) - beforeReplay);
      console.log(`  replay charged ${charged} CRC (balance ${beforeReplay} -> ${afterReplay})`);

      expect(charged, 'a replay must CHARGE, i.e. move the balance toward debt').toBeGreaterThan(0);

      /**
       * The parked row is gone from the in-flight table and now sits in
       * `file_detail_record_processed` carrying the CONSUMPTION, not the reading.
       * That is the pair that proves "nothing is lost by a breach".
       */
      const stillParked = await db.query<any>(
        `SELECT id FROM core_usage.file_detail_record
          WHERE provisioningid = $1 AND errorcode = 'CURRENCY_CREDIT_LIMIT_EXCEEDED'`,
        [meter],
      );
      expect(stillParked, 'the parked row must leave the in-flight table after a successful replay').toEqual([]);

      const replayed = await db.query<any>(
        `SELECT id, quantity::float8 AS quantity, accountid, status
           FROM core_usage.file_detail_record_processed
          WHERE provisioningid = $1 AND id = $2`,
        [meter, mdrFile],
      );
      expect(replayed.length, `no processed row for ${mdrFile} after the replay`).toBeGreaterThan(0);
      expect(
        replayed[0].quantity,
        `the PROCESSED row carries the consumption (${BREACH_READING - FIRST_READING}), ` +
        `not the reading (${BREACH_READING})`,
      ).toBe(BREACH_READING - FIRST_READING);
      expect(replayed[0].accountid, 'a processed row resolves its account').toBe(accountId);

      // ── step 9: on screen after the replay ─────────────────────────
      await test.step(`Core UI: ${mdrFile} has left Suspended/Failed Batches`, async () => {
        await page.navigateToHome();
        await usagePage.navigateViaNav();
        const row = await usagePage.findSuspendedBatch(mdrFile!);
        const filter = await batchFilter.inputValue();
        console.log(`  Suspended/Failed Batches after replay (filter "${filter}"): ${row ? 'STILL LISTED' : 'not listed'}`);
        // Prove the filter applied before trusting an empty result (the same search found it in step 7).
        expect(filter, 'the batch filter did not apply').toBe(mdrFile);
        expect.soft(row, `${mdrFile} is still listed as suspended/failed after a successful replay`).toBeNull();
      });

      await test.step(`Core UI: Rated Usage of ${accountId} shows the replayed reading`, async () => {
        const txns = await db.query<{ id: string; netamount: number; startdate: string }>(
          `SELECT t.id, t.netamount::float8 AS netamount, to_char(t.startdate, 'YYYY-MM-DD HH24:MI:SS') AS startdate
             FROM core_engine.transaction_unit t
            WHERE t.accountid = $1 AND t.type = 'USAGE'
              AND t.usageid IN (SELECT usageid FROM core_usage.file_detail_record_processed WHERE id = $2)`,
          [accountId, mdrFile],
        );
        console.log(`  replayed transactions: ${txns.map(t => `${t.id} ${t.netamount}`).join(', ') || 'NONE'}`);
        expect(txns.length, `the replay of ${mdrFile} wrote no USAGE transactions for ${accountId}`).toBeGreaterThan(0);
        // Window from the transaction's own date (the CCP clock is months from real time).
        const at = new Date(`${txns[0].startdate.replace(' ', 'T')}Z`).getTime();
        await new AgentScreens(page).openAccount(accountId);
        await billsPage.navigateToRatedUsage();
        await billsPage.searchByDate(screenDateTime(at - 2 * 86_400_000), screenDateTime(at + 2 * 86_400_000));
        await billsPage.clickSearchButton();
        const rows = await billsPage.getUsageGridRows();
        const shown = txns.filter(t => rows.some(r => r.join(' | ').includes(t.id)));
        console.log(`  Rated Usage: ${rows.length} row(s); replayed transactions on screen ${shown.length}/${txns.length}`);
        expect.soft(shown.length, `Rated Usage does not show the replayed transactions of ${mdrFile}`).toBe(txns.length);
      });

      console.log(`\n  PASS — ${accountId}: breach parked, charged nothing, replayed for ${charged} CRC\n`);
    } finally {
      await db.disconnect();
    }
  });

  /**
   * B — the SUSPENSION half of point 7 of the guide.
   *
   * Test A above proves the reading parks and replays. It says nothing about
   * whether the service is actually cut off, and until now neither did anything
   * else in the suite: the `SUSPEND_SUBSCRIPTION` matches elsewhere are
   * NOTIFICATION TYPES in the Block H specs, not a suspension executing.
   *
   * THE EXCEPTION WINDOW, AND WHY THIS CASE PICKS ITS PROFILE AT RUNTIME.
   * "Prepaid Energy Profile" carries a suspension exception window of
   * 20:00–08:00 in `core_config.credit_profile_limit_actions`, evaluated
   * against REAL COSTA RICA WALL-CLOCK TIME — the CCP clock does not affect it,
   * so nothing this suite does can move it. A breach during CR night-time
   * therefore suspends nothing, correctly, and an unconditional assertion here
   * would pass or fail on the hour the suite happened to start.
   *
   * There are two honest ways to get a deterministic answer, and this case
   * takes whichever the tenant offers:
   *
   *   1. An UNWINDOWED profile — "Prepaid Energy E2E No Window"
   *      (`TIDLT-100009-CRPRE-E2E`), same CRC limit of 0 and the same
   *      SUBSCRIPTION_SUSPENSION action with both exception times NULL. Runs at
   *      any hour. Exists on jasec-dev only.
   *
   *   2. The STOCK windowed profile, run while CR time is outside the window.
   *      Equally real — arguably more so, since it is the live config. It just
   *      has to be scheduled.
   *
   * Verified 2026-09-15:
   *
   *     jasec-dev      TIDLT-100009-CRPRE       20:00:00 -> 08:00:00
   *                    TIDLT-100009-CRPRE-E2E   null     -> null
   *     jasec-preprod  TIDLT-100010-CRPRE       20:00:00 -> 08:00:00   (no E2E profile)
   *
   * So preprod takes route 2. CR is 13h behind Vietnam and NEITHER country
   * observes DST, so the suspendable window CR 08:00–20:00 is a stable
   * 21:00–09:00 in VN — i.e. the evening. The case prints the local equivalent
   * in its BLOCKED message rather than making the reader convert.
   *
   * This asks the team for nothing. The earlier version reported BLOCKED on
   * preprod purely because the E2E profile was absent, which read as "waiting
   * on the team" when it was really "run it later in the day".
   *
   * The window RULE itself is still not tested here — proving that a breach is
   * correctly ignored at 03:00 CR needs the opposite schedule, and is separate
   * scheduled-manual work.
   *
   * NOT YET OFFICIAL — this is new behaviour and needs its own EPDP-348
   * sub-task before it gets a TC number. Deliberately left untagged.
   */

  test('B — a credit breach suspends the service, and a top-up resumes it', async () => {
    blockedIf(
      !RUN_ENABLED,
      'JASEC_USAGE_RUN is not "true". This spec seeds an account, drops real MDR ' +
      'files and moves balances, so it never runs by accident.',
    );

    const logger = new TestLogger('ts-06-breach-suspension');
    const db = new DbHelper(logger);
    await db.connect();

    try {
      /**
       * THIS CASE ONLY HOLDS WHILE provisioningEnabled IS OFF.
       *
       * With it off, a breach suspends for BILLING only and the subscription reads
       * SUSPENDED straight away — which is what the steps below assert. With it ON
       * (jasec-dev since 2026-09-28) the breach raises a SUSPEND order, dispatches
       * accion D to the AMI, and the subscription only moves once a provisioning
       * CALLBACK arrives; for our made-up meter the AMI refuses, so it never would.
       * That path — breach, dispatch, callback, top-up, RESUME — is covered by
       * provisioning/auto-suspend-resume.spec.ts (@auto-journey), which BLOCKs in
       * the opposite case. Checked BEFORE anything is seeded, so a blocked run
       * leaves nothing behind.
       */
      const provFlag = await db.query<{ value: string }>(
        `SELECT value FROM core_config.ccp_properties WHERE property = 'provisioningEnabled'`,
      );
      blockedIf(
        provFlag[0]?.value === 'true',
        `provisioningEnabled is 'true' on this tenant: a breach now suspends through a ` +
        `provisioning order and a callback, not immediately, so this billing-only case ` +
        `does not apply. Run provisioning/auto-suspend-resume.spec.ts @auto-journey instead.`,
      );

      /**
       * Read the profiles and their windows from config rather than naming one.
       * If the team ever adds, renames or re-windows a profile, this follows it
       * instead of going quietly BLOCKED. `credit_profile_limit_actions.id` IS
       * the credit profile id — there is no separate FK column.
       */
      const profiles = await db.query<{
        id: string; name: string; winstart: string | null; winend: string | null;
      }>(
        `SELECT cp.id,
                cp.name,
                a.exceptionstarttime::text AS winstart,
                a.exceptionendtime::text   AS winend
           FROM core_config.credit_profile cp
           JOIN core_config.credit_profile_limit_actions a ON a.id = cp.id
          WHERE a.action = 'SUBSCRIPTION_SUSPENSION'
          ORDER BY cp.name`,
      );
      blockedIf(
        profiles.length === 0,
        'this tenant has no credit profile carrying a SUBSCRIPTION_SUSPENSION action, ' +
        'so a breach can never suspend anything and there is nothing to assert.',
      );

      // Prefer an unwindowed profile; else the prepaid one; else anything windowed.
      const unwindowed = profiles.find(p => !p.winstart && !p.winend);
      const windowed = profiles.filter(p => p.winstart && p.winend);
      const profile = unwindowed
        ?? windowed.find(p => /prepaid/i.test(p.name))
        ?? windowed[0];

      const crNow = costaRicaNow();
      console.log(
        `\n  Costa Rica wall-clock is ${crNow}. Using "${profile.name}" ` +
        `(${profile.winstart ? `window ${profile.winstart}-${profile.winend}` : 'no window'}).`,
      );

      if (!unwindowed) {
        // Route 2: the stock windowed profile. Only assertable outside the window,
        // with enough headroom left for the polling steps to finish inside it.
        const open = profile.winend!;     // window ENDS -> suspension becomes possible
        const shuts = profile.winstart!;  // window STARTS -> suspension stops firing
        const headroom = minutesUntil(crNow, shuts);

        blockedIf(
          insideWindow(crNow, shuts, open),
          `"${profile.name}" suspends only OUTSIDE ${shuts}-${open} Costa Rica time, ` +
          `and CR is ${crNow} now — inside it. A breach would correctly suspend ` +
          `nothing, so running this would prove nothing either way. This is a ` +
          `SCHEDULING constraint, not a missing precondition: re-run while CR is ` +
          `between ${open} and ${shuts}, which is ${crToLocal(open)}-${crToLocal(shuts)} ` +
          `local time. (jasec-dev also carries an unwindowed profile and runs at any hour.)`,
        );

        blockedIf(
          headroom < REQUIRED_HEADROOM_MIN,
          `CR is ${crNow} and the no-cut window opens at ${shuts}, in ${headroom} min. ` +
          `This case polls for a suspension, a notification and a resume and needs ` +
          `~${REQUIRED_HEADROOM_MIN} min, so it would be cut off mid-run and fail for ` +
          `the wrong reason. Re-run after ${crToLocal(open)} local time.`,
        );

        // The hour is only half the rule — weekends and CR holidays defer all day.
        const crDate = costaRicaDate();
        blockedIf(
          crDate.weekday === 'Sat' || crDate.weekday === 'Sun',
          `it is ${crDate.weekday} ${crDate.iso} in Costa Rica. Suspension defers all ` +
          `day at weekends regardless of the hour, so a breach would correctly suspend ` +
          `nothing. Re-run on a CR weekday between ${crToLocal(open)} and ` +
          `${crToLocal(shuts)} local time.`,
        );

        const holiday = CR_FIXED_HOLIDAYS[crDate.mmdd];
        blockedIf(
          holiday !== undefined,
          `${crDate.iso} is ${holiday}, a Costa Rican public holiday. Suspension ` +
          `defers all day on holidays regardless of the hour, so a breach would ` +
          `correctly suspend nothing. Re-run on an ordinary CR weekday between ` +
          `${crToLocal(open)} and ${crToLocal(shuts)} local time.`,
        );
      }

      const mdr = new MdrRemoteHelper(logger);
      blockedIf(
        !(await mdr.isAvailable()),
        'the MDR loader tree is not reachable over SSH — cannot submit a reading. ' +
        'Check the VPN, MDR_SSH_HOST and MDR_WORK_DIR.',
      );

      const seed = new PrepaidSeedHelper(logger);
      const suffix = uniqueRunSuffix();
      const meter = assertQaMeter(`M-QAUSG-${suffix}`);

      // ── step 1: a contract on the no-window profile ─────────────────
      const { accountId, orderId } = await seed.seed({
        meter,
        customerId: `E2ESUSP-${suffix}`,
        name: `E2ESUSP ${suffix}`,
        creditProfileName: profile.name,
      });
      console.log(`\n  seeded ${accountId} / ${orderId} / meter ${meter} on "${profile.name}"\n`);

      const problems = await new OrderOutcomeHelper(logger).readAndVerify(accountId, {
        meter, bundleId: 'B-100000-E', creditProfileName: profile.name,
      });
      expect(problems, 'the seeded contract is not rateable, so the rest proves nothing').toEqual([]);

      /** Subscription + its service unit, which must move together. */
      const contractState = async () => {
        const rows = await db.query<any>(
          `SELECT s.id AS sub, s.status AS substatus, su.id AS svc, su.status AS svcstatus
             FROM core_engine.subscription s
             LEFT JOIN core_engine.service_unit su ON su.subscriptionid = s.id
            WHERE s.accountid = $1`,
          [accountId],
        );
        return rows[0] ?? null;
      };

      const notificationsOfType = async (type: string) =>
        db.query<any>(
          `SELECT id, status FROM core_engine.email_notification
            WHERE accountid = $1 AND type = $2`,
          [accountId, type],
        );

      const balance = async () => money(await db.getAccountBalance(accountId));

      // ── step 2: fund it and rate something it CAN pay for ───────────
      await seed.topUp(accountId, INITIAL_TOPUP);
      expect(await balance(), 'a 3,300 top-up must read as -3300.00 credit').toBe(-INITIAL_TOPUP);

      await mdr.submitReading(meter, FIRST_READING);
      const firstRated = await waitFor('the first reading to rate', async () => {
        const rows = await db.query<any>(
          `SELECT id FROM core_usage.file_detail_record_processed WHERE provisioningid = $1`,
          [meter],
        );
        return rows.length ? rows : null;
      });
      expect(firstRated, `the first ${FIRST_READING} kWh reading never rated`).not.toBeNull();

      const before = await contractState();
      console.log(`  before the breach: ${before.sub} ${before.substatus} / ${before.svc} ${before.svcstatus}`);
      expect(before.substatus, 'a funded contract must still be ACTIVE').toBe('ACTIVE');
      expect(before.svcstatus, 'a funded contract must still be ACTIVE').toBe('ACTIVE');

      // ── step 3: breach it ───────────────────────────────────────────
      await mdr.submitReading(meter, BREACH_READING);

      const parked = await waitFor('the reading to park', async () => {
        const rows = await db.query<any>(
          `SELECT id, status, errorcode FROM core_usage.file_detail_record
            WHERE provisioningid = $1 AND errorcode = 'CURRENCY_CREDIT_LIMIT_EXCEEDED'`,
          [meter],
        );
        return rows.length ? rows[0] : null;
      });
      expect(parked, 'the breach never parked, so there is nothing to suspend on').not.toBeNull();
      console.log(`  parked: ${parked.id} ${parked.status}/${parked.errorcode}`);

      // ── step 4: THE POINT — the suspension executed ─────────────────
      /**
       * Asynchronous: the breach commits, then the limit action runs. Poll the
       * subscription rather than reading it once.
       */
      const suspended = await waitFor('the subscription to be suspended', async () => {
        const s = await contractState();
        return s?.substatus === 'SUSPENDED' ? s : null;
      }, 180_000);

      expect(
        suspended,
        `the subscription never reached SUSPENDED. With no exception window on ` +
        `"${profile.name}" a breach must suspend. ${profile.winstart
          ? `CR was ${crNow} on ${costaRicaDate().weekday} ${costaRicaDate().iso} at ` +
            `the start of this run — outside the ${profile.winstart}-${profile.winend} ` +
            `no-cut window, not a weekend, and not a known fixed-date CR holiday. ` +
            `BEFORE FILING A DEFECT, rule out the two deferrals this case cannot ` +
            `predict: a MOVABLE holiday (Jueves/Viernes Santo), or one shifted to a ` +
            `Monday by Ley 9875. Also check the run did not cross ${profile.winstart} CR.`
          : 'This profile has no exception window, so it must suspend at any hour.'}`,
      ).not.toBeNull();

      expect(
        suspended.svcstatus,
        'the ELECTRICITY service unit must be suspended with its subscription — ' +
        'a suspended subscription over an ACTIVE service unit still delivers power',
      ).toBe('SUSPENDED');
      console.log(`  suspended: ${suspended.sub} ${suspended.substatus} / ${suspended.svc} ${suspended.svcstatus}`);

      const suspendNotes = await waitFor('the SUSPEND_SUBSCRIPTION notification', async () => {
        const rows = await notificationsOfType('SUSPEND_SUBSCRIPTION');
        return rows.length ? rows : null;
      }, 120_000);
      expect(
        suspendNotes,
        'no SUSPEND_SUBSCRIPTION row — the customer was cut off with no audit trail',
      ).not.toBeNull();
      console.log(`  notified: ${(suspendNotes ?? []).map((n: any) => `${n.id}/${n.status}`).join(', ')}`);

      // ── step 5: a top-up brings it back ─────────────────────────────
      await seed.topUp(accountId, RECOVERY_TOPUP);

      const resumed = await waitFor('the subscription to resume', async () => {
        const s = await contractState();
        return s?.substatus === 'ACTIVE' ? s : null;
      }, 180_000);

      expect(
        resumed,
        'the subscription never came back to ACTIVE after a top-up — the customer paid and stayed cut off',
      ).not.toBeNull();
      expect(resumed.svcstatus, 'the service unit must resume with its subscription').toBe('ACTIVE');
      console.log(`  resumed: ${resumed.sub} ${resumed.substatus} / ${resumed.svc} ${resumed.svcstatus}`);

      const resumeNotes = await waitFor('the RESUME_SUBSCRIPTION notification', async () => {
        const rows = await notificationsOfType('RESUME_SUBSCRIPTION');
        return rows.length ? rows : null;
      }, 120_000);
      expect(resumeNotes, 'no RESUME_SUBSCRIPTION row for the reconnection').not.toBeNull();

      console.log(`\n  PASS — ${accountId}: breach suspended the service, top-up resumed it\n`);
    } finally {
      await db.disconnect();
    }
  });
});
