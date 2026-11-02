import { Page, expect } from '@playwright/test';
import { BasePage } from '../../base.page';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT } from '../../../helpers/timeouts.helper';

/**
 * Core UI  Customer Hub -> Order -> Suspend Order / Resume Order.
 *
 * Both sidebar entries render the SAME component (OrderSubscription/
 * SuspendSubscription.js), switched by the route. Two steps:
 *
 *   1 Select Account         account search + a NEXT button per row
 *   2 Manage & Create Order  the subscription table, then CREATE
 *
 * CREATE sends createOrder with `subscriptions: [...]` and NO `services` - which
 * is why an order made here carries no core_oms.order_services row, unlike the
 * API-built orders the older specs use. That difference is the subject of
 * suspend-resume-orders.spec.ts. On success the app redirects to
 * /orders/<id>/detail, which is where "Submit order" lives.
 *
 * WHY AN ACCOUNT CAN BE MISSING FROM STEP 1. The search only lists accounts that
 * are ACTIVE, have a subscription in the right status (ACTIVE for suspend,
 * SUSPENDED for resume), have no order in CREATED/PENDING, AND whose effective
 * date is on or before the CCP clock (PGAccountService ~1150). An account created
 * "today" while the clock is parked in the past is invisible here and the screen
 * says only "No account subscription found for Suspend".
 *
 * Owner: Anh Tran (QC).
 */
export type SubscriptionOrderKind = 'suspend' | 'resume';

export class SuspendResumeOrderPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── Locators ─────────────────────────────────────────────────────────
  private get accountIdInput() { return this.page.locator('input[name="accountId"]').first(); }
  private get searchButton() { return this.page.getByRole('button', { name: /^\s*(search|buscar)\s*$/i }).first(); }
  // The deployed build renders this table WITHOUT the tbl-order-subscription
  // class the develop source has, so it is found by a header only it carries.
  private get subscriptionTable() {
    return this.page.locator('table', {
      has: this.page.getByRole('columnheader', { name: 'Initial Term Unit', exact: true }),
    }).first();
  }
  private get createButton() { return this.page.getByRole('button', { name: /^\s*(create|crear)\s*$/i }).first(); }
  private get submitOrderButton() {
    return this.page.getByRole('button', { name: /^\s*(submit\s*order|enviar\s*orden)\s*$/i }).first();
  }
  private accountRow(accountId: string) {
    return this.page.locator('tr', { has: this.page.getByText(accountId, { exact: true }) }).first();
  }

  // ── Step 1: select account ───────────────────────────────────────────

  async open(kind: SubscriptionOrderKind): Promise<void> {
    await this.navigate(`/orders/${kind}`);
    await this.accountIdInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
   * Search one account. Returns false - rather than throwing - when the screen
   * does not list it, because that is usually the effective-date-vs-CCP filter
   * (a precondition), and the caller decides whether that is BLOCKED.
   */
  async searchAccount(accountId: string): Promise<boolean> {
    await this.accountIdInput.fill(accountId);
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();
    try {
      await this.accountRow(accountId).waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
      return true;
    } catch {
      return false;
    }
  }

  /** Press the row's NEXT button; waits for step 2's subscription table. */
  async selectAccount(accountId: string): Promise<void> {
    await this.accountRow(accountId).locator('button.btn-select-next').click();
    await this.page.waitForLoadingToDisappear();
    await this.subscriptionTable.waitFor({ state: 'visible', timeout: LONG_WAIT });
  }

  // ── Step 2: manage & create ──────────────────────────────────────────

  /**
   * Pick the Subscription Reason in the subscription table (suspend only - the
   * resume screen has no such column). It is a plain react-select with no class
   * prefix, portalled to <body>, so it is driven by typing the option label and
   * pressing Enter rather than by hunting its menu. Labels equal the enum values
   * (NONE, CUSTOMER_RELOCATION, NOT_HAPPY, QOS, PRICING).
   */
  async chooseSubscriptionReason(reason: string): Promise<void> {
    // The only editable cell in the row is the reason select (its search textbox).
    const cell = this.subscriptionTable.locator('td', { has: this.page.getByRole('textbox') }).first();
    await cell.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await cell.click();
    await this.page.keyboard.type(reason);
    await this.page.keyboard.press('Enter');
    await expect(cell, `Subscription Reason did not take the value ${reason}.`)
      .toContainText(reason, { timeout: SHORT_WAIT });
  }

  /**
   * Tick one of the order options above the subscription table. They are
   * checkboxes (isPartialFulfillmentAllowed / billOrderCharges / billingOnlyFlag /
   * provisioningOnlyFlag) styled as radios, so the visible label is clicked.
   * Billing Only and Provisioning Only clear each other.
   *
   * The click is NOT proof the flag reached the order - the caller must read
   * core_oms."order".billingonlyflag back after CREATE.
   */
  async tickOrderOption(label: 'Allow Partial Provisioning' | 'Bill For Order' | 'Billing Only' | 'Provisioning Only'): Promise<void> {
    const option = this.page.getByText(label, { exact: true }).first();
    await option.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await option.click();
  }

  /**
   * Press CREATE and wait for the redirect to the new order's detail page.
   * Returns the order id, or '' when no redirect happened - in which case the
   * caller should read `lastToastText()` for the refusal.
   */
  async create(): Promise<string> {
    await expect(this.createButton, 'CREATE is disabled - check the SUSPEND/RESUME order permission.')
      .toBeEnabled({ timeout: MEDIUM_WAIT });
    // Capture the server's own answer: a refusal only flashes a toast that is
    // gone long before a redirect timeout expires.
    const answer = this.page.waitForResponse(
      r => /graphql/i.test(r.url()) && /createOrder|processAccountAndOrder/.test(r.request().postData() ?? ''),
      { timeout: LONG_WAIT },
    ).then(r => r.text()).catch(() => '');
    await this.createButton.click();
    this.lastCreateResponse = await answer;
    try {
      await this.page.waitForURL(/\/orders\/ORD-[0-9]+\/detail/, { timeout: LONG_WAIT });
    } catch {
      return '';
    }
    await this.page.waitForLoadingToDisappear();
    return this.page.url().match(/(ORD-[0-9]+)/)?.[1] ?? '';
  }

  /** Raw GraphQL response to the last CREATE - carries the error when no order was made. */
  lastCreateResponse = '';

  /** Text of any toast on screen - the app reports refusals this way. */
  async lastToastText(): Promise<string> {
    const toasts = this.page.locator('.Toastify__toast');
    const n = await toasts.count();
    return n ? ((await toasts.nth(n - 1).textContent()) ?? '').trim() : '';
  }

  // ── Order detail ─────────────────────────────────────────────────────

  async openOrderDetail(orderId: string): Promise<void> {
    await this.navigate(`/orders/${orderId}/detail`);
    await this.page.getByText(orderId).first().waitFor({ state: 'visible', timeout: LONG_WAIT });
  }

  async submitOrder(): Promise<void> {
    await expect(this.submitOrderButton,
      'Submit order is disabled - it is gated on SUBMIT_ORDER READ_WRITE.').toBeEnabled({ timeout: MEDIUM_WAIT });
    await this.submitOrderButton.click();
    await this.page.waitForLoadingToDisappear();
  }

  /**
   * The order status AS THE SCREEN SHOWS IT, after a reload. The field renders as
   * a disabled <input> or a react-select depending on state, so both are read -
   * the same walk JasecOrderManagementPage.verifyOrderCompletedWithBundle uses.
   */
  async readOrderStatus(orderId: string): Promise<string> {
    return (await this.readOrderFields(orderId, ['Status']))['Status'];
  }

  /**
   * Several header fields of the order detail screen at once (e.g. Type, Status, Reason, User Id),
   * by their on-screen label, after one load. A label the screen does not show reads ''.
   */
  async readOrderFields(orderId: string, labels: string[]): Promise<Record<string, string>> {
    await this.openOrderDetail(orderId);
    return this.page.evaluate((wanted: string[]) => {
      const out: Record<string, string> = {};
      for (const label of wanted) {
        out[label] = '';
        const groups = Array.from(document.querySelectorAll('div')).filter(d => {
          const span = d.querySelector(':scope > span');
          return d.className.includes('form-group') && span !== null
            && (span.textContent || '').trim().toLowerCase() === label.toLowerCase();
        });
        for (const g of groups) {
          const input = g.querySelector('input') as HTMLInputElement | null;
          if (input && input.value) { out[label] = input.value.trim(); break; }
          const sv = g.querySelector('[class*="single-value"]');
          if (sv && sv.textContent) { out[label] = sv.textContent.trim(); break; }
        }
      }
      return out;
    }, labels);
  }
}
