/**
 * TC-02 — Customer registration with optional address and document type (JEPYP-316): a clerk can register a customer with only the details they have. Runs after TC-01.
 *
 *   Given a clerk is creating a new customer in Core UI
 *   When the clerk registers customers with the full address, part of the address, or no address at all,
 *        each with a different Tipo de documento
 *   Then every customer is created without an error
 *   And the customer holds exactly what was entered: names in the right fields, the document type chosen,
 *       the address parts filled, blanks left blank (a blank País is the tenant country, Costa Rica)
 *
 * Business-confirmed 2026-10-13 (ticket §5 AC 8: no address field mandatory; Distrito free text by decision).
 * Four customers through the SCREEN (customerId QA316-CF-<run>-<key>), no order, no clock move, no billing.
 * "What was entered" is read back from the DB (the form maps by meaning: Primer Apellido -> lastName, Segundo
 * Apellido -> middleName, Provincia -> state, Cantón -> city, Otras señas -> street). Without DB_* the customers are
 * still created and the case is reported PARTIAL, as TC-01 does.
 *   npx playwright test --project=jasec-regression --grep "@tc-02"
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures/page-factory';
import { CreateAccountPage, type PrepaidAccountPayload } from '../../../pages/customer-hub/customer-management/create-account.page';
import { DbHelper, hasDbConfig } from '../../../helpers/db.helper';
import { ON_JASEC_PROD, PROD_REFUSAL } from '../../../helpers/prod-guard';

// Creates or changes data: never on JASEC production (the client's live environment).
test.skip(ON_JASEC_PROD, PROD_REFUSAL);

const RUN = Date.now().toString(36).toUpperCase();
const row = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'data', 'jasec-prepaid-accounts.data.json'), 'utf8'))[0];

type Customer = {
  key: string; title: string;
  identityDocument: string;
  /** 'clear' = the clerk empties the field; undefined = left as the form pre-fills it (Costa Rica / Cartago). */
  country?: 'clear'; state?: 'clear';
  city?: string; district?: string; street?: string; postalCode?: string;
  /** What the account must hold afterwards. */
  stored: { country: string; state: string; city: string; district: string; street: string; postalcode: string };
};
const CUSTOMERS: Customer[] = [
  { key: 'FULL', title: 'full address', identityDocument: 'CÉDULA DE IDENTIDAD',
    city: 'Paraíso', district: 'Orosi', street: '200 m norte de la iglesia de Orosi', postalCode: '30203',
    stored: { country: 'CRI', state: 'Cartago', city: 'Paraíso', district: 'Orosi', street: '200 m norte de la iglesia de Orosi', postalcode: '30203' } },
  { key: 'PART', title: 'part of the address (Provincia + Cantón)', identityDocument: 'CÉDULA JURIDICA',
    city: 'Paraíso',
    stored: { country: 'CRI', state: 'Cartago', city: 'Paraíso', district: '', street: '', postalcode: '' } },
  { key: 'DEFAULTS', title: 'only what the form pre-fills (País + Provincia)', identityDocument: 'PASAPORTE',
    stored: { country: 'CRI', state: 'Cartago', city: '', district: '', street: '', postalcode: '' } },
  { key: 'NONE', title: 'no address at all (País and Provincia cleared)', identityDocument: 'CÉDULA DE RESIDENCIA',
    country: 'clear', state: 'clear',
    stored: { country: 'CRI', state: '', city: '', district: '', street: '', postalcode: '' } },
];
const NAMES = { firstName: 'Johny Gerardo', lastName: 'Rojas', middleName: 'Vargas' };

test.describe('TC-02 — Customer registration with optional address and document type', {
  tag: ['@jasec', '@tc-02'],
}, () => {
  test.describe.configure({ mode: 'serial' });

  for (const c of CUSTOMERS) {
    test(`${c.key}: ${c.title}, ${c.identityDocument}`, { tag: ['@tc-02'] }, async ({ page, searchAccountsPage, testLogger }) => {
      test.setTimeout(240_000);
      const create = new CreateAccountPage(page);
      const customerId = `QA316-CF-${RUN}-${c.key}`;

      // Given a clerk is creating a new customer in Core UI
      await page.navigateToHome();
      await searchAccountsPage.navigateViaNav();
      await create.clickCreateNew();
      await create.fillAccountInfo({ ...row.accountInfo, customerId, clientId: `NISE316-${RUN}-${c.key}` });

      // When the clerk enters the names, the document type and the address parts they have
      const contact: PrepaidAccountPayload['contact'] = { ...row.contact, ...NAMES, identityDocument: c.identityDocument };
      await create.fillContact(contact);
      await create.fillAddress({
        country: '', state: undefined,
        city: c.city, district: c.district, street: c.street, postalCode: c.postalCode, useAsBilling: true,
      });
      if (c.state === 'clear') await clearSelect(page, 'state');
      if (c.country === 'clear') await clearSelect(page, 'country');
      await create.fillPaymentProfile(row.paymentProfile);
      await create.fillBillingProfile(row.billingProfile);

      // Then the customer is created without an error
      const accountId = await create.submitCreateAccount();
      testLogger.data('Customer created', { accountId, customerId, scenario: c.key });
      expect(accountId, 'account created').toMatch(/^(ACT|AC)-\d+$/);

      // And it holds exactly what was entered
      if (!hasDbConfig()) {
        const why = `read-back BLOCKED: no DB_* credentials - ${accountId} created, stored contact/address NOT checked`;
        console.log(`\n  PARTIAL: ${why}\n`);
        test.info().annotations.push({ type: 'partial', description: why });
        return;
      }
      const db = new DbHelper();
      await db.connect();
      try {
        const contacts = await db.query<Record<string, string | null>>(
          `SELECT id, firstname, lastname, middlename, identitydocument FROM core_engine.contact WHERE accountid = $1`, [accountId]);
        const addresses = await db.query<Record<string, string | null>>(
          `SELECT country, state, city, district, street, postalcode FROM core_engine.address WHERE accountid = $1`, [accountId]);
        testLogger.data('Stored', { contacts, addresses });
        expect(contacts.length, 'one contact').toBe(1);
        expect(addresses.length, 'one address').toBe(1);
        const [k] = contacts;
        expect.soft(k.id, 'the only contact is the main contact').toBe('PRIMARY');
        expect.soft(k.firstname, 'Nombre').toBe(NAMES.firstName);
        expect.soft(k.lastname, 'Primer Apellido').toBe(NAMES.lastName);
        expect.soft(k.middlename, 'Segundo Apellido').toBe(NAMES.middleName);
        expect.soft(k.identitydocument, 'Tipo de documento').toBe(c.identityDocument);
        // Blank = blank: the engine stores '' for most blank fields and NULL for a blank Distrito (F4) - both are blank.
        const [a] = addresses;
        for (const [field, label] of [['country', 'País'], ['state', 'Provincia'], ['city', 'Cantón'], ['district', 'Distrito'],
                                      ['street', 'Otras señas'], ['postalcode', 'Código postal']] as const) {
          expect.soft(a[field] ?? '', label).toBe(c.stored[field]);
        }
      } finally {
        await db.disconnect();
      }
    });
  }
});

/** Empty a react-select by its field name: the clear indicator when shown, otherwise Backspace in the control. */
async function clearSelect(page: Page, name: string): Promise<void> {
  const group = page.locator(`//div[contains(@class,'form-group')][.//input[@name='${name}']]`).first();
  await group.waitFor({ state: 'visible', timeout: 15_000 });
  const clear = group.locator('.custom-react-select__clear-indicator').first();
  if (await clear.count()) {
    await clear.click();
  } else {
    await group.locator('.custom-react-select__control').first().click();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(500);
}
