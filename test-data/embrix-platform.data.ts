/**
 * Catalog + seed data for the Embrix platform regression suite
 * (`tests/regression/embrixPlatform/ts-02.spec.ts`).
 *
 * These values were hardcoded inside the spec and, worse, inside
 * `create-order.page.ts`. That made the suite runnable on exactly one tenant:
 * when the congero demo box was reseeded in August 2026 its catalog was
 * replaced, `PO_FR` and `TelconectService` vanished, and every case from TC-18
 * onward failed on missing data with no way to repoint it.
 *
 * Add a block per tenant; the suite resolves the right one at runtime.
 */

export interface EmbrixPlatformData {
  /**
   * Ala-carte price offer for TC-18's order.
   *
   * MUST be non-provisionable. A provisionable offer sends the order down the
   * network-provisioning path, where it parks at PROVISIONING_INITIATED
   * waiting for a Nokia response that never arrives on a sandbox — no
   * subscription is created and every downstream billing case starves.
   * Check with: searchPriceOffers(filter:{status:SELLABLE, isProvisionable:false})
   */
  alaCarteOffer: string;
  /** Bundle id — TC-19 (quotation) and TC-26 (bundle search). Must be SELLABLE. */
  bundleId: string;
  /** TC-46 — value as rendered in the dropdown, including the code in brackets. */
  exchangeCurrency: string;
  /** TC-43 — tax-exemption Level dropdown value. */
  taxExemptionLevel: string;
  /**
   * TC-24 — Pricing Center → Basic Configurations → Currency.
   *
   * A list, not a single value, because the case is only idempotent if it can
   * pick a currency the tenant does NOT already have. The Currency Id dropdown
   * refuses a duplicate and silently leaves the new row blank, which the form
   * then rejects with "index, currencyid, symbol, name, roundingmethod,
   * roundingprecision are all mandatory". The original hardcoded 'Euro (EUR)'
   * therefore passed exactly once per tenant — the run that created it.
   */
  currency: {
    candidates: string[];
    roundingMethod: string;
    roundingPrecision: string;
  };
  /** TC-25 — Product Family row. `productType` is tenant-defined. */
  productFamily: {
    company: string;
    family: string;
    line: string;
    type: string;
    subType: string;
  };
  /** Seed values for the accounts TC-18, TC-19 and TC-44 create. */
  account: {
    email: string;
    firstName: string;
    lastName: string;
    street: string;
    state: string;
    city: string;
    postalCode: string;
  };
  /**
   * Lower bound for the date-range filters (TC-35, TC-50, TC-57, TC-63, TC-31).
   * Keep it early enough to cover seeded history on the tenant.
   */
  searchFromDate: string;
}

export const EMBRIX_PLATFORM_DATA: Record<string, EmbrixPlatformData> = {
  'coopeg-sandbox': {
    // Verified against coopeg-sandbox 2026-09-11: SELLABLE + isProvisionable:false.
    alaCarteOffer: 'PO_INT_50MBPS',
    bundleId: 'Internet_100_Mbps_LAB01',
    exchangeCurrency: 'USD (USD)',
    taxExemptionLevel: 'STATE',
    currency: {
      candidates: [
        'Euro (EUR)',
        'British Pound Sterling (GBP)',
        'Japanese Yen (JPY)',
        'Swiss Franc (CHF)',
        'Australian Dollar (AUD)',
        'Mexican Peso (MXN)',
        'Brazilian Real (BRL)',
        'Colombian Peso (COP)',
      ],
      roundingMethod: 'HALF_UP',
      roundingPrecision: '2',
    },
    productFamily: {
      company: '080',
      family: 'Communications',
      line: '03-Information Services',
      // TC-25 fails on coopeg-sandbox — confirm this Product Type exists here.
      type: 'prueba',
      subType: 'NONE',
    },
    account: {
      email: 'lisalog2026@gmail.com',
      firstName: 'Lisa',
      lastName: 'Nuevo',
      street: 'CallePrincipal',
      state: 'Alajuela',
      city: 'Grecia',
      postalCode: '102333',
    },
    searchFromDate: '2024-01-01',
  },

  // Alka's original target. Preserved for the record — the box was reseeded in
  // August 2026 and no longer holds these, so this block will not run as-is.
  'congero-sandbox': {
    alaCarteOffer: 'PO_FR',
    bundleId: 'TelconectService',
    exchangeCurrency: 'USD (USD)',
    taxExemptionLevel: 'STATE',
    currency: {
      candidates: [
        'Euro (EUR)',
        'British Pound Sterling (GBP)',
        'Japanese Yen (JPY)',
        'Swiss Franc (CHF)',
        'Australian Dollar (AUD)',
        'Mexican Peso (MXN)',
        'Brazilian Real (BRL)',
        'Colombian Peso (COP)',
      ],
      roundingMethod: 'HALF_UP',
      roundingPrecision: '2',
    },
    productFamily: {
      company: '080',
      family: 'Communications',
      line: '03-Information Services',
      type: 'prueba',
      subType: 'NONE',
    },
    account: {
      email: 'lisalog2026@gmail.com',
      firstName: 'Lisa',
      lastName: 'Nuevo',
      street: 'CallePrincipal',
      state: 'Alajuela',
      city: 'Grecia',
      postalCode: '102333',
    },
    searchFromDate: '2024-01-01',
  },
};

/**
 * Resolve the tenant from the base URL FIRST, not from TEST_ENV.
 *
 * `EMBRIX_BASE_URL` overrides `TEST_ENV` in playwright.config.ts, so TEST_ENV
 * can name one tenant while the run actually targets another — which is how a
 * previous run provisioned onto the wrong environment.
 */
export function embrixPlatformData(): EmbrixPlatformData {
  const url = (process.env.EMBRIX_BASE_URL ?? '').toLowerCase();
  let key: string;
  if (url.includes('coopeg')) key = 'coopeg-sandbox';
  else if (url.includes('nip.io') || url.includes('congero')) key = 'congero-sandbox';
  else key = process.env.TEST_ENV ?? 'coopeg-sandbox';

  const data = EMBRIX_PLATFORM_DATA[key];
  if (!data) {
    throw new Error(
      `No embrixPlatform test data for environment '${key}' ` +
      `(EMBRIX_BASE_URL='${process.env.EMBRIX_BASE_URL ?? ''}'). ` +
      `Add a block to test-data/embrix-platform.data.ts.`
    );
  }
  return data;
}
