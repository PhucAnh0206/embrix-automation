# Part B · §5 — L2/L3: Tenant identity + merchants (via GraphQL `createTenant`)

> This is where we **stop using raw SQL and start driving the GraphQL onboarding API** on `service-transactional`. Tenant creation has validation, a multi-table cascade, and cache side-effects that hand-SQL would bypass — so we use the same `createTenant` path the Congero UI uses.
>
> ⚠️ **Two non-obvious gates that will bite your team if undocumented (both verified in `PGTenantService.create`):**
> 1. **The tenant `id` does NOT come from the mutation.** It is injected from the Spring property `tenant.id` (= Helm `app.tenantId`, e.g. `TIDLT-100007`). `createTenant` literally does `tenant.id = tenantId`. ⇒ **one tenant per service deployment**, and you must set `app.tenantId` correctly in Part A *before* calling this.
> 2. **`validateCreate` requires EXACTLY 3 merchant accounts**, of 3 distinct types, and the `FINANCE_GATEWAY`/`PAYMENT_GATEWAY`/`TAX_GATEWAY` ones must each carry **every** URL-type enum value, plus the auth attributes for their `authType`. You cannot create a "bare" tenant. This is by design and it's why the API is safer than copy-paste SQL.

---

## 5.0 — Why GraphQL here, not SQL

For L5/L4 we used SQL because that data is static and has no behavioural side-effects. Tenant/merchant creation is different:

1. **Validation** — `validateCreate` (below) enforces a complete, internally-consistent merchant config. Raw SQL would let you insert a half-configured tenant that *looks* fine and fails at the first gateway call.
2. **Cascade** — one `createTenant` call writes `tenant`, `tenant_profile`, three `tenant_merchants`, all the `*_gateway_attributes` + auth attribute rows, **and** the `ccp_properties` (via the nested `tenantPropertyDefaults` → `PGTenantPropertyDefaultsService.create` → `setCcpProperties`). Replicating that ordering and the index assignment (`it.index = ++index`) by hand is error-prone.
3. **Cache** — merchant/gateway config is cached in the gateways; the onboarding flow is the one the platform expects (and `modifyTenant` even calls `reloadMerchantGateway`). See §5.6.

So: **L2 (`tenant`,`tenant_profile`) + L3 (`tenant_merchants`,`*_gateway_attributes`) + part of L1 (`ccp_properties`) are all created by a single `createTenant` mutation.**

---

## 5.1 — The `createTenant` contract (real schema)

Mutation entry point: `service-transactional MutationResolver.createTenant(TenantInput)` (`:2571`) → `tenantService.create`.

`TenantInput` (real `.graphqls`):
```graphql
input TenantInput {
    name: String!
    licenseKey: String!
    vaultUri: String!
    vaultPath: String!
    tenantProfile: TenantProfileInput!
    tenantMerchantAccounts: [TenantMerchantAccountsInput!]!   # EXACTLY 3 (see 5.2)
    tenantPropertyDefaults: TenantPropertyDefaultsInput!       # the typed L1 flags
}
```

`TenantProfileInput` (all the `!` fields are mandatory):
```graphql
input TenantProfileInput {
    number: Int!  street: String!  city: String!  state: String!
    country: Country!            # scalar; pass the country NAME that exists in country_codes (L5 §3.2)
    postalCode: String!  enquiryEmail: String!  enquiryPhone: String!
    companyTaxId: String!  companyTag: String!
    logoPath: String  extraLine: String  landMark: String  code: String
    companyTaxRegime: String  externalUid: String  pacUrl: String  taxVersion: String
}
```

`TenantMerchantAccountsInput` (per merchant):
```graphql
input TenantMerchantAccountsInput {
    type: MerchantType!          # CRM_GATEWAY|FINANCE_GATEWAY|PAYMENT_GATEWAY|TAX_GATEWAY|... (9)
    name: MerchantName!          # EMBRIX|DEFAULT|COOPEWEB|AVALARA|... (20)
    startDate: Date!             # 'YYYY-MM-DD'
    validity: Int!
    authType: MerchantAuthType!  # HTTP_BASIC|JSON_WEB_TOKEN|OAUTH1|OAUTH2|API_KEY
    status: MerchantStatus!      # ACTIVE|INACTIVE
    webApiType: WebApiType
    country: String
    financeGatewayAttributes: [FinanceGatewayAttributesInput]
    paymentGatewayAttributes: [PaymentGatewayAttributesInput]
    taxGatewayAttributes: [TaxGatewayAttributesInput]
    crmGatewayAttributes: [CrmGatewayAttributesInput]
    # ...documentGatewayAttributes, operationGatewayAttributes, etc.
    httpBasicAttributes: [HttpBasicAttributesInput]   # required when authType=HTTP_BASIC
    jwtAttributes: [JWTAttributesInput]               # required when authType=JSON_WEB_TOKEN
    oauthAttributes: [OAuthAttributesInput]           # required when authType=OAUTH2
    apiKeyAttributes: [ApiKeyAttributesInput]
    oauth1Attributes: [OAuth1AttributesInput]
}
```
Each `*GatewayAttributesInput` is `{ type: <UrlTypeEnum>!, url: String!, apiType, apiProtocol, payloadMapOnly }`. `HttpBasicAttributesInput` is `{ clientId!, clientProfileId!, username!, password! }`.

---

## 5.2 — The validation gate (memorize this; it's the #1 createTenant failure)

From `PGTenantService.validateCreate`:

```
size(tenantMerchantAccounts) == 3   AND   distinct(type) == 3      else -> MISSING_A_MERCHANT_FOR_A_GATEWAY
for each merchant:
   type=FINANCE_GATEWAY  -> financeGatewayAttributes must cover ALL FinanceGatewayUrlType  (else MISSING_MANDATORY_GATEWAY_INPUT)
   type=PAYMENT_GATEWAY  -> paymentGatewayAttributes must cover ALL PaymentGatewayUrlType
   type=TAX_GATEWAY      -> taxGatewayAttributes    must cover ALL TaxGatewayUrlType
   authType=HTTP_BASIC   -> httpBasicAttributes present (else MISSING_MANDATORY_AUTH_INPUT)
   authType=JSON_WEB_TOKEN -> jwtAttributes present
   authType=OAUTH2       -> oauthAttributes present
```

So the **canonical minimal trio is `FINANCE_GATEWAY` + `PAYMENT_GATEWAY` + `TAX_GATEWAY`**, each ACTIVE/INACTIVE but **fully populated**. The complete URL-type sets you must provide (from the real enums):

| Gateway | Required URL types (ALL must be present) |
|---------|------------------------------------------|
| **TAX_GATEWAY** (6) | `ADDRESS_LOOKUP, BASE_URL, CALCULATE_TAX, CREATE_CONFIG, MODIFY_CONFIG, READ_CONFIG` |
| **PAYMENT_GATEWAY** (9) | `BASE_URL, AUTHORIZE_CREDIT_CARD, CAPTURE_CREDIT_CARD, CREDIT_CREDIT_CARD, VOID_CREDIT_CARD, AUTHORIZE_ECHECK, CAPTURE_ECHECK, CREDIT_ECHECK, VOID_ECHECK` |
| **FINANCE_GATEWAY** (17) | `BASE_URL, CREATE_AROPS, CREATE_CREDIT_NOTES, CREATE_CUSTOMER, CREATE_INVOICE, CREATE_JOURNAL, CREATE_PAYMENT, CREATE_REVENUE, GET_AUTHORIZATION_TOKEN, MODIFY_CUSTOMER, SEND_ACCOUNTING_EXTRACT, SEND_INVOICE, CREATE_COA, MODIFY_COA, MODIFY_JOURNAL, READ_COA, RUN_REPORT` |

> The check is `EnumType.values().size() == inputSet.size()` — it counts **distinct types in your input**, so you must supply one attribute row per enum value (duplicates won't help; missing one fails).

### 5.2.1 ⚠️ Verified drift: GraphQL enum vs DB enum (read before createTenant)

The live-DB enum query (2026-05-30) revealed the GraphQL enums (used by `validateCreate`) and the `core_enums.*` (the FK constraint) **diverge on the demo DB**:

| Gateway | GraphQL enum (validation counts) | Live DB `core_enums.*` | Conflict |
|---------|----------------------------------|------------------------|----------|
| TAX (`tax_gateway_url_type`) | 6 | 6 (identical) | none ✅ |
| FINANCE (`finance_gateway_url_type`) | 17 (incl. `SEND_INVOICE`) | 16 (**no `SEND_INVOICE`**) | sending 17 → FK fails on SEND_INVOICE; sending 16 → validation wants 17 |
| PAYMENT (`payment_gateway_url_type`) | 9 (incl. `BASE_URL`) | 13 (**no `BASE_URL`**; has AUTHORIZE/CAPTURE/CREDIT/VOID/BATCH) | sending 9 → FK fails on BASE_URL |

This is **schema-vs-code version drift** (the demo's Flyway is frozen at 2021). A correctly-migrated *fresh* tenant should have `core_enums.*` matching its deployed code's GraphQL enum — but **you must verify, because if they don't match, `createTenant` for that gateway is impossible** (you can't satisfy both the validation count and the FK at once).

**Mandatory precheck — run on the TARGET tenant DB before createTenant:**
```sql
SELECT 'tax' g,     string_agg(name,', ' ORDER BY name) FROM core_enums.tax_gateway_url_type
UNION ALL SELECT 'finance', string_agg(name,', ' ORDER BY name) FROM core_enums.finance_gateway_url_type
UNION ALL SELECT 'payment', string_agg(name,', ' ORDER BY name) FROM core_enums.payment_gateway_url_type;
```
Then build each merchant's attribute set in `createTenant.vars.json` to **exactly equal the DB list** for that gateway. If the DB list count ≠ the GraphQL enum count, `validateCreate` will reject it → escalate to the dev team (the migration and the `*GatewayUrlType` enum are out of sync), or seed `tenant_merchants` + `*_gateway_attributes` directly via SQL (bypassing the GraphQL validation) as a fallback. The shipped `createTenant.vars.json.tmpl` uses the current-code (GraphQL) sets — adjust to the precheck output if they differ.

**"No integration yet" tenant:** you still provide all three. Point the URLs at the internal service DNS (`http://<tenant>-tax-gateway`, `…-finance-gateway`, `…-payment-gateway`) or a stub, set `status: INACTIVE` for the ones not live yet (the rows are still required), `authType: HTTP_BASIC` with placeholder creds. The `if(flag)->do X` model means nothing *calls* an INACTIVE gateway until you enable it.

---

## 5.3 — The full `createTenant` mutation (minimal tenant, copy-paste)

Saved as `graphql/createTenant.graphql` (query) + `graphql/createTenant.vars.json` (variables). Variables for `acme` (a no-external-integration tenant: tax→internal EMBRIX, finance/payment→stub/INACTIVE):

```graphql
# graphql/createTenant.graphql
mutation CreateTenant($t: TenantInput!) {
  createTenant(tenant: $t) { id name }
}
```

```jsonc
// graphql/createTenant.vars.json  — fill <…> from the Part A parameter sheet
{
  "t": {
    "name": "Acme Telecom",
    "licenseKey": "<license issued for TIDLT-100010>",
    "vaultUri": "http://acme-vault-interface/",
    "vaultPath": "secret/acme",
    "tenantProfile": {
      "number": 1, "street": "1 Main St", "city": "San Jose", "state": "CA",
      "country": "United States",          // MUST exist in core_config.country_codes (L5 §3.2)
      "postalCode": "95110",
      "enquiryEmail": "billing@acme.example", "enquiryPhone": "+1-555-0100",
      "companyTaxId": "ACME-TAXID-001", "companyTag": "ACME"
    },
    "tenantMerchantAccounts": [
      {
        "type": "TAX_GATEWAY", "name": "EMBRIX", "startDate": "2026-01-01",
        "validity": 3650, "authType": "HTTP_BASIC", "status": "ACTIVE",
        "taxGatewayAttributes": [
          {"type":"BASE_URL","url":"http://acme-tax-gateway"},
          {"type":"CALCULATE_TAX","url":"http://acme-tax-gateway/calculateTax"},
          {"type":"ADDRESS_LOOKUP","url":"http://acme-tax-gateway/addressLookup"},
          {"type":"CREATE_CONFIG","url":"http://acme-tax-gateway/createConfig"},
          {"type":"MODIFY_CONFIG","url":"http://acme-tax-gateway/modifyConfig"},
          {"type":"READ_CONFIG","url":"http://acme-tax-gateway/readConfig"}
        ],
        "httpBasicAttributes":[{"clientId":"acme","clientProfileId":"acme","username":"svc","password":"<stub>"}]
      },
      {
        "type": "PAYMENT_GATEWAY", "name": "DEFAULT", "startDate": "2026-01-01",
        "validity": 3650, "authType": "HTTP_BASIC", "status": "INACTIVE",
        "paymentGatewayAttributes": [
          {"type":"BASE_URL","url":"http://acme-payment-gateway"},
          {"type":"AUTHORIZE_CREDIT_CARD","url":"http://acme-payment-gateway/authCC"},
          {"type":"CAPTURE_CREDIT_CARD","url":"http://acme-payment-gateway/captureCC"},
          {"type":"CREDIT_CREDIT_CARD","url":"http://acme-payment-gateway/creditCC"},
          {"type":"VOID_CREDIT_CARD","url":"http://acme-payment-gateway/voidCC"},
          {"type":"AUTHORIZE_ECHECK","url":"http://acme-payment-gateway/authEC"},
          {"type":"CAPTURE_ECHECK","url":"http://acme-payment-gateway/captureEC"},
          {"type":"CREDIT_ECHECK","url":"http://acme-payment-gateway/creditEC"},
          {"type":"VOID_ECHECK","url":"http://acme-payment-gateway/voidEC"}
        ],
        "httpBasicAttributes":[{"clientId":"acme","clientProfileId":"acme","username":"svc","password":"<stub>"}]
      },
      {
        "type": "FINANCE_GATEWAY", "name": "DEFAULT", "startDate": "2026-01-01",
        "validity": 3650, "authType": "HTTP_BASIC", "status": "INACTIVE",
        "financeGatewayAttributes": [
          {"type":"BASE_URL","url":"http://acme-finance-gateway"},
          {"type":"CREATE_AROPS","url":"http://acme-finance-gateway/createArops"},
          {"type":"CREATE_CREDIT_NOTES","url":"http://acme-finance-gateway/createCreditNotes"},
          {"type":"CREATE_CUSTOMER","url":"http://acme-finance-gateway/createCustomer"},
          {"type":"CREATE_INVOICE","url":"http://acme-finance-gateway/createInvoice"},
          {"type":"CREATE_JOURNAL","url":"http://acme-finance-gateway/createJournal"},
          {"type":"CREATE_PAYMENT","url":"http://acme-finance-gateway/createPayment"},
          {"type":"CREATE_REVENUE","url":"http://acme-finance-gateway/createRevenue"},
          {"type":"GET_AUTHORIZATION_TOKEN","url":"http://acme-finance-gateway/token"},
          {"type":"MODIFY_CUSTOMER","url":"http://acme-finance-gateway/modifyCustomer"},
          {"type":"SEND_ACCOUNTING_EXTRACT","url":"http://acme-finance-gateway/sendExtract"},
          {"type":"SEND_INVOICE","url":"http://acme-finance-gateway/sendInvoice"},
          {"type":"CREATE_COA","url":"http://acme-finance-gateway/createCoa"},
          {"type":"MODIFY_COA","url":"http://acme-finance-gateway/modifyCoa"},
          {"type":"MODIFY_JOURNAL","url":"http://acme-finance-gateway/modifyJournal"},
          {"type":"READ_COA","url":"http://acme-finance-gateway/readCoa"},
          {"type":"RUN_REPORT","url":"http://acme-finance-gateway/runReport"}
        ],
        "httpBasicAttributes":[{"clientId":"acme","clientProfileId":"acme","username":"svc","password":"<stub>"}]
      }
    ],
    "tenantPropertyDefaults": {
      "defaultCurrency": "USD",
      "billingDom": 1,
      "billingFrequency": "MONTHLY",
      "paymentTerm": "NET_15",
      "taxApplicable": true,
      "generateInvoicePdf": true
      // §6 expands this to the full minimal flag set; createTenant only needs a valid subset here.
    }
  }
}
```

> ⚠️ `EMBRIX`/`DEFAULT` must be valid `MerchantName` enum values (they are — see the 20-value enum). `country` must be a `name` you seeded in `country_codes`. `startDate` is `YYYY-MM-DD`. If you set `status: INACTIVE` on finance/payment, you're telling the platform "configured but not live" — exactly the "no integration yet" state.

---

## 5.4 — How to call it (against `service-transactional` in the namespace)

```bash
# port-forward the GraphQL endpoint
kubectl -n acme port-forward svc/acme-service-transactional 8080:8080 &

# fire the mutation (assemble query+vars into one JSON body)
jq -n --slurpfile q <(jq -Rs . graphql/createTenant.graphql) \
      --slurpfile v graphql/createTenant.vars.json \
      '{query: $q[0], variables: $v[0].t | {t: .}}' > /tmp/body.json
# (or just hand-build {"query":"...","variables":{...}} )

curl -s -X POST localhost:8080/graphql \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <token if required>" \
  --data @/tmp/body.json | jq .
```
Success → `{"data":{"createTenant":{"id":"TIDLT-100010","name":"Acme Telecom"}}}`. The returned `id` is the Helm `app.tenantId` (proving gate #1). A validation failure returns a GraphQL error with `MISSING_A_MERCHANT_FOR_A_GATEWAY` / `MISSING_MANDATORY_GATEWAY_INPUT` / `MISSING_MANDATORY_AUTH_INPUT` — map it straight back to §5.2.

> Auth: if `service-transactional` requires a JWT, the demo flag `skipGatewayAuthorizationApis` lists bypass paths (`/graphql`,`/reload`,…). On a fresh tenant you may bootstrap with the bypass or a system token; see §7 (users) for issuing real tokens.

---

## 5.5 — What `createTenant` actually wrote (so you can verify/trust it)

In one transaction (`@Transactional`), in this order (from `PGTenantService.create`):
1. `core_config.tenant` — `uuid`, `id`(=app.tenantId), `name`, `vaulturi`, `vaultpath`, `licensekey`, `createddate`.
2. `core_config.tenant_profile` — `id`, address, `enquiryemail/phone`, `companytaxid`, `companytag`, and **`companyname` set from `tenant.name`**.
3. `core_config.tenant_merchants` ×3 — `id`, `index`(=1,2,3 via `++index`), `name`,`type`,`status`,`authtype`,`startdate`,`validity`,`webapitype`,`country`; plus the matching `*_gateway_attributes` rows and the auth attr rows (`http_basic_attributes` etc.), keyed by `(id,index,refindex)`.
4. `core_config.ccp_properties` — via `tenantPropertyDefaults` → flags upserted (this is the **L1 overlap**: the typed subset of flags is set here; §6 finishes the rest via `setCcpProperties`).

---

## 5.6 — Cache reload side-effect (don't skip)

`modifyTenant` calls `tenantMerchantAccountsService.reloadMerchantGateway(...)` (`MutationResolver:2585`) precisely because gateways cache merchant config. `createTenant` itself relies on fresh boot, but after you create/modify a tenant on already-running gateways, you must reload so the gateways pick up the new merchant rows. Two ways (both in §8):
- hit each gateway's `/reload` endpoint (it's in the `skipGatewayAuthorizationApis` bypass list, so no token needed), or
- `kubectl -n <tenant> rollout restart deploy` for the gateways.

---

## 5.7 — Verification gate (before §6)

```sql
SELECT 'L2L3_GATE' AS gate,
  (SELECT count(*) FROM core_config.tenant)                          AS tenants,         -- expect 1
  (SELECT id FROM core_config.tenant LIMIT 1)                        AS tenant_id,       -- == app.tenantId
  (SELECT count(*) FROM core_config.tenant_profile)                  AS profiles,        -- 1
  (SELECT count(*) FROM core_config.tenant_merchants)                AS merchants,       -- 3
  (SELECT string_agg(type, ',' ORDER BY type) FROM core_config.tenant_merchants) AS merchant_types,
  (SELECT count(*) FROM core_config.tax_gateway_attributes)          AS tax_attrs,       -- 6
  (SELECT count(*) FROM core_config.payment_gateway_attributes)      AS pay_attrs,       -- 9
  (SELECT count(*) FROM core_config.finance_gateway_attributes)      AS fin_attrs;       -- 17
```
Also confirm via the API (proves the read path + the id-from-property behaviour):
```graphql
query { getTenant(input:{dummy:"x"}) { id name tenantMerchantAccounts { type status } } }
```

---

## 5.8 — Backout (delete the tenant)

There's no `deleteTenant` mutation in the core path, so backout is scoped SQL (children → parents). Because the whole DB is the tenant's, the simplest full revert is to re-run L0/L5 fresh; for a surgical undo:
```sql
BEGIN;
DELETE FROM core_config.tax_gateway_attributes      WHERE id = :tenant_id;
DELETE FROM core_config.payment_gateway_attributes  WHERE id = :tenant_id;
DELETE FROM core_config.finance_gateway_attributes  WHERE id = :tenant_id;
DELETE FROM core_config.http_basic_attributes       WHERE id = :tenant_id;
-- (repeat for any jwt/oauth/apikey/oauth1 attrs used)
DELETE FROM core_config.tenant_merchants            WHERE id = :tenant_id;
DELETE FROM core_config.tenant_profile              WHERE id = :tenant_id;
DELETE FROM core_config.tenant                      WHERE id = :tenant_id;
-- ccp_properties set via tenantPropertyDefaults are cleared in §6 backout
COMMIT;
```

---

## 5.9 — Implications you must brief the team on

- **One tenant per `service-transactional` deployment.** Because `tenant.id` = `${tenant.id}` property and `getById` ignores its argument and reads the property, a single deployment serves a single tenant. Multi-tenant = multi-namespace (the D5 model). Don't try to `createTenant` twice in one namespace expecting two tenants.
- **`app.tenantId` is load-bearing.** A typo there → tenant created under the wrong id → every downstream lookup (which also reads the property) silently targets the wrong/empty tenant. Verify §5.7 `tenant_id == app.tenantId`.
- **The 3-gateway completeness rule is non-negotiable.** Build the merchant block from the URL-type tables in §5.2; missing one value = whole mutation rejected.
- **`createTenant` already seeded part of L1.** §6 is additive (`setCcpProperties`) for the flags not on `TenantPropertyDefaults` — it won't duplicate what you set here.

---

## 5.10 — What §5 produced / next

`tenant` + `tenant_profile` + 3 complete merchant gateways + their attributes are in place, the tenant id is anchored to the deployment, and the typed subset of L1 flags is set. **Next: §6 (L1 — the full `ccp_properties` flag set)** via `setCcpProperties`, generated from the demo-dump analysis in `GUIDE.md` §1.4 (the minimal-ON set, the raw-only flags, the Coope-specific values stripped). I already have the 198-key dump and the `TenantPropertyDefaults` field list, so §6 needs no new query — I'll produce `templates/minimal/flags-raw.json` + the `setCcpProperties` calls + the consistency checks against L5 pointers.
