/**
 * JASEC production (TEST_ENV=jasec) is the client's live environment: a case that changes data (seeds accounts,
 * moves the clock, bills, consumes journals) never runs there. On dev and preprod such cases run with nothing to set.
 *
 * Two layers: config/tenants.ts offers no JASEC suite at all on the customer build, and each mutating spec also
 * refuses prod itself with this check. playwright.config.ts writes the canonical tenant name back into TEST_ENV,
 * so an alias still reads as 'jasec' here.
 *
 * Cases that reach JASEC's own live systems (AMI commands, the accounting gateway) keep their explicit switches.
 */
export const ON_JASEC_PROD = (process.env.TEST_ENV ?? '').trim() === 'jasec';

export const PROD_REFUSAL =
  "refused on JASEC production (the client's live environment): this case changes data - run it on dev or preprod";
