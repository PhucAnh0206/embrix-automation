/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX). JEPYP-316 finding F7, through the SCREEN.
 *
 * The clerk path that leaves an account without a PRIMARY contact (Anh, manual, dev ACT-101403):
 *   account with PRIMARY María (Billing) -> Contact tab -> ADD NEW CONTACT, tick Use As Billing -> DELETE María ->
 *   MODIFY. It saves, and no contact is PRIMARY any more.
 * This spec creates a fresh account of ours over GraphQL (customerId QA316-DEL-*), does exactly those clicks, records
 * the toast and screenshots, and reads the contacts back. Downstream (receipt with no name) is explore-316-03 - run it
 * with JEPYP316_NOPRI_ACCOUNT=<the account printed here>.
 * Control step first: deleting the ONLY billing contact must be refused (no Modify succeeds).
 *
 * MUTATING (own data only). No clock move, no billing. dev / preprod.
 *   npx playwright test --project=jasec-customer-form-explore --grep "@316-delete-primary"
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/page-factory';
import type { Page } from '@playwright/test';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const ENV = process.env.TEST_ENV ?? '';
const ALLOWED = ['jasec-dev', 'jasec-preprod'].includes(ENV);
const URL = process.env.EMBRIX_GRAPHQL_URL ?? process.env.GRAPH_URLS ?? '';
const EVIDENCE = process.env.JEPYP316_EVIDENCE_DIR ?? path.resolve(__dirname,
  `../../../../../../Regression testing/EPDP-348_JASEC-Test/EXPLORE_JEPYP-316_customer-form/evidence/${ENV.replace('jasec-', '')}`);

async function gql(query: string, token?: string): Promise<any> {
  const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query }) });
  return res.json();
}

/** Index of the contact block whose first name is `name` (blocks are in DOM order, one firstName input each). */
async function blockIndex(page: Page, name: string): Promise<number> {
  const vals = await page.locator('input[name="firstName"]').evaluateAll(els => els.map(e => (e as HTMLInputElement).value));
  return vals.indexOf(name);
}

const deleteButtons = (page: Page) => page.getByRole('button', { name: /^\s*(delete|eliminar)\s*$/i });
const modifyButton = (page: Page) => page.getByRole('button', { name: /^\s*(modify|modificar)\s*$/i }).first();
const toastText = async (page: Page) => {
  const t = page.locator('.Toastify__toast, [class*="toast"]').first();
  await t.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => { });
  return ((await t.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
};

test('JEPYP-316 F7: delete the primary contact through the screen (exploratory) @316-delete-primary', async ({ page }) => {
  if (blockedIf(!ALLOWED, `dev / preprod only (TEST_ENV=${ENV})`)) return;
  if (blockedIf(!hasDbConfig() || !URL, 'needs DB access and the GraphQL URL')) return;
  test.setTimeout(300_000);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const db = new DbHelper();
  await db.connect();
  const report: Record<string, unknown> = { env: ENV, at: new Date().toISOString() };
  const contacts = async (id: string) => db.query<{ id: string; firstname: string; lastname: string }>(
    `SELECT id, firstname, lastname FROM core_engine.contact WHERE accountid = $1 ORDER BY id`, [id]);
  try {
    // 0. A fresh account of ours: PRIMARY María (Billing) only.
    const tok = (await gql(`{ userLogin(input: {userName: ${JSON.stringify(process.env.EMBRIX_USER)}, password: ${JSON.stringify(process.env.EMBRIX_PASSWORD)}}) { token } }`))?.data?.userLogin?.token;
    if (blockedIf(!tok, 'GraphQL login failed')) return;
    const s = Date.now().toString(36).toUpperCase();
    const created = await gql(`mutation { createAccount(input:{
      currency:"CRC", type: RESIDENTIAL, accountCategory: PREPAID, customerSegment: B2C, salesChannel: NONE, marketSegment: NONE, subType: NONE,
      name:"QA316 DEL ${s}", customerId:"QA316-DEL-${s}",
      contacts:[{roles:[BILLING], firstName:"María", lastName:"Rojas", middleName:"Vargas", identityDocument:"CÉDULA DE IDENTIDAD", email:"anh.tran@congerotechnology.com"}],
      addresses:[{roles:[BILLING], street:"", city:"Cartago", state:"Cartago", country:"CRI", postalCode:""}],
      billingProfiles:[{billingDom:1, billingFrequency: MONTHLY, invoiceType: SUMMARY, invoiceDelivery: EMAIL, paymentProfileId:"PRIMARY"}],
      paymentProfiles:[{paymentMethod: CHECK, paymentTerm:"NET_30"}] }){ id } }`, tok);
    const acct: string = created?.data?.createAccount?.id;
    if (blockedIf(!acct, `createAccount failed: ${JSON.stringify(created?.errors ?? created).slice(0, 300)}`)) return;
    report.accountId = acct;
    report.before = await contacts(acct);
    console.log(`  account ${acct}: ${JSON.stringify(report.before)}`);

    const openContacts = async () => {
      await page.navigateToHome();
      await page.goto(`/customers/${acct}/info`);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { });
      // Sidebar: Account Data > Contact (Datos De La Cuenta > Contacto).
      await page.getByText(/^\s*(Contact|Contacto)\s*$/).first().click();
      await page.locator('input[name="firstName"]').first().waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(1_000);
    };

    // 1. Control: delete the only (Billing, PRIMARY) contact -> must be refused.
    await openContacts();
    const del1 = deleteButtons(page).nth(await blockIndex(page, 'María'));
    const del1Enabled = await del1.isEnabled().catch(() => false);
    let modify1Enabled = false;
    let toast1 = '(Delete disabled for the only contact)';
    if (del1Enabled) {
      await del1.click();
      await page.waitForTimeout(500);
      modify1Enabled = await modifyButton(page).isEnabled().catch(() => false);
      if (modify1Enabled) { await modifyButton(page).click(); toast1 = await toastText(page); } else toast1 = '(Modify disabled)';
    }
    report.control = { deleteEnabled: del1Enabled, modifyEnabled: modify1Enabled, toast: toast1, after: await contacts(acct) };
    await page.screenshot({ path: path.join(EVIDENCE, `F7-UI-${acct}-1-delete-only-billing.png`), fullPage: true });
    console.log(`  control (delete the only contact): ${JSON.stringify(report.control)}`);

    // 2. The F7 path: add a Billing contact, delete María, Modify.
    await openContacts();
    await page.getByRole('button', { name: /^\s*(add new contact|añadir nuevo contacto)\s*$/i }).first().click();
    await page.waitForTimeout(800);
    const n = await page.locator('input[name="firstName"]').count();
    const fill = async (name: string, value: string) => {
      const el = page.locator(`input[name="${name}"]`).nth(n - 1);
      await el.click(); await el.fill(value);
    };
    await fill('firstName', 'Pedro');
    await fill('lastName', 'Solís');
    await fill('middleName', 'Brenes');
    await fill('email', 'anh.tran@congerotechnology.com');
    await page.getByText(/^\s*(Use As Billing|Usar como Facturación)\s*$/i).nth(n - 1).click();
    await page.screenshot({ path: path.join(EVIDENCE, `F7-UI-${acct}-2-new-billing-contact.png`), fullPage: true });
    // "Add new contact" opens a dialog; its own ADD NEW CONTACT button puts the contact on the tab (not saved yet).
    const dialog = page.getByRole('dialog').or(page.locator('.modal.show, .modal-dialog')).first();
    await dialog.getByRole('button', { name: /^\s*(add new contact|añadir nuevo contacto)\s*$/i }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => { });
    await page.waitForTimeout(800);
    await deleteButtons(page).nth(await blockIndex(page, 'María')).click();
    // "Are you sure you want to delete this Contact?" -> Yes / Sí
    await page.getByRole('button', { name: /^\s*(yes|sí|si)\s*$/i }).first().click({ timeout: 10_000 }).catch(() => { });
    await page.waitForTimeout(800);
    report.blocksBeforeModify = await page.locator('input[name="firstName"]').evaluateAll(els => els.map(e => (e as HTMLInputElement).value));
    await modifyButton(page).click();
    report.f7 = { toast: await toastText(page) };
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: path.join(EVIDENCE, `F7-UI-${acct}-3-after-modify.png`), fullPage: true });
    const after = await contacts(acct);
    const hasPrimary = after.some(c => c.id === 'PRIMARY');
    Object.assign(report.f7 as object, { after, hasPrimary,
      verdict: after.some(c => c.firstname === 'María') ? 'NOT SAVED (María still there)'
        : hasPrimary ? 'saved, a contact is PRIMARY (promoted)' : 'saved, NO PRIMARY contact left (F7)' });
    console.log(`  F7 path: ${JSON.stringify(report.f7)}`);
  } finally {
    const file = path.join(EVIDENCE, `F7-UI-delete-primary-${Date.now().toString(36)}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\n  report: ${file}`);
    await db.disconnect();
  }
  expect(report.accountId, 'account created').toBeTruthy();
});
