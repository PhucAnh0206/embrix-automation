/**
 * JEPYP-316 customer contacts: build accounts with given contacts, top them up, and read who the receipt and the
 * top-up email name. Shared by ts-03-main-contact (TC-03) and customer-form/explore-316-07 (strict retest).
 *
 * Accounts are ours: customerId `QA316-<tag>-<run>`, email = the QA mailbox. Orders carry M-QA meters only.
 */
import * as path from 'path';
import type { Page } from '@playwright/test';
import { PrepaidSeedHelper } from './prepaid-seed.helper';
import type { DbHelper } from './db.helper';
import { uniqueRunSuffix, assertQaMeter, attachToAccountInSelfCare } from '../fixtures/create-prepaid-account.helper';
import { fetchAndExtractPdfText } from './pdf.helper';

/** The QA mailbox test customers get: QA_EMAIL, else NOTIFY_EMAIL_TO, from the local .env files (kept out of git). */
export const QA_EMAIL = process.env.QA_EMAIL || process.env.NOTIFY_EMAIL_TO || 'qa.mailbox@example.com';

export type Contact = { firstName: string; lastName: string; middleName: string; phone?: string };
export const JOHNY: Contact = { firstName: 'Johny Gerardo', lastName: 'Rojas', middleName: 'Vargas' };
export const MARIA: Contact = { firstName: 'María', lastName: 'Rojas', middleName: 'Vargas' };
export const JORGE: Contact = { firstName: 'Jorge', lastName: 'Mora', middleName: 'Solano' };
export const PEDRO: Contact = { firstName: 'Pedro', lastName: 'Solís', middleName: 'Brenes' };

/** "Nombre Primer Apellido Segundo Apellido" - the business format (2026-10-13) for the receipt and the email. */
export const fullName = (c: Contact) => `${c.firstName} ${c.lastName} ${c.middleName}`;
/** The full name, any whitespace between the words. */
export const fullNameRe = (c: Contact) =>
  new RegExp(fullName(c).split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function graphqlUrl(): string {
  const url = process.env.EMBRIX_GRAPHQL_URL ?? process.env.GRAPH_URLS ?? '';
  if (!url) throw new Error('customer-contact.helper: set EMBRIX_GRAPHQL_URL (or GRAPH_URLS).');
  return url;
}
async function gql(query: string, token?: string): Promise<any> {
  const res = await fetch(graphqlUrl(), { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query }) });
  return res.json();
}
let token = '';
export async function graphqlLogin(): Promise<string> {
  if (!token) token = (await gql(`{ userLogin(input: {userName: ${JSON.stringify(process.env.EMBRIX_USER)}, password: ${JSON.stringify(process.env.EMBRIX_PASSWORD)}}) { token } }`))?.data?.userLogin?.token ?? '';
  return token;
}

/**
 * An account with these contacts, in this order, and no contact ids - what the Create Account form sends since
 * the contact id is hidden. Full Cartago address. Returns the account id.
 */
export async function createAccountWithContacts(customerId: string, contacts: Contact[]): Promise<string> {
  const c = contacts.map(x => `{roles:[BILLING], firstName:${JSON.stringify(x.firstName)}, lastName:${JSON.stringify(x.lastName)}, middleName:${JSON.stringify(x.middleName)}, identityDocument:"CÉDULA DE IDENTIDAD", email:"${QA_EMAIL}"${x.phone ? `, phones:[{type: MOBILE, number:${JSON.stringify(x.phone)}}]` : ''}}`).join(',');
  const r = await gql(`mutation { createAccount(input:{
    currency:"CRC", type: RESIDENTIAL, accountCategory: PREPAID, customerSegment: B2C, salesChannel: NONE, marketSegment: NONE, subType: NONE,
    name:${JSON.stringify(customerId.replace(/-/g, ' '))}, customerId:${JSON.stringify(customerId)}, contacts:[${c}],
    addresses:[{roles:[BILLING], street:"Avenida 2 Occidental", city:"Cartago", state:"Cartago", district:"Oriental", country:"CRI", postalCode:"30101"}],
    billingProfiles:[{billingDom:1, billingFrequency: MONTHLY, invoiceType: SUMMARY, invoiceDelivery: EMAIL, paymentProfileId:"PRIMARY"}],
    paymentProfiles:[{paymentMethod: CHECK, paymentTerm:"NET_30"}] }){ id } }`, await graphqlLogin());
  const id = r?.data?.createAccount?.id;
  if (!id) throw new Error(`createAccount ${customerId} failed: ${JSON.stringify(r?.errors ?? r).slice(0, 300)}`);
  return id;
}

export async function contactsOf(db: DbHelper, accountId: string) {
  return db.query<{ id: string; firstname: string; lastname: string; middlename: string | null }>(
    `SELECT id, firstname, lastname, middlename FROM core_engine.contact WHERE accountid = $1 ORDER BY id`, [accountId]);
}

/** Order + QA meter, wait for ACTIVE, top up 5,000, return the meter and the BALANCE_TOPUP mail's greeting. */
export async function orderTopUpAndMail(db: DbHelper, accountId: string, tag: string) {
  const seed = new PrepaidSeedHelper();
  const meter = assertQaMeter(`M-QA${tag.replace(/[^A-Z]/gi, '').toUpperCase()}-${uniqueRunSuffix()}`);
  const orderId = await seed.orderExisting(accountId, meter);
  for (let i = 0; i < 40; i++) {
    const s = await db.query<{ status: string }>(`SELECT status FROM core_engine.subscription WHERE accountid = $1`, [accountId]);
    if (s.some(x => x.status === 'ACTIVE')) break;
    await wait(3_000);
  }
  const water = Number((await db.query<{ n: string }>(
    `SELECT COALESCE(max((regexp_replace(id,'\\D','','g'))::bigint),0)::text n FROM core_engine.email_notification`))[0].n);
  const before = await db.getTopUpCount(accountId);
  await seed.topUp(accountId, 5000);
  for (let i = 0; i < 20 && (await db.getTopUpCount(accountId)) === before; i++) await wait(3_000);
  let note: { status: string; content: string } | undefined;
  for (let i = 0; i < 30 && !note; i++) {
    note = (await db.query<{ status: string; content: string }>(
      `SELECT status, COALESCE(content,'') content FROM core_engine.email_notification
        WHERE accountid = $1 AND type = 'BALANCE_TOPUP' AND (regexp_replace(id,'\\D','','g'))::bigint > $2 ORDER BY id DESC LIMIT 1`,
      [accountId, water]))[0];
    if (!note) await wait(3_000);
  }
  const greeting = note
    ? (note.content.replace(/<[^>]+>/g, ' ').match(/Estimad[oa]\(?a?\)?[^.,<]{0,80}/i) ?? [''])[0].replace(/\s+/g, ' ').trim()
    : '';
  return { meter, orderId, mailStatus: note?.status ?? '<no BALANCE_TOPUP mail>', greeting };
}

export type SelfcareFixtures = {
  selfcareLoginPage: any; selfcareAccountSearchPage: any; selfcareActivityPage: any; selfcareTopupPage: any;
};

/** Self-care (agent view): the newest top-up receipt's customer name and "Medidor". */
export async function readNewestReceipt(page: Page, fx: SelfcareFixtures, accountId: string, shotDir?: string) {
  await attachToAccountInSelfCare({ selfcareLoginPage: fx.selfcareLoginPage, selfcareAccountSearchPage: fx.selfcareAccountSearchPage }, accountId);
  await fx.selfcareActivityPage.navigateToTopUp();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
  if (shotDir) await page.screenshot({ path: path.join(shotDir, `${accountId}-selfcare-topup.png`), fullPage: true });
  const text = await fetchAndExtractPdfText(await fx.selfcareTopupPage.clickReceiptButtonForRow(0));
  return {
    name: (text.match(/Nombre\s+del\s+Cliente[\s.:]*([^\n]{0,80})/i) ?? ['', ''])[1].trim(),
    medidor: (text.match(/Medidor[\s.:]*(\S+)/i) ?? ['', ''])[1].trim(),
  };
}

// ── Contact tab, JEPYP-316 round 2 (2026-10-14): one "Primary contact" / "Contacto principal" card, listed first, its
// Delete disabled; every other card has "Make primary contact" / "Marcar como contacto principal". ──

export async function openContactTab(page: Page & { navigateToHome(): Promise<void> }, accountId: string): Promise<void> {
  await page.navigateToHome();   // back on Core UI if a Self-care step ran before
  await page.goto(`/customers/${accountId}/info`);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { });
  await page.getByText(/^\s*(Contact|Contacto)\s*$/).first().click();
  await page.locator('input[name="firstName"]').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1_000);
}

/** Tag each contact card with data-qa-card=<first name> and return what each shows, in screen order. */
export async function readContactCards(page: Page) {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[name="firstName"]')) as HTMLInputElement[];
    return inputs.map(fn => {
      let el: HTMLElement | null = fn;
      while (el && el.parentElement && el.parentElement.querySelectorAll('input[name="firstName"]').length === 1) el = el.parentElement;
      const card = el as HTMLElement;
      card.setAttribute('data-qa-card', fn.value);
      // The tag text only: drop button labels ("Make primary contact" also says "primary contact").
      const clone = card.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('button').forEach(b => b.remove());
      const text = (clone.textContent ?? '').replace(/\s+/g, ' ');
      const btn = (re: RegExp) => Array.from(card.querySelectorAll('button')).find(b => re.test((b.textContent ?? '').trim())) as HTMLButtonElement | undefined;
      const del = btn(/^(delete|eliminar)$/i);
      return {
        firstName: fn.value,
        primaryTag: /primary contact|contacto principal/i.test(text),
        deleteEnabled: !!del && !del.disabled,
        canMakePrimary: !!btn(/make primary contact|marcar como contacto principal/i),
      };
    });
  });
}

const card = (page: Page, firstName: string) => page.locator(`[data-qa-card="${firstName}"]`);

/** "Make primary contact" on this contact's card (not saved until Modify). */
export async function makePrimary(page: Page, firstName: string): Promise<void> {
  await readContactCards(page);
  await card(page, firstName).getByRole('button', { name: /make primary contact|marcar como contacto principal/i }).click();
  await page.waitForTimeout(800);
}

/** Delete on this contact's card + "Are you sure...?" Yes (not saved until Modify). */
export async function deleteContactCard(page: Page, firstName: string): Promise<void> {
  await readContactCards(page);
  await card(page, firstName).getByRole('button', { name: /^\s*(delete|eliminar)\s*$/i }).click();
  await page.getByRole('button', { name: /^\s*(yes|sí|si)\s*$/i }).first().click({ timeout: 10_000 }).catch(() => { });
  await page.waitForTimeout(800);
}

/** Modify; `twice` = two quick clicks (the save must apply once). Returns the toast. */
export async function saveContacts(page: Page, opts: { twice?: boolean } = {}): Promise<string> {
  const modify = page.getByRole('button', { name: /^\s*(modify|modificar)\s*$/i }).first();
  if (opts.twice) { await modify.dblclick().catch(() => modify.click()); } else { await modify.click(); }
  const t = page.locator('.Toastify__toast, [class*="toast"]').first();
  await t.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => { });
  const toast = ((await t.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  await page.waitForTimeout(2_000);
  return toast;
}
