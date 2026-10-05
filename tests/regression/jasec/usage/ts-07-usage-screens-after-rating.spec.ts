/**
 * Rated usage reaches the two Core UI screens that display it.
 *
 * When an MDR reading rates, four charge lines are written — ENERGIA, CVG
 * ENERGIA, ALUMBRADO PUBLICO, CVG ALUMBRADO PUBLICO — and they must be readable
 * in BOTH places the product offers:
 *
 *   Customer Hub -> Billing Data -> Rated Usage     (the rated transactions)
 *   Customer Hub -> Billing Data -> Usage Records   (the underlying usage rows)
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Reported 2026-08-25: Rated Usage showed the transactions, Usage Records came
 * back empty for the same account, while `core_engine.transaction_usage_data`
 * held the rows. It was fixed on jasec-dev and is STILL OPEN on jasec-preprod.
 * It escaped because nothing in the suite looked at either screen.
 *
 * TC-60 and TC-62 in the CoopeG platform suite (`embrixPlatform/ts-02.spec.ts`)
 * appear to cover this and do not:
 *   - TC-60 asserts the grid settles into rows OR "No records found". An empty
 *     screen after rating is a PASS. It cannot fail the way that matters.
 *   - TC-62 never asserts a row exists; it only checks an export downloads.
 * Both also build their date filter from `new Date()` — real today — which on a
 * CCP tenant filters everything out and then passes via the empty branch. This
 * spec derives its window from the rated row itself, never from the wall clock.
 *
 * ── WHAT IT ASSERTS ────────────────────────────────────────────────────────
 * Not "some rows are present". Exactly the rows THIS RUN created: the four
 * transaction ids rating produced, their descriptions, their net amounts to the
 * cent, and the usage id — matched against the database, which is the only
 * source of truth for what should be on screen.
 *
 * Soft checks, so one run reports on both screens. A hard failure on Rated
 * Usage would hide whatever Usage Records was going to say, and on preprod
 * today it is Usage Records that fails.
 *
 * ── MUTATING ───────────────────────────────────────────────────────────────
 * Seeds an account, tops it up and drops a real MDR file through the loader.
 * Needs SSH to the control server AND the database, therefore the VPN, AND a
 * browser. Gated behind JASEC_USAGE_UI_RUN=true.
 *
 *     $env:JASEC_USAGE_UI_RUN='true'
 *     npx playwright test --project=jasec-usage-screens --headed
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

const RUN_ENABLED = String(process.env.JASEC_USAGE_UI_RUN ?? '').trim().toLowerCase() === 'true';

/** Fixed charge plus 15 kWh — the documented recarga inicial. */
const INITIAL_TOPUP = 20000;
/** Small enough that the top-up funds it comfortably, so nothing parks. */
const READING_KWH = 40;

/** The four charge lines a JASEC prepaid reading always produces. */
const EXPECTED_LINES = [
  'ENERGIA',
  'CVG ENERGIA',
  'ALUMBRADO PUBLICO',
  'CVG ALUMBRADO PUBLICO',
];

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

/**
 * `YYYY-MM-DD HH:mm:ss`, the format both screens' date fields use.
 * Built from a Date the caller already shifted — no timezone maths here.
 */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Does any row in the grid contain all of these strings? */
function rowMatching(rows: string[][], ...needles: string[]): string[] | undefined {
  return rows.find((cells) => {
    const joined = cells.join(' | ');
    return needles.every((n) => joined.includes(n));
  });
}

test.describe('JASEC usage — rated usage is visible on both Core UI screens (MUTATING)', {
  tag: ['@jasec', '@usage', '@ui', '@tc-60'],
}, () => {
  test.setTimeout(20 * 60 * 1000);

  test('a rated reading appears on Rated Usage and on Usage Records', async ({
    page, customerManagementPage, billsPage, testLogger,
  }) => {
    blockedIf(
      !RUN_ENABLED,
      'JASEC_USAGE_UI_RUN is not "true". This spec seeds an account, drops a real ' +
      'MDR file and moves a balance, so it never runs by accident.',
    );

    const logger = new TestLogger('ts-07-usage-screens-after-rating');
    const db = new DbHelper(logger);
    await db.connect();

    try {
      const mdr = new MdrRemoteHelper(logger);
      blockedIf(
        !(await mdr.isAvailable()),
        'the MDR loader tree is not reachable over SSH — cannot submit a reading. ' +
        'Check the VPN and the ssh alias.',
      );

      const seed = new PrepaidSeedHelper(logger);

      // ── 1. a fresh, rateable contract ───────────────────────────────
      /**
       * Seeded, not borrowed. A shared account carries accumulator history that
       * moves the reading into a different tariff block, so the amounts on
       * screen would no longer be predictable from this run alone.
       */
      const suffix = uniqueRunSuffix();
      const meter = assertQaMeter(`M-QAUSR-${suffix}`);
      let accountId = '';

      await test.step('seed a prepaid contract with its own meter', async () => {
        const seeded = await seed.seed({
          meter,
          customerId: `E2EUSGUI-${suffix}`,
          name: `E2EUSGUI ${suffix}`,
        });
        accountId = seeded.accountId;
        testLogger.data('Seeded account', `${accountId} / meter ${meter}`);

        /**
         * POLL, do not assert once. `seed()` returns as soon as the order is
         * submitted, but the subscription, the METER provisioning row and the
         * balance are written by order completion a few seconds later. Checking
         * immediately reports a perfectly good contract as unrateable — seen on
         * dev 2026-09-22, where ORD-1630 was COMPLETED and fully provisioned by
         * the time the failure was investigated.
         */
        const outcome = new OrderOutcomeHelper(logger);
        const problems = await waitFor(
          'the seeded contract to become rateable',
          async () => {
            const found = await outcome.readAndVerify(accountId, { meter, bundleId: 'B-100000-E' });
            return found.length === 0 ? [] : null;
          },
          180_000,
          5_000,
        );
        expect(
          problems,
          'the seeded contract never became rateable, so nothing below proves anything. ' +
          `Last check on ${accountId} / meter ${meter}: ` +
          (await outcome.readAndVerify(accountId, { meter, bundleId: 'B-100000-E' })).join(' | '),
        ).toEqual([]);
      });

      // ── 2. credit, so the reading rates rather than parking ─────────
      await test.step('top up so the reading can be funded', async () => {
        await seed.topUp(accountId, INITIAL_TOPUP);
        // INVERTED SIGN: credit is negative in CRC on JASEC.
        expect(await db.getAccountBalance(accountId), 'the top-up must read as credit')
          .toBe(-INITIAL_TOPUP);
      });

      // ── 3. a real reading, through the real loader ──────────────────
      await test.step(`submit a ${READING_KWH} kWh reading`, async () => {
        const out = await mdr.submitReading(meter, READING_KWH);
        testLogger.data('MDR file', out.match(/MDR_PREPAGO_\d{8}-\d{6}\.csv/)?.[0] ?? '(name not found)');
      });

      // ── 4. the truth, from the database ─────────────────────────────
      /**
       * Everything asserted on screen is compared against THIS, not against a
       * hardcoded expectation. If the tariff changes, the test still holds.
       */
      type Txn = {
        id: string; description: string; itemid: string;
        netamount: number; startdate: string; usageid: string;
      };
      let truth: Txn[] = [];

      await test.step('wait for rating, and read what it produced', async () => {
        const rated = await waitFor('the reading to rate', async () => {
          const rows = await db.query<Txn>(
            `SELECT t.id,
                    t.description,
                    t.itemid,
                    t.netamount::float8 AS netamount,
                    to_char(t.startdate, 'YYYY-MM-DD HH24:MI:SS') AS startdate,
                    u.usageid
               FROM core_engine.transaction_unit t
               JOIN core_engine.transaction_usage_data u ON u.transactionid = t.id
              WHERE t.accountid = $1 AND t.type = 'USAGE'
              ORDER BY t.itemid`,
            [accountId],
          );
          return rows.length >= 4 ? rows : null;
        });

        expect(rated, `the ${READING_KWH} kWh reading never rated — nothing to look for on screen`)
          .not.toBeNull();
        truth = rated!;

        testLogger.data('Rated transactions', truth.map(
          (t) => `${t.id} ${t.description} ${t.netamount}`,
        ));

        // The shape itself is part of the contract.
        expect(
          truth.map((t) => t.description).sort(),
          'a JASEC prepaid reading must produce exactly the four tariff lines',
        ).toEqual([...EXPECTED_LINES].sort());
      });

      const usageId = truth[0].usageid;
      const txnIds = truth.map((t) => t.id);

      /**
       * The search window comes from the rated row's own date, never from
       * `new Date()`. These tenants run on a frozen CCP clock months away from
       * real time; a wall-clock window silently excludes everything.
       */
      const rated0 = new Date(`${truth[0].startdate.replace(' ', 'T')}Z`);
      const from = new Date(rated0.getTime() - 2 * 86_400_000);
      const to = new Date(rated0.getTime() + 2 * 86_400_000);
      const [fromStamp, toStamp] = [stamp(from), stamp(to)];
      testLogger.data('Search window (CCP-derived)', `${fromStamp} -> ${toStamp}`);

      // ── 5. open the account in Core UI ──────────────────────────────
      await test.step('open the seeded account in Core UI', async () => {
        /**
         * LOAD THE APP FIRST. navigateViaNav() hovers a nav button with a 5s
         * wait and assumes the shell is already rendered; without this the
         * context is still on about:blank and it fails with a bare
         * "locator.waitFor: Timeout 5000ms exceeded" that looks like a broken
         * screen rather than a missing step.
         */
        await page.navigateToHome();
        await customerManagementPage.navigateViaNav();
        await customerManagementPage.searchByAccountId(accountId);
        // The grid column is "ACCT No" — "Account Id" does not exist here.
        await customerManagementPage.clickFirstRowLink('ACCT No');
      });

      // ── 6. Rated Usage ──────────────────────────────────────────────
      await test.step('Rated Usage shows the four transactions this run rated', async () => {
        await billsPage.navigateToRatedUsage();
        await billsPage.searchByDate(fromStamp, toStamp);
        await billsPage.clickSearchButton();

        const rows = await billsPage.getUsageGridRows();
        testLogger.data('Rated Usage rows returned', rows.length);

        expect.soft(
          rows.length,
          `Rated Usage returned no rows, but rating wrote ${truth.length} transactions ` +
          `for ${accountId} (${txnIds.join(', ')}). Window ${fromStamp} -> ${toStamp}.`,
        ).toBeGreaterThan(0);

        for (const t of truth) {
          // Amounts render with thousands separators and no trailing zeros,
          // so match the id and description, then read the row back.
          const hit = rowMatching(rows, t.id);
          expect.soft(hit, `Rated Usage has no row for ${t.id} (${t.description})`).toBeTruthy();
          if (!hit) continue;

          const joined = hit.join(' | ');
          expect.soft(joined, `${t.id} is on screen but not labelled ${t.description}`)
            .toContain(t.description);
          expect.soft(joined, `${t.id} is on screen but its Item Id is not ${t.itemid}`)
            .toContain(t.itemid);

          // Net Amount, compared numerically — the grid formats it.
          const shown = hit
            .map((c) => c.replace(/[, ]/g, ''))
            .find((c) => /^-?\d+(\.\d+)?$/.test(c) && Math.abs(Number(c) - t.netamount) < 0.005);
          expect.soft(
            shown,
            `${t.id} (${t.description}) should show Net Amount ${t.netamount}; ` +
            `row reads: ${joined}`,
          ).toBeTruthy();
        }

        expect.soft(
          rowMatching(rows, usageId),
          `Rated Usage shows no row carrying the usage id ${usageId}`,
        ).toBeTruthy();
      });

      // ── 7. Usage Records ────────────────────────────────────────────
      /**
       * OPEN DEFECT on jasec-preprod as of 2026-09-22: this screen returns
       * nothing while the rows exist in `core_engine.transaction_usage_data`.
       * Fixed on jasec-dev. The message below is written so a preprod failure
       * reads as that known defect and not as a broken test.
       */
      await test.step('Usage Records shows the underlying usage rows', async () => {
        await billsPage.navigateToUsageRecord();
        await billsPage.searchByDate(fromStamp, toStamp);
        await billsPage.clickSearchButton();

        const rows = await billsPage.getUsageGridRows();
        testLogger.data('Usage Records rows returned', rows.length);

        expect.soft(
          rows.length,
          `Usage Records returned no rows for ${accountId}, but ` +
          `core_engine.transaction_usage_data holds ${truth.length} rows for usage id ` +
          `${usageId} (transactions ${txnIds.join(', ')}). Window ${fromStamp} -> ${toStamp}. ` +
          `This is the 2026-08-25 defect: fixed on jasec-dev, open on jasec-preprod.`,
        ).toBeGreaterThan(0);

        for (const t of truth) {
          const hit = rowMatching(rows, t.id);
          expect.soft(hit, `Usage Records has no row for transaction ${t.id}`).toBeTruthy();
          if (!hit) continue;

          // This grid carries Net Amount too, so hold it to the same figure
          // Rated Usage showed and the database recorded.
          const joined = hit.join(' | ');
          const shown = hit
            .map((c) => c.replace(/[, ]/g, ''))
            .find((c) => /^-?\d+(\.\d+)?$/.test(c) && Math.abs(Number(c) - t.netamount) < 0.005);
          expect.soft(
            shown,
            `${t.id} (${t.description}) should show Net Amount ${t.netamount} on Usage ` +
            `Records; row reads: ${joined}`,
          ).toBeTruthy();
        }

        expect.soft(
          rowMatching(rows, usageId),
          `Usage Records shows no row carrying the usage id ${usageId}`,
        ).toBeTruthy();

        expect.soft(
          rowMatching(rows, meter),
          `Usage Records shows no row carrying the meter ${meter} as Provisioning Id`,
        ).toBeTruthy();
      });
    } finally {
      await db.disconnect();
    }
  });
});
