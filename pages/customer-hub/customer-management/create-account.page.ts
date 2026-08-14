import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { ToastComponent } from '../../components/toast.component';

/** Payload for the JASEC prepaid residential account creation form. */
export interface PrepaidAccountPayload {
  accountInfo: {
    accountCategory: string;
    customerSegment: string;
    customerId: string;
    legalEntity: string;     // overwrites form default "US"
    accountType: string;     // form field is name="type"
    currency?: string;
    sellingCompany?: string;
  };
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    useAsBilling: boolean;   // pre-checked in the form; field kept for parity
  };
  address: {
    street: string;          // textarea
    country: string;
    state: string;
    city: string;
    postalCode: string;
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

  private async selectByLabel(label: string, optionText: string): Promise<void> {
    const group = this.formGroupByLabel(label);
    await group.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
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

    await this.selectByLabel('Account Category', info.accountCategory);

    if (info.currency) {
      await this.typeAndSelectByLabel('Currency', info.currency);
    }
    await this.selectByLabel('Customer Segment', info.customerSegment);
    if (info.sellingCompany) {
      await this.fillInputByName('sellingCompany', info.sellingCompany);
    }
    await this.fillInputByName('customerId', info.customerId);
    await this.fillInputByName('legalEntity', info.legalEntity);
    // The form field for "Account Type" is name="type", so we go by label.
    await this.selectByLabel('Account Type', info.accountType);
  }

  async fillContact(contact: PrepaidAccountPayload['contact']): Promise<void> {
    await this.expandSection('Create Contact');
    await this.fillInputByName('firstName', contact.firstName);
    await this.fillInputByName('lastName', contact.lastName);
    await this.fillInputByName('email', contact.email);
    // "Use As Billing" is pre-checked readonly — no click needed.
  }

  async fillAddress(address: PrepaidAccountPayload['address']): Promise<void> {
    await this.expandSection('Create Address');
    await this.fillTextareaByName('street', address.street);
    await this.typeAndSelectByLabel('Country', address.country);
    await this.fillInputByName('state', address.state);
    await this.fillInputByName('city', address.city);
    await this.fillInputByName('postalCode', address.postalCode);
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
