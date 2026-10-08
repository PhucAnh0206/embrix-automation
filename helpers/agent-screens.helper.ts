import type { BrowserContext, Page } from '@playwright/test';
import { CustomerManagementPage } from '../pages/customer-hub/customer-management/customer-management.page';
import { ServicesPage } from '../pages/customer-hub/customer-management/account-details/subscription-data/services.page';
import { BillsPage } from '../pages/customer-hub/customer-management/account-details/billing-data/bills.page';
import { AccountInfoPage } from '../pages/customer-hub/customer-management/account-details/account-data/account-info.page';
import { SuspendResumeOrderPage } from '../pages/customer-hub/order-management/suspend-resume-order.page';
import { SHORT_WAIT } from './timeouts.helper';

/**
 * What an AGENT sees in Core UI for one account - the screens verified in the 2026-10-06 UI audit
 * (notes/guides/UI-CANDIDATES_2026-10-06.md): Services (V1), Balances (V2), order detail (V11).
 *
 * Every read opens the account the way an agent does (Customer Management > search > ACCT No) and then
 * PROVES the right account is open (the URL carries its id) before reading anything - a read of the wrong
 * account must fail, never pass.
 */

/** "-3,056.6" -> -3056.6; '' or unparseable -> null. */
export function uiAmount(s: string | undefined | null): number | null {
  const t = String(s ?? '').replace(/[,\s ₡]/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** 'YYYY-MM-DD HH:mm:ss' - the format the Core UI date-range fields (Rated Usage, Usage Records) take. */
export function screenDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * A Core UI tab next to the test's own page, for specs whose page is busy in Self Care. Same browser
 * context, so it shares the Core UI session the setup project stored. Carries the two helpers the page
 * objects expect on `page` (same code as fixtures/page-factory).
 */
export async function openAgentTab(context: BrowserContext): Promise<Page> {
  const tab = await context.newPage() as any;
  tab.navigateToHome = async () => {
    await tab.goto(process.env.EMBRIX_BASE_URL ?? '/');
    await tab.waitForLoadState('networkidle');
    await tab.locator('.animate__animated.animate__zoomIn').waitFor({ state: 'hidden', timeout: SHORT_WAIT }).catch(() => { });
  };
  tab.waitForLoadingToDisappear = async () => {
    const loader = tab.locator('.animate__animated.animate__zoomIn');
    await loader.waitFor({ state: 'visible', timeout: SHORT_WAIT }).catch(() => { });
    await loader.waitFor({ state: 'hidden', timeout: SHORT_WAIT }).catch(() => { });
  };
  return tab as Page;
}

export class AgentScreens {
  constructor(private readonly page: Page) {}

  /** Customer Management > search > open. Throws if the opened account is not `accountId`. */
  async openAccount(accountId: string): Promise<void> {
    const cm = new CustomerManagementPage(this.page);
    await (this.page as any).navigateToHome();
    await cm.navigateViaNav();
    await cm.searchByAccountId(accountId);
    await cm.clickFirstRowLink('ACCT No');
    if (!this.page.url().includes(`/customers/${accountId}/`)) {
      throw new Error(`Core UI opened ${this.page.url()} instead of account ${accountId}`);
    }
  }

  /** Subscription Data > Services: subscription status + reason, and the In-complete Orders rows. */
  async services(accountId: string): Promise<{ sub: string; reason: string; incomplete: string[] }> {
    await this.openAccount(accountId);
    const sp = new ServicesPage(this.page);
    await sp.navigateViaSideMenu();
    // An account whose order broke has no subscription row - read that as '' rather than throw.
    const sub = await sp.getSubscriptionFirstRowCellValue('Status').catch(() => '');
    const reason = await sp.getSubscriptionFirstRowCellValue('Reason').catch(() => '');
    const incomplete = (await this.page.locator('//h5[contains(text(), "In-complete Orders")]/following::table[1]//tbody/tr').allInnerTexts())
      .map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t && !/no record/i.test(t));
    console.log(`  UI Services ${accountId}: subscription ${sub} (${reason}); in-complete orders: ${incomplete.join(' | ') || 'none'}`);
    return { sub, reason, incomplete };
  }

  /**
   * Services > In-complete Orders > CANCEL ORDER - the agent's way out of a stuck order (F7, verified by hand on
   * prod 2026-10-08: ORD-386 became `ORD-386-<timestamp>` CANCELLED at once, no confirmation dialog). The rows have
   * no selection control and the button acts on the account's incomplete order, so this refuses (throws) unless
   * `orderId` is the ONLY row - it must never cancel an order the test did not mean. The caller checks the result in
   * the database (the order is renamed, so look for `<orderId>-%` CANCELLED).
   */
  async cancelIncompleteOrder(accountId: string, orderId: string): Promise<void> {
    const before = await this.services(accountId);
    if (before.incomplete.length !== 1 || !before.incomplete[0].startsWith(`${orderId} `)) {
      throw new Error(`In-complete Orders on ${accountId} must list only ${orderId} before CANCEL ORDER; it lists: ` +
        `${before.incomplete.join(' | ') || 'nothing'}`);
    }
    const section = this.page.locator('//h5[contains(text(), "In-complete Orders")]/ancestor::*[.//table][1]');
    await section.locator('tbody tr').filter({ hasText: orderId }).first().locator('td').nth(1).click();
    this.page.once('dialog', d => d.accept());
    await section.getByRole('button', { name: 'Cancel Order' }).click();
    await (this.page as any).waitForLoadingToDisappear?.();
    console.log(`  UI Services ${accountId}: CANCEL ORDER clicked for ${orderId}`);
  }

  /**
   * Billing Data > Balances: the CRC amount as the agent sees it. JASEC sign: NEGATIVE = credit.
   * null when the screen shows no CRC row.
   */
  async crcBalance(accountId: string): Promise<number | null> {
    await this.openAccount(accountId);
    await new BillsPage(this.page).navigateToBalance();
    // The balances grid is the one headed "Currency Id" (Grants and Accumulators sit below it).
    const table = this.page.locator('table').filter({ has: this.page.locator('thead th, thead td', { hasText: 'Currency Id' }) }).first();
    const row = table.locator('tbody tr').filter({ hasText: 'CRC' }).first();
    const ok = await row.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    const amount = ok ? uiAmount(await row.locator('td').nth(1).innerText()) : null;
    console.log(`  UI Balances ${accountId}: CRC ${amount ?? 'NOT SHOWN'}`);
    return amount;
  }

  /**
   * Balances until it shows `expected` (a top-up can take a moment to post). Every try re-opens the
   * account, so it never re-reads a stale page. Returns the last figure seen - the caller asserts.
   */
  async waitForCrcBalance(accountId: string, expected: number, tries = 4, gapMs = 10_000): Promise<number | null> {
    let seen: number | null = null;
    for (let i = 0; i < tries; i++) {
      seen = await this.crcBalance(accountId);
      if (seen !== null && Math.abs(seen - expected) < 0.005) return seen;
      if (i + 1 < tries) await this.page.waitForTimeout(gapMs);
    }
    return seen;
  }

  /**
   * Customer Activity rows of one order's AMI dispatch attempts (CREATE_UTILITIES_ORDER_TRIGGER - one row per
   * attempt, the same rows the database's core_engine.activity holds). Call while the account is open.
   * The screen opens filtered to the REAL current month, but activity carries the tenant (CCP) date, so the
   * default view is empty on a moved clock (seen on dev 2026-10-06; in production the two agree). Widen the
   * dates and Search, as an agent would, then wait for this order's rows before reading.
   */
  async customerActivityDispatches(order: string): Promise<number> {
    await new AccountInfoPage(this.page).navigateToCustomerActivity();
    await this.page.waitForURL(/\/activities/, { timeout: 30_000 });
    await this.page.locator('input[name="startDate"]').fill('2020-01-01');
    await this.page.locator('input[name="endDate"]').fill('2030-12-31');
    await this.page.getByRole('button', { name: 'Search', exact: true }).click();
    const grid = this.page.locator('table').first().locator('tbody tr');
    await grid.filter({ hasText: order }).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => { });
    const rows = await grid.allInnerTexts();
    const n = rows.filter(r => r.includes(order) && r.includes('CREATE_UTILITIES_ORDER_TRIGGER')).length;
    console.log(`  UI Customer Activity: ${n} dispatch row(s) for ${order} (${rows.length} rows on the page)`);
    return n;
  }

  /** Order detail header fields (Type, Status, Reason, User Id ...). */
  async order(orderId: string, labels = ['Type', 'Status', 'Reason', 'User Id']): Promise<Record<string, string>> {
    const f = await new SuspendResumeOrderPage(this.page).readOrderFields(orderId, labels);
    console.log(`  UI order ${orderId}: ${Object.entries(f).map(([k, v]) => `${k}=${v || '-'}`).join(', ')}`);
    return f;
  }
}
