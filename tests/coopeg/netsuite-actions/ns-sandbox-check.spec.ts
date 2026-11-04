/**
 * NetSuite sandbox read (view only): finds each document number in NetSuite and prints how many records match and
 * what each shows. First run headed (a verification code, if asked, is typed in the window; the session is then kept):
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_SB_FIND='FA586029,NC1001'
 *   npx playwright test tests/coopeg/netsuite-actions/ns-sandbox-check.spec.ts --project=dev --headed --reporter=line
 * Writes test-results/ns-sandbox-check.json and a screenshot per document.
 */
import * as fs from 'fs';
import { test, expect } from '@playwright/test';
import { NsSandbox } from '../../../helpers/netsuite/ns-sandbox.helper';

const FIND = (process.env.NS_SB_FIND ?? '').split(',').map(s => s.trim()).filter(Boolean);

test('NetSuite sandbox: documents Embrix sent', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  expect(FIND.length, 'NS_SB_FIND=<FA…/NC…>,...').toBeGreaterThan(0);
  const sb = await NsSandbox.open(browser);
  const out: any[] = [];
  fs.mkdirSync('test-results', { recursive: true });
  for (const q of FIND) {
    const r = await sb.search(q);
    await sb.page.screenshot({ path: `test-results/ns-sandbox-${q}-search.png`, fullPage: true });
    const docs = [];
    for (const h of r.rows) docs.push({ ...h, record: h.url ? (await sb.read(h.url)).slice(0, 4000) : '' });
    if (r.rows[0]?.url) await sb.page.screenshot({ path: `test-results/ns-sandbox-${q}.png`, fullPage: true });
    out.push({ number: q, total: r.total, docs });
    console.log(`${q}: TOTAL ${r.total}`);
    for (const d of docs) console.log(`  row: ${d.text}\n  record: ${String(d.record).slice(0, 900)}`);
  }
  fs.writeFileSync('test-results/ns-sandbox-check.json', JSON.stringify(out, null, 2));
  await sb.close();
});
