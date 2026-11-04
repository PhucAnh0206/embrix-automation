/**
 * NetSuite business demo (coopegsbx2): the main happy flows, in a visible browser, with a caption bar at the top of the
 * screen that says what is happening. Run by ns-demo.ps1 (menu); guide for the audience: docs\NetSuite\DEMO.md.
 *   Demo 1  An invoice goes to NetSuite      Manual Billing > invoice > Bills shows NetSuite status + number > NetSuite sandbox
 *   Demo 2  An agent extends a due date       Bills > EXTEND_DUE_DATE > the new date on the invoice
 *   Demo 3  A payment comes from NetSuite     NetSuite's payment call > Bills shows the invoice paid
 *   Demo 4  Voiding an invoice in NetSuite    Bills > UNDO_MANUAL_INVOICE > full credit note > Credit Notes + NetSuite sandbox
 *   Demo 5  The monthly billing run           a contract's waiting month > Daily Schedule (Create, Process) > the month's invoice
 *                                             on Bills, sent to NetSuite > NetSuite sandbox
 *   Demo 6  A new contract from CoopeWeb      CoopeWeb's request > Account Info (NetSuite customer number) > the order (CoopeWeb's
 *                                             number, waiting for connection) > Services (nothing active or billed yet)
 * Demos 2 and 3 use the invoice of demo 1 while it is open (kept in .ns-demo-state.json); otherwise they make a fresh one first. 4 makes its own.
 * Demos 1-4 write only on the team test account (NS_DEMO_ACCOUNT, default 208886) and never move the clock. Demo 5 bills Coope's
 * test contract 798166 (NS_DEMO_BILL_ACCOUNT; registered in NetSuite) on its next billing day: it moves the clock to that day
 * and back, removes that day's old Daily Schedule (clean-schedules.js, backup kept; needs the VPN) and the schedule bills every
 * account due that day. Demo 6 creates one QA contract (billing-only, not connected). NetSuite sandbox view only.
 *   NS_DEMO=1..6|all   NS_DEMO_HOLD=<ms a caption stays, default 5000>
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Page, Browser, Locator } from '@playwright/test';
import { test, expect } from '../../../fixtures/page-factory';
import { contractBody, TD } from '../../../helpers/netsuite/ns-data';
import { SUITE_DIR } from '../../../helpers/netsuite/ns-record';
import { NsApi } from '../../../helpers/netsuite/ns-api.helper';
import { attachUi, rowAcrossPages } from '../../../helpers/netsuite/ns-ui.helper';
import { NsSandbox } from '../../../helpers/netsuite/ns-sandbox.helper';

const ACC = process.env.NS_DEMO_ACCOUNT ?? '208886';
const BILL_ACC = process.env.NS_DEMO_BILL_ACCOUNT ?? '798166';
const HOLD = Number(process.env.NS_DEMO_HOLD ?? 5000);
const WHICH = (process.env.NS_DEMO ?? 'all').split(',');
const STATE = '.ns-demo-state.json';
const money = (n: unknown) => Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const runs = (n: string) => WHICH.includes('all') || WHICH.includes(n);
const load = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const keep = (k: string, v: string) => { fs.writeFileSync(STATE, JSON.stringify({ ...load(), [k]: v }, null, 2)); };

/** Caption bar on top of every page of this browser context (kept across navigations). */
async function captions(page: Page) {
  await page.context().addInitScript(() => {
    const show = () => {
      const t = sessionStorage.getItem('demoCaption'); if (!t || !document.body) return;
      let b = document.getElementById('__demo');
      if (!b) {
        b = document.createElement('div'); b.id = '__demo';
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0a6e4f;color:#fff;font:600 22px/1.45 Segoe UI,Arial,sans-serif;padding:12px 20px;box-shadow:0 3px 10px rgba(0,0,0,.35);pointer-events:none;white-space:pre-line';
        document.body.appendChild(b);
      }
      b.textContent = t;
    };
    document.addEventListener('DOMContentLoaded', show); setInterval(show, 700);
  });
}
async function say(page: Page, text: string, hold = HOLD) {
  console.log(`  » ${text.replace(/\n/g, ' / ')}`);
  await page.evaluate(t => {
    sessionStorage.setItem('demoCaption', t);
    let b = document.getElementById('__demo');
    if (!b) {
      b = document.createElement('div'); b.id = '__demo';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0a6e4f;color:#fff;font:600 22px/1.45 Segoe UI,Arial,sans-serif;padding:12px 20px;box-shadow:0 3px 10px rgba(0,0,0,.35);pointer-events:none;white-space:pre-line';
      document.body.appendChild(b);
    }
    b.textContent = t;
  }, text).catch(() => {});
  await page.waitForTimeout(hold);
}
/** Puts the invoice's row in view and outlines it. */
async function point(page: Page, id: string) {
  const row = await rowAcrossPages(page, id);
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.evaluate((tr: HTMLElement) => { tr.style.outline = '4px solid #f5a623'; tr.style.background = '#fff6e0'; }).catch(() => {});
  return row;
}
async function bills(page: Page, base: string, account = ACC) {
  await page.goto(`${base}/customers/${account}/bills`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
}
async function screen(page: Page, base: string, p: string) {
  await page.goto(`${base}${p}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
}
/** Outlines an element so the audience sees where to look. */
async function mark(el: Locator) {
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.evaluate((e: HTMLElement) => { e.style.outline = '4px solid #f5a623'; e.style.background = '#fff6e0'; }).catch(() => {});
}
async function action(page: Page, id: string, name: string) {
  const row = await point(page, id);
  await row.locator('.custom-control, input[type=radio], td').first().click();
  await page.waitForTimeout(800);
  await page.getByText('<Select Action>').last().click();
  await page.waitForTimeout(800);
  await page.locator('[class*="option"]').filter({ hasText: new RegExp(`^${name}$`) }).first().click();
  await page.waitForTimeout(1200);
}
async function toast(page: Page): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const t = (await page.locator('.Toastify').allInnerTexts()).join(' ').replace(/[✖︎︎]/g, '').replace(/\s+/g, ' ').trim();
    if (t) return t;
    await page.waitForTimeout(1000);
  }
  return '';
}
/** Waits until NetSuite has answered for the invoice (SUCCESS with its number, or ERROR with the reason). */
async function netsuite(api: NsApi, id: string) {
  // The invoice query has NetSuite's number (financeVersion); the status and reason come from the Invoicing report.
  let inv: any = {};
  for (let i = 0; i < 60; i++) {
    inv = await api.invoice(id);
    const r = await api.invoiceReport(id, inv.invoiceDate);
    inv = { ...inv, financeSyncStatus: r?.financeSyncStatus, financeErrorMessage: r?.financeErrorMessage };
    // On SUCCESS, NetSuite's number lands on the invoice a moment after the status.
    if ((inv.financeSyncStatus === 'SUCCESS' && inv.financeVersion) || inv.financeSyncStatus === 'ERROR') return inv;
    await new Promise(res => setTimeout(res, 10_000));
  }
  return inv;
}
async function newInvoice(api: NsApi, browser: Browser, label: string): Promise<{ id: string; page: Page; base: string }> {
  const ui: any = await attachUi(api, browser);
  const page: Page = ui.page;
  const base: string = test.info().project.use.baseURL!.replace(/\/+$/, '');
  await captions(page);
  await page.goto(`${base}/customers/${ACC}/manual-billing`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await say(page, `${label}\nAn agent opens the customer's Manual Billing screen and bills Internet: 10,000.00 + IVA + 911 and Cruz Roja levies.`);
  const r = await ui.manualInvoice(ACC, [{ serviceType: 'INTERNET', itemId: 'I_INT', quantity: 1, unitPrice: 10000, description: 'Demo NetSuite' }]);
  await say(page, `Invoice ${r.id} is created. Hacienda stamps it, then Embrix sends it to NetSuite on its own.`);
  return { id: r.id, page, base };
}
async function showInNetSuite(browser: Browser, number: string, text: string) {
  const sb = await NsSandbox.open(browser);
  const r = await sb.search(number);
  await say(sb.page, `NetSuite (Coope's ERP, test sandbox): searching ${number}.\nFound ${r.total} record.`);
  if (r.rows[0]?.url) { await sb.read(r.rows[0].url); await say(sb.page, text, HOLD * 2); }
  await sb.close();
}

test.describe.serial('NetSuite business demo', () => {
  test.setTimeout(20 * 60_000);
  let api: NsApi;
  test.beforeAll(async ({ playwright }) => { api = new NsApi(await playwright.request.newContext()); });

  /** Demos 2 and 3 work on demo 1's invoice while it is still open; otherwise (none yet, or already paid by demo 3)
   * they first make a fresh one behind the scenes, so each demo can be run on its own, in any order. */
  async function openInvoice(): Promise<string> {
    const saved = load().invoice;
    if (saved) {
      const inv = await api.invoice(saved).catch(() => undefined);
      if (inv && inv.status !== 'CLOSED' && Number(inv.due) > 0) return saved;
    }
    (api as any).ui = undefined;   // through the API, not on screen: this step is not part of the demo
    const fresh = await api.manualInvoice(ACC, [{ itemId: 'I_INT', serviceType: 'INTERNET', quantity: 1, unitPrice: 10000, description: 'Demo NetSuite' }]);
    await netsuite(api, fresh);
    keep('invoice', fresh);
    return fresh;
  }

  test('Demo 1: an invoice goes to NetSuite', async ({ browser }) => {
    test.skip(!runs('1'), 'not selected');
    const { id, page, base } = await newInvoice(api, browser, 'DEMO 1 · An invoice goes to NetSuite');
    keep('invoice', id);
    const inv = await netsuite(api, id);
    await bills(page, base);
    await point(page, id);
    await say(page, inv.financeSyncStatus === 'SUCCESS'
      ? `On Bills, invoice ${id} shows Finance Sync Status SUCCESS and NetSuite's number ${inv.financeVersion} (scroll right: Finance Version).\nEvery stamped invoice reaches NetSuite once.`
      : `On Bills, invoice ${id} shows NetSuite status ${inv.financeSyncStatus}: ${inv.financeErrorMessage ?? ''}`, HOLD * 2);
    await page.context().close();
    expect(inv.financeSyncStatus, `NetSuite answer for ${id}`).toBe('SUCCESS');
    keep('number', inv.financeVersion);
    await showInNetSuite(browser, inv.financeVersion, `The same invoice in NetSuite: ${inv.financeVersion}, same customer and same total (11,475.00) as in Embrix.`);
  });

  test('Demo 2: an agent extends a due date', async ({ browser }) => {
    test.skip(!runs('2'), 'not selected');
    const id = await openInvoice();
    const before = await api.invoice(id);
    const d = new Date(`${before.dueDate}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 15);
    const date = d.toISOString().slice(0, 10);
    const ui: any = await attachUi(api, browser);
    const page: Page = ui.page; const base = test.info().project.use.baseURL!.replace(/\/+$/, '');
    await captions(page);
    await bills(page, base);
    await point(page, id);
    await say(page, `DEMO 2 · An agent extends a due date\nInvoice ${id} is due on ${before.dueDate}. The customer asks for 15 more days.`);
    await action(page, id, 'EXTEND_DUE_DATE');
    const box = page.locator('input[name="dueDate"]:visible').first();
    await box.fill(date); await box.press('Tab');
    await page.locator('[name="noteItem"]:visible').first().fill('Demo: 15 more days agreed with the customer');
    await say(page, `Action EXTEND_DUE_DATE: new due date ${date} and a note, then SUBMIT.`);
    await page.getByRole('button', { name: /^submit$/i }).first().click();
    const t = await toast(page);
    await bills(page, base);
    await point(page, id);
    const after = await api.invoice(id);
    await say(page, `Screen: "${t}". Invoice ${id} is now due on ${after.dueDate} (Due Date column).`, HOLD * 2);
    await page.context().close();
    expect(after.dueDate).toBe(date);
  });

  test('Demo 3: a payment comes from NetSuite', async ({ browser }) => {
    test.skip(!runs('3'), 'not selected');
    const id = await openInvoice();
    const ui: any = await attachUi(api, browser);
    const page: Page = ui.page; const base = test.info().project.use.baseURL!.replace(/\/+$/, '');
    await captions(page);
    await bills(page, base);
    await point(page, id);
    const before = await api.invoice(id);
    await say(page, `DEMO 3 · A payment comes from NetSuite\nInvoice ${id}: ${money(before.due)} due. The customer pays; Coope records it in NetSuite, and NetSuite sends the payment to Embrix.`);
    const r = await api.crm('applyPayment', { paymentDate: '', paymentSource: 'BCR', allocationData: [{ accountId: ACC, invoiceId: id, currency: 'CRC', amount: before.due }] });
    await page.waitForTimeout(15_000);
    await bills(page, base);
    await point(page, id);
    const after = await api.invoice(id);
    await say(page, `Payment received from NetSuite (${r.json?.status ?? r.status}). Invoice ${id} is now ${after.status}, due ${money(after.due)}.\nPayments are applied with Embrix's usual rules; nothing is sent back to NetSuite.`, HOLD * 2);
    await page.context().close();
    expect(after.status).toBe('CLOSED');
  });

  test('Demo 4: voiding an invoice already in NetSuite', async ({ browser }) => {
    test.skip(!runs('4'), 'not selected');
    const { id, page, base } = await newInvoice(api, browser, 'DEMO 4 · Voiding an invoice that is already in NetSuite');
    const inv = await netsuite(api, id);
    expect(inv.financeSyncStatus, `NetSuite answer for ${id}`).toBe('SUCCESS');
    await bills(page, base);
    await point(page, id);
    await say(page, `Invoice ${id} is in NetSuite as ${inv.financeVersion}. A stamped invoice can never be deleted: it is voided with a credit note for its full amount.`);
    await action(page, id, 'UNDO_MANUAL_INVOICE');
    await say(page, 'Action UNDO_MANUAL_INVOICE, then SUBMIT.');
    await page.getByRole('button', { name: /^submit$/i }).first().click();
    const t = await toast(page);
    // The credit note is stamped, then sent to NetSuite: wait for NetSuite's number (up to ~5 minutes).
    let note: any;
    for (let i = 0; i < 30; i++) {
      note = (await api.gql(`{ searchNotesUnits(page:1,size:100,filter:{accountId:"${ACC}",startDate:"2000-01-01",endDate:"2099-12-31"}) { id invoiceId total reasonDescription financeSyncStatus financeVersion } }`))
        .searchNotesUnits?.find((n: any) => n.invoiceId === id);
      if (note?.financeVersion || note?.financeSyncStatus === 'ERROR') break;
      await page.waitForTimeout(10_000);
    }
    await page.goto(`${base}/customers/${ACC}/credit-notes`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    if (note) await point(page, note.id);
    await say(page, `Screen: "${t}". Credit note ${note?.id} for the full amount (${money(note?.total)}), reason "${note?.reasonDescription}", stamped by Hacienda and sent to NetSuite as ${note?.financeVersion ?? '…'}. The invoice is closed: the bill is 0.`, HOLD * 2);
    await page.context().close();
    expect(note, `credit note for ${id}`).toBeTruthy();
    if (note?.financeVersion) await showInNetSuite(browser, note.financeVersion, `The credit memo in NetSuite (${note.financeVersion}), applied to invoice ${inv.financeVersion}: the invoice is paid in full there too.`);
  });

  test('Demo 5: the monthly billing run', async ({ page, dailySchedulePage, testLogger, browser }) => {
    test.skip(!runs('5'), 'not selected');
    test.setTimeout(45 * 60_000);
    const base = test.info().project.use.baseURL!.replace(/\/+$/, '');
    // The contract's next month waiting to be billed. Plans bill after the month: the billing day is the end of that month.
    const units = (await api.gql(`{ searchBillUnits(page:1,size:100,filter:{accountId:"${BILL_ACC}"}) { id status startDate endDate } }`)).searchBillUnits ?? [];
    const due = units.filter((u: any) => u.status === 'PENDING').sort((a: any, b: any) => String(a.endDate).localeCompare(String(b.endDate)))[0];
    expect(due, `contract ${BILL_ACC} has a month waiting to be billed`).toBeTruthy();
    const from = String(due.startDate).slice(0, 10), day = String(due.endDate).slice(0, 10);
    const original = await api.ccpDate();
    const setClock = async (d: string) => { await api.gql(`mutation { setCcpTime(input:{ccpTime:"${d}"}) { ccpTime } }`); };
    await captions(page);
    let inv: any, ns: any = {};
    try {
      await bills(page, base, BILL_ACC);
      await say(page, `DEMO 5 · The monthly billing run\nContract ${BILL_ACC} (a Coope test contract, registered in NetSuite) has the month ${from} to ${day} waiting to be billed: see Pending Bills at the top. Plans are billed after the month, so its billing day is ${day}.`, HOLD * 2);
      // Behind the scenes: an old schedule of that day is removed (backup kept) and the environment's date becomes the billing day.
      try { execFileSync(process.execPath, [path.join(SUITE_DIR, 'tools', 'clean-schedules.js'), day, day, '--go'], { stdio: 'pipe' }); }
      catch (e) { throw new Error(`Could not clear the old schedule of ${day} (is the VPN on?): ${String((e as any).stderr ?? e).slice(0, 300)}`); }
      await setClock(day);
      await say(page, `Every billing day Embrix runs the Daily Schedule: billing, invoices, Hacienda stamping, collections.\nThe operator opens Operations Hub > Jobs Management > Daily, picks ${day}, then Create Job Schedule and Process.`);
      const cards = await dailySchedulePage.createAndProcess(day, () => setClock(day), testLogger);
      // Job by job in PowerShell only: one check step (INVOICE_CHECK) often ends in ERROR on this environment (Bug_035)
      // without affecting the invoices; the audience sees the outcome that matters, the month's invoice.
      console.log(`  jobs of ${day}: ${Object.entries(cards).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      await say(page, `The Daily Schedule of ${day} has run its billing jobs. Now the contract's Bills.`, HOLD * 1.5);
      for (let i = 0; i < 30 && !inv; i++) {
        inv = (await api.invoicesOf(BILL_ACC)).find((x: any) => String(x.invoiceDate).slice(0, 10) === day);
        if (!inv) await page.waitForTimeout(10_000);
      }
      expect(inv, `invoice of ${BILL_ACC} dated ${day}`).toBeTruthy();
      ns = await netsuite(api, inv.id);
      await bills(page, base, BILL_ACC);
      await point(page, inv.id);
      await say(page, `The month is billed: invoice ${inv.id} for ${money(inv.total)}, dated ${day}. Hacienda stamped it and Embrix sent it to NetSuite on its own: Finance Sync Status ${ns.financeSyncStatus}, NetSuite number ${ns.financeVersion ?? ns.financeErrorMessage ?? '...'}.`, HOLD * 2);
    } finally {
      await setClock(original);
    }
    await page.context().close().catch(() => {});
    expect(ns.financeSyncStatus, `NetSuite answer for ${inv?.id}`).toBe('SUCCESS');
    await showInNetSuite(browser, ns.financeVersion, `The monthly invoice in NetSuite: ${ns.financeVersion}, same customer and total (${money(inv.total)}) as in Embrix.`);
  });

  test('Demo 6: a new contract arrives from CoopeWeb', async ({ page }) => {
    test.skip(!runs('6'), 'not selected');
    const base = test.info().project.use.baseURL!.replace(/\/+$/, '');
    const party = TD.DEFAULT.party;
    const body = contractBody({ tag: 'DEMO', partyId: party });
    const acc = String(body.accountId), order = String(body.orderId);
    await captions(page);
    await screen(page, base, '/dashboard/me');
    await say(page, `DEMO 6 · A new contract arrives from CoopeWeb\nCoopeWeb sells an Internet contract (300 Mbps) and sends it to Embrix: the customer, the NetSuite customer number ${party}, the plan, and CoopeWeb's own order number.`, HOLD * 1.5);
    const r = await api.crm('processAccountAndOrder', body);
    await say(page, `Embrix answers CoopeWeb: ${r.json?.status ?? r.status}. Contract ${acc} and order ${order} are created.`);

    await screen(page, base, `/customers/${acc}/info`);
    const partyBox = page.locator('input[name=partyId]').first();
    await mark(partyBox);
    const shownParty = await partyBox.inputValue().catch(() => '');
    await say(page, `Account Info of the new contract: Party Id ${shownParty} is the NetSuite customer number. Every invoice of this contract goes to that NetSuite customer.`, HOLD * 1.5);

    const o = (await api.gql(`{ getOrderById(input:{id:"${order}"}) { id type status } }`)).getOrderById;
    await screen(page, base, `/orders/${encodeURIComponent(order)}/detail`);
    await say(page, `The order keeps CoopeWeb's number ${o?.id}: a ${o?.type} order, status ${o?.status}. It waits for the technician to connect the service.`, HOLD * 1.5);

    const sub = (await api.gql(`{ getSubscriptionByAccountId(input:{id:"${acc}"}) { id status } }`).catch(() => ({} as any)))?.getSubscriptionByAccountId;
    await screen(page, base, `/customers/${acc}/services`);
    await say(page, `Services: nothing is active yet, so nothing is billed. Billing starts on the day the service is connected.`, HOLD * 1.5);

    expect(r.json?.status, 'CoopeWeb request accepted').toBe('SUCCESS');
    expect(shownParty, 'NetSuite customer number on the account').toBe(party);
    expect(o?.id, "order created with CoopeWeb's number").toBe(order);
    expect(o?.status, 'order waiting for connection').not.toBe('COMPLETED');
    expect(sub?.status === 'ACTIVE', 'no active subscription before connection').toBe(false);
  });

});
