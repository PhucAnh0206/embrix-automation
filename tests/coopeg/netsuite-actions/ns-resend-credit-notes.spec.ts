/**
 * NetSuite — re-send credit notes in ERROR from Core UI > Customer > Credit/Debit Notes (SYNC_CREDIT_NOTE, SUBMIT),
 * then wait for each to reach NetSuite (financeSyncStatus SUCCESS and its NC number in the CREATE_CREDIT_NOTES answer).
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_RESEND='208886:CR-105173,208886:CR-105174'
 *   npx playwright test tests/coopeg/netsuite-actions/ns-resend-credit-notes.spec.ts --project=dev --reporter=line
 * Writes output/test-results/ns-resend-credit-notes.json.
 */
import * as fs from 'fs';
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { attachUi } from '../../../helpers/netsuite/ns-ui.helper';

const LIST = (process.env.NS_RESEND ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(':') as [string, string]);

test('re-send credit notes from the Credit/Debit Notes screen', async ({ playwright, browser }) => {
  test.setTimeout(LIST.length * 6 * 60_000 + 60_000);
  expect(process.env.TEST_ENV, 'coopegsbx2 only').toBe('coopegsbx2');
  expect(LIST.length, 'NS_RESEND=<account>:<CR-id>,...').toBeGreaterThan(0);
  const api = new NsApi(await playwright.request.newContext());
  await attachUi(api, browser);
  const out: any[] = [];
  for (const [acc, cn] of LIST) {
    const at = new Date().toISOString();
    const r: any = { account: acc, note: cn, at };
    try { r.toast = (await api.resendCreditNote(acc, cn)).toast; } catch (e) { r.toast = (e as Error).message; }
    for (let i = 0; i < 24; i++) {
      const n = (await api.creditNotesOf(acc)).find(x => x.id === cn);
      r.status = n?.financeSyncStatus; r.error = n?.financeErrorMessage?.slice(0, 200);
      if (r.status && r.status !== 'ERROR' && r.status !== 'PENDING') break;
      await new Promise(x => setTimeout(x, 10_000));
    }
    const act = (await api.activitiesFor(acc, cn, 'CREATE_CREDIT_NOTES')).pop();
    r.netsuite = parse(act?.response);
    out.push(r);
    console.log(JSON.stringify(r));
  }
  fs.mkdirSync('output/test-results', { recursive: true });
  fs.writeFileSync('output/test-results/ns-resend-credit-notes.json', JSON.stringify(out, null, 2));
  expect(out.filter(r => r.status !== 'SUCCESS').map(r => `${r.note}: ${r.status} ${r.toast}`)).toEqual([]);
});
