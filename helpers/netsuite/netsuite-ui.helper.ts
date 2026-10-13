/**
 * NetSuite sandbox (CoopeG 8754760-sb1) — READ-ONLY record reader.
 *
 * Opens a transaction by its NetSuite internal id (= Embrix Finance Ref Id /
 * CREATE_* response data.id) with the session saved by ns-98-netsuite-login,
 * and returns what the record page shows. It never clicks Edit/Save.
 *
 * Field labels are the sandbox's (mixed English/Spanish) as seen 2026-10-12.
 */
import { Page } from '@playwright/test';

export const NETSUITE_URL = 'https://8754760-sb1.app.netsuite.com';
export const NETSUITE_STATE = 'playwright/.auth/netsuite.json';

const RECORD_PATH = { invoice: 'custinvc.nl', creditMemo: 'custcred.nl' } as const;

/** Names NetSuite shows for the DEFAULT mapping ids (dept 15 / class 104 / location 131), seen on FA584306. */
export const DEFAULT_NAMES = { department: 'Gerencia de Telecomunicaciones', class: 'Telecom : Telecomunicaciones', location: 'Telecomunicaciones' };

export interface NsRecord {
  url: string;
  found: boolean;
  text: string;        // visible text
  allText: string;     // includes hidden subtabs (Apply, etc.)
  ids: string[];       // every id=... found in links (customer internal id is among them)
  field: (label: string) => string | undefined;
  money: (label: string) => number | undefined;
  lines: string[];     // item lines ("I_INT INTERNET ...")
}

export async function openRecord(page: Page, kind: keyof typeof RECORD_PATH, internalId: string | number): Promise<NsRecord> {
  const url = `${NETSUITE_URL}/app/accounting/transactions/${RECORD_PATH[kind]}?id=${internalId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  if (/login|loginform|\/app\/login/i.test(page.url())) {
    throw new Error('NetSuite session expired — re-run ns-98-netsuite-login.spec.ts --headed and sign in again');
  }
  const text = await page.locator('body').innerText();
  const allText = (await page.locator('body').textContent()) ?? '';
  const ids = await page.locator('a[href*="id="]').evaluateAll(as => as.map(a => (a.getAttribute('href') ?? '').match(/[?&]id=(\d+)/)?.[1]).filter(Boolean) as string[]);
  const found = !/no existe|does not exist|insufficient permission|permiso/i.test(text.slice(0, 2000)) && /TOTAL/i.test(text);
  // Labels are on their own line, value on the next non-empty line.
  const rows = text.split('\n').map(s => s.trim()).filter(Boolean);
  const field = (label: string) => { const i = rows.findIndex(r => r.toUpperCase() === label.toUpperCase()); return i >= 0 ? rows[i + 1] : undefined; };
  const money = (label: string) => { const v = field(label); return v === undefined ? undefined : Number(v.replace(/,/g, '')); };
  const lines = rows.filter(r => /^I_[A-Z0-9_]+\s/.test(r)); // digits too: I_IMP_911
  return { url, found, text, allText, ids: [...new Set(ids)], field, money, lines };
}
