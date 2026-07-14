# Embrix O2X — New-Tenant Provisioning: Build Guide (from scratch)

> A step-by-step, runnable engineering guide to stand up a **brand-new tenant environment** (sandbox or production) from a **minimal, generic, parameterized template**, wired into GitLab CI/CD, with a clean backout.
>
> This is not a summary. Every layer below comes with: (a) *why* it exists, (b) the *exact* tables/columns/code involved (verified against `engine` source and the live demo DB `coopegsbx2-dev-db`), and (c) the *actual* migration/SQL/GraphQL you run.
>
> **Decisions locked (Huy, 2026-05-29):** full lifecycle designed / config-seed delivered first; **hybrid** apply (versioned SQL for tenant-identical static data + GraphQL onboarding API for tenant-specific config); template is a **purpose-built minimal generic** config, portable to any new tenant by parameter substitution.

---

## ⚡ Start here by role
- **Provisioning a tenant?** → `README.md` (copy/fill/run in 4 lines), then `CHEATSHEET.md` (commands only).
- **First time ever running it?** → `DRY-RUN-CHECKLIST.md` (guided rehearsal on a throwaway tenant, per-role commands + gates).
- **Leading the team / who-does-what?** → `ROLES-AND-RUNBOOK.md` (DevOps vs Developer vs QE, Helm-vs-DB config split, handoff checklists).
- **What does each script do?** → `SCRIPTS-REFERENCE.md` (plain-language: what/how/expect).
- The docs below are the *why* behind each step.

## Document map (read in this order)

| File | What it covers | Status |
|------|----------------|--------|
| **`DIAGRAMS.md`** | 5 flow diagrams (plain text/ASCII): system topology, end-to-end provisioning sequence, config-dependency graph, CI/CD, tenant isolation | ✅ done |
| **`PART-A-INFRASTRUCTURE.md`** | AWS (RDS/Redis/MQ/S3/Vault/License) → EKS namespace + secrets → images → Helm deploy → new GitLab job. Grounded in your real CI/Helm/Docker | ✅ done |
| **`GUIDE.md`** (this file) | §1 config model + §2 L0 schema bootstrap | ✅ §1–§2 done |
| **`PART-B-S3-REFERENCE.md`** | §3 L5 reference data: currency, country, UOM, product family, Chart-of-Accounts/GL, tax, AR items/reason codes, payment, credit, operating unit, invoice config — column-exact parameterized INSERTs | ✅ done |
| **`PART-B-S4-CANONICAL.md`** | §4 L4 canonical maps: integration catalog, minimal EMBRIX set, extract-once→replay-per-provider tooling | ✅ done |
| **`PART-B-S5-TENANT.md`** | §5 L2/L3 tenant + 3 mandatory merchants via `createTenant` (incl. the id-from-Helm + 3-gateway-completeness gates) | ✅ done |
| **`PART-B-S6-FLAGS.md`** | §6 L1 `ccp_properties`: minimal generic flag set, PARAM/KEEP/ENV/OFF/DROP classification, pointer-consistency gate | ✅ done |
| **`PART-B-S7-USERS.md`** | §7 L6 users + RBAC: extract-replay role catalog (pg_dump), bootstrap admin via `createUser` (Vault-encrypted pwd), resolve `selfcareRole`/`sysAdminUser` | ✅ done |
| **`SERVICES-AND-GATEWAYS.md`** | Component catalog: all 11 core services + 5 gateways + 2 UIs + vault-interface — purpose, config, call-graph, mandatory-vs-deferred, minimal deploy set | ✅ done |
| **`DOMAIN-FLOWS.md`** | The "what actually happens": AMQ backbone + queue-prefix isolation, full order→bill→invoice→payment→revenue lifecycle per-stage config, OMS tasks, provisioning sequences, document/invoice rendering, AR/collections, scheduled jobs, supporting-config long tail — each tagged seed/defer/verify | ✅ done |
| **`PART-B-S8-SUPPORTING.md`** | §8 operational config: OMS task pipeline, daily jobs, collections/dunning + payment allocation, calendar/work-week/holidays, correspondence templates, invoice/doc stylesheets, + singletons (invoice-number sequence, ccp_time clock, JWT token expiry). Built from real golden rows. Scripts `sql/05,30,31,32,34,35` | ✅ done |
| **`PART-A2-VAULT-SECRETS.md`** | Vault transit-key setup (the silent-failure gap): `tenantId123` password key + MQ-cred key, encrypt round-trip verification — blocks §7/§8 if missing | ✅ done |
| **`PART-C-OPS.md`** | §9 cache reload+propagation · §10 smoke verification (order→invoice→payment) · §11 GitLab provision pipeline · §12 backout | ✅ done |
| **`RUN-ORDER.md`** | 🎯 the ordered master runbook — Phase 0 profile → 1 infra → 2 vault → 3 seed (bottom-up) → 4 reload+verify → 5 repeat/teardown | ✅ done |
| **`README.md`** | front door: copy/fill/run quickstart + folder map | ✅ done |
| **`ROLES-AND-RUNBOOK.md`** | who does what (DevOps/Dev/QE), Helm-vs-DB config model, RACI, handoffs, failure→owner | ✅ done |
| **`SCRIPTS-REFERENCE.md`** | every script/SQL/template in plain language (what/who/run/expect/if-fails) | ✅ done |
| **`DRY-RUN-CHECKLIST.md`** | guided first rehearsal: per-role commands + expected output + ✅ boxes; resolves the 2 live-only unknowns | ✅ done |
| **`CHEATSHEET.md`** | one-screen commands-only sequence for repeat runs | ✅ done |
| **artifacts** | `sql/` (00-verify, 00-params.tmpl, 05-singletons, 10-reference, 20-canonical-embrix, 21-canonical-jars[opt], 30-oms, 31-jobs, 32-collections, 34-correspondence, 35-invoice-template, smoke-verify) · `graphql/` (createTenant, setCcpProperties, createUser + .vars.tmpl) · `scripts/` (provision, render, gql, reload, replay-canonical, replay-rbac, backout) · `templates/minimal/flags.json` · `tenants/_TEMPLATE/tenant.env` | ✅ done |

> **The big picture:** Part A gets services *running but empty*. Part B (this file) seeds the *config that makes them work*. Part C operates it (reload, verify, CI/CD, backout). Start at `DIAGRAMS.md` D1/D2 for the mental model, then `PART-A`, then come back here.

## How this guide is organized

The work is split into **layers** applied in strict order — each references the one beneath it (see `DIAGRAMS.md` D3, the dependency graph).

| Layer | Name | What it produces | Apply method | Where |
|------:|------|------------------|--------------|-------|
| **LA1** | AWS resources | RDS db, Redis, MQ prefix, Vault, license | AWS CLI / DBA | PART-A §A.2 |
| **LA2** | EKS namespace + secrets | namespace, `pg-secret`, `app-vault-token` | kubectl | PART-A §A.3 |
| **LA3** | Helm deploy | all services running (empty DB) | `helm upgrade` | PART-A §A.5 |
| L0 | Schema + enums | schemas, enum tables, tables, functions | Flyway / baseline SQL | §2 |
| L5 | Reference data | currency, country, UOM, Chart-of-Accounts/GL, tax types, AR item types, payment allocation | Versioned SQL seed | §3 |
| L4 | Canonical maps | `gateway_api_map` + request/response maps | Versioned SQL seed | §4 |
| L2 | Tenant identity | `tenant`, `tenant_profile` | GraphQL `createTenant` | §5 |
| L3 | Merchant/integration | `tenant_merchants`, `*_gateway_attributes` | GraphQL `createTenant` (nested) | §5 |
| L1 | Feature flags / defaults | `ccp_properties` (198 keys on demo) | GraphQL `createTenant` + `setCcpProperties` | §6 |
| L6 | Users / RBAC | `users`, `roles_*`, `role_groups` (large — see inventory) | SQL seed + GraphQL | §7 |
| — | Cache reload + verify | Redis `ccpPropertiesMap`, gateway `/reload` | scripts | §8 |
| — | CI/CD pipeline | GitLab parameterized provision pipeline | `.gitlab-ci.yml` | §9 |
| — | Backout | Revert to out-of-box | `backout.sh` | §10 |

> ⚠️ **The single most important rule:** L1 (`ccp_properties`) contains *string pointers* — `defaultGLAccount=10001`, `taxationItemId=CTG-TaxationItemId`, `productFamily=...`. Those values must already exist as rows in L5/lower. If you seed L1 before L5, the engine boots but every flow that dereferences the pointer fails at runtime (often silently, because the read pattern is `if (x) ...`). **Bottom-up, always.**

---

## §1 — The configuration model (read this before touching anything)

### 1.1 Why Embrix behaves the way it does

Embrix is a **config-driven monolith-of-services**. There is almost no behaviour hard-coded into the engine that you cannot turn on/off or re-point through configuration. The single most pervasive idiom in the codebase is:

```groovy
if (ccpPropertiesMap.get(SOME_FLAG)) {
    // ... do behaviour X ...
}
// else: behaviour is simply skipped — no error, no log, nothing
```

That one line explains the entire pain your team has been living with. When Jeremy copied the config table over from Congero without understanding it, three things happened:

1. **Flags that should have been ON were absent** → the corresponding behaviour silently did nothing. No exception. The system just "doesn't do that thing," and you spend a day finding out why.
2. **Flags that pointed at IDs (GL accounts, tax items) were copied, but the rows they point at were not** → the flag is "on," the code runs, dereferences a missing row, and *then* you get a hard failure ("config not found", NPE, or an empty result that breaks downstream).
3. **Junk crept in** (we'll see literal proof below) → the config table is the source of truth for the entire platform, and it had garbage rows in it.

So the mental model you must hold for the rest of this guide is: **the database *is* the application's behaviour.** Provisioning a tenant is not "installing software," it is "writing a correct, minimal, internally-consistent set of configuration rows in the right order." The services are stateless shells around that configuration.

### 1.2 What "ccpConfig" actually is — `core_config.ccp_properties`

The thing your colleagues call "the ccp config table" is physically `core_config.ccp_properties`. Confirmed shape (from the live demo DB — 198 rows — and the DTO `engine/.../ccpUtils/dto/CcpProperty.groovy`):

```sql
-- core_config.ccp_properties
property  VARCHAR   -- the key, e.g. 'defaultCurrency'
value     VARCHAR   -- the value as text, e.g. 'CRC' or 'true' or '50'
```

That's it. A flat key/value store. Every value is text; the engine coerces it (`Boolean.valueOf`, `Integer.valueOf`, `Enum.valueOf`) at read time. There is no type column, no tenant column, no "enabled" column — **presence + value is the entire contract.**

### 1.3 The lifecycle of a flag (boot → cache → read → write)

This is the part nobody documented, and it's why "I changed the config but nothing happened" keeps biting you.

**(a) Boot / load.** When an engine-bearing service starts, `PGCcpPropertiesService.getCcpProperties()` (`engine/.../ccpUtils/service/impl/PGCcpPropertiesService.groovy`) runs under `@PostConstruct`. It does `SELECT * FROM core_config.ccp_properties`, loads every row into:
- a Redis hash named **`ccpPropertiesMap`** (`redisTemplate.opsForHash().putAll('ccpPropertiesMap', ...)`), and
- a JVM-static `LinkedHashMap` `ccpPropertiesMapCache`.

**(b) Read.** Business code reads through `PGccpPropertiesMap.get(name)` (`PGccpPropertiesMap.groovy`). The lookup order is **Redis first**, DB fallback:

```groovy
String get(String propertyName) {
    def cache = redisTemplate.opsForHash().entries('ccpPropertiesMap')
    String v = cache?.get(propertyName)
    if (!v) { v = (select value from ccp_properties where property = :name) }   // DB fallback
    return v
}
```

**(c) Write.** Two ways, and the difference matters:
- **Typed:** `PGTenantPropertyDefaultsService.create/modify` takes the ~250-field `TenantPropertyDefaults` DTO and `manageProperties()` translates each populated field into a `(property, value)` pair, then calls `setCcpProperties`. This is the path the **Congero UI** uses, and it's why the flag names look like Java field names (`defaultCurrency`, `billingDom`, `paymentTerm`). Constants live in `common/.../PropertiesConstants`.
- **Raw:** `setCcpProperties(CcpPropertiesInput)` (GraphQL mutation, `service-transactional MutationResolver.groovy:2287`) writes arbitrary `(property, value)` pairs. **This is the only way to set flags that are not fields on `TenantPropertyDefaults`** (see §1.6 — there are several in the demo dump).

Both write paths do `INSERT ... ON CONFLICT`-style upsert (`findCcpProperty` then `create` or `modify`) **and** update the Redis hash live. So a write *is* immediately visible to the writing service.

**(d) The propagation trap.** Here is the gotcha that wastes days: `setCcpProperties` updates Redis, and `PGccpPropertiesMap.get()` reads Redis-first, so the **writing** pod sees the change instantly. But every **other** engine-bearing pod (billing, invoice, payment, transactional…) also built the JVM-static `ccpPropertiesMapCache` at its own boot, and some code paths historically read that static cache. More importantly, **gateway/merchant config is cached separately** and only refreshed by an explicit `reloadMerchantGateway` call (we saw `modifyTenant` invoke it at `MutationResolver.groovy:2585`). 

➡️ **Operational rule:** after seeding a fresh tenant, either seed *before* services boot, or **roll the engine-bearing pods** (and hit the gateway `/reload` endpoint) so every JVM rereads. This is a mandatory step in §8, not optional hygiene.

### 1.4 The demo dump, dissected (this is your raw material for the template)

You pasted the full 198-row `ccp_properties` from `coopegsbx2-dev-db` (a Coope/Coopeguanacaste, Costa Rica tenant). I've classified every meaningful row into four buckets, because each bucket is handled differently by the template.

**Bucket A — Identity / reference-pointers (MUST resolve to L5 rows; parameterize per tenant):**

| property | demo value | points at | template treatment |
|----------|-----------|-----------|--------------------|
| `currency`, `defaultCurrency` | `CRC` | `core_config.currency` / `currencylist` | **parameter** `${CURRENCY}` |
| `defaultGLAccount` | `10001` | `config_chart_of_account_list` | **parameter** (must seed matching GL row in L5) |
| `taxationItemId` | `CTG-TaxationItemId` | tax item config | **parameter** (seed matching tax item) |
| `legalEntity` | `Coopeguanacaste` | legal-entity config | **parameter** `${LEGAL_ENTITY}` |
| `sellingCompany` | `0900` | company config | **parameter** |
| `organization` | `Pespi` | org config | **DROP** (looks like leftover test data) |
| `lineOfBusiness` | `ISP` | — | **parameter** (default `ISP`) |
| `selfcareRole` | `500076` | `core_config.roles` | **derive** from L6 seed (don't hardcode) |
| `quickbooksRefreshToken` | `Q011561274274...` | external secret | **DROP / Vault** — never ship a secret in a template |

**Bucket B — Enum defaults (safe generic defaults; keep but make overridable):**

`accountType=RESIDENTIAL`, `accountSubType=NONE`, `customerSegment=B2C`, `marketSegment=NONE`, `salesChannel=NONE`, `contactRole=BILLING`, `addressRole=BILLING`, `invoiceType=SUMMARY`, `invoiceDelivery=EMAIL`, `paymentMethod=CHECK`, `phoneType=MOBILE`, `billingFrequency=MONTHLY`, `subscriptionStatus=SUBMITTED`, `trialType=BOTH`, `financeSyncBatchMode=API`, `primaryTaxType=Main`, `addOnTaxType=Additional`, `defaultTaxRuleForAROps=WITHOUT_TAX`, `defaultLanguage=ENGLISH`, `templateType=XSLT`, `taxExemptionEndCycle=USE_FULL`, `taxExemptionMidStartCycle=USE_FULL`.

These are reasonable for any tenant. Keep them in the template; expose the obvious ones (`paymentMethod`, `billingFrequency`, `customerSegment`) as parameters.

**Bucket C — Numeric thresholds / batch sizing (generic defaults, tune later):**

`billingDom=1`, `paymentTerm=NET_15`, `advanceBillingInNoOfDays=0`, `batchSizeBilling=50`, `batchSizeCommon=50`, `batchSizeInvoice=60`, `batchSizeInvoicing=50`, `batchSizePayment=5`, `usageProcessBatchSize=50`, `migrationBatchSize=200`, `noOfThreads=3`, `noOfJobThreads=1`, `noOfBatchProcessThreads=1`, `noOfBulkAdjustmentThreads=3`, `dashboardMonths=12`, `passwordExpiryInMonths=30`, `archiveAccountTimeExpiry=60`, `renewalReminderThreshold=30`, `trialExpiryReminderThreshold=10`, `exchangeThreshold=0.05`, `roundingPrecisionForExchangeRate=4`, `waitTimeForNextSequence=60`, `minimumCreditNoteThreshold=2`, `minimumDebitNoteThreshold=2`, `notMoreThanDiscount=100`.

⚠️ **Coope-specific outliers to override in the generic template:** `initialTerm=15` + `initialTermUnit=YEARS` (15-year initial term is Coope's ISP contract, not a sane default — set `initialTerm=1`, `initialTermUnit=MONTHS` or `YEARS=1`), and `renewalTerm=1 YEARS`.

**Bucket D — Boolean feature flags (the actual "feature switches"):**

True on demo: `accountOrderWrapperAPI, accumulatorBasedTaxThresholds, alignInstallmentWithBdom, allowUsageProcessing, autoReverseWriteoffOnPayment, avoidZeroAmountTaxTransaction, creditNoteReadyNotification, crossCountryPurchase, filterInstallmentInvoicesForAR, firstInvoicePaymentActivation, generateInvoicePdf, getServiceViaServiceUnitProvId, immediateNotesGeneration, includeCurrentConsumptionForIntialTopup, invoiceDueNotification, invoiceEndDateInclusive, invoiceReadyNotification, isCollectionScheduleCached, isCustomAttributeCached, matchBillingEntries, multiCurrency, newSubscriptionNotification, notificationOnCollectionEntry, pacCustomizedPdfLayout, pacEnabled, partialFulfillment, partialProvisioningEnabled, paymentFailureNotification, paymentNotification, pricingSync, provisioningEnabled, recurringPeriodInInvoice, reratePendingTransactionsOnly, revenueTracking, searchPkgBnldToIncTax, sendAllDataToProvisioning, sendInvoicePdfAndXml, sendServiceProvDataToProvisioning, skipNetZeroGLExtract, splitTaxCalculationByItem, splitTaxCalculationByServiceType, support29_30_31DayBilling, taxApplicable, taxExemptionOnTaxableAmount, testMode, triggerInvoicingOnNewSubsActivation, triggerInvoicingWithPendingBill, useAutoAllocation, useCcpTime, useGLCombination, useProviderForARTax, useShortBillingCycle, useUsageStartTime, userInMultipleGroups, withTaxARRule`.

False on demo (explicitly off): a long list including `autoSendInvoice, batchFinancialExtract, collectDebtFirst, invoiceApproval, projectEnabled, ssoEnabled, multiSubscriptionEnabled, prorate*` etc.

**For the *minimal generic* template we keep only the flags required for a healthy boot + a basic order→invoice→payment cycle, and let everything else default-off by omission.** The proposed minimal-ON set (justified per flag in §6): `taxApplicable, taxByLineItem(false), generateInvoicePdf, sendInvoicePdfAndXml(only if document gw present), revenueTracking, allowUsageProcessing(if usage), useAutoAllocation, paymentNotification, paymentFailureNotification, invoiceReadyNotification, invoiceDueNotification, recurringPeriodInInvoice, invoiceEndDateInclusive, useCcpTime(see note), isCollectionScheduleCached, isCustomAttributeCached`. Provisioning/PAC/multi-currency/cross-country flags stay OFF until the matching integration exists ("no integration yet" = those features simply don't run).

> Note on `useCcpTime=true` + table `ccp_time` (1 row): Embrix can run on a **simulated clock** (CCP time) instead of wall-clock, which is how demo/test environments fast-forward billing cycles. For a **production** tenant you almost certainly want `useCcpTime=false`. This is a per-env parameter, not a per-tenant one. (More in §6.)

### 1.5 The junk we found (proof of why "copy from X" must die)

Your demo `ccp_properties` literally contains these rows:

| property | value | what it is |
|----------|-------|------------|
| *(empty string)* | *(empty)* | a blank key — garbage |
| `2023-11-15` | *(empty)* | a date used as a key — garbage |
| `2024-01-01` | *(empty)* | another date-as-key — garbage |
| `property` | `value` | **the CSV header row got inserted as data** during some import |

None of these are read by any code; they're inert. But they are *proof* that the current export/import process is lossy and unvalidated. The template approach eliminates this class of problem because the template is a curated, reviewed artifact — nothing gets in by accident. **Action:** the backout/cleanup script (§10) should also include a one-time `DELETE FROM core_config.ccp_properties WHERE property IN ('', 'property', '2023-11-15', '2024-01-01')` for any env that inherited the mess.

### 1.6 Flags that are NOT on `TenantPropertyDefaults` (must use raw `setCcpProperties`)

Cross-referencing the 198 demo keys against the `TenantPropertyDefaults` DTO fields (`engine/.../tenantOnboarding/dto/TenantPropertyDefaults.groovy`), several demo keys have **no corresponding DTO field**, which means `createTenant` cannot set them — they require the raw `setCcpProperties` mutation:

`defaultLanguage, pricingSync, provisioningEnabled, provisioningRequired, partialFulfillment, partialProvisioningEnabled, queuePollDisabled, testMode, useCcpTime, mailSmtpSslEnable, migrationBatchSize, migrationOrder, noOfBatchProcessThreads, noOfJobThreads, usageProcessBatchSize, batchSizeInvoicing, trackSubscriptionCount, getServiceViaServiceUnitProvId, searchPkgBnldToIncTax, eliminateFirstInvoice, filterInstallmentInvoicesForAR, interCompanyCreditNoteItem, interCompanyInvoiceCreditReason, minimumCreditNoteThreshold, minimumDebitNoteThreshold, notMoreThanDiscount, coaExportFileName, holiday*…`

This split directly drives §6: the template has **two** flag files — `flags-typed.yaml` (goes through `createTenant`/`TenantPropertyDefaults`) and `flags-raw.json` (goes through `setCcpProperties`). I'll generate both, derived from this analysis, once we confirm the constant names in `PropertiesConstants` (a quick grep in §6).

### 1.7 The artifact this section produces

A canonical, reviewed **`templates/minimal/flags.master.csv`** — the 3-column source of truth `(property, generic_default, kind)` where `kind ∈ {param, keep, drop, env}`. Everything in §6 is generated from this file. I'll write it in §6 after we lock the constant names; for now the classification above *is* its content.

---

## §2 — L0: Schema + enums bootstrap (the empty, correct database)

### 2.1 Why this layer exists and what "done" looks like

Before any tenant config can be written, the database must contain: the schemas (`core_config`, `core_engine`, `core_enums`, `core_pricing`, `core_revenue`, `core_usage`, `core_mediation`, `core_oms`, `core_migration`), every table, every **enum reference table** in `core_enums` (these are real tables with FK references — e.g. `tenant_merchants.type` references `core_enums.merchant_type(name)`), all functions, views, triggers, and the small set of bootstrap rows that the very first migrations insert (e.g. `V10_1__Create_ArHub_Config_Records.sql`).

"Done" = Flyway reports the full migration set applied, every expected schema exists, and `core_enums` is populated. If `core_enums` is empty, **every** later seed/insert that references an enum (and almost all of them do — look at the `references core_enums.*` clauses in §2.4) fails with a FK violation. So L0 is not just "create tables," it's "create tables **and** load the enum vocabulary."

### 2.2 The two delivery mechanisms (and which to use)

There are two ways the schema gets created, and you need to understand both because they're used in different situations:

**(1) Flyway migrations** — `engine/src/main/resources/db/migration/V*.sql`. This is the *authoritative, ordered* schema definition. The version ladder is meaningful:

| Version family | Responsibility | Example files |
|----------------|----------------|---------------|
| `V1` | Create schemas | `V1__Create_Schema.sql` |
| `V2*` | Create enums (per hub) | `V2__Create_Enums.sql`, `V2_1..V2_13` per hub, `V2_6__Create_Sequences.sql` |
| `V3*` | Create **config** tables (per hub) | `V3_6__Create_OpsHub_Config_Tables.sql` (tenant, users, merchants, gateways), `V3_4` (ArHub), `V3_5` (RevenueHub/GL), `V3_2` (BillingHub), `V3_3`/`V3_11` (Pricing) |
| `V4*` | Create transactional tables | `V4_1__Create_CustomerHub_Tables.sql` … |
| `V5*` | Indexes | `V5_*` |
| `V6*` | Constraints (FKs) | `V6_*` |
| `V7*` | Views | `V7_*` |
| `V8*` | Functions | `V8_*` |
| `V9*` | Triggers | `V9_*` |
| `V10_1` | **Seed ArHub config records** | `V10_1__Create_ArHub_Config_Records.sql` |
| `V10_2` | Report perf indexes | `V10_2__Add_Report_Performance_Indexes.sql` |

So config *tables* are born at `V3_*`; the only built-in *config data* the migrations seed is the ArHub records at `V10_1`. Everything else (currency, GL, tax, tenant…) is **your** job in L5+.

**(2) Baseline SQL snapshot** — `engine/db/scripts/baseline-3.2.0.sql` (latest; the folder also has `baseline-3.1.17`, etc.). A baseline is a *flattened snapshot* of the schema at a released version, used to (a) initialize Flyway's history on an environment that already has the schema, or (b) stand up the schema fast without replaying 90+ migrations. The baseline contains the `CREATE TABLE`/enum DDL pre-collapsed.

**Which to use:**
- **Brand-new sandbox/prod env (our case):** run **Flyway from clean** against the empty database. It's authoritative and leaves a correct `flyway_schema_history`. Use the baseline only as the Flyway *baseline version* marker if your org's convention is baseline-then-migrate.
- **Existing env that already has tables but no Flyway history** (this is the **demo** situation — see §2.6): you `flyway baseline` to the matching `baseline-3.x` version, then migrate forward. **Do not** replay V1 against a populated DB; it will collide.

### 2.3 Exact commands

Set the three required env vars (the engine reads these — see `CLAUDE.md`):

```bash
export DB_URL="jdbc:postgresql://<host>:5432/<dbname>"
export DB_USER="<user>"
export DB_PASSWORD="<password>"
```

**Option A — Flyway via the engine Maven build (preferred for a fresh env):**

```bash
cd /c/embrix-o2x/engine
# Runs Flyway migrate using the engine's configured datasource (DB_URL/USER/PASSWORD).
# -Dskip.jooq.generation=true avoids the jOOQ codegen step (we only want the schema applied).
./mvnw -q flyway:migrate -Dskip.jooq.generation=true
```

(If the engine pom doesn't bind the flyway plugin, use the Flyway CLI directly against the same migration folder — Option B.)

**Option B — Flyway CLI directly against the migration scripts:**

```bash
flyway \
  -url="$DB_URL" -user="$DB_USER" -password="$DB_PASSWORD" \
  -locations="filesystem:/c/embrix-o2x/engine/src/main/resources/db/migration" \
  -schemas="core_config,core_engine,core_enums,core_pricing,core_revenue,core_usage,core_mediation,core_oms,core_migration" \
  migrate
```

**Option C — apply the baseline snapshot directly (fast schema, no replay):**

```bash
psql "$DB_URL_PSQL" -v ON_ERROR_STOP=1 -f /c/embrix-o2x/engine/db/scripts/baseline-3.2.0.sql
# (DB_URL_PSQL is the libpq form: postgresql://user:pass@host:5432/dbname)
```

> Why `ON_ERROR_STOP=1` everywhere: without it, `psql` plows through errors and you end up with a half-built schema that *looks* like it worked. Every seed script in this toolkit uses it.

### 2.4 What the enum FKs mean for you (don't skip core_enums)

From the DDL I pulled (`V3_6__Create_OpsHub_Config_Tables.sql`), here are the FK references that *will* fail if `core_enums` isn't loaded — these are the columns you'll be inserting in L2/L3:

```text
core_config.tenant_merchants.name        -> core_enums.merchant_name(name)
core_config.tenant_merchants.type        -> core_enums.merchant_type(name)
core_config.tenant_merchants.status      -> core_enums.merchant_status(name)
core_config.tenant_merchants.authtype    -> core_enums.merchant_auth_type(name)
core_config.tenant_merchants.webapitype  -> core_enums.webapi_type(name)
core_config.crm_gateway_attributes.type  -> core_enums.crm_gateway_url_type(name)
core_config.*_gateway_attributes.apitype -> core_enums.api_type(name)
core_config.*_gateway_attributes.apiprotocol -> core_enums.api_protocol(name)
core_config.users.status                 -> core_enums.account_status(name)
core_config.users.category               -> core_enums.user_category(name)
core_config.users.credentialtype         -> core_enums.credential_type(name)
```

So when, in L3, you insert a merchant of `type='CRM_GATEWAY'`, the string `CRM_GATEWAY` must already be a row in `core_enums.merchant_type`. The `V2*` migrations create and populate these enum tables. **Verification that `core_enums` is loaded is therefore part of L0's definition of done** (query in §2.5).

### 2.5 Verification (the L0 gate — runnable)

I've written these to `tenant-provisioning/sql/00-verify-schema.sql`. Run after migrate; all checks must pass before you proceed to L5.

```sql
-- 1) All expected schemas exist
SELECT 'schemas' AS check, string_agg(nspname, ',' ORDER BY nspname) AS found
FROM pg_namespace
WHERE nspname IN ('core_config','core_engine','core_enums','core_pricing',
                  'core_revenue','core_usage','core_mediation','core_oms','core_migration');

-- 2) Flyway applied cleanly (no failed rows; latest version present)
SELECT 'flyway' AS check, max(version) AS latest_version,
       count(*) FILTER (WHERE success = false) AS failed_count
FROM core_config.flyway_schema_history;   -- adjust schema if history lives elsewhere

-- 3) core_enums is populated (the vocabulary later layers reference)
SELECT 'enums_loaded' AS check,
       (SELECT count(*) FROM core_enums.merchant_type)  AS merchant_type,
       (SELECT count(*) FROM core_enums.merchant_status) AS merchant_status,
       (SELECT count(*) FROM core_enums.api_type)        AS api_type,
       (SELECT count(*) FROM core_enums.account_status)  AS account_status;

-- 4) Tenant tables exist and are EMPTY (fresh env — nothing seeded yet)
SELECT 'tenant_tables_empty' AS check,
       (SELECT count(*) FROM core_config.tenant)          AS tenants,
       (SELECT count(*) FROM core_config.tenant_merchants) AS merchants,
       (SELECT count(*) FROM core_config.ccp_properties)   AS ccp;
```

Expected on a fresh env: schemas all present; `failed_count = 0`; enum counts > 0; tenant/merchant/ccp counts = 0.

### 2.6 The demo-environment caveat (so you don't trust the wrong thing)

From prior investigation: on the **demo** DB (`coopegsbx2-dev-db`), `flyway_schema_history` **stopped at `V10_1` (2021-10-14)** — Flyway-on-boot has not advanced there for years. That has two consequences you must internalize:

1. **Demo is a content reference, not a schema reference.** Its `ccp_properties` values are gold for designing the template (we used them in §1.4), but its *schema* is old. Always validate column/enum existence against the current `engine` migrations (which is exactly what this guide does — every DDL claim here is from `V3_6`, not from demo).
2. **On a genuinely fresh env you run the full Flyway ladder** (§2.3 Option A/B) and it *will* go far past V10_1. Don't copy the demo's frozen state.

### 2.7 L0 outcome

At the end of §2 you have an **empty but structurally complete** database: all schemas, all tables, all enums loaded, zero tenant/config rows. The system could boot, but would be useless — every `if (flag)` is false and every lookup is empty. That's expected. §3 starts filling it, bottom-up.

---

*(Sections §3–§10 follow — see "Build roadmap & what I need next" at the end. Each is written to this same file as we lock the exact columns from the migrations and you run the two remaining diagnostics.)*
