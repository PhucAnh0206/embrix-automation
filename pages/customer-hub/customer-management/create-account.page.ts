import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { ToastComponent } from '../../components/toast.component';

/**
 * Payload for the JASEC prepaid residential account creation form.
 *
 * JEPYP-231 (shipped to jasec-dev, verified 2026-09-24) rewrote this screen:
 * it REMOVED several fields from the DOM entirely, LOCKED two selects, and
 * relabelled the rest into Spanish. The optional markers below record which
 * fields the form may no longer offer — they are not cosmetic.
 */
export interface PrepaidAccountPayload {
  accountInfo: {
    /** Locked to PREPAID by JEPYP-231. Verified, never selected. */
    accountCategory: string;
    /** name="customerId", label "Número de Identificación". MANDATORY. */
    customerId: string;
    /** name="clientId", label "NISE". MANDATORY since JEPYP-231. */
    clientId?: string;
    /** name="type", label "Tarifa ARESEP". "RESIDENTIAL" -> option "Residencial". */
    accountType: string;
    /** Locked to "Residencial Permanente" by JEPYP-231. Verified, never selected. */
    accountSubtype?: string;
    /** REMOVED from the form by JEPYP-231 (default B2C). Set only if present. */
    customerSegment?: string;
    /** REMOVED from the form by JEPYP-231 (default CRC). Set only if present. */
    currency?: string;
    /** REMOVED from the form by JEPYP-231 (default CR). Set only if present.
     *  This one is load-bearing — see the note on fillAccountInfo. */
    legalEntity?: string;
    /** name="sellingCompany", label "Punto de Venta". Pre-filled "0900". */
    sellingCompany?: string;
    /** name="id", label "Account Id". Normally left blank (system assigns ACT-n). Set only
     *  by the account-ID validation case - the value is filled EXACTLY, control chars included. */
    accountId?: string;
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

  /**
   * The form-group carrying one of these labels.
   *
   * Takes ALTERNATIVES because JEPYP-231's labels are per-language and the
   * English set only exists after the ui-core deploy. "Tarifa Jasec" becomes
   * "JASEC Tariff", so a single-spelling locator works in Spanish and breaks in
   * English — and the values are Redis-cached, so both can be live at once
   * during a rollout. Matching either spelling spans the change instead of
   * needing a follow-up fix on the day it lands.
   *
   * Only used where there is nothing better. A field with a `name` should go
   * through formGroupByFieldName, which is language-independent outright.
   */
  private formGroupByLabel(label: string | string[]): Locator {
    const labels = Array.isArray(label) ? label : [label];
    const clause = labels
      .map((l) => `./span[starts-with(normalize-space(),${q(l)})]`)
      .join(' or ');
    return this.page.locator(`//div[contains(@class,'form-group') and (${clause})]`).first();
  }

  /**
   * The form-group that OWNS a given form field, found by the field's `name`
   * rather than by its visible label.
   *
   * WHY NAME AND NOT LABEL. JEPYP-231 relabelled this whole screen, and on
   * jasec-dev those new labels render in Spanish even with the UI language set
   * to English (verified 2026-09-24 — the section headers and Account Category
   * are still English, so it is the JEPYP-231 labels specifically). A locator
   * keyed on visible text therefore breaks twice: once when the label changes,
   * and again when the translation is fixed. The underlying `name` attributes
   * did NOT change — `customerId`, `clientId`, `type`, `marketSegment`,
   * `sellingCompany`, `commercialName`, `lineOfBusiness`, `collectionAgent` and
   * `effectiveDate` are all still there under their old names. Keying on those
   * survives both events.
   */
  private formGroupByFieldName(name: string): Locator {
    return this.page.locator(
      `//div[contains(@class,'form-group')][.//input[@name=${q(name)}]]`
    ).first();
  }

  /** Is this field present in the DOM at all? JEPYP-231 deleted several. */
  private async fieldExists(name: string): Promise<boolean> {
    return (await this.page.locator(`//input[@name=${q(name)}]`).count()) > 0;
  }

  /**
   * Choose an option in the react-select that owns `fieldName`, then PROVE the
   * underlying value is what we wanted.
   *
   * The verify step is the point. The option TEXT is a Spanish label that may
   * be retranslated at any time, while the stored VALUE is what every downstream
   * assertion and every tariff query keys on. Selecting "Residencial" and
   * getting `RESIDENTIAL` is the contract; if the mapping ever moves, this
   * throws and names the options it did find rather than creating an account of
   * the wrong shape and letting a later block fail for an unrelated-looking
   * reason.
   */
  private async selectByFieldName(
    fieldName: string, optionText: string, expectedValue: string,
  ): Promise<void> {
    const group = this.formGroupByFieldName(fieldName);
    await group.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    const control = group.locator('.custom-react-select__control').first();
    await control.scrollIntoViewIfNeeded().catch(() => { });
    await control.click();

    const menu = this.page.locator('.custom-react-select__menu').last();
    await menu.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    const options = await menu.locator('.custom-react-select__option').allTextContents();
    const exact = menu.locator('.custom-react-select__option')
      .filter({ hasText: new RegExp(`^\\s*${escapeRe(optionText)}\\s*$`, 'i') }).first();
    if (!(await exact.count())) {
      throw new Error(
        `Create Account: "${optionText}" is not offered by the ${fieldName} dropdown. ` +
        `Available: [${options.join(' | ')}]. JEPYP-231 repopulated these lists, so a ` +
        `missing option is a data-vs-form mismatch, not a flake.`,
      );
    }
    await exact.click();
    await menu.waitFor({ state: 'hidden', timeout: SHORT_WAIT }).catch(() => { });

    const actual = await this.page.locator(`//input[@name=${q(fieldName)}]`).first()
      .inputValue().catch(() => '');
    if (actual !== expectedValue) {
      throw new Error(
        `Create Account: picked "${optionText}" in ${fieldName} but the form now holds ` +
        `"${actual}", not the expected "${expectedValue}". The label-to-value mapping ` +
        `has moved — an account created now would not match the reference shape.`,
      );
    }
  }

  /**
   * Read a select that JEPYP-231 LOCKED, and confirm it already holds the value
   * we would otherwise have chosen.
   *
   * A disabled react-select never opens its menu, so the old code clicked it and
   * sat there until the 30s timeout — which is exactly how Block B failed on
   * 2026-09-24. There is nothing to set here: the product derives the value. The
   * job is to assert it is the RIGHT derived value, so that if the derivation
   * ever changes the suite says so instead of quietly building a different
   * account.
   */
  private async assertLockedSelect(label: string | string[], expected: string): Promise<void> {
    const shownLabel = Array.isArray(label) ? label.join('" / "') : label;
    const group = this.formGroupByLabel(label);
    if (!(await group.count())) {
      throw new Error(`Create Account: locked field "${shownLabel}" is not on the form at all.`);
    }
    const control = group.locator('.custom-react-select__control').first();
    const read = async () => ({
      disabled: (((await control.getAttribute('class').catch(() => '')) ?? '')).includes('is-disabled'),
      shown: ((await group.locator('.custom-react-select__single-value').first()
        .textContent().catch(() => '')) ?? '').trim(),
    });

    /**
     * WAIT FOR IT TO SETTLE, then judge.
     *
     * This form renders an intermediate state before the tenant config lands:
     * "Account Category" appears as POSTPAID and ENABLED, and only then flips to
     * PREPAID and locked. Reading it once caught that intermediate state and
     * failed roughly half of a 16-run Block E batch on 2026-09-24 with
     * `is NO LONGER disabled (value "POSTPAID")`.
     *
     * Re-READ rather than re-assert — a retried assertion over a stale handle
     * would just re-check the same captured value. Settling is the precondition;
     * once settled, a wrong value is still a hard failure.
     */
    const deadline = Date.now() + MEDIUM_WAIT;
    let state = await read();
    const first = state;
    while ((!state.disabled || state.shown !== expected) && Date.now() < deadline) {
      await this.page.waitForTimeout(250);
      state = await read();
    }
    if (first.disabled !== state.disabled || first.shown !== state.shown) {
      // Worth saying out loud: a human clicking fast enough could act on it.
      console.log(
        `  [create-account] "${shownLabel}" settled from ` +
        `${first.disabled ? 'locked' : 'ENABLED'}/"${first.shown}" to ` +
        `${state.disabled ? 'locked' : 'ENABLED'}/"${state.shown}"`,
      );
    }

    if (!state.disabled) {
      // Still settable after the wait — then leaving it unset would be a silent
      // gap. Say so loudly rather than assume the default holds.
      throw new Error(
        `Create Account: "${shownLabel}" is NO LONGER disabled (value "${state.shown}") ` +
        `after waiting ${MEDIUM_WAIT}ms for it to settle. JEPYP-231 locked it; if ` +
        `that has been reverted this page object must go back to selecting it.`,
      );
    }
    if (state.shown !== expected) {
      throw new Error(
        `Create Account: "${shownLabel}" is locked to "${state.shown}", expected "${expected}". ` +
        `The account this form would create no longer matches the reference shape.`,
      );
    }
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

  /**
   * Fields the form no longer offers, recorded during the last fillAccountInfo.
   *
   * These are NOT ignorable. Each one is a value the caller asked for and the
   * UI refused to take, so the account carries whatever the product defaults to
   * instead. The spec reads this list and checks the created account against the
   * reference shape, because a field we could not set is exactly the kind of gap
   * that reads as coverage and is not.
   */
  readonly unsettableFields: string[] = [];

  /**
   * "Tarifa ARESEP" (name="type") — Spanish option text to the stored value.
   *
   * Verified against jasec-dev 2026-09-24 by selecting each and reading the
   * input back: "Residencial" writes `RESIDENTIAL`, "Tarifa Prepago" writes
   * `PREPAID`. Options offered: Preferencial | Residencial | Tarifa Comercial |
   * Tarifa Industrial | Tarifa Prepago. The form pre-selects Tarifa Prepago.
   *
   * ⚠️ THE STORED CODES ARE STILL THE OLD ONES. JASEC asked for T-RE / T-RP /
   * T-CO / T-IN / T-CS (JEPYP-231 comment, Luis, 2026-09-21) and Toan replied
   * that "none of the new codes exist yet, so adding them is a back-end change,
   * not a UI one" (2026-09-21). So today the dropdown is relabelled over the
   * PRE-EXISTING values. When the back-end codes land, these mappings move and
   * selectByFieldName's verify step is what will tell us.
   */
  private static readonly ARESEP_OPTION_FOR_VALUE: Record<string, string> = {
    RESIDENTIAL: 'Residencial',
    PREPAID: 'Tarifa Prepago',
    COMMERCIAL: 'Tarifa Comercial',
    INDUSTRIAL: 'Tarifa Industrial',
    PREFERENTIAL: 'Preferencial',
  };

  /**
   * JEPYP-231 reshaped this section. What it did, verified on jasec-dev
   * 2026-09-24 by reading the live DOM rather than the ticket:
   *
   *   LOCKED   Account Category -> PREPAID            (was selected by hand)
   *   LOCKED   Tarifa Jasec     -> Residencial Permanente
   *   RENAMED  Account Type     -> "Tarifa ARESEP", repopulated with tariffs
   *   NEW REQ  NISE (clientId)  -> now mandatory; this form used to leave it null
   *   REMOVED  legalEntity, currency, customerSegment, salesChannel, rfc,
   *            foreignTaxId, employeeId, salesAgentId, externalReferenceId,
   *            region, partyId, groupId, name   (gone from the DOM entirely)
   *
   * ⚠️ legalEntity is gone from the form. The suite's own note in
   * create-prepaid-account.helper.ts says the form "defaults to US" and calls
   * it load-bearing. Measured 2026-09-24: an account created here still stores
   * US, so the ticket's "default value CR" has not taken effect and nothing
   * broke. The spec asserts it, so a later change to that default is named
   * rather than silent.
   *
   * WHICH TARIFF A PREPAID ACCOUNT CARRIES. Tarifa Prepago + Residencial
   * Permanente, which is what the form pre-selects and locks. That is JASEC's
   * instruction (Luis, JEPYP-231, 2026-09-22): "when field tarifa ARESEP is
   * selected as Tarifa Prepago, then only Residencial Permanente will be
   * chosen".
   *
   * It is NOT chosen for credit-profile reasons. An earlier version of this
   * comment argued the tariff decided the profile; that was wrong and is
   * RETRACTED. Profiles resolve by `getByName(subscription.creditProfileName)`
   * and the accounttype / accountsubtype columns on the profile row are
   * descriptive only — 34 PREPAID/SUBTYPE_01 subscriptions on dev carry Prepaid
   * Energy Profile. The tariff and the profile are independent.
   *
   * The consequence is that this form cannot reproduce the pre-JEPYP-231 row
   * exactly: accounttype moves RESIDENTIAL -> PREPAID, accountsubtype
   * NONE -> SUBTYPE_01, and clientid is now mandatory where it used to be null.
   * Everything else is unchanged, and the team confirmed the tariff values feed
   * nothing that matters — the accounting extract carries NULL for both,
   * invoice templates select on account category, and pricing is fetched by id.
   */
  async fillAccountInfo(info: PrepaidAccountPayload['accountInfo']): Promise<void> {
    await this.expandSection('Create Account Info');
    this.unsettableFields.length = 0;

    // ── Locked by JEPYP-231: verify, never click. Clicking a disabled
    //    react-select is what made Block B hang for 30s on 2026-09-24. ──
    await this.assertLockedSelect('Account Category', info.accountCategory);
    if (info.accountSubtype) {
      await this.assertLockedSelect(['Tarifa Jasec', 'JASEC Tariff'], info.accountSubtype);
    }

    // ── Fields JEPYP-231 deleted. Record, do not silently shrug. ──
    for (const [label, wanted] of [
      ['currency', info.currency],
      ['customerSegment', info.customerSegment],
      ['legalEntity', info.legalEntity],
    ] as const) {
      if (!wanted) continue;
      if (await this.fieldExists(label)) {
        if (label === 'currency') await this.typeAndSelectByLabel('Currency', wanted);
        else if (label === 'customerSegment') await this.selectByLabel('Customer Segment', wanted);
        else await this.fillInputByName('legalEntity', wanted);
      } else {
        this.unsettableFields.push(`${label}=${wanted}`);
      }
    }

    if (info.sellingCompany) {
      await this.fillInputByName('sellingCompany', info.sellingCompany);
    }

    if (info.accountId !== undefined) {
      await this.fillInputByName('id', info.accountId);          // "Account Id"
    }

    // ── Still present, still named the same, just relabelled ──
    await this.fillInputByName('customerId', info.customerId);   // "Número de Identificación"
    if (info.clientId) {
      await this.fillInputByName('clientId', info.clientId);     // "NISE" — mandatory now
    }

    const option = CreateAccountPage.ARESEP_OPTION_FOR_VALUE[info.accountType];
    if (!option) {
      throw new Error(
        `Create Account: no "Tarifa ARESEP" option is mapped to accountType ` +
        `"${info.accountType}". Add it to ARESEP_OPTION_FOR_VALUE rather than ` +
        `guessing — the stored value is what the tariff queries key on.`,
      );
    }
    await this.selectByFieldName('type', option, info.accountType);
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

  /** Whether the form shows an "Account Id" input (name="id"). */
  async hasAccountIdField(): Promise<boolean> {
    return this.inputByName('id').isVisible().catch(() => false);
  }

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
