import { Page, expect } from '@playwright/test';
import { BasePage } from '../base.page';
import { EXTRA_LONG_WAIT, LONG_WAIT, MEDIUM_WAIT, SHORT_WAIT } from '../../helpers/timeouts.helper';

/**
 * Shared test data for PlaceToPay flows.
 *
 * Card variants:
 *   - approve: tokenization succeeds, payment approved
 *   - deny:    tokenization succeeds, payment declined
 *   - invalid: fails at tokenization (invalid card number)
 */
export type PlaceToPayCardVariant = 'approve' | 'deny' | 'invalid';

export const PLACETOPAY_TEST_DATA = {
  cards: {
    approve: '4110760000000081',
    deny: '4110760000000016',
    invalid: '4005580000000011',
  },
  expiryMonthYear: '02/29',
  cvv: '123',
  name: 'Anh',
  surname: 'Tran',
  cedulaIdentidad: '502210225',
  phoneNumber: '88888888',
  documentType: 'CI',
  paymentEmail: 'test@gmail.com',
} as const;

/**
 * PlaceToPayCheckoutPage — the checkout form hosted at
 * `checkout-test.placetopay.com/spa/session/<sid>/<token>`.
 *
 * Supports both tokenization (Save Card) and payment (Top-Up) flows.
 * The card form is the same in both; the payment flow adds an email step
 * before the card form.
 */
export class PlaceToPayCheckoutPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── Locators ────────────────────────────────────────────────────────

  private get emailInput() {
    return this.page.getByPlaceholder(/email@ejemplo\.com/i).first();
  }

  private get continuarButton() {
    return this.page.getByRole('button', { name: /^\s*Continuar\s*$/i }).first();
  }

  private get pagarButton() {
    return this.page.getByRole('button', { name: /^\s*Pagar/i }).first();
  }

  private get cardNumberInput() {
    return this.page.getByPlaceholder(/1234\s*5678\s*9012\s*3456/i).first();
  }

  /** Expiry input — bilingual EN "Month / Year" / ES "Mes / Año". */
  private get expiryInput() {
    return this.page
      .getByPlaceholder(/Month\s*\/\s*Year|Mes\s*\/\s*A[ñn]o/i)
      .first();
  }

  private get cvvInput() {
    return this.page.getByPlaceholder(/^CVV$/i).first();
  }

  /** Name input — bilingual EN "Name" / ES "Nombre". */
  private get nameInput() {
    return this.page.getByPlaceholder(/^\s*(Name|Nombre)\s*$/i).first();
  }

  /** Surname input — bilingual EN "Surname" / ES "Apellido". */
  private get surnameInput() {
    return this.page.getByPlaceholder(/^\s*(Surname|Apellido)\s*$/i).first();
  }

  private get cedulaInput() {
    return this.page.getByPlaceholder(/C[eé]dula\s*de\s*identidad/i).first();
  }

  /** Mobile input — bilingual EN "Mobile number" / ES "Número de celular". */
  private get mobileInput() {
    return this.page
      .getByPlaceholder(/Mobile\s*number|N[uú]mero\s*de\s*celular/i)
      .first();
  }

  private get continueButton() {
    return this.page.getByRole('button', { name: /^\s*Continue\s*$/i }).first();
  }

  /** "I don't want to continue" abandon link — EN / ES. */
  private get iDontWantToContinueLink() {
    const nameRegex = /I\s*don'?t\s*want\s*to\s*continue|No\s*deseo\s*continuar/i;
    return this.page
      .getByRole('link', { name: nameRegex })
      .or(this.page.getByRole('button', { name: nameRegex }))
      .first();
  }

  // ── Actions ─────────────────────────────────────────────────────────

  /** Wait until the checkout form has rendered. */
  async waitForCheckoutFormReady(): Promise<void> {
    await this.page.waitForURL(/checkout-test\.placetopay\.com\/spa\/session/i, {
      timeout: EXTRA_LONG_WAIT,
    });
    await this.cardNumberInput.waitFor({ state: 'visible', timeout: EXTRA_LONG_WAIT });
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
  }

  /** Fill the card form using shared test data. `variant` picks the card number. */
  async fillTokenizationForm(variant: PlaceToPayCardVariant = 'approve'): Promise<void> {
    const cardNumber = PLACETOPAY_TEST_DATA.cards[variant];

    await this.cardNumberInput.fill(cardNumber);
    await this.expiryInput.fill(PLACETOPAY_TEST_DATA.expiryMonthYear);
    await this.cvvInput.fill(PLACETOPAY_TEST_DATA.cvv);
    await this.nameInput.fill(PLACETOPAY_TEST_DATA.name);
    await this.surnameInput.fill(PLACETOPAY_TEST_DATA.surname);
    await this.cedulaInput.fill(PLACETOPAY_TEST_DATA.cedulaIdentidad);
    await this.mobileInput.fill(PLACETOPAY_TEST_DATA.phoneNumber);
  }

  /** Click the tokenization "Continue" button. */
  async clickContinue(): Promise<void> {
    await this.continueButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.continueButton.click();
  }

  /**
   * Wait for the state page, click "Back to merchant", handle the
   * leave-confirmation modal, and land back on Self Care.
   */
  async returnToSelfCare(): Promise<void> {
    if (/selfcare-ui\..*embrix\.org/i.test(this.page.url())) return;

    await this.page.waitForURL(/checkout-test\.placetopay\.com\/spa\/state/i, {
      timeout: EXTRA_LONG_WAIT,
    }).catch(() => { });

    const backToMerchantSelector = /back\s*to\s*merchant|volver\s*al\s*comercio/i;
    const backButton = this.page
      .getByRole('button', { name: backToMerchantSelector })
      .or(this.page.getByRole('link', { name: backToMerchantSelector }))
      .first();

    await backButton.waitFor({ state: 'visible', timeout: EXTRA_LONG_WAIT });
    await backButton.click();

    // Automated clicks may trigger PlaceToPay's leave-confirmation modal.
    const leaveConfirmSelector =
      /yes,?\s*leave\s*the\s*process|s[ií],?\s*(abandonar|salir)/i;
    const leaveConfirmButton = this.page
      .getByRole('button', { name: leaveConfirmSelector })
      .first();

    const modalAppeared = await leaveConfirmButton
      .waitFor({ state: 'visible', timeout: SHORT_WAIT })
      .then(() => true)
      .catch(() => false);
    if (modalAppeared) {
      await leaveConfirmButton.click();
    }

    await this.page.waitForURL(/selfcare-ui\..*embrix\.org/i, {
      timeout: EXTRA_LONG_WAIT,
    });
  }

  /** Full tokenization flow: fill form, Continue, return to Self Care. */
  async completeTokenization(variant: PlaceToPayCardVariant = 'approve'): Promise<void> {
    await this.waitForCheckoutFormReady();
    await this.fillTokenizationForm(variant);
    await this.clickContinue();
    await this.returnToSelfCare();
  }

  /** Click "I don't want to continue", handle any confirmation, return. */
  async abandonCheckoutSession(): Promise<void> {
    await this.waitForCheckoutFormReady();

    await this.iDontWantToContinueLink.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await this.iDontWantToContinueLink.click();

    const leaveConfirmSelector =
      /yes,?\s*leave\s*the\s*process|s[ií],?\s*(abandonar|salir)/i;
    const leaveConfirmButton = this.page
      .getByRole('button', { name: leaveConfirmSelector })
      .first();

    const modalAppeared = await leaveConfirmButton
      .waitFor({ state: 'visible', timeout: MEDIUM_WAIT })
      .then(() => true)
      .catch(() => false);
    if (modalAppeared) {
      await leaveConfirmButton.click();
    }

    await this.page.waitForURL(/selfcare-ui\..*embrix\.org/i, {
      timeout: EXTRA_LONG_WAIT,
    });
  }

  // ── Payment flow ─────────────────────────────────────────────────────

  private async isOnEmailStep(): Promise<boolean> {
    return this.emailInput.isVisible().catch(() => false);
  }

  /** Fill email and click Continuar to advance to the card form. */
  async fillEmailAndContinue(): Promise<void> {
    await this.emailInput.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await this.emailInput.fill(PLACETOPAY_TEST_DATA.paymentEmail);
    await this.continuarButton.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.continuarButton.click();
    await this.cardNumberInput.waitFor({ state: 'visible', timeout: LONG_WAIT });
  }

  /** Click the "Pagar ¢XXX" button to submit a payment. */
  async clickPagar(): Promise<void> {
    await this.pagarButton.waitFor({ state: 'visible', timeout: LONG_WAIT });
    await this.pagarButton.click();
  }

  /** Full payment flow: handle email step if present, fill card, submit, return. */
  async completePaymentFlow(variant: PlaceToPayCardVariant = 'approve'): Promise<void> {
    await this.page.waitForURL(/checkout-test\.placetopay\.com/i, {
      timeout: EXTRA_LONG_WAIT,
    });
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });

    if (await this.isOnEmailStep()) {
      await this.fillEmailAndContinue();
    } else {
      await this.cardNumberInput.waitFor({ state: 'visible', timeout: LONG_WAIT });
    }

    await this.fillTokenizationForm(variant);
    await this.clickPagar();
    await this.returnToSelfCare();
  }

  /**
   * Submit an invalid card and return. PlaceToPay may reject inline (stays
   * on /spa/session/) or via a declined state page (/spa/state/); we handle
   * both.
   */
  async submitDeclinedCard(): Promise<void> {
    await this.waitForCheckoutFormReady();
    await this.fillTokenizationForm('invalid');
    await this.clickContinue();

    await this.page.waitForTimeout(2500);

    if (/\/spa\/session\//.test(this.page.url())) {
      await this.abandonCheckoutSession();
    } else {
      await this.returnToSelfCare();
    }
  }
}
