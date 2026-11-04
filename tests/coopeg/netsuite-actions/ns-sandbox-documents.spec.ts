/**
 * NetSuite regression: every invoice / credit note the client CSV cites, checked on the NetSuite side.
 * For each Embrix document (0279xxx invoice, CR-xxxxxx credit note) and NetSuite number (FA… / NC…) in the
 * "Actual Result(s)" of the Pass / Waiting cases: what Embrix stored (Finance Version, sync status, error), then the
 * NetSuite sandbox global search (found exactly once, with the amount) and a screenshot of the search and the record.
 * Documents of QA contracts NetSuite does not know were refused with "contract not found" (expected): listed, not searched.
 * Read only (Embrix database read only, NetSuite sandbox view only).
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; npx playwright test --project=dev tests/coopeg/netsuite-actions/ns-sandbox-documents.spec.ts --reporter=line
 * Writes test-cases\netsuite\evidence\netsuite-sandbox\ (one PNG per search / record) and
 * test-cases\netsuite\results\NetSuite_sandbox_documents.csv.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { NsSandbox } from '../../../helpers/netsuite/ns-sandbox.helper';
import { db } from '../tickets/eft-106/eft-lib';
import { suiteDir } from '../../../helpers/netsuite/suite-dir';

const ROOT = suiteDir();
const SHOTS = path.join(ROOT, 'evidence', 'netsuite-sandbox');
const OUT = path.join(ROOT, 'results', 'NetSuite_sandbox_documents.csv');

const parse = (t: string) => { const rows: string[][] = []; let r: string[] = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { r.push(f); f = ''; } else if (c === '\r') { } else if (c === '\n') { r.push(f); rows.push(r); r = []; f = ''; } else f += c; } if (f || r.length) { r.push(f); rows.push(r); } return rows.filter(x => x.length > 1); };
const csv = (list: unknown[][]) => list.map(x => x.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)).join(',')).join('\r\n') + '\r\n';
const money = (n: number) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Cases whose cited document is meant to stay out of NetSuite (what the case itself checks). */
const KEPT_OUT: Record<string, string> = {
  'MAP-007': 'the case checks NetSuite refuses a customer without a NetSuite number',
  'CRN-007': 'the case checks a credit note waits while its invoice is not in NetSuite',
  'RPT-001/002': 'the case uses a rejected invoice to check the report\'s ERROR filter',
};

interface Doc { embrix: string; kind: 'Invoice' | 'Credit note'; account: string; total: number; version: string | null; sync: string; error: string | null }

test('NetSuite sandbox: the documents of the regression cases', async ({ browser }) => {
  test.setTimeout(60 * 60_000);
  const rows = parse(fs.readFileSync(path.join(ROOT, 'NetSuite_Regression_TestSuite - NetSuite_Regression_TestSuit.csv'), 'utf8'));
  const H = rows[0];
  const cases = rows.slice(1).map(r => ({ id: r[0], status: r[H.indexOf('Status')], text: r[H.indexOf('Actual Result(s)')] }));

  // Every Embrix document and NetSuite number each case cites, resolved through the Embrix database.
  const docs = new Map<string, Doc>();
  const load = async (where: string, v: string[]) => {
    for (const r of await db(`select id, accountid, total, financeversion, financesyncstatus, financeerrormessage, 'Invoice' k from core_engine.invoice_unit where ${where} = any($1)
      union all select id, accountid, total, financeversion, financesyncstatus, financeerrormessage, 'Credit note' from core_engine.notes_unit where ${where} = any($1)`, [v]))
      docs.set(r.id, { embrix: r.id, kind: r.k, account: r.accountid, total: Number(r.total), version: r.financeversion, sync: r.financesyncstatus, error: r.financeerrormessage });
  };
  const cites = cases.map(c => ({ ...c, embrix: [...new Set(c.text.match(/\b0279\d{3}\b|\bCR-\d{6}\b/g) ?? [])], ns: [...new Set(c.text.match(/\b(?:FA|NC)\d{4,}\b/g) ?? [])] }));
  await load('id', [...new Set(cites.flatMap(c => c.embrix))]);
  await load('financeversion', [...new Set(cites.flatMap(c => c.ns))]);
  const byVersion = new Map([...docs.values()].filter(d => d.version).map(d => [d.version!, d]));

  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png')) fs.unlinkSync(path.join(SHOTS, f));
  const sb = await NsSandbox.open(browser);
  const seen = new Map<string, { total: number; row: string; amountOk: boolean; shots: string[] }>();
  try {
    for (const d of [...docs.values()].filter(d => d.version)) {
      const r = await sb.search(d.version!);
      const shots = [`evidence/netsuite-sandbox/${d.version}-search.png`];
      await sb.page.screenshot({ path: path.join(ROOT, shots[0]), fullPage: true });
      if (r.rows[0]?.url && r.rows[0].url !== sb.page.url()) {
        await sb.read(r.rows[0].url);
        shots.push(`evidence/netsuite-sandbox/${d.version}-record.png`);
        await sb.page.screenshot({ path: path.join(ROOT, shots[1]), fullPage: true });
      }
      const row = r.rows.map(x => x.text).join(' | ');
      seen.set(d.version!, { total: r.total, row, amountOk: row.includes(money(d.total)), shots });
      console.log(`  ${d.version} (${d.embrix}, ${d.account}, ${money(d.total)}): TOTAL ${r.total} ${row.slice(0, 140)}`);
    }
  } finally { await sb.close(); }

  // One line per case and document.
  const out: unknown[][] = [['Case', 'Case status', 'Embrix document', 'Type', 'Account', 'Amount', 'NetSuite number', 'Sync status', 'In the NetSuite sandbox', 'Result', 'Screenshots']];
  const problems: string[] = [];
  for (const c of cites) {
    const list = [...new Set([...c.embrix.map(e => docs.get(e)), ...c.ns.map(n => byVersion.get(n))])].filter(Boolean) as Doc[];
    for (const n of c.ns.filter(n => !byVersion.has(n))) { out.push([c.id, c.status, '', '', '', '', n, '', 'not checked', `${n} is not stored on any Embrix document`, '']); problems.push(`${c.id} ${n}`); }
    for (const d of list) {
      const s = d.version ? seen.get(d.version) : undefined;
      let result: string;
      if (!d.version) {
        const why = `${d.sync}${d.error ? ` "${d.error}"` : ''}`;
        if (/No se ha encontrado un contrato/.test(d.error ?? '')) result = 'Not in NetSuite: test contract unknown to NetSuite ("contract not found"), expected';
        else if (KEPT_OUT[c.id]) result = `Not in NetSuite (${why}), expected: ${KEPT_OUT[c.id]}`;
        else if (d.account.startsWith('QA-')) result = `Not in NetSuite (${why}), expected: QA test contract without a NetSuite customer`;
        else { result = `Not in NetSuite: ${why}`; problems.push(`${c.id} ${d.embrix}: ${result}`); }
      } else if (s!.total === 1 && s!.amountOk) result = 'Found once, same amount';
      else { result = `Found ${s!.total} time(s)${s!.amountOk ? '' : `, amount ${money(d.total)} not shown`}`; problems.push(`${c.id} ${d.version}: ${result}`); }
      out.push([c.id, c.status, d.embrix, d.kind, d.account, money(d.total), d.version ?? '', d.sync, s ? `${s.total} record(s): ${s.row}` : '', result, (s?.shots ?? []).join('\n')]);
    }
  }
  fs.writeFileSync(OUT, csv(out));
  const found = [...seen.values()].filter(s => s.total === 1 && s.amountOk).length;
  console.log(`  ${seen.size} NetSuite document(s) searched, ${found} found once with the same amount; ${docs.size - seen.size} Embrix document(s) of test contracts not in NetSuite. ${OUT}`);
  expect(problems, 'documents not found once with the same amount').toEqual([]);
});
