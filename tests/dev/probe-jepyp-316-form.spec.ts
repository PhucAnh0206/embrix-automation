/**
 * Tags: @dev_test @probe-316
 *
 * READ-ONLY probe of the JEPYP-316 Create Contact / Create Address sections. Opens Create New, records every
 * form-group (label, field names, react-select or plain input, disabled, shown value, options), walks the
 * Provincia -> Cantón -> Distrito cascade once, and NEVER clicks Create Account. Nothing is saved.
 *   $env:TEST_ENV='jasec-dev'; npx playwright test --project=dev --grep "@probe-316"
 * Writes artifacts/probe-jepyp-316-<env>.json.
 */
import * as fs from 'fs';
import { test } from '../../fixtures/page-factory';
import { CreateAccountPage } from '../../pages/customer-hub/customer-management/create-account.page';

type Group = { label: string; names: string[]; select: boolean; disabled: boolean; shown: string; required: boolean };

// page-factory, not jasec-fixtures: the jasec fixture rewinds the shared CCP clock, and a probe must touch nothing.
test('@probe-316 JEPYP-316 contact/address DOM probe (no save)', async ({ page, searchAccountsPage }) => {
  test.setTimeout(180_000);
  const createAccountPage = new CreateAccountPage(page);
  await page.navigateToHome();
  await searchAccountsPage.navigateViaNav();
  await createAccountPage.clickCreateNew();

  const section = (title: string) => page.locator(
    `//div[contains(@class,'embrix-card-collapsible')][.//span[@class='panel__title' and normalize-space()='${title}']]`).first();

  const out: Record<string, unknown> = { env: process.env.TEST_ENV, at: new Date().toISOString(), titles: [] };
  out.titles = await page.locator('span.panel__title').allTextContents();

  const dump = async (title: string): Promise<Group[]> => {
    const s = section(title);
    if (!(await s.count())) return [];
    const head = s.locator(`xpath=.//div[@role='button' and contains(@class,'collapse__title')]`).first();
    const wrap = s.locator(`xpath=./div[contains(@class,'collapse__wrapper')]`).first();
    if (((await wrap.getAttribute('class')) ?? '').includes('closed')) { await head.click(); await page.waitForTimeout(800); }
    return s.locator('div.form-group').evaluateAll((els) => els.map((g) => {
      const e = g as HTMLElement;
      const ctl = e.querySelector('.custom-react-select__control');
      return {
        label: (e.querySelector(':scope > span, label')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        names: Array.from(e.querySelectorAll('input[name],textarea[name],select[name]'))
          .map((i) => `${i.tagName.toLowerCase()}:${i.getAttribute('name')}:${i.getAttribute('type') ?? ''}=${(i as HTMLInputElement).value}`),
        select: !!ctl,
        disabled: !!ctl?.className.includes('is-disabled') || !!e.querySelector('input:disabled,textarea:disabled'),
        shown: (e.querySelector('.custom-react-select__single-value')?.textContent ?? '').trim(),
        required: !!e.querySelector('.required, .text-danger') || /\*/.test(e.textContent ?? ''),
        visible: e.offsetParent !== null,
      };
    }).filter((x) => x.visible));
  };

  // Sections are an accordion: opening one closes the others, so read each while it is open.
  // Options of a react-select, opened and closed again with Escape (no selection).
  const options = async (title: string, labelStart: string[]) => {
    const g = section(title).locator('div.form-group').filter({ has: page.locator('.custom-react-select__control') })
      .filter({ hasText: new RegExp(`^\\s*(${labelStart.join('|')})`) }).first();
    if (!(await g.count())) return null;
    await g.locator('.custom-react-select__control').first().click();
    const menu = page.locator('.custom-react-select__menu').last();
    await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
    const opts = await menu.locator('.custom-react-select__option').allTextContents();
    await page.keyboard.press('Escape');
    return opts;
  };
  const pick = async (title: string, labelStart: string[], text: string) => {
    const g = section(title).locator('div.form-group').filter({ has: page.locator('.custom-react-select__control') })
      .filter({ hasText: new RegExp(`^\\s*(${labelStart.join('|')})`) }).first();
    await g.locator('.custom-react-select__control').first().click();
    await page.locator('.custom-react-select__menu').last().locator('.custom-react-select__option')
      .filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) }).first().click();
    await page.waitForTimeout(800);
  };

  out.contact = await dump('Create Contact');
  out.docTypeOptions = await options('Create Contact', ['Tipo de documento', 'Document type', 'Documento de Identificaci', 'Identity document']);
  out.address = await dump('Create Address');
  out.countryOptionsHead = (await options('Create Address', ['País', 'Pais', 'Country']))?.slice(0, 5);
  out.provinceOptions = await options('Create Address', ['Provincia', 'Province', 'Estado', 'State']);
  out.cantonOptionsCartago = await options('Create Address', ['Cantón', 'Canton', 'Ciudad', 'City']);
  try {
    await pick('Create Address', ['Cantón', 'Canton', 'Ciudad', 'City'], 'Paraíso');
    out.districtOptionsParaiso = await options('Create Address', ['Distrito', 'District']);
    out.addressAfterParaiso = await dump('Create Address');
    await pick('Create Address', ['Cantón', 'Canton', 'Ciudad', 'City'], 'Cartago');
    out.districtOptionsCartago = await options('Create Address', ['Distrito', 'District']);
    await pick('Create Address', ['Distrito', 'District'], 'Oriental');
    out.addressAfterOriental = await dump('Create Address');
  } catch (e) { out.cascadeError = String(e); }

  fs.mkdirSync('artifacts', { recursive: true });
  const file = `artifacts/probe-jepyp-316-${process.env.TEST_ENV}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  await page.screenshot({ path: `artifacts/probe-jepyp-316-${process.env.TEST_ENV}.png`, fullPage: true });
  console.log(`probe written: ${file}`);
  // Deliberately no submit.
});
