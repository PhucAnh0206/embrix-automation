/**
 * NetSuite sandbox (8754760-sb1, CoopeG) — READ ONLY. Logs in like a user, keeps the session, and reads what Embrix
 * sent: global search by document number (FA… / NC…), and the record page of an invoice or credit memo.
 * Never clicks Edit / Save / Delete: the sandbox is Coope's and view-only for QA.
 *
 * Settings (git-ignored .env.coopegsbx2): NS_SANDBOX_URL, NS_SANDBOX_USER, NS_SANDBOX_PASSWORD and NS_SANDBOX_QA
 * ("question fragment=>answer|..." for the security question NetSuite asks on a new browser).
 * Session: playwright/.auth/netsuite-sandbox.json (git-ignored), reused until NetSuite logs it out.
 * A verification-code step (2FA) cannot be answered by code: in a headed run the helper waits for it to be typed in
 * the window (up to 5 min), then saves the session.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Browser, BrowserContext, Page } from '@playwright/test';

const STATE = path.join('playwright', '.auth', 'netsuite-sandbox.json');

export interface NsDoc { number: string; type: string; text: string; url: string }

export class NsSandbox {
  private constructor(private readonly ctx: BrowserContext, readonly page: Page, private readonly base: string) {}

  static async open(browser: Browser): Promise<NsSandbox> {
    const url = process.env.NS_SANDBOX_URL;
    if (!url || !process.env.NS_SANDBOX_USER || !process.env.NS_SANDBOX_PASSWORD) throw new Error('NS_SANDBOX_URL / USER / PASSWORD not set (.env.coopegsbx2)');
    const ctx = await browser.newContext({ storageState: fs.existsSync(STATE) ? STATE : undefined, viewport: { width: 1500, height: 950 }, locale: 'es-CR' });
    const sb = new NsSandbox(ctx, await ctx.newPage(), new URL(url).origin);
    await sb.login();
    return sb;
  }

  async close() { await this.ctx.close(); }

  private async text(): Promise<string> { return (await this.page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' '); }

  private loggedIn(): boolean { return this.page.url().startsWith(this.base + '/app/') && !/login|customerlogin/i.test(this.page.url()); }

  /** Logs in (or reuses the saved session), answers the security question, dismisses the "set up questions" prompt. */
  async login(): Promise<void> {
    const p = this.page;
    await p.goto(process.env.NS_SANDBOX_URL!, { waitUntil: 'domcontentloaded' });
    for (let step = 0; step < 40; step++) {
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      await p.waitForTimeout(2000);
      const body = await this.text();
      const email = p.locator('input#email, input[name=email]').first();
      if (await email.isVisible().catch(() => false)) {
        await email.fill(process.env.NS_SANDBOX_USER!);
        await p.locator('input#password, input[name=password]').first().fill(process.env.NS_SANDBOX_PASSWORD!);
        await p.locator('#login-submit, button[type=submit], input[type=submit]').first().click();
        continue;
      }
      const answer = p.locator('input[name=answer]').first();
      if (await answer.isVisible().catch(() => false)) {
        const qa = (process.env.NS_SANDBOX_QA ?? '').split('|').map(x => x.split('=>')).filter(x => x.length === 2);
        const hit = qa.find(([q]) => body.toLowerCase().includes(q.toLowerCase()));
        if (!hit) throw new Error(`NetSuite security question not in NS_SANDBOX_QA: ${body.slice(0, 300)}`);
        await answer.fill(hit[1]);
        await p.locator('input[type=submit], button[type=submit]').first().click();
        continue;
      }
      if (/verificaci[oó]n|verification code|c[oó]digo de|authentication code|autenticaci[oó]n de dos/i.test(body) && !this.loggedIn()) {
        console.log('[netsuite-sandbox] verification code requested: type it in the browser window (waiting up to 5 min)');
        await p.waitForURL(u => u.toString().startsWith(this.base + '/app/'), { timeout: 300_000 });
        continue;
      }
      const later = p.getByRole('button', { name: /Recordármelo más tarde|Remind me later/i });
      // Each dismissal counts down NetSuite's "you can dismiss this N more times": the saved session avoids new logins.
      if (await later.isVisible().catch(() => false)) { console.log('[netsuite-sandbox] security-questions setup prompt dismissed'); await later.click(); continue; }
      if (this.loggedIn() && (await p.locator('#ns_navigation, #ns-header-menu-main, [data-header-section]').count()) > 0) break;
      if (this.loggedIn() && step > 3) break;
    }
    if (!this.loggedIn()) throw new Error(`NetSuite sandbox login did not finish: ${p.url()}`);
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    await this.ctx.storageState({ path: STATE });
  }

  /**
   * Global search (as typing in the header search box). Returns NetSuite's TOTAL and one entry per result row that
   * shows the number (a single exact match may open the record itself).
   */
  async search(q: string): Promise<{ total: number; rows: NsDoc[] }> {
    const p = this.page;
    await p.goto(`${this.base}/app/common/search/ubersearchresults.nl?quicksearch=T&searchtype=Uber&frame=be&Uber_NAMEtype=KEYWORDSTARTSWITH&Uber_NAME=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    if (!this.loggedIn()) { await this.login(); return this.search(q); }
    const body = await this.text();
    const total = /TOTAL:\s*(\d+)/i.exec(body);
    if (!total) return { total: 1, rows: [{ number: q, type: '', text: body.slice(0, 1500), url: p.url() }] };
    const rows = await p.locator('tr').evaluateAll((trs: any[], n: string) => trs
      .filter(tr => tr.querySelectorAll('td').length > 2 && tr.innerText.includes(n) && !tr.querySelector('tr'))
      .map(tr => ({ text: tr.innerText.replace(/\s+/g, ' ').trim(), url: (tr.querySelector('a[href*="id="]') as any)?.href ?? '' })), q);
    return { total: Number(total[1]), rows: rows.map(r => ({ number: q, type: '', ...r })) };
  }

  /** The record page's text (header fields, lines), read only. */
  async read(url: string): Promise<string> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);
    return this.text();
  }
}
