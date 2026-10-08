import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { ToastComponent } from '../../components/toast.component';

/** Payload for the JASEC prepaid residential account creation form. */
export interface PrepaidAccountPayload {
  accountInfo: {
    customerId: string;       // Número de Identificación
    clientId?: string;        // NISE - mandatory on JASEC since JEPYP-231
    accountType: string;      // option text as shown, e.g. 'Tarifa Prepago' (field name="type")
    accountSubType?: string;  // Tarifa Jasec (name="subType"); locked while the tariff is Prepago
    marketSegment?: string;   // Ciclo (name="marketSegment")
    // JEPYP-231 hides or locks these on JASEC through ccp_properties (their values
    // come from tenant defaults). They are still filled on tenants that show them.
    accountCategory?: string;
    customerSegment?: string;
    legalEntity?: string;     // overwrites form default "US"
    currency?: string;
    sellingCompany?: string;
  };
  contact: {
    firstName: string;
    middleName?: string;      // JASEC "Primer Apellido" (JEPYP-316)
    lastName: string;
    identityDocument?: string; // JASEC "Tipo de documento" option text
    email: string;
    useAsBilling: boolean;   // pre-checked in the form; field kept for parity
  };
  address: {
    street: string;          // textarea
    country: string;
    state: string;
    city: string;
    district?: string;
    postalCode?: string;     // optional on JASEC since JEPYP-316
    useAsBilling: boolean;   // pre-checked in the form
  };
  paymentProfile: {
    paymentMethod: string;
    paymentTerm: string;
  };
  billingProfile: {
    billingDom: string | number;  // overwrites form default "10"
  };
}

/**
 * CreateAccountPage — Customer Hub → Customer Management → CREATE NEW.
 * Implements the multi-section form from "Energia Prepago - Creación de Cuentas.pdf".
 */
export class CreateAccountPage extends BasePage {
  readonly toast: ToastComponent;

  constructor(page: Page) {
    super(page);
    this.toast = new ToastComponent(page);
  }

  private get createNewLink() {
    return this.page
      .getByRole('link', { name: /^\s*Create\s+New\s*$/i })
      .or(this.page.locator("//a[normalize-space(text())='Create New']"))
      .first();
  }

  private get createAccountButton() {
    return this.page.getByRole('button', { name: /^\s*Create\s+Account\s*$/i }).first();
  }

  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Customer Hub/i);
    await this.clickNavLink(/Customer Management/i, /customer/i);
  }

  async clickCreateNew(): Promise<void> {
    await this.createNewLink.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    // The Customer Hub nav dropdown stays open after navigateViaNav and can
    // intercept the click; dismiss it before clicking.
    await this.page.keyboard.press('Escape').catch(() => { });
    await this.dismissDropdowns();
    await this.createNewLink.scrollIntoViewIfNeeded().catch(() => { });
    await this.createNewLink.click();
    await this.page.waitForURL(/\/customers\/create\/info/, { timeout: LONG_WAIT }).catch(() => { });
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
    await this.page.waitForLoadingToDisappear();
  }

  // ── Section expand ──────────────────────────────────────────────────
  // Each section is a `<div class="embrix-card-collapsible">` whose inner
  // `collapse__wrapper` carries either `closed` or `active` as an exact
  // class token. "Create Account Info" starts active; the rest start closed.

  private sectionWrapper(title: string): Locator {
    return this.page.locator(
      `//div[contains(@class,'embrix-card-collapsible')][.//span[@class='panel__title' and normalize-space()=${q(title)}]]/div[contains(@class,'collapse__wrapper')]`
    ).first();
  }

  private sectionHeader(title: string): Locator {
    return this.page.locator(
      `//div[contains(@class,'embrix-card-collapsible')][.//span[@class='panel__title' and normalize-space()=${q(title)}]]//div[@role='button' and contains(@class,'collapse__title')]`
    ).first();
  }

  private async expandSection(title: string): Promise<void> {
    const wrapper = this.sectionWrapper(title);
    await wrapper.waitFor({ state: 'attached', timeout: MEDIUM_WAIT }).catch(() => { });
    const classes = ((await wrapper.getAttribute('class').catch(() => '')) ?? '').split(/\s+/);
    // Exact-token check; "non-active-sub-from" would otherwise false-match `active`.
    if (classes.includes('closed') && !classes.includes('active')) {
      const header = this.sectionHeader(title);
      await header.scrollIntoViewIfNeeded().catch(() => { });
      await header.click();
      await this.page.waitForFunction(
        (titleArg) => {
          const wrap = document.evaluate(
            `//div[contains(@class,'embrix-card-collapsible')][.//span[@class='panel__title' and normalize-space()='${titleArg}']]/div[contains(@class,'collapse__wrapper')]`,
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null,
          ).singleNodeValue as HTMLElement | null;
          if (!wrap) return false;
          const cls = (wrap.className || '').split(/\s+/);
          return cls.includes('active') && !cls.includes('closed');
        },
        title,
        { timeout: MEDIUM_WAIT },
      ).catch(() => { });
    }
  }

  // ── Field helpers ───────────────────────────────────────────────────

  private inputByName(name: string): Locator {
    return this.page.locator(`//input[@name=${q(name)}]`).first();
  }

  private textareaByName(name: string): Locator {
    return this.page.locator(`//textarea[@name=${q(name)}]`).first();
  }

  private formGroupByLabel(label: string): Locator {
    return this.page.locator(
      `//div[contains(@class,'form-group') and ./span[starts-with(normalize-space(),${q(label)})]]`
    ).first();
  }

  /**
   * The form-group holding the control named `name`. By field name, not label,
   * because tenant config (JEPYP-231) relabels fields per tenant. react-select only
   * renders its named hidden input while enabled, so a locked select matches
   * nothing here - which is what the *IfEditable callers want.
   */
  private formGroupByName(name: string): Locator {
    return this.page.locator(`//div[contains(@class,'form-group') and .//input[@name=${q(name)}]]`).first();
  }

  private async isShown(locator: Locator): Promise<boolean> {
    return locator.isVisible().catch(() => false);
  }

  /** Pick `optionText` in the named dropdown, if this tenant shows it and it is editable. */
  private async selectByNameIfEditable(name: string, optionText?: string): Promise<void> {
    if (!optionText) return;
    const group = this.formGroupByName(name);
    if (await this.isShown(group)) await this.selectInGroup(group, optionText);
  }

  /** Fill the named input, if this tenant shows it. */
  private async fillInputByNameIfShown(name: string, value?: string): Promise<void> {
    if (value && (await this.isShown(this.inputByName(name)))) await this.fillInputByName(name, value);
  }

  private async selectByLabel(label: string, optionText: string): Promise<void> {
    const group = this.formGroupByLabel(label);
    await group.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.selectInGroup(group, optionText);
  }

  private async selectInGroup(group: Locator, optionText: string): Promise<void> {
    const control = group.locator('.custom-react-select__control').first();
    await control.scrollIntoViewIfNeeded().catch(() => { });
    await control.click();

    const menu = this.page.locator('.custom-react-select__menu').last();
    await menu.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    const option = menu
      .locator(`xpath=.//*[normalize-space(text())=${q(optionText)} or normalize-space(.)=${q(optionText)}]`)
      .first();
    if (await option.isVisible().catch(() => false)) {
      await option.click();
    } else {
      await menu.getByText(new RegExp(escapeRe(optionText), 'i')).first().click();
    }
    await menu.waitFor({ state: 'hidden', timeout: SHORT_WAIT }).catch(() => { });
  }

  private async typeAndSelectByLabel(label: string, optionText: string): Promise<void> {
    const group = this.formGroupByLabel(label);
    await group.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    const control = group.locator('.custom-react-select__control').first();
    await control.scrollIntoViewIfNeeded().catch(() => { });
    await control.click();

    await group.locator('.custom-react-select__input input').first().fill(optionText);

    const menu = this.page.locator('.custom-react-select__menu').last();
    await menu.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await menu.getByText(new RegExp(`^${escapeRe(optionText)}$`, 'i')).first().click()
      .catch(async () => {
        await menu.getByText(new RegExp(escapeRe(optionText), 'i')).first().click();
      });
    await menu.waitFor({ state: 'hidden', timeout: SHORT_WAIT }).catch(() => { });
  }

  private async fillInputByName(name: string, value: string): Promise<void> {
    const el = this.inputByName(name);
    await el.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await el.scrollIntoViewIfNeeded().catch(() => { });
    // Clear via select-all + delete so prefilled defaults (e.g. "US") are replaced.
    await el.click();
    await el.press('Control+A');
    await el.press('Delete');
    await el.fill(value);
  }

  private async fillTextareaByName(name: string, value: string): Promise<void> {
    const el = this.textareaByName(name);
    await el.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await el.scrollIntoViewIfNeeded().catch(() => { });
    await el.fill('');
    await el.fill(value);
  }

  // ── Sections ────────────────────────────────────────────────────────

  async fillAccountInfo(info: PrepaidAccountPayload['accountInfo']): Promise<void> {
    await this.expandSection('Create Account Info');

    // customerId is on every tenant's form, and fillInputByName waits for it, so the
    // section has rendered before the "if shown" checks below look for anything.
    await this.fillInputByName('customerId', info.customerId);
    await this.fillInputByNameIfShown('clientId', info.clientId);

    // Fields a tenant may hide or lock (JEPYP-231, ccp_properties). Category before
    // tariff: a tariff rule may fix the category and the Tarifa Jasec value.
    await this.selectByNameIfEditable('accountCategory', info.accountCategory);
    if (info.currency && (await this.isShown(this.formGroupByName('currency')))) {
      await this.typeAndSelectByLabel('Currency', info.currency);
    }
    await this.selectByNameIfEditable('customerSegment', info.customerSegment);
    await this.fillInputByNameIfShown('sellingCompany', info.sellingCompany);
    await this.fillInputByNameIfShown('legalEntity', info.legalEntity);

    await this.selectByNameIfEditable('type', info.accountType);
    await this.selectByNameIfEditable('subType', info.accountSubType);
    await this.selectByNameIfEditable('marketSegment', info.marketSegment);
  }

  async fillContact(contact: PrepaidAccountPayload['contact']): Promise<void> {
    await this.expandSection('Create Contact');
    await this.fillInputByName('firstName', contact.firstName);
    await this.fillInputByNameIfShown('middleName', contact.middleName);
    await this.fillInputByName('lastName', contact.lastName);
    await this.selectByNameIfEditable('identityDocument', contact.identityDocument);
    await this.fillInputByName('email', contact.email);
    // "Use As Billing" is pre-checked readonly — no click needed.
  }

  async fillAddress(address: PrepaidAccountPayload['address']): Promise<void> {
    await this.expandSection('Create Address');
    await this.fillTextareaByName('street', address.street);
    await this.typeAndSelectByLabel('Country', address.country);
    // Parent before child: a tenant with region lists (JEPYP-316) renders these as
    // cascading dropdowns, and picking a parent clears its children.
    await this.fillOrSelectByName('state', address.state);
    await this.fillOrSelectByName('city', address.city);
    await this.fillOrSelectByName('district', address.district);
    await this.fillInputByNameIfShown('postalCode', address.postalCode);
  }

  /** Pick `value` when the named field is a dropdown, otherwise type it. Skips a hidden field. */
  private async fillOrSelectByName(name: string, value?: string): Promise<void> {
    if (!value) return;
    const group = this.formGroupByName(name);
    if (!(await this.isShown(group))) return;
    if (await this.isShown(group.locator('.custom-react-select__control').first())) {
      await this.selectInGroup(group, value);
    } else {
      await this.fillInputByName(name, value);
    }
  }

  async fillPaymentProfile(profile: PrepaidAccountPayload['paymentProfile']): Promise<void> {
    await this.expandSection('Create Payment Profile');
    await this.selectByLabel('Payment Method', profile.paymentMethod);
    await this.selectByLabel('Payment Term', profile.paymentTerm);
  }

  async fillBillingProfile(profile: PrepaidAccountPayload['billingProfile']): Promise<void> {
    await this.expandSection('Create Billing Profile');
    await this.fillInputByName('billingDom', String(profile.billingDom));
  }

  // ── Submit ──────────────────────────────────────────────────────────

  async submitCreateAccount(): Promise<string> {
    await this.createAccountButton.scrollIntoViewIfNeeded().catch(() => { });
    await this.createAccountButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.createAccountButton.click();

    const winner = await Promise.race([
      this.toast.successToast.waitFor({ state: 'visible', timeout: EXTRA_LONG_WAIT }).then(() => 'success' as const),
      this.toast.errorToast.waitFor({ state: 'visible', timeout: EXTRA_LONG_WAIT }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const);

    if (winner === 'error') {
      throw new Error(`Create Account failed: ${await this.toast.getErrorMessage()}`);
    }

    await this.page.waitForURL(/customers?\/(ACT|AC|ACNT)-\d+/i, { timeout: LONG_WAIT }).catch(() => { });
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });

    const m = this.page.url().match(/(ACT|AC|ACNT)-\d+/i);
    return m ? m[0] : '';
  }

  async createPrepaidAccount(payload: PrepaidAccountPayload): Promise<string> {
    await this.fillAccountInfo(payload.accountInfo);
    await this.fillContact(payload.contact);
    await this.fillAddress(payload.address);
    await this.fillPaymentProfile(payload.paymentProfile);
    await this.fillBillingProfile(payload.billingProfile);
    return this.submitCreateAccount();
  }
}

/** XPath-safe string literal — handles single/double quotes. */
function q(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.split("'").join(`',"'",'`)}')`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
