/**
 * The accounting extract tells the ERP what the customer was actually charged.
 *
 * ts-02 and ts-03 prove the batch is a well-formed, balanced, traceable ledger. None of
 * that notices a ledger that drops every minus sign: Dr = Cr still holds, every line still
 * balances. That is exactly how the defect raised on 2026-10-08 got past them -
 * `create_accounting_entry` books credit lines (the -17.40 CVG ENERGIA credit, the matching
 * negative IVA) with ABS(amount), in the same direction as a charge, so the batch sent to
 * Exactus = the sum of absolute amounts, not the invoice. Preprod ACT-100297, invoice
 * 000225 (24,677.57), batch 10028 (25,123.03).
 *
 * Three checks, each one link of the chain:
 *   1. invoice  = signed sum of its journals     (the basis - holds today)
 *   2. journal  -> its accounting entry keeps the sign   (FAILS today on every credit line)
 *   3. journals -> the batch line per GL account = their net   (FAILS today on every batch
 *                                                            with a credit line)
 * Checks 2 and 3 judge the EFFECT on the GL account, so either fix in the bug report (keep
 * the sign, or swap debit/credit) makes them pass - see EntrySignResult in
 * helpers/accounting-db.helper.ts. FIXED 2026-10-08 (team: credit lines keep their sign).
 * Batches extracted BEFORE the fix keep their old amounts by design, so per tenant
 * TIE_OUT_FIX_FROM_BATCH names the first post-fix batch: older ones are logged, not judged;
 * that one and every later one must tie out exactly (ts-06 also checks its own new batch).
 *
 * READ-ONLY. Queries only, no clock move (plain `@playwright/test`, not the JASEC
 * fixtures). Needs the database, therefore the VPN.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { AccountingDbHelper, KNOWN_BASIS_GAPS, KNOWN_TIE_OUT_DEBRIS, TIE_OUT_FIX_FROM_BATCH } from '../../../../helpers/accounting-db.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const DEFECT = 'credit lines booked as positive amounts (accounting extract defect raised 2026-10-08)';
const CENT = 0.005;
/** First batch extracted with the team's fix on this tenant (see TIE_OUT_FIX_FROM_BATCH). Undefined = judge all. */
const FIX_FROM = TIE_OUT_FIX_FROM_BATCH[process.env.TEST_ENV ?? ''];
const preFix = (batchId: string) => FIX_FROM !== undefined && /^\d+$/.test(batchId) && Number(batchId) < FIX_FROM;

let db: DbHelper;
let acct: AccountingDbHelper;

test.describe('JASEC accounting — the extract ties out to the net invoice', {
  tag: ['@jasec', '@accounting', '@tc-146', '@ebs-net'],
}, () => {

  test.beforeAll(async () => {
    db = new DbHelper();
    await db.connect();
    acct = new AccountingDbHelper(db);
  });

  test.afterAll(async () => {
    await db?.disconnect();
  });

  test('basis: every extracted invoice equals the signed sum of its journals', async () => {
    const rows = await acct.invoiceVsJournals();
    blockedIf(rows.length === 0, 'no invoice on this tenant has journals in an INVOICE extract');
    const known = KNOWN_BASIS_GAPS[process.env.TEST_ENV ?? ''] ?? [];
    const gaps = rows.filter((r) => Math.abs(r.total - r.journals) > CENT);
    for (const r of gaps.filter((g) => known.includes(g.invoiceId))) {
      console.log(`  known pre-existing anomaly, see KNOWN_BASIS_GAPS — invoice ${r.invoiceId}: total ${r.total}, journals ${r.journals}`);
    }
    const off = gaps.filter((g) => !known.includes(g.invoiceId));
    console.log(`\n  ${rows.length} extracted invoice(s), ${off.length} not equal to their journals\n`);
    expect
      .soft(
        off.map((r) => `invoice ${r.invoiceId} (bill unit ${r.billUnitId}): total ${r.total}, journals ${r.journals}`),
        'invoices whose journals do not add up to them - the net tie-out below loses its meaning',
      )
      .toEqual([]);
  });

  test('every accounting entry keeps the sign of its journal', async () => {
    if (FIX_FROM !== undefined) {
      const old = await acct.entrySign(undefined, { below: FIX_FROM });
      console.log(`\n  pre-fix batches (< ${FIX_FROM}, kept with their old amounts by design - team 2026-10-08): ` +
        `${old.broken} of ${old.credits} credit line(s) booked like charges - logged, not judged`);
    }
    const r = await acct.entrySign(undefined, FIX_FROM !== undefined ? { from: FIX_FROM } : undefined);
    blockedIf(r.judged === 0, FIX_FROM !== undefined
      ? `no journal extracted at or after batch ${FIX_FROM} (the first post-fix batch) - extract a day first (TC-146)`
      : 'no journal in an INVOICE extract has an accounting entry');
    console.log(`\n  ${r.judged} journal(s) judged, ${r.credits} credit line(s), ${r.broken} booked against their sign`);
    for (const x of r.sample) {
      console.log(`    journal ${x.journalId} (batch ${x.batchId}, ${x.accountId}): amount ${x.amount}, entry moves its GL account by ${x.effect}`);
    }
    console.log('');
    expect
      .soft(r.broken, `${r.broken} of ${r.credits} credit line(s) are booked like charges - ${DEFECT}`)
      .toBe(0);
  });

  test('every INVOICE batch line equals the net of the journals it consumed', async () => {
    const lines = await acct.batchNetTieOut();
    const known = KNOWN_TIE_OUT_DEBRIS[process.env.TEST_ENV ?? ''] ?? [];
    const pre = lines.filter((l) => !known.includes(l.batchId) && preFix(l.batchId));
    const preOff = new Set(pre.filter((l) => Math.abs(l.batch - l.net) > CENT).map((l) => l.batchId));
    if (FIX_FROM !== undefined) {
      console.log(`  pre-fix batches (< ${FIX_FROM}): ${preOff.size} keep their old amounts by design (team 2026-10-08) - ` +
        `logged, not judged: ${[...preOff].join(', ') || 'none'}`);
      // A pre-fix batch that is off in some OTHER way than the known defect is still a finding.
      const preOther = pre.filter((l) => Math.abs(l.batch - l.net) > CENT && !(l.credits > 0 && Math.abs(l.batch - l.gross) <= CENT));
      expect.soft(preOther.map((l) => `batch ${l.batchId} ${l.glAccount}: net ${l.net.toFixed(2)}, batch ${l.batch.toFixed(2)}`),
        'pre-fix batches that are off in some way OTHER than the known credit-line defect').toEqual([]);
    }
    const judged = lines.filter((l) => !known.includes(l.batchId) && !preFix(l.batchId));
    for (const id of new Set(lines.filter((l) => known.includes(l.batchId)).map((l) => l.batchId))) {
      console.log(`  known pre-existing anomaly, see KNOWN_TIE_OUT_DEBRIS — batch ${id}`);
    }
    blockedIf(judged.length === 0, FIX_FROM !== undefined
      ? `no INVOICE batch at or after ${FIX_FROM} (the first post-fix batch) - extract a day first (TC-146)`
      : 'no INVOICE batch on this tenant has journals stamped with it');

    const off = judged.filter((l) => Math.abs(l.batch - l.net) > CENT);
    const batches = new Set(judged.map((l) => l.batchId));
    const offBatches = new Set(off.map((l) => l.batchId));
    const overstated = off.reduce((n, l) => n + (l.batch - l.net), 0);
    console.log(
      `\n  ${batches.size} batch(es), ${judged.length} GL line(s) judged; ${offBatches.size} batch(es) do not ` +
      `tie out, by ${overstated.toFixed(2)} in total\n`,
    );
    for (const l of off) {
      const looksLikeDefect = l.credits > 0 && Math.abs(l.batch - l.gross) <= CENT;
      console.log(
        `    batch ${l.batchId} ${l.glAccount}: ${l.journals} journal(s), ${l.credits} credit(s) - ` +
        `net ${l.net.toFixed(2)}, batch ${l.batch.toFixed(2)}` +
        (looksLikeDefect ? ' (= sum of absolute amounts: the known defect)' : ' (NOT the known defect pattern)'),
      );
    }
    console.log('');

    // Split so a NEW kind of break is never hidden behind the known one.
    const defect = off.filter((l) => l.credits > 0 && Math.abs(l.batch - l.gross) <= CENT);
    const other = off.filter((l) => !defect.includes(l));
    expect
      .soft(
        defect.map((l) => `batch ${l.batchId} ${l.glAccount}: net ${l.net.toFixed(2)}, sent ${l.batch.toFixed(2)}`),
        `batch lines that send the sum of absolute amounts instead of the net - ${DEFECT}`,
      )
      .toEqual([]);
    expect
      .soft(
        other.map((l) => `batch ${l.batchId} ${l.glAccount}: net ${l.net.toFixed(2)}, batch ${l.batch.toFixed(2)}, ` +
          `${l.credits} credit line(s)`),
        'batch lines that differ from the net of their journals in some OTHER way - a new finding',
      )
      .toEqual([]);
  });
});
