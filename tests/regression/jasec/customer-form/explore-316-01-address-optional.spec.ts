/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX). JEPYP-316 charter rows 2.19-2.22 (+1.8 partly):
 * "None of the address fields ... should be mandatory" (ticket §5, AC 8). Records the answer; asserts only the harness.
 * Charter / evidence: Regression testing\EPDP-348_JASEC-Test\EXPLORE_JEPYP-316_customer-form\.
 *
 * Five accounts through Core UI Create Account, each with a different address:
 *   A all blank (País and Provincia cleared too)  B País only  C País + Provincia (the defaults)
 *   D + Cantón (no Distrito)                      E full address
 * For each: screenshot of the address section, submit, the outcome (account id or the error shown), and a DB
 * read-back of contact + address (NULL vs '' recorded, design review m4).
 *
 * MUTATING: creates accounts (customerId QA316-*), NO order, no clock move, no billing. dev / preprod only.
 *   $env:TEST_ENV='jasec-dev'; npx playwright test --project=jasec-customer-form-explore --grep "@316-address"
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/page-factory';
import { CreateAccountPage, type PrepaidAccountPayload } from '../../../../pages/customer-hub/customer-management/create-account.page';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';

const ENV = process.env.TEST_ENV ?? '';
const ALLOWED = ['jasec-dev', 'jasec-preprod'].includes(ENV);
const EVIDENCE = process.env.JEPYP316_EVIDENCE_DIR ?? path.resolve(__dirname,
  `../../../../../../Regression testing/EPDP-348_JASEC-Test/EXPLORE_JEPYP-316_customer-form/evidence/${ENV.replace('jasec-', '')}`);
const RUN = Date.now().toString(36).toUpperCase();
const row = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json'), 'utf8'))[0];

type Pick = 'keep' | 'clear' | string;
type Scenario = {
  key: string; charter: string; title: string;
  country: Pick; state: Pick; city?: string; district?: string; street?: string; postalCode?: string;
  identityDocument: string;
};
const SCENARIOS: Scenario[] = [
  { key: 'A', charter: '2.19', title: 'every address field blank (País and Provincia cleared)', country: 'clear', state: 'clear', identityDocument: 'CÉDULA DE IDENTIDAD' },
  { key: 'B', charter: '2.20', title: 'País only', country: 'keep', state: 'clear', identityDocument: 'CÉDULA JURIDICA' },
  { key: 'C', charter: '2.21', title: 'País + Provincia (form defaults), nothing else', country: 'keep', state: 'keep', identityDocument: 'PASAPORTE' },
  { key: 'D', charter: '2.21', title: 'País + Provincia + Cantón, no Distrito', country: 'keep', state: 'keep', city: 'Paraíso', identityDocument: 'CÉDULA DE RESIDENCIA' },
  { key: 'E', charter: '2.22', title: 'full address', country: 'keep', state: 'keep', city: 'Paraíso', district: 'Orosi',
    street: '200 m norte de la iglesia de Orosi', postalCode: '30203', identityDocument: 'CÉDULA DE IDENTIDAD' },
];

const results: Record<string, unknown>[] = [];

test.describe('JEPYP-316 address fields are all optional @316-address', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    if (!ALLOWED) throw new Error(`BLOCKED: explore-316 creates accounts - dev / preprod only, not '${ENV}'.`);
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  test.afterAll(() => {
    const file = path.join(EVIDENCE, `316-address-optional-${RUN}.json`);
    fs.writeFileSync(file, JSON.stringify({ env: ENV, run: RUN, at: new Date().toISOString(), results }, null, 2));
    console.log(`results: ${file}`);
  });

  for (const s of SCENARIOS) {
    test(`${s.key} (${s.charter}) ${s.title}`, async ({ page, searchAccountsPage }) => {
      test.setTimeout(240_000);
      const create = new CreateAccountPage(page);
      const customerId = `QA316-${RUN}-${s.key}`;

      await page.navigateToHome();
      await searchAccountsPage.navigateViaNav();
      await create.clickCreateNew();

      await create.fillAccountInfo({ ...row.accountInfo, customerId, clientId: `NISE316-${RUN}-${s.key}` });
      const contact: PrepaidAccountPayload['contact'] = {
        ...row.contact, firstName: 'Johny Gerardo', lastName: 'Rojas', middleName: 'Vargas',
        identityDocument: s.identityDocument,
      };
      await create.fillContact(contact);

      // Address: start from what the form pre-selects, then clear or set each field.
      await create.fillAddress({
        country: s.country === 'keep' || s.country === 'clear' ? '' : s.country,
        state: s.state === 'keep' || s.state === 'clear' ? undefined : s.state,
        city: s.city, district: s.district, street: s.street, postalCode: s.postalCode, useAsBilling: true,
      });
      if (s.state === 'clear') await clearSelect(page, 'state');
      if (s.country === 'clear') await clearSelect(page, 'country');

      const form = await readAddressForm(page);
      const shot = path.join(EVIDENCE, `2.19-22-${s.key}-${RUN}-form.png`);
      await page.locator(`//div[contains(@class,'embrix-card-collapsible')][.//span[@class='panel__title' and normalize-space()='Create Address']]`)
        .first().screenshot({ path: shot }).catch(() => page.screenshot({ path: shot, fullPage: true }));

      await create.fillPaymentProfile(row.paymentProfile);
      await create.fillBillingProfile(row.billingProfile);
      let accountId = '';
      let error = '';
      try { accountId = await create.submitCreateAccount(); } catch (e) { error = String((e as Error).message ?? e); }
      await page.screenshot({ path: path.join(EVIDENCE, `2.19-22-${s.key}-${RUN}-after-submit.png`), fullPage: true });

      let db: Record<string, unknown> = { note: 'no DB config' };
      if (accountId && hasDbConfig()) {
        const h = new DbHelper();
        await h.connect();
        try {
          db = {
            contact: await h.query(`SELECT id, firstname, lastname, middlename, identitydocument, email
                                      FROM core_engine.contact WHERE accountid = $1 ORDER BY id`, [accountId]),
            address: await h.query(`SELECT id, country, state, city, district, street, postalcode,
                                           (country IS NULL) AS country_null, (state IS NULL) AS state_null,
                                           (city IS NULL) AS city_null, (street IS NULL) AS street_null,
                                           (postalcode IS NULL) AS postal_null
                                      FROM core_engine.address WHERE accountid = $1 ORDER BY id`, [accountId]),
          };
        } finally { await h.disconnect(); }
      }

      const verdict = accountId ? 'SAVED' : 'REFUSED';
      results.push({ scenario: s.key, charter: s.charter, title: s.title, customerId, formBeforeSubmit: form,
        accountId, error, verdict, expected: 'SAVED (ticket §5, AC 8)', db });
      console.log(`  ${s.key} ${s.title}: ${verdict} ${accountId || error}`);
      // Harness only: the outcome is recorded, a refusal is a finding, not a test failure.
      expect(accountId || error, 'neither an account id nor an error was captured').toBeTruthy();
    });
  }
});

/** Empty a react-select by its field name: the clear indicator when shown, otherwise Backspace in the control. */
async function clearSelect(page: import('@playwright/test').Page, name: string): Promise<void> {
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

/** What the address section shows and holds right before submit. */
async function readAddressForm(page: import('@playwright/test').Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ['country', 'state', 'city', 'district', 'street', 'postalCode']) {
    const el = page.locator(`[name='${name}']`).first();
    out[name] = (await el.count()) ? await el.inputValue().catch(() => '?') : '<absent>';
  }
  return out;
}
