/**
 * Writes the NetSuite run back into the suite's own format.
 *
 * Input:  test-cases\netsuite\NetSuite_Regression_TestSuite_v2_coopegsbx2.csv (never modified)
 * Output: test-cases\netsuite\results\NetSuite_Regression_TestSuite_R2_<date>.csv
 *         — same 10 columns; for every case that ran, Actual Result(s) gets
 *         "R2 <date>: ..." prepended to the round-1 text and Status is replaced.
 * Cases with no matching test keep their row untouched.
 */
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';

const SUITE = 'D:/Dev/products/Embrix/test-cases/netsuite/NetSuite_Regression_TestSuite_v2_coopegsbx2.csv';
const OUT_DIR = 'D:/Dev/products/Embrix/test-cases/netsuite/results';

function parseCsv(s: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let f = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export default class NetsuiteCsvReporter implements Reporter {
  private results = new Map<string, { status: string; actual: string; evidence: string[] }>();

  onTestEnd(test: TestCase, result: TestResult) {
    const id = test.title.split(':')[0].trim();
    if (!/^[A-Z]{2,4}-[\w./-]+$/.test(id) || !test.location.file.includes('netsuite')) return;
    const ann = (t: string) => [...new Set(test.annotations.concat(result.annotations ?? []).filter(a => a.type === t).map(a => a.description ?? ''))];
    const forced = ann('ns-status').pop();
    const status = forced ?? (result.status === 'passed' ? 'Pass' : result.status === 'skipped' ? 'Not run' : 'Fail');
    let actual = ann('ns-actual').join(' | ');
    if (result.status === 'failed' || result.status === 'timedOut') {
      const msg = (result.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join(' ').trim();
      actual = [actual, msg].filter(Boolean).join(' | ');
    }
    // Keyed by case AND spec file: a case checked in two places (e.g. the Embrix side in ns-01 and the
    // NetSuite side in ns-08) gets one combined row; re-running a file replaces only that file's part.
    const file = path.basename(test.location.file);
    this.results.set(`${id}@@${file}`, { status, actual, evidence: ann('ns-evidence') });
  }

  onEnd() {
    if (!this.results.size) return;
    const date = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // Accumulate across runs of the same day: earlier specs keep their results.
    const store = path.join(OUT_DIR, `R2_${date}.json`);
    const all: Record<string, { status: string; actual: string; evidence: string[] }> =
      fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
    for (const [k, v] of this.results) {
      const id = k.split('@@')[0];
      delete all[id]; // legacy entry (before per-file keys) for this case
      all[k] = v;
    }
    fs.writeFileSync(store, JSON.stringify(all, null, 2));
    const rows = parseCsv(fs.readFileSync(SUITE, 'utf8'));
    const header = rows[0];
    const iA = header.indexOf('Actual Result(s)'), iS = header.indexOf('Status'), iN = header.indexOf('Note');
    const RANK = ['Fail', 'Blocked', 'Need confirmation', 'Not run', 'Not applicable', 'Pass'];
    const combined: Record<string, { status: string; actual: string; evidence: string[] }> = {};
    for (const [k, v] of Object.entries(all)) {
      const id = k.split('@@')[0];
      const c = combined[id];
      if (!c) { combined[id] = { ...v, evidence: [...v.evidence] }; continue; }
      c.status = RANK.indexOf(v.status) < RANK.indexOf(c.status) ? v.status : c.status;
      c.actual = [c.actual, v.actual].filter(Boolean).join(' || ');
      c.evidence.push(...v.evidence);
    }
    for (const r of rows.slice(1)) {
      const res = combined[r[0]];
      if (!res) continue;
      const ev = res.evidence.length ? ` [evidence: ${res.evidence.join(', ')}]` : '';
      r[iA] = `R2 ${date}: ${res.actual || '(as expected)'}${ev}` + (r[iA] ? `\n${r[iA]}` : '');
      r[iS] = res.status;
      void iN;
    }
    const out = path.join(OUT_DIR, `NetSuite_Regression_TestSuite_R2_${date}.csv`);
    fs.writeFileSync(out, rows.filter(r => r.length > 1).map(r => r.map(cell).join(',')).join('\n') + '\n');
    const tally: Record<string, number> = {};
    for (const v of Object.values(combined)) tally[v.status] = (tally[v.status] ?? 0) + 1;
    console.log(`\n[netsuite] ${this.results.size} cases → ${out}\n[netsuite] ${JSON.stringify(tally)}`);
  }
}
