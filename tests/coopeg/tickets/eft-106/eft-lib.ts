/**
 * EFT-106 escalation checks (coopegsbx2): shared reads and the result / evidence record.
 * Every check writes its verdict and evidence to test-cases\netsuite\eft-106\ (results.json + evidence\), which
 * test-cases\netsuite\tools\eft106-report.js turns into the per-ticket documents.
 * Reads the environment's own database (coopegsbx-dev-db, VPN on) read only; never writes to it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, Page } from '@playwright/test';
import { rowAcrossPages } from '../../../../helpers/netsuite/ns-ui.helper';
import { NsSandbox } from '../../../../helpers/netsuite/ns-sandbox.helper';
import { suiteDir } from '../../../../helpers/netsuite/suite-dir';

export const OUT = require('path').join(suiteDir(), 'eft-106');
const PG_CFG = `${suiteDir()}/tools/.pg-${process.env.NS_PG || 'coopegsbx-dev'}.json`;

/** Read-only query on this environment's database. */
export async function db<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('read-only: SELECT only');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg');
  const c = new Client({ ...JSON.parse(fs.readFileSync(PG_CFG, 'utf8')), port: 5432, ssl: { rejectUnauthorized: false },
    options: '-c default_transaction_read_only=on -c statement_timeout=120000' });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

/** simulated: the operation gateway answered "SUCCESS In Test Mode" (ccp testMode = true, as on the CoopeG Sandbox): nothing was sent. */
export interface Call { id: string; accountId: string; api: string; provider: string; ok: boolean; simulated: boolean; answer: string; request?: string }

/** Outbound / inbound gateway calls of an account (or of a provider since an activity id), oldest first. */
export async function calls(where: { accountId?: string; provider?: string; sinceId?: number; api?: string }, withRequest = false): Promise<Call[]> {
  const cond: string[] = ['apiname is not null']; const p: unknown[] = [];
  if (where.accountId) { p.push(where.accountId); cond.push(`accountid = $${p.length}`); }
  if (where.provider) { p.push(where.provider); cond.push(`merchantname = $${p.length}`); }
  if (where.api) { p.push(where.api); cond.push(`apiname = $${p.length}`); }
  if (where.sinceId) { p.push(where.sinceId); cond.push(`substring(id from 3)::int > $${p.length}`); }
  const rows = await db(`select id, accountid, apiname, merchantname, coalesce(nullif(response::text, 'null'), canonicalresponse::text) r${withRequest ? ', request::text q' : ''}
    from core_engine.activity where ${cond.join(' and ')} order by substring(id from 3)::int`, p);
  return rows.map(r => ({ id: r.id, accountId: r.accountid, api: r.apiname, provider: r.merchantname ?? '', answer: clip(r.r), ok: answered(r.r), simulated: /In Test Mode/.test(String(r.r)), request: r.q ? clip(r.q, 1500) : undefined }));
}

/**
 * True when the provider answered without an error (SOAP answer, status SUCCESS / codigo 00, NetSuite error false).
 * A SOAP fault is matched as an element: a bare "Fault" also matched NOKIA's value DEFAULT (10-26).
 */
export function answered(r: string | null): boolean {
  const s = String(r ?? '');
  if (!s || s === 'null') return false;
  const t = s.replace(/\\"/g, '"');
  if (/"status":\s*"FAILED"|"error":\s*true|errorMsg"?:\s*"[^"]|:Fault\b|<Fault\b|"isError":\s*true|returned an error code/i.test(t)) return false;
  // MOTV answers {"status": <code>, "response": ...}: 1 is success, any other code a refusal (24: user without rights).
  const motv = t.match(/"status":\s*(\d+)(?:\.0+)?\s*,\s*"response"|"response":[^{}]*?,\s*"status":\s*(\d+)(?:\.0+)?/);
  if (motv && Number(motv[1] ?? motv[2]) !== 1) return false;
  return true;
}

export const clip = (s: unknown, n = 400) => String(s ?? '').replace(/\s+/g, ' ').replace(/\\"/g, '"').slice(0, n);

/** Secrets never go into evidence: tokens, passwords and OAuth values are masked. */
export function mask(s: string): string {
  // [a-z_]*password / [a-z_]*secret also cover MOTV's users_password (a hash) and users_secret in SESSION_LOGIN answers.
  return s.replace(/((?:\\*")?([a-z_]*password|[a-z_]*secret|api_token|access_token|refresh_token|token|session_id|oauth_[a-z_]+|consumer_?key)(?:\\*")?\s*[:=]\s*(?:\\*")?)[^"\\,}\s]+/gi, '$1***');
}

/**
 * page.goto with one retry: Core UI pages sometimes take minutes to answer on coopegsbx2 (three EFT runs on 10-25
 * failed on a single slow load). A second attempt usually loads at once.
 */
export async function goto(page: Page, url: string): Promise<void> {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 }); }
  catch { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 }); }
}

/**
 * Screenshots of one check, saved next to its evidence as evidence\<check>-<name>.png (latest run only: the check's
 * older screenshots are removed when it starts). Never point it at PortaOne activity: those rows show its token and
 * password in plain text.
 */
export class Shots {
  readonly files: string[] = [];
  constructor(private readonly page: Page, private readonly id: string) {
    const dir = path.join(OUT, 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${id}-`) && f.endsWith('.png')) fs.unlinkSync(path.join(dir, f));
  }

  async take(name: string, page: Page = this.page): Promise<void> {
    const file = `${this.id}-${name}.png`;
    await page.screenshot({ path: path.join(OUT, 'evidence', file), fullPage: true });
    this.files.push(`eft-106/evidence/${file}`);
  }

  /** A Core UI screen as it opens (e.g. /customers/<id>/services). */
  async screen(name: string, url: string): Promise<void> {
    await goto(this.page, url);
    await this.page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { });
    await this.page.waitForTimeout(2500);
    await this.take(name);
  }

  /** Customer Activity of the account, with the row's View open (request and answer side by side). */
  async activity(name: string, accountId: string, activityId: string, apiName?: string): Promise<void> {
    const p = this.page;
    await goto(p, `/customers/${encodeURIComponent(accountId)}/activities`);
    await p.locator('input[name="startDate"]').fill('2020-01-01');
    await p.locator('input[name="endDate"]').fill('2039-12-31');
    // Busy accounts (208886) have hundreds of rows: narrow to the API, as an agent would.
    if (apiName) {
      await p.locator('.form-group', { has: p.getByText('Api Name', { exact: true }) }).locator('input').first().fill(apiName);
      await p.keyboard.press('Enter');
    }
    await p.getByRole('button', { name: 'Search', exact: true }).click();
    await p.locator('table').first().locator('tbody tr').first().waitFor({ timeout: 30_000 });
    await p.waitForTimeout(1500);
    const row = await rowAcrossPages(p, activityId);
    await row.getByText('View', { exact: true }).first().click();
    await p.locator('.modal-content').first().waitFor();
    await p.waitForTimeout(1000);
    await this.take(name);
    await p.getByRole('button', { name: 'OK', exact: true }).click().catch(() => { });
  }

  /** The invoice's row on the account's Bills screen, outlined (wide window so Finance Version / Ref Id show). */
  async billRow(name: string, accountId: string, invoiceId: string): Promise<void> {
    const p = this.page;
    const size = p.viewportSize();
    await p.setViewportSize({ width: 2600, height: 1000 });
    await goto(p, `/customers/${accountId}/bills`);
    await p.locator('tbody tr', { hasText: 'MANUAL_BILL' }).first().waitFor({ timeout: 60_000 }).catch(() => { });
    await p.waitForTimeout(1500);
    const row = await rowAcrossPages(p, invoiceId);
    await row.scrollIntoViewIfNeeded();
    await row.evaluate(el => { (el as HTMLElement).style.outline = '3px solid #e53935'; });
    await this.take(name);
    if (size) await p.setViewportSize(size);
  }

  /** The credit note's row on the account's Credit/Debit Notes screen, outlined. */
  async creditNoteRow(name: string, accountId: string, noteId: string): Promise<void> {
    const p = this.page;
    const size = p.viewportSize();
    await p.setViewportSize({ width: 2600, height: 1000 });
    await goto(p, `/customers/${encodeURIComponent(accountId)}/credit-notes`);
    await p.locator('tbody tr', { hasText: 'CR-' }).first().waitFor({ timeout: 60_000 }).catch(() => { });
    await p.waitForTimeout(1500);
    const row = await rowAcrossPages(p, noteId);
    await row.scrollIntoViewIfNeeded();
    await row.evaluate(el => { (el as HTMLElement).style.outline = '3px solid #e53935'; });
    await this.take(name);
    if (size) await p.setViewportSize(size);
  }

  /** NetSuite sandbox: the global search for a document number, then its record page (read only). */
  async netsuite(name: string, sb: NsSandbox, number: string): Promise<{ total: number; rows: { text: string; url: string }[] }> {
    const r = await sb.search(number);
    await this.take(`${name}-search`, sb.page);
    if (r.rows[0]?.url && r.rows[0].url !== sb.page.url()) { await sb.read(r.rows[0].url); await this.take(`${name}-record`, sb.page); }
    return r;
  }
}

/** Records one check: verdict (Pass / Fail / Blocked / Not tested), the result in plain words, and its evidence. */
export function record(id: string, verdict: 'Pass' | 'Fail' | 'Blocked' | 'Not tested' | 'Recorded', result: string, evidence: unknown = {}): void {
  fs.mkdirSync(path.join(OUT, 'evidence'), { recursive: true });
  const file = path.join(OUT, 'evidence', `${id}.json`);
  fs.writeFileSync(file, mask(JSON.stringify({ id, verdict, result, at: new Date().toISOString(), evidence }, null, 2)));
  const all = fs.existsSync(path.join(OUT, 'results.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8')) : {};
  result = mask(result);
  all[id] = { verdict, result, at: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(all, null, 2));
  test.info().annotations.push({ type: 'result', description: `${verdict}: ${result}` });
  console.log(`  ${verdict.toUpperCase().padEnd(10)} ${id}  ${result}`);
}
