/**
 * EFT-108: evidence per business process, from the documents the NetSuite regression produced (read only).
 * For each process, the invoices / credit notes its cases cite in the client CSV ("Actual Result(s)"): the document's
 * row on the account's Bills or Credit/Debit Notes screen, and the request Embrix sent to NetSuite with its answer
 * (Customer Activity). The NetSuite side of each document is in evidence\netsuite-sandbox (ns-sandbox-documents).
 * Saved as test-cases\netsuite\eft-106\evidence\EFT108-<process>-*.png; tools\eft106-report.js lists them per process.
 * The process ↔ case list is the one in eft106-report.js. Fresh runs of the cases: ns.ps1 / ns-cycle.ps1 (NEXT-RUN.md).
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; npx playwright test --project=eft106 tests/coopeg/tickets/eft-106/eft108-processes.spec.ts --reporter=line
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import { db, record, Shots } from './eft-lib';
import { suiteDir } from '../../../../helpers/netsuite/suite-dir';

const CSV = require('path').join(suiteDir(), 'NetSuite_Regression_TestSuite - NetSuite_Regression_TestSuit.csv');
const PROCESSES: [string, string[]][] = [
  ['BILLING', ['REG-001', 'REG-003', 'INV-001', 'INV-002', 'INV-003', 'INV-010', 'MAP-002', 'MAP-003', 'MAP-008', 'MAP-009', 'MAP-012', 'MAP-013']],
  ['DISCONNECTION', ['REG-002', 'SUS-001']],
  ['CREDIT-NOTES', ['CRN-001', 'CRN-002', 'CRN-003', 'CRN-004', 'CRN-006', 'CRN-007', 'CRN-008', 'CRN-011', 'ADJ-001', 'ADJ-002', 'INV-018']],
  ['CONTRACT-CREATION', ['CRM-004']],
  ['PLAN-CHANGES', ['CHG-001']],
  ['PAYMENTS', ['PAY-001', 'AR-001']],
];

const parse = (t: string) => { const rows: string[][] = []; let r: string[] = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { r.push(f); f = ''; } else if (c === '\r') { } else if (c === '\n') { r.push(f); rows.push(r); r = []; f = ''; } else f += c; } if (f || r.length) { r.push(f); rows.push(r); } return rows.filter(x => x.length > 1); };
const rows = parse(fs.readFileSync(CSV, 'utf8'));
const H = rows[0];
const CASES = Object.fromEntries(rows.slice(1).map(r => [r[0], { status: r[H.indexOf('Status')], text: r[H.indexOf('Actual Result(s)')] }]));

test.use({ viewport: { width: 1800, height: 1000 } });

for (const [process, ids] of PROCESSES) {
  test(`${process}: documents of the process's cases on the screens`, async ({ page }) => {
    test.setTimeout(30 * 60_000);
    const shots = new Shots(page, `EFT108-${process}`);
    const lines: string[] = [];
    for (const id of ids) {
      const c = CASES[id];
      if (!c) { lines.push(`${id}: not in the client CSV`); continue; }
      // Up to two documents per case keep the pack readable.
      const docs = [...new Set(c.text.match(/\b0279\d{3}\b|\bCR-\d{6}\b/g) ?? [])].slice(0, 2);
      if (!docs.length) { lines.push(`${id} (${c.status}): no document cited`); continue; }
      for (const d of docs) {
        const inv = d.startsWith('CR-') ? undefined : (await db('select accountid, financeversion v from core_engine.invoice_unit where id = $1', [d]))[0];
        const cn = d.startsWith('CR-') ? (await db('select accountid, financeversion v from core_engine.notes_unit where id = $1', [d]))[0] : undefined;
        const doc = inv ?? cn;
        if (!doc) { lines.push(`${id} ${d}: not found in Embrix`); continue; }
        const api = inv ? 'CREATE_INVOICE' : 'CREATE_CREDIT_NOTES';
        const act = (await db(`select id from core_engine.activity where accountid = $1 and entityid = $2 and apiname = $3 order by substring(id from 3)::int desc limit 1`, [doc.accountid, d, api]))[0];
        const tag = `${id.replace(/[^A-Z0-9-]/gi, '')}-${d}`;
        try {
          if (inv) await shots.billRow(`${tag}-bills`, doc.accountid, d);
          else await shots.creditNoteRow(`${tag}-credit-notes`, doc.accountid, d);
          if (act) await shots.activity(`${tag}-netsuite-request`, doc.accountid, act.id, api);
          lines.push(`${id} (${c.status}) ${d} on ${doc.accountid}: ${doc.v ? `NetSuite ${doc.v}` : 'not in NetSuite'}`);
        } catch (e) {
          lines.push(`${id} ${d}: screenshot failed (${(e as Error).message.split('\n')[0].slice(0, 80)})`);
        }
      }
    }
    const statuses = ids.map(i => CASES[i]?.status);
    record(`EFT108-${process}`, statuses.includes('Fail') ? 'Fail' : 'Pass', lines.join('; '), { cases: ids, screenshots: shots.files });
  });
}
