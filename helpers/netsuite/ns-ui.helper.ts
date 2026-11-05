/**
 * NetSuite track — Core UI actions an agent does on coopegsbx2, driven through the screens (UI-first rule,
 * docs\NetSuite\UI-FIRST-PLAN.md). Mapped and proven on 2026-10-24:
 *   - Manual Billing (/customers/<id>/manual-billing): invoice 0279714, same payload as the API path (FA586037)
 *   - Apply Adjustment (/ar-operations/adjustments/apply): line credit CR-105160 (NC988)
 *   - Bulk Adjustments upload: tests\coopeg\netsuite-actions\ns-bulk-adjustment.spec.ts
 * Results are read back by the caller (NsApi reads / Customer Activity), as evidence next to the screen value.
 * Dates on the screens default to the CCP clock: the caller sets the clock first.
 */
import { Page, Locator, Browser, expect, test } from '@playwright/test';
import { NsApi, QA_MAILBOX } from './ns-api.helper';

/**
 * In a beforeAll: opens a logged-in page (the project's storage state) and routes the NsApi user actions
 * (manualInvoice, processAdjustment) through the screens. NS_API_ACTIONS=true keeps the old GraphQL path,
 * for comparing the two paths.
 */
export async function attachUi(api: NsApi, browser: Browser): Promise<NsUi | undefined> {
  if (process.env.NS_API_ACTIONS === 'true') return undefined;
  const use = test.info().project.use;
  const ctx = await browser.newContext({ storageState: use.storageState as string, baseURL: use.baseURL, viewport: { width: 1600, height: 1000 } });
  const ui = new NsUi(await ctx.newPage(), use.baseURL!, api);
  api.ui = ui;
  return ui;
}

/** serviceType empty: left unpicked on the screen (the line then takes its item's service type). */
export interface UiLine { itemId: string; serviceType?: string; quantity: number; unitPrice: number; description?: string }
export interface UiAdjustment {
  accountId: string;
  invoiceId: string;
  type?: 'BILL_ADJUSTMENT' | 'INVOICE_LINE_ADJUSTMENT';
  arType?: 'CREDIT' | 'DEBIT';
  taxRule?: 'WITH_TAX' | 'WITHOUT_TAX' | 'TAX_ONLY';
  /** Reason code (DATA_ERROR, CUSTOMER_SATISFACTION, …: not stamped) or Coope's custom reason (stamped), not both. */
  reason?: string;
  customReason?: string;
  amount?: number;
  percent?: number;
  /** INVOICE_LINE_ADJUSTMENT: the line, by its name on the invoice (Invoice Line Details "Name"), and amount or percent. */
  lines?: { name: string; amount?: number; percent?: number }[];
  notes?: string;
}

/**
 * The row of a list (Bills, Credit/Debit Notes) that shows this id, paging through the list (20 rows a page, not in
 * date order: a new credit note can be on page 2). Returns a locator with count 0 when it is on no page.
 */
export async function rowAcrossPages(page: Page, id: string): Promise<Locator> {
  const row = page.locator('tr', { has: page.getByText(id, { exact: true }) }).first();
  for (let i = 0; i < 20 && !(await row.count()); i++) {
    const next = page.locator('nav.pagination li.next-page:not(.disabled) a[aria-label="Next page"]').first();
    if (!(await next.count())) break;
    await next.click();
    await page.waitForTimeout(2500);
  }
  return row;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class NsUi {
  constructor(private readonly page: Page, private readonly baseURL: string, private readonly api: NsApi) {}

  private async open(path: string) {
    const url = `${this.baseURL.replace(/\/+$/, '')}${path}`;
    // One retry: a single Core UI load sometimes hangs for minutes on coopegsbx2 (I5 timed out twice on 10-25).
    try { await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 }); }
    catch { await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 }); }
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(4000);
  }

  /** Waits for a toast and returns its text ('' if none within ~60 s). */
  async toast(): Promise<string> {
    for (let i = 0; i < 40; i++) {
      const t = (await this.page.locator('.Toastify').allInnerTexts()).join(' | ').replace(/✖︎/g, '').trim();
      if (t) return t;
      await this.page.waitForTimeout(1500);
    }
    return '';
  }

  /** react-select whose hidden input has this name (the form's select for that field). */
  private async choose(field: string, option: string) {
    const box = this.page.locator(`input[type=hidden][name="${field}"]`).locator('xpath=ancestor::div[contains(@class,"form-group")][1]');
    await box.locator('input[id^="react-select-"][id$="-input"]').click({ force: true });
    await this.page.waitForTimeout(600);
    await this.page.locator('[class*="menu"] [class*="option"]').filter({ hasText: new RegExp(`^${esc(option)}$`) }).first().click();
    await this.page.waitForTimeout(400);
  }

  /** Picker modals (Choose Item ID, Choose Account Id, Select Invoice): search, tick the row, Select. */
  private async pickInModal(title: string, rowKey: string, search?: { field: string; value: string }) {
    // A picker closed earlier stays in the page hidden: only the visible one.
    const m = this.page.locator('.modal:visible').filter({ hasText: title }).last();
    await m.waitFor({ timeout: 30_000 });
    if (search) {
      // Filled right after opening, the picker's form resets the box: wait, and check the value stuck.
      const box = m.locator(search.field).first();
      for (let i = 0; i < 5 && (await box.inputValue()) !== search.value; i++) {
        await this.page.waitForTimeout(1500);
        await box.fill(search.value);
      }
      await m.getByRole('button', { name: /search/i }).last().click();
      await m.locator('tbody tr', { has: this.page.getByText(rowKey, { exact: true }) }).first().waitFor({ timeout: 30_000 });
    }
    await this.page.waitForTimeout(1500);
    const row = m.locator('tbody tr', { has: this.page.getByText(rowKey, { exact: true }) }).first();
    await row.locator('.custom-control').first().click();
    await m.getByRole('button', { name: 'Select', exact: true }).click();
    await this.page.waitForTimeout(1500);
  }

  /**
   * Customer > Billing Data > Manual Billing: one row per line (Item Id picker sets the service type), RUN MANUAL BILL.
   * Returns the new invoice id and the toast. Never retried (a slow answer does not mean "not created").
   */
  async manualInvoice(accountId: string, lines: UiLine[]): Promise<{ id: string; toast: string }> {
    const before = new Set((await this.api.invoicesOf(accountId)).map(i => i.id));
    await this.open(`/customers/${accountId}/manual-billing`);
    for (const [i, l] of lines.entries()) {
      await this.page.getByText('+ADD NEW MANUAL TRANSACTION').click();
      await this.page.waitForTimeout(1500);
      const row = this.page.locator('tbody tr', { has: this.page.locator('input[name=unitPrice]') }).nth(i);
      // Pick Service Type from its list first: the item picker shows a service type on the line but it is not sent
      // (seen 10-25: an exempt contract then got full tax). Picked here, the screen gives the API path's result.
      // Since the 10-25 fix a line left without one takes its item's (I_INT → INTERNET, I_TV → IPTV). A name missing
      // from the list is skipped the same way.
      if (l.serviceType) {
        await row.locator('input[name=serviceType]').locator('xpath=..').locator('input[id^="react-select-"][id$="-input"]').click({ force: true });
        await this.page.waitForTimeout(700);
        const opt = this.page.locator('[class*="menu"] [class*="option"]').filter({ hasText: new RegExp(`^${esc(l.serviceType)}$`) }).first();
        if (await opt.count()) await opt.click(); else await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(700);
      }
      await row.locator('input[name=itemId]').click();
      await this.pickInModal('Choose Item ID', l.itemId, { field: 'input[name=id]', value: l.itemId });
      if (l.description) await row.locator('textarea[name=customDescription]').fill(l.description);
      await row.locator('input[name=quantity]').fill(String(l.quantity));
      await row.locator('input[name=unitPrice]').fill(String(l.unitPrice));
      await row.locator('input[name=unitPrice]').press('Tab');
      await this.page.waitForTimeout(500);
    }
    await this.page.getByRole('button', { name: /run manual bill/i }).click();
    const toast = await this.toast();
    expect(toast, 'Manual Billing answer').toMatch(/Manual Invoice successfully/i);
    for (let i = 0; i < 18; i++) {
      const created = (await this.api.invoicesOf(accountId)).find(inv => !before.has(inv.id));
      if (created) return { id: created.id, toast };
      await this.page.waitForTimeout(10_000);
    }
    throw new Error(`Manual Billing on ${accountId}: "${toast}" but no new invoice within 3 min`);
  }

  /** AR Hub > AR Operations > Apply Adjustment. Returns the toast and the adjustment page it lands on. */
  async applyAdjustment(a: UiAdjustment): Promise<{ toast: string; url: string; at: string }> {
    await this.open('/ar-operations/adjustments/apply');
    await this.choose('type', a.type ?? 'BILL_ADJUSTMENT');
    if (a.arType && a.arType !== 'CREDIT') await this.choose('arType', a.arType);
    if (a.taxRule && a.taxRule !== 'WITH_TAX') await this.choose('taxRule', a.taxRule);
    if (a.customReason) await this.choose('customReason', a.customReason);
    if (a.reason) await this.choose('reason', a.reason);
    await this.page.locator('input[name=accountId]').click();
    await this.pickInModal('Choose Account Id', a.accountId, { field: 'input', value: a.accountId });
    await this.page.locator('input[name=invoiceId]').click();
    await this.pickInModal('Select Invoice', a.invoiceId, { field: 'input[name=id]', value: a.invoiceId });
    await this.page.waitForTimeout(2500);
    if (a.lines?.length) {
      const table = this.page.locator('table').filter({ hasText: 'Amount Adjustment' }).last();
      for (const l of a.lines) {
        const tr: Locator = table.locator('tbody tr').filter({ has: this.page.getByText(l.name, { exact: true }) }).first();
        await tr.locator('.custom-control').first().click();
        await this.page.waitForTimeout(500);
        const input = tr.locator(l.percent !== undefined ? 'input[name=percentAdjustment]' : 'input[name=amountAdjustment]');
        await input.fill(String(l.percent ?? l.amount));
        await input.press('Tab');
      }
    } else if (a.percent !== undefined) {
      await this.page.locator('input[name=percent]').fill(String(a.percent));
    } else if (a.amount !== undefined) {
      // The Amount field has no name: the form group labelled "Amount" (enabled once the invoice is chosen). An outer
      // form group wraps the whole form and matches too: only the group without the Percent field.
      const amount = this.page.locator('.form-group', { has: this.page.locator('span.left-label', { hasText: /^Amount\s*$/ }) })
        .filter({ hasNot: this.page.locator('input[name=percent]') }).locator('input').first();
      await amount.fill(String(a.amount));
      await amount.press('Tab');
      expect(await amount.inputValue(), 'Amount on the screen').not.toBe('');
    }
    if (a.notes) await this.page.locator('textarea[name=notes]').fill(a.notes);
    const at = new Date().toISOString();
    await this.page.getByRole('button', { name: /^apply$/i }).click();
    const toast = await this.toast();
    return { toast, url: this.page.url(), at };
  }

  /**
   * processAdjustment input (the GraphQL shape the specs already build) → Apply Adjustment screen. A refusal comes
   * back as the screen's toast and is thrown, like the API error, so the specs' error checks keep working.
   */
  async adjustFromInput(input: Record<string, any>): Promise<{ id: string; toast: string; at: string }> {
    const r = await this.applyAdjustment({
      accountId: input.accountId, invoiceId: input.invoiceId, type: input.type, arType: input.arType, taxRule: input.taxRule,
      reason: input.reason, customReason: input.customReason, amount: input.amount, percent: input.percent, notes: input.notes,
      lines: (input.invoiceLines ?? []).map((l: any) => ({ name: l.name, amount: l.amount, percent: l.percent })),
    });
    if (!/successfully/i.test(r.toast)) throw new Error(`Apply Adjustment: ${r.toast || 'no answer on screen'}`);
    return { id: r.url.match(/adjustments\/([^/]+)\/detail/)?.[1] ?? '', toast: r.toast, at: r.at };
  }

  /**
   * Customer > Bills: select the invoice row, Action, then the action's button (SEND INVOICE / REGENERATE INVOICE).
   * EMAIL_INVOICE always uses Override Mail = the non-deliverable QA mailbox (test accounts carry real CoopeG mailboxes).
   */
  async billAction(accountId: string, invoiceId: string, action: 'EMAIL_INVOICE' | 'REGENERATE_INVOICE' | 'SYNC_INVOICE' | 'UNDO_MANUAL_INVOICE'): Promise<string> {
    await this.open(`/customers/${accountId}/bills`);
    const row = await rowAcrossPages(this.page, invoiceId);
    await row.locator('.custom-control, input[type=radio], td').first().click();
    await this.page.waitForTimeout(800);
    await this.page.getByText('<Select Action>').last().click();
    await this.page.waitForTimeout(800);
    await this.page.locator('[class*="option"]').filter({ hasText: new RegExp(`^${action}$`) }).click();
    await this.page.waitForTimeout(1500);
    if (action === 'EMAIL_INVOICE') {
      await this.page.locator('input[name=emailId]').fill(QA_MAILBOX);
      await this.page.getByRole('button', { name: /^send invoice$/i }).click();
    } else if (action === 'REGENERATE_INVOICE') {
      await this.page.getByRole('button', { name: /^regenerate invoice$/i }).click();
    } else {
      // SYNC_INVOICE is offered only on an invoice in ERROR or never sent (UI-002). UNDO_MANUAL_INVOICE: also on an
      // invoice already in NetSuite (since 31 Oct), voided by a full credit note.
      await this.page.getByRole('button', { name: /^submit$/i }).click();
    }
    const toast = await this.toast();
    // SYNC_INVOICE answers "Invoice queued for NetSuite." (the send then runs in the background).
    if (!/success|queued for NetSuite/i.test(toast)) throw new Error(`${action} on screen: ${toast || 'no answer on screen'}`);
    return toast;
  }

  /** Customer > Account Data > Account Info: Party Id, MODIFY (proven on QA-ANH-NS-002: 57936 → 61425 → 57936). */
  async setPartyId(accountId: string, partyId: string): Promise<string> {
    await this.open(`/customers/${accountId}/info`);
    // MODIFY stays disabled when nothing changed: the same value is already saved.
    if ((await this.page.locator('input[name=partyId]').inputValue()) === partyId) return 'unchanged';
    await this.page.locator('input[name=partyId]').fill(partyId);
    await this.page.waitForTimeout(500);
    await this.page.getByRole('button', { name: /^modify$/i }).click();
    const toast = await this.toast();
    if (!/successfully/i.test(toast)) throw new Error(`Modify Account (Party Id) on screen: ${toast || 'no answer on screen'}`);
    return toast;
  }

  /**
   * Customer > Account Data > Tax Exemptions: sets exemption 1 (adds it, or edits it in place) with the API path's
   * dates (2020-01-01 to 2039-12-31; the environment's clock runs years ahead, so an earlier end would expire the exemption), percent, certificate (emptied when not given) and service types (old ones removed
   * with the sub-table's Remove), then SAVE. The screen has no Remove for a whole exemption (commented out in the
   * source): removing one stays on the API (NsApi.setTaxExemption with null).
   */
  async setTaxExemption(accountId: string, percent: number, opts: { certificate?: string; serviceTypes?: string[] } = {}): Promise<string> {
    const p = this.page;
    await this.open(`/customers/${accountId}/tax-exemptions`);
    const rows = p.locator('form table').first().locator('tbody tr', { has: p.locator('input[name=percent]') });
    if (!(await rows.count())) {
      await p.getByRole('button', { name: '+ADD NEW' }).first().click();
      await p.waitForTimeout(1200);
    }
    const row = rows.first();
    const date = async (name: string, v: string) => {
      const box = row.locator(`input[name=${name}]`);
      await box.fill(v); await box.press('Enter'); await p.waitForTimeout(300);
      await p.keyboard.press('Escape');
      expect(await box.inputValue(), `${name} on the screen`).toBe(v);
    };
    await date('startDate', '2020-01-01');
    await date('endDate', '2039-12-31');
    await row.locator('input[name=percent]').fill(String(percent));
    await row.locator('input[name=percent]').press('Tab');
    await row.locator('input[name=certificateNumber]').fill(opts.certificate ?? '');
    // Service types: open the row's Service Type sub-table, remove what is there, add the wanted ones.
    await row.locator('button.btn-expand-table').first().click();
    await p.waitForTimeout(1200);
    const sub = p.locator('table', { has: p.locator('th', { hasText: /^Remove$/ }) }).last();
    for (let i = 0; i < 10; i++) {
      const live = sub.locator('tbody tr', { has: p.locator('[class*=single-value]') });
      if (!(await live.count())) break;
      await live.first().locator('button.btn-phone').click();
      await p.waitForTimeout(500);
    }
    for (const st of opts.serviceTypes ?? []) {
      await p.getByRole('button', { name: '+ADD NEW' }).last().click();
      await p.waitForTimeout(800);
      const r = sub.locator('tbody tr', { has: p.locator('input[id^="react-select-"]') }).last();
      await r.locator('input[id^="react-select-"][id$="-input"]').click({ force: true });
      await p.waitForTimeout(600);
      await p.locator('[class*="menu"] [class*="option"]').filter({ hasText: new RegExp(`^${esc(st)}$`) }).first().click();
      await p.waitForTimeout(400);
    }
    await p.getByRole('button', { name: /^save$/i }).first().click();
    const toast = await this.toast();
    if (!/success/i.test(toast)) throw new Error(`Tax Exemptions SAVE on ${accountId}: ${toast || 'no answer on screen'}`);
    return toast;
  }

  /** Customer > Bills: the Action options offered for an invoice row. */
  async billActions(accountId: string, invoiceId: string): Promise<string[]> {
    await this.open(`/customers/${accountId}/bills`);
    const row = await rowAcrossPages(this.page, invoiceId);
    await row.locator('.custom-control, input[type=radio], td').first().click();
    await this.page.waitForTimeout(800);
    await this.page.getByText('<Select Action>').last().click();
    await this.page.waitForTimeout(1000);
    const opts = (await this.page.locator('[class*="option"]').allInnerTexts()).map(s => s.trim()).filter(s => s && s !== 'No options');
    await this.page.keyboard.press('Escape');
    return opts;
  }

  /** Customer > Credit/Debit Notes: select the note, Action SYNC_CREDIT_NOTE, SUBMIT (offered only on a note in ERROR). */
  async resendCreditNote(accountId: string, noteId: string): Promise<string> {
    await this.open(`/customers/${accountId}/credit-notes`);
    const row = await rowAcrossPages(this.page, noteId);
    await row.locator('.custom-control, input[type=checkbox]').first().click({ force: true });
    await this.page.waitForTimeout(800);
    await this.page.getByText('<Select Action>').last().click();
    await this.page.waitForTimeout(800);
    await this.page.locator('[class*="option"]').filter({ hasText: /^SYNC_CREDIT_NOTE$/ }).click();
    await this.page.waitForTimeout(1500);
    await this.page.getByRole('button', { name: /^submit$/i }).click();
    const toast = await this.toast();
    if (!/success|queued/i.test(toast)) throw new Error(`SYNC_CREDIT_NOTE ${noteId} on screen: ${toast || 'no answer on screen'}`);
    return toast;
  }

  /** Customer > Credit/Debit Notes: the Action options offered for a note row. */
  async creditNoteActions(accountId: string, noteId: string): Promise<string[]> {
    await this.open(`/customers/${accountId}/credit-notes`);
    const row = await rowAcrossPages(this.page, noteId);
    await row.locator('.custom-control, input[type=checkbox]').first().click({ force: true });
    await this.page.waitForTimeout(800);
    await this.page.getByText('<Select Action>').last().click();
    await this.page.waitForTimeout(1000);
    const opts = (await this.page.locator('[class*="option"]').allInnerTexts()).map(s => s.trim()).filter(s => s && s !== 'No options');
    await this.page.keyboard.press('Escape');
    return opts;
  }
}
