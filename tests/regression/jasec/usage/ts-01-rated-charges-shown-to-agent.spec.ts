/**
 * Block E, the AGENT's side: the charges the tarification scenarios rated are shown on Core UI
 * Rated Usage exactly as the rating engine wrote them.
 *
 * Block E (`_scripts/calc/run-block-E.ps1`, TC-40..56 + TC-61) proves the charge ARITHMETIC - tariff
 * blocks, ICB / IVA thresholds, the ALP cap, the 0-30 fixed charge - by reading the database. A correct
 * charge the agent sees wrongly (a missing line, another amount) is still a wrong answer to a customer
 * who calls about their consumption. This holds the screen to the stored lines.
 *
 * WHAT IT JUDGES, per Block E scenario that PASSED: the LAST reading that scenario rated on its account
 * (one usage id = its charge lines). account > Billing Data > Rated Usage, searched around that reading's
 * date, must list every one of those transactions with the same Net Amount. One reading, not the whole
 * history, so grid paging can never hide a row and fake a failure.
 *
 * INPUT: `artifacts/block-e-results.json`, written by run-block-E.ps1 at the end of every run (since
 * 2026-10-06). Missing, or written for another tenant = BLOCKED. A scenario that did not PASS is not
 * judged here - its arithmetic already failed or never ran.
 *
 * READ-ONLY.   npx playwright test --project=jasec-usage-charges
 * (`run-suite.ps1 -Block tarif` runs it straight after Block E.)
 *
 * Owner: Anh Tran (QC).
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/page-factory';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { AgentScreens, uiAmount } from '../../../../helpers/agent-screens.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const HANDOFF = path.resolve(__dirname, '../../../../artifacts/block-e-results.json');
const TENANT = (process.env.TEST_ENV ?? '').trim();

type BlockEResult = { TC: string; Verdict: string; Meter: string; Detail?: string };
type Handoff = { tenant: string; finishedUtc: string; results: BlockEResult[] };
type Txn = { id: string; description: string; netamount: number; startdate: string };

/** 'YYYY-MM-DD HH:mm:ss' (the Rated Usage date fields), from epoch ms. */
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function readHandoff(): Handoff | null {
  if (!fs.existsSync(HANDOFF)) return null;
  try {
    const h = JSON.parse(fs.readFileSync(HANDOFF, 'utf8').replace(/^﻿/, ''));
    return { ...h, results: Array.isArray(h.results) ? h.results : (h.results ? [h.results] : []) };
  } catch { return null; }
}

test.describe('Block E charges shown to the agent on Rated Usage @tarif-on-screen', () => {
  test('every Block E scenario that passed: its last rated reading is on Rated Usage with the same amounts', async ({
    page, billsPage,
  }) => {
    test.setTimeout(1_800_000);
    blockedIf(!hasDbConfig(), 'needs DB access to read the stored charge lines');
    const h = readHandoff();
    blockedIf(!h, `no Block E handoff at ${HANDOFF} - run run-block-E.ps1 first`);
    const sameTenant = h!.tenant === TENANT || `jasec-${h!.tenant}` === TENANT;
    blockedIf(!sameTenant, `the Block E handoff is for "${h!.tenant}" (finished ${h!.finishedUtc}), this run targets "${TENANT}"`);
    const passed = h!.results.filter(r => r.Verdict === 'PASS' && String(r.Meter ?? '').trim());
    blockedIf(!passed.length, `the Block E run of ${h!.finishedUtc} has no PASS scenario with a meter/account to judge`);
    console.log(`  Block E run ${h!.finishedUtc} on ${h!.tenant}: judging ${passed.map(r => r.TC).join(', ')}`);

    const db = new DbHelper(new TestLogger('block-e-on-screen'));
    await db.connect();
    const ui = new AgentScreens(page);
    try {
      for (const r of passed) {
        await test.step(`${r.TC}: Rated Usage shows the last rated reading`, async () => {
          // FC cases record the ACCOUNT, rating cases the METER.
          let accountId = r.Meter.trim();
          if (!/^ACT-/.test(accountId)) {
            // service_provision.id is the service unit's id; the account sits on the service unit.
            const a = await db.query<{ accountid: string }>(
              `SELECT su.accountid FROM core_engine.service_provision sp
                 JOIN core_engine.service_unit su ON su.id = sp.id
                WHERE sp.provisioningid = $1 AND sp.type = 'METER' ORDER BY su.id DESC LIMIT 1`, [accountId]);
            accountId = a[0]?.accountid ?? '';
          }
          expect.soft(accountId, `${r.TC}: could not resolve an account from "${r.Meter}"`).toMatch(/^ACT-/);
          if (!/^ACT-/.test(accountId)) return;

          const txns = await db.query<Txn>(
            `SELECT t.id, t.description, t.netamount::float8 AS netamount,
                    to_char(t.startdate, 'YYYY-MM-DD HH24:MI:SS') AS startdate
               FROM core_engine.transaction_unit t
              WHERE t.accountid = $1 AND t.type = 'USAGE'
                AND t.usageid = (SELECT usageid FROM core_engine.transaction_unit
                                  WHERE accountid = $1 AND type = 'USAGE' AND usageid IS NOT NULL
                                  ORDER BY id DESC LIMIT 1)
              ORDER BY t.id`, [accountId]);
          console.log(`  ${r.TC} ${accountId}: last reading ${txns.map(t => `${t.id} ${t.description} ${t.netamount}`).join(', ') || 'NO USAGE'}`);
          if (!txns.length) {
            // A fixed-charge scenario can pass without a usage transaction (the charge is made at billing).
            test.info().annotations.push({ type: 'not-judged', description: `${r.TC} ${accountId}: no rated usage to show` });
            return;
          }

          const at = new Date(`${txns[0].startdate.replace(' ', 'T')}Z`).getTime();
          await ui.openAccount(accountId);
          await billsPage.navigateToRatedUsage();
          await billsPage.searchByDate(stamp(at - 2 * 86_400_000), stamp(at + 2 * 86_400_000));
          await billsPage.clickSearchButton();
          const rows = await billsPage.getUsageGridRows();
          const problems: string[] = [];
          for (const t of txns) {
            const row = rows.find(cells => cells.join(' | ').includes(t.id));
            if (!row) { problems.push(`${t.id} ${t.description}: not listed`); continue; }
            const amountShown = row.some(c => { const v = uiAmount(c); return v !== null && Math.abs(v - t.netamount) < 0.005; });
            if (!amountShown) problems.push(`${t.id} ${t.description}: Net Amount ${t.netamount} not shown (row: ${row.join(' | ')})`);
          }
          console.log(`  ${r.TC} Rated Usage: ${rows.length} row(s); ${txns.length - problems.length}/${txns.length} charge lines shown with the same amount`);
          expect.soft(problems, `${r.TC} ${accountId}: Rated Usage does not match the stored charge lines`).toEqual([]);
        });
      }
    } finally {
      await db.disconnect();
    }
  });
});
