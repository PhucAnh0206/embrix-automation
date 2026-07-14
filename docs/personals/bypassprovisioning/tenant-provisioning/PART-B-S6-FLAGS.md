# Part B · §6 — L1: The feature-flag set (`ccp_properties` via `setCcpProperties`)

> This is the heart of "config-driven Embrix." Every behaviour the platform has is gated by a key here (`if (ccpPropertiesMap.get(FLAG)) -> do X`). §5's `createTenant` already wrote the *typed subset* (via `tenantPropertyDefaults`); §6 writes the **authoritative, complete minimal set** with one idempotent `setCcpProperties` call, then proves every *pointer* flag resolves to a real L5 row.
>
> Grounded in: the **real 198-key demo dump** (`GUIDE.md` §1.4), the authoritative **constant→key map** (`common/.../PropertiesConstants.groovy`), and the write path (`PGCcpPropertiesService.setCcpProperties` → DB upsert + live Redis update).

---

## 6.0 — One call sets everything (why we don't split typed/raw)

`setCcpProperties(CcpPropertiesInput)` (`MutationResolver:2287`) is a **generic key/value upsert** — for each `{property,value}` it does "update if exists, else insert" and live-writes the Redis `ccpPropertiesMap`. It does **not** care whether a key happens to also be a `TenantPropertyDefaults` field. So the clean approach is:

1. `createTenant` (§5) sets a small valid `tenantPropertyDefaults` subset (it's a required input).
2. `setCcpProperties` (this section) sets the **full authoritative minimal set** — overwriting/adding everything, typed or not, in one shot.

Because it's an upsert, re-running is safe and converges. This avoids the brittle "which key is settable where" bookkeeping entirely.

`CcpPropertiesInput` shape:
```graphql
input CcpPropertiesInput { ccpPropertyList: [CcpPropertyInput!]! }
input CcpPropertyInput   { property: String!  value: String! }
```

---

## 6.1 — Classifying the 198 demo keys → the minimal generic set

Every meaningful demo key falls into one of five actions. (`GUIDE.md` §1.4 has the long-form reasoning; this is the actionable result.)

- **PARAM** — a pointer/identity; value comes from `tenant-profile.yaml` and **must** resolve to an L5/L6 row.
- **KEEP** — a sane generic default; ship as-is in the template.
- **ENV** — differs sandbox vs prod (clock, test mode, SSL).
- **OFF** — a feature that needs an integration/region we don't have yet; omit (absent = off) or set false.
- **DROP** — junk, secret, or Coope/region-specific; never ship in a generic template.

### 6.1.1 DROP (do not put in the template)
| key | demo value | why dropped |
|-----|-----------|-------------|
| `` (empty), `property`, `2023-11-15`, `2024-01-01` | — | junk / CSV header row imported as data |
| `quickbooksRefreshToken` | `Q011561274274…` | **secret** → Vault, never a template literal |
| `organization` | `Pespi` | leftover test value |
| `enterpriseManualProvisioningQueue`, `oldProvisioningSystemQueue` | `ENTERPRISE`, `AREDIAL_PROVISIONING` | Coope provisioning-specific |
| `interCompanyCreditNoteItem`, `interCompanyInvoiceCreditReason` | … | Coope intercompany feature |
| `substitutionSatCode`, `ivaTaxItemId`, `iepsTaxItemId`, `pacEnabled`, `pacCustomizedPdfLayout` | … | **Mexico CFDI/PAC**-specific; only for MX tenants |
| `selfcareRole` | `500076` | hardcoded role id → **derive** from the L6 RBAC seed (§7), don't ship a magic number |

### 6.1.2 PARAM (from `tenant-profile.yaml`; must resolve to seeded rows)
| key | example | must exist in |
|-----|---------|---------------|
| `currency`, `defaultCurrency` | `USD` | `currencyList` (L5 §3.1) |
| `defaultGLAccount` | `10001` | `config_chart_of_account_list.accountnumber` (§3.5) |
| `taxationItemId` | `ACME-TaxationItemId` | `config_tax_types.itemid` (§3.6) |
| `legalEntity` | `Acme Inc` | operating unit / credit profile (§3.9/3.10) |
| `sellingCompany` | `0900` | product family / AR items (§3.4/3.7) |
| `lineOfBusiness` | `ISP` | — (free text, tenant LOB) |
| `productCompany`,`productFamily`,`productLine`,`productType`,`productSubType` | `0900`,`DEFAULT`×4 | `product_family_list` 5-tuple (§3.4) |
| `paymentTerm` | `NET_15` | `payment_terms.paymentterm` (§3.8) |

### 6.1.3 ENV (sandbox vs production)
| key | sandbox | production | meaning |
|-----|---------|-----------|---------|
| `useCcpTime` | `true` | `false` | simulated clock (CCP time) vs wall-clock. **Prod must be false** or billing runs on a fake date. |
| `testMode` | `true` | `false` | test behaviours / relaxed validations |
| `mailSmtpSslEnable` | `false` | `true` (usually) | SMTP SSL for outbound mail |

### 6.1.4 KEEP — the minimal generic defaults (the template body)
Enum defaults: `accountType=RESIDENTIAL`, `accountSubType=NONE`, `customerSegment=B2C`, `marketSegment=NONE`, `salesChannel=NONE`, `contactRole=BILLING`, `addressRole=BILLING`, `invoiceType=SUMMARY`, `invoiceDelivery=EMAIL`, `paymentMethod=CHECK`, `phoneType=MOBILE`, `billingFrequency=MONTHLY`, `subscriptionStatus=SUBMITTED`, `trialType=BOTH`, `financeSyncBatchMode=API`, `primaryTaxType=Main`, `addOnTaxType=Additional`, `defaultTaxRuleForAROps=WITHOUT_TAX`, `defaultLanguage=ENGLISH`, `templateType=XSLT`, `taxExemptionMidStartCycle=USE_FULL`, `taxExemptionEndCycle=USE_FULL`, `billingDom=1`.

Terms (⚠️ overriding Coope's 15-year): `initialTerm=1`, `initialTermUnit=YEARS`, `renewalTerm=1`, `renewalTermUnit=YEARS`, `advanceBillingInNoOfDays=0`.

Numeric/batch: `batchSizeBilling=50`, `batchSizeInvoice=60`, `batchSizePayment=5`, `batchSizeCommon=50`, `usageProcessBatchSize=50`, `migrationBatchSize=200`, `noOfThreads=3`, `noOfJobThreads=1`, `noOfBatchProcessThreads=1`, `noOfBulkAdjustmentThreads=3`, `dashboardMonths=12`, `passwordExpiryInMonths=30`, `archiveAccountTimeExpiry=60`, `renewalReminderThreshold=30`, `trialExpiryReminderThreshold=10`, `exchangeThreshold=0.05`, `roundingPrecisionForExchangeRate=4`, `waitTimeForNextSequence=60`, `minimumCreditNoteThreshold=2`, `minimumDebitNoteThreshold=2`, `notMoreThanDiscount=100`, `financeSyncBatchSize=5`, `coaExportFileName=ExportCOA.csv`.

Booleans ON (core order→invoice→payment): `taxApplicable=true`, `generateInvoicePdf=true`, `revenueTracking=true`, `allowUsageProcessing=true`, `useAutoAllocation=true`, `paymentNotification=true`, `paymentFailureNotification=true`, `invoiceReadyNotification=true`, `invoiceDueNotification=true`, `newSubscriptionNotification=true`, `creditNoteReadyNotification=true`, `recurringPeriodInInvoice=true`, `invoiceEndDateInclusive=true`, `isCollectionScheduleCached=true`, `isCustomAttributeCached=true`, `useGLCombination=true`, `matchBillingEntries=true`, `useShortBillingCycle=true`, `useUsageStartTime=true`, `triggerInvoicingOnNewSubsActivation=true`, `triggerInvoicingWithPendingBill=true`, `support29_30_31DayBilling=true`, `autoReverseWriteoffOnPayment=true`, `userInMultipleGroups=true`, `accountOrderWrapperAPI=true`, `getServiceViaServiceUnitProvId=true`, `skipNetZeroGLExtract=true`, `accumulatorBasedTaxThresholds=true`, `avoidZeroAmountTaxTransaction=true`.

`skipGatewayAuthorizationApis` (KEEP — internal bypass paths, generic): `/graphiql,/graphql,/reload,/generate-token,/processProvisioning,/paymentNotification`.

### 6.1.5 OFF (omit, or explicit false — feature/integration/region not present yet)
`pacEnabled, pacCustomizedPdfLayout, ssoEnabled, projectEnabled, multiSubscriptionEnabled, multiCurrency, crossCountryPurchase, crossCountryPayment, autoSendInvoice, invoiceApproval, collectDebtFirst, batchFinancialExtract, realTimeFinanceSync, paymentFinanceSync, sendAllDataToProvisioning, sendServiceProvDataToProvisioning, provisioningEnabled, partialFulfillment, partialProvisioningEnabled, useProviderForARTax, withTaxARRule, splitTaxCalculationByItem, splitTaxCalculationByServiceType, firstInvoicePaymentActivation, eliminateFirstInvoice, …` — turn these ON only when the matching integration/region/feature is configured. (Many are Coope=true; that's Coope, not generic.)

> ⚠️ `useProviderForARTax`/`withTaxARRule`/`splitTax*` are ON for Coope because Coope uses an external tax provider + Mexico-style splitting. For a generic tenant with the internal `EMBRIX` tax (§4) they start **false**. `firstInvoicePaymentActivation` vs `eliminateFirstInvoice` are **mutually exclusive** order-flow modes (see the `PropertiesConstants` comment) — pick at most one, per tenant requirement; default neither.

---

## 6.2 — The artifact: `templates/minimal/flags.json`

> **TRIMMED to true-minimal (2026-05-30).** After validating every value against the live `core_enums`, the shipped `flags.json` was cut from ~90 keys to **~62** — deliberately dropping Coope/feature-specific flags so we provision a *generic* tenant, not a Coope clone. **Absent = OFF**, and each dropped flag is re-added only when its feature is actually scoped (per your "don't copy Coope" principle). The file's shape is the GraphQL variables object `{"in":{"ccpPropertyList":[…]}}` (matches `setCcpProperties($in)`), with `${...}` rendered from `tenant.env`.
>
> **Dropped (Coope-isms / non-minimal), re-add per requirement:**
> | Dropped flag(s) | Why not minimal |
> |---|---|
> | `trialType` | trials not in minimal; demo value `BOTH` isn't even a valid `trial_type` (only `OPT_IN_TRIAL`/`OPT_OUT_TRIAL`) |
> | `financeSyncBatchMode`, `financeSyncBatchSize`, `coaExportFileName` | finance/ERP sync is OFF until a finance integration exists |
> | `primaryTaxType`, `addOnTaxType`, `taxExemptionMidStartCycle`, `taxExemptionEndCycle`, `accumulatorBasedTaxThresholds`, `avoidZeroAmountTaxTransaction` | Coope/Mexico tax-split & exemption nuances; minimal uses a single standard tax |
> | `allowUsageProcessing`, `useUsageStartTime`, `usageProcessBatchSize`, `getServiceViaServiceUnitProvId` | usage/rating — only for usage tenants |
> | `useShortBillingCycle`, `support29_30_31DayBilling`, `triggerInvoicingWithPendingBill` | billing-cycle nuances; default behaviour is fine |
> | `useGLCombination`, `skipNetZeroGLExtract`, `matchBillingEntries` | GL/finance-extract nuances (Coope) |
> | `autoReverseWriteoffOnPayment` | AR write-off nuance |
> | `userInMultipleGroups`, `accountOrderWrapperAPI` | RBAC/UI behaviour choices |
> | `archiveAccountTimeExpiry`, `trialExpiryReminderThreshold`, `migrationBatchSize` | archival/trial/migration — not order-to-cash |
>
> **Verified-fixed values kept:** `subscriptionStatus=SUBMITTED` (valid `order_status`), `defaultTaxRuleForAROps=WITHOUT_TAX` (valid `arops_tax_rule`). The minimal set below is the *illustrative* full list from the original analysis; the **shipped** file is the trimmed version described above.

```jsonc
// templates/minimal/flags.json  — render ${...} from tenant-profile.yaml, then POST via setCcpProperties
{
  "ccpPropertyList": [
    {"property":"currency","value":"${CURRENCY}"},
    {"property":"defaultCurrency","value":"${CURRENCY}"},
    {"property":"defaultGLAccount","value":"${DEFAULT_GL}"},
    {"property":"taxationItemId","value":"${TAX_ITEM_ID}"},
    {"property":"legalEntity","value":"${LEGAL_ENTITY}"},
    {"property":"sellingCompany","value":"${SELLING_COMPANY}"},
    {"property":"lineOfBusiness","value":"${LINE_OF_BUSINESS}"},
    {"property":"productCompany","value":"${SELLING_COMPANY}"},
    {"property":"productFamily","value":"DEFAULT"},
    {"property":"productLine","value":"DEFAULT"},
    {"property":"productType","value":"DEFAULT"},
    {"property":"productSubType","value":"DEFAULT"},
    {"property":"paymentTerm","value":"NET_15"},
    {"property":"billingDom","value":"1"},
    {"property":"billingFrequency","value":"MONTHLY"},
    {"property":"accountType","value":"RESIDENTIAL"},
    {"property":"accountSubType","value":"NONE"},
    {"property":"customerSegment","value":"B2C"},
    {"property":"marketSegment","value":"NONE"},
    {"property":"salesChannel","value":"NONE"},
    {"property":"contactRole","value":"BILLING"},
    {"property":"addressRole","value":"BILLING"},
    {"property":"invoiceType","value":"SUMMARY"},
    {"property":"invoiceDelivery","value":"EMAIL"},
    {"property":"paymentMethod","value":"CHECK"},
    {"property":"phoneType","value":"MOBILE"},
    {"property":"subscriptionStatus","value":"SUBMITTED"},
    {"property":"trialType","value":"BOTH"},
    {"property":"financeSyncBatchMode","value":"API"},
    {"property":"primaryTaxType","value":"Main"},
    {"property":"addOnTaxType","value":"Additional"},
    {"property":"defaultTaxRuleForAROps","value":"WITHOUT_TAX"},
    {"property":"defaultLanguage","value":"ENGLISH"},
    {"property":"templateType","value":"XSLT"},
    {"property":"taxExemptionMidStartCycle","value":"USE_FULL"},
    {"property":"taxExemptionEndCycle","value":"USE_FULL"},
    {"property":"initialTerm","value":"1"},
    {"property":"initialTermUnit","value":"YEARS"},
    {"property":"renewalTerm","value":"1"},
    {"property":"renewalTermUnit","value":"YEARS"},
    {"property":"advanceBillingInNoOfDays","value":"0"},
    {"property":"batchSizeBilling","value":"50"},
    {"property":"batchSizeInvoice","value":"60"},
    {"property":"batchSizePayment","value":"5"},
    {"property":"batchSizeCommon","value":"50"},
    {"property":"usageProcessBatchSize","value":"50"},
    {"property":"migrationBatchSize","value":"200"},
    {"property":"noOfThreads","value":"3"},
    {"property":"noOfJobThreads","value":"1"},
    {"property":"noOfBatchProcessThreads","value":"1"},
    {"property":"noOfBulkAdjustmentThreads","value":"3"},
    {"property":"dashboardMonths","value":"12"},
    {"property":"passwordExpiryInMonths","value":"30"},
    {"property":"archiveAccountTimeExpiry","value":"60"},
    {"property":"renewalReminderThreshold","value":"30"},
    {"property":"trialExpiryReminderThreshold","value":"10"},
    {"property":"exchangeThreshold","value":"0.05"},
    {"property":"roundingPrecisionForExchangeRate","value":"4"},
    {"property":"waitTimeForNextSequence","value":"60"},
    {"property":"minimumCreditNoteThreshold","value":"2"},
    {"property":"minimumDebitNoteThreshold","value":"2"},
    {"property":"notMoreThanDiscount","value":"100"},
    {"property":"financeSyncBatchSize","value":"5"},
    {"property":"coaExportFileName","value":"ExportCOA.csv"},
    {"property":"taxApplicable","value":"true"},
    {"property":"generateInvoicePdf","value":"true"},
    {"property":"revenueTracking","value":"true"},
    {"property":"allowUsageProcessing","value":"true"},
    {"property":"useAutoAllocation","value":"true"},
    {"property":"paymentNotification","value":"true"},
    {"property":"paymentFailureNotification","value":"true"},
    {"property":"invoiceReadyNotification","value":"true"},
    {"property":"invoiceDueNotification","value":"true"},
    {"property":"newSubscriptionNotification","value":"true"},
    {"property":"creditNoteReadyNotification","value":"true"},
    {"property":"recurringPeriodInInvoice","value":"true"},
    {"property":"invoiceEndDateInclusive","value":"true"},
    {"property":"isCollectionScheduleCached","value":"true"},
    {"property":"isCustomAttributeCached","value":"true"},
    {"property":"useGLCombination","value":"true"},
    {"property":"matchBillingEntries","value":"true"},
    {"property":"useShortBillingCycle","value":"true"},
    {"property":"useUsageStartTime","value":"true"},
    {"property":"triggerInvoicingOnNewSubsActivation","value":"true"},
    {"property":"triggerInvoicingWithPendingBill","value":"true"},
    {"property":"support29_30_31DayBilling","value":"true"},
    {"property":"autoReverseWriteoffOnPayment","value":"true"},
    {"property":"userInMultipleGroups","value":"true"},
    {"property":"accountOrderWrapperAPI","value":"true"},
    {"property":"getServiceViaServiceUnitProvId","value":"true"},
    {"property":"skipNetZeroGLExtract","value":"true"},
    {"property":"accumulatorBasedTaxThresholds","value":"true"},
    {"property":"avoidZeroAmountTaxTransaction","value":"true"},
    {"property":"skipGatewayAuthorizationApis","value":"/graphiql,/graphql,/reload,/generate-token,/processProvisioning,/paymentNotification"},
    {"property":"useCcpTime","value":"${ENV_USE_CCP_TIME}"},
    {"property":"testMode","value":"${ENV_TEST_MODE}"}
  ]
}
```

(~90 keys — the minimal viable set. Coope ran 198 because it carries provisioning + MX-tax + intercompany packs we deliberately leave off.)

---

## 6.3 — Apply it (`setCcpProperties` mutation)

```graphql
# graphql/setCcpProperties.graphql
mutation SetCcp($in: CcpPropertiesInput!) {
  setCcpProperties(input: $in) { ccpPropertyList { property value } }
}
```
```bash
kubectl -n acme port-forward svc/acme-service-transactional 8080:8080 &
curl -s -X POST localhost:8080/graphql -H 'Content-Type: application/json' \
  --data "$(jq -n --argjson in "$(cat templates/minimal/flags.rendered.json)" \
        '{query:"mutation SetCcp($in:CcpPropertiesInput!){setCcpProperties(input:$in){ccpPropertyList{property}}}",variables:{in:$in}}')" \
  | jq '.data.setCcpProperties.ccpPropertyList | length'   # == number of keys you sent
```
This upserts every key into `core_config.ccp_properties` **and** live-updates the Redis `ccpPropertiesMap` on the writing pod.

---

## 6.4 — Consistency gate (the anti-"config not found" check for L1↔L5)

Every PARAM flag must dereference to a real row. Run after applying:
```sql
SELECT 'L1_POINTERS' AS gate,
  EXISTS(SELECT 1 FROM core_config.config_chart_of_account_list
         WHERE accountnumber = (SELECT value FROM core_config.ccp_properties WHERE property='defaultGLAccount')) AS default_gl_ok,
  EXISTS(SELECT 1 FROM core_config.config_tax_types
         WHERE itemid = (SELECT value FROM core_config.ccp_properties WHERE property='taxationItemId'))          AS tax_item_ok,
  EXISTS(SELECT 1 FROM core_config.currencyList cl
         WHERE cl.currencyid = (SELECT value FROM core_config.ccp_properties WHERE property='defaultCurrency'))   AS currency_ok,
  EXISTS(SELECT 1 FROM core_config.payment_terms
         WHERE paymentterm = (SELECT value FROM core_config.ccp_properties WHERE property='paymentTerm'))         AS payterm_ok,
  EXISTS(SELECT 1 FROM core_config.product_family_list
         WHERE productfamily = (SELECT value FROM core_config.ccp_properties WHERE property='productFamily'))     AS prodfamily_ok;
```
**All must be `true`.** Any `false` = a dangling pointer; fix the L5 seed or the flag value before going further. (This single query is the highest-value safeguard in the whole process — it's exactly the class of bug that has been costing days.)

---

## 6.5 — Verify + the cache-propagation step (mandatory)

```graphql
query { getCcpProperties { ccpPropertyList { property value } } }   # returns the live set
```
```sql
SELECT count(*) FROM core_config.ccp_properties;   -- ~90 (your sent count + any from createTenant)
```
**Propagation:** `setCcpProperties` updated Redis on the `service-transactional` pod only. **Other engine-bearing pods (billing/invoice/payment/usage/…) cached `ccpPropertiesMap` at their boot.** So after the full flag load you must refresh them (covered fully in §8):
```bash
kubectl -n acme rollout restart deploy   # all engine-bearing deployments re-read ccp_properties at boot
```
Until you do this, a flag you just set may be honoured by `service-transactional` but ignored by `service-billing` — the classic "it works in one place but not another."

---

## 6.6 — Backout
```sql
-- remove the template flags (keep nothing tenant-business-specific here)
DELETE FROM core_config.ccp_properties
WHERE property = ANY (ARRAY[ /* the ~90 keys from flags.json */ ]);
-- and clear Redis so caches don't serve stale values:
--   redis-cli -h $REDIS_HOST DEL ccpPropertiesMap   (then rollout restart)
```
(Also run the one-time junk cleanup on any inherited env: `DELETE FROM core_config.ccp_properties WHERE property IN ('','property','2023-11-15','2024-01-01');`)

---

## 6.7 — What §6 produced / next
The tenant now has a complete, minimal, internally-consistent flag set; every pointer flag resolves to a seeded row; env-specific flags (`useCcpTime`,`testMode`) are set per environment. **Next: §7 (L6 — users + RBAC).** The `roles_*` tables are huge (e.g. `roles_report_permissions`=632, `roles_pricing_permissions`=557 on Coope) — hand-authoring is infeasible, so §7 uses a **pg_dump extract-replay** of the role catalog from a golden tenant + creation of one bootstrap admin user, and wires `selfcareRole`/`sysAdminUser` (the §6.1.1 "derive" items) to the seeded role/user ids. I have the `users`/`roles`/`role_groups` DDL already; I may ask you for one small dump (the list of `role_groups` + the admin role id) so the bootstrap user is linked to the right role.
