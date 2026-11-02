/**
 * NetSuite regression — test data builders.
 *
 * Contracts are created the way Coopeweb creates them: crm-gateway
 * processAccountAndOrder, billing-only (the first ONE_TIME invoice is generated
 * at once). Body shape = the team's Postman "Create Account ERP" request for
 * coopegsbx2. Ids are QA-ANH-NS-R2-<stamp>-<tag> so they are recognisable,
 * never collide with CoopeG data, and pass NsApi's QA_ACCOUNT guard.
 *
 * Contact data is deliberately non-deliverable (example.com, all-zero phone) so
 * the Coopeweb work order / SMS side effect (Bug_014) cannot reach a person.
 */
// MMddHHmm, fixed once per `playwright test` run in playwright.config (NS_RUN_ID) so restarted workers agree.
export const RUN_STAMP = process.env.NS_RUN_ID ?? new Date().toISOString().replace(/\D/g, '').slice(4, 12);

export function qaId(tag: string): string { return `QA-ANH-NS-R2-${RUN_STAMP}-${tag}`; }

/**
 * NS_REUSE_RUN=<MMddHHmm>: use that run's contracts (still in the data) instead of creating new ones, each with a
 * new manual invoice. On the develop build (10-23) a new contract's order stays CREATED until provisioning
 * completes, and nothing on coopegsbx2 completes it, so a new contract can't be invoiced at all.
 * N1 (no partyId) maps to that run's X1 (partyId "").
 */
export const REUSE_RUN = process.env.NS_REUSE_RUN;
/** NS_CONTRACT_<tag>=<account id> uses that existing contract for the tag (e.g. one provisioned by ns-provision). */
export function contractId(tag: string): string {
  const own = process.env[`NS_CONTRACT_${tag}`];
  if (own) return own;
  return REUSE_RUN ? `QA-ANH-NS-R2-${REUSE_RUN}-${tag === 'N1' ? 'X1' : tag}` : qaId(tag);
}
/** True when the tag's contract already exists (NS_CONTRACT_<tag> or NS_REUSE_RUN): invoice it instead of creating it. */
export function isReused(tag: string): boolean {
  return !!(process.env[`NS_CONTRACT_${tag}`] || REUSE_RUN);
}

export interface ContractOpts {
  tag: string;
  partyId?: string | null;          // null/undefined = omit the field
  accounttype?: string;             // RESIDENTIAL | INTERCOMPANY | ...
  customAccountType?: string;       // FONATEL / PHC [ASSUMPTION — values to confirm]
  bundleId?: string;
}

export function contractBody(o: ContractOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {
    userId: 'COOPEWEB',
    firstName: 'QA NETSUITE', lastName: `R2 ${o.tag}`,
    organization: '', commercialName: '',
    accountId: qaId(o.tag), orderId: `${qaId(o.tag)}-O`,
    email: 'qa.netsuite@example.com',
    country: 'Costa Rica', landmark: '', state: 'GUANACASTE', extraLine: '', postalCode: '50101',
    city: 'LIBERIA', phone: '00000000', street: 'QA NetSuite R2', district: 'LIBERIA',
    orderType: 'NEW', collectionProfile: 'Normal', billingOnlyFlag: 'true',
    groupId: '', accounttype: o.accounttype ?? 'RESIDENTIAL', customAccountType: o.customAccountType ?? '',
    identity: '503830816', identityDocument: 'CÉDULA DE IDENTIDAD', staticIpRented: 'false',
    paymentProfiles: [{ paymentMethod: 'CHECK' }],
    services: [{ bundleId: o.bundleId ?? 'BDL_INT_300MBPS', packageId: '', serviceType: 'INTERNET', action: 'ADD', quantity: '1' }],
  };
  if (o.partyId !== undefined && o.partyId !== null) body.partyId = o.partyId;
  return body;
}

/** Test contracts provided by Jeremy (10-07). */
export const TD = {
  DEFAULT: { account: '208886', party: '74003' },
  FONATEL: { account: '3012830', party: '57936' },
  PHC: { account: '244821', party: '61425' },
};
