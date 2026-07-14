# Embrix O2X — Service & Gateway Catalog (what each component is, needs, and its provisioning role)

> Companion to the provisioning guide. To build a *minimal template before knowing a tenant's requirements*, you must know **which components are mandatory vs. integration-gated**, what each needs to boot, and how they call each other. Every component below is in your real deploy set (`core/.gitlab-ci.yml` `MODULES` + the gateway/UI repos), and the env/dependency facts come from the actual `helm_values/coopegenergy/*.yaml`.
>
> **Three facts that hold for ALL backend components** (verified across the Helm values + Dockerfile):
> - Each is a **Spring Boot (Java 8, `eclipse-temurin:8-jre`)** app on **port 8080**, profile `pg`.
> - Each gets the **same** `postgres.url` (the tenant DB), `REDIS_HOST`, `AMQ_BROKER_URL`, `VAULT_API`, `tenantId`, `tenantName`, and the five gateway URLs — i.e. **every backend reads the same tenant DB and the same Redis `ccpPropertiesMap`**. That's why the §6 cache-reload step must restart *all* of them.
> - Inter-service routing is by **k8s Service DNS** = `<tenant>-<component>` (set by `fullnameOverride`). Keep the tenant prefix identical everywhere or they can't find each other.

---

## 0 — One-screen map

```
                         ┌───────────────── UIs ─────────────────┐
                         │  core-ui (Congero)   selfcare-ui       │
                         └───────┬───────────────────┬───────────┘
                                 │ GraphQL/HTTP       │
                    ┌────────────▼─────────┐   ┌──────▼─────────┐
                    │ service-proxy (facade│   │ service-sso     │  <- auth / token (/generate-token)
                    │  /router to batch &  │   └──────┬─────────┘
                    │  domain services)    │          │
                    └─────────┬────────────┘          │
                              │                        │
   ┌──────────────────────────▼────────────────────────▼─────────────────────────┐
   │ DOMAIN / ENGINE-BEARING SERVICES (all read tenant DB + ccpPropertiesMap)      │
   │  service-transactional  (THE GraphQL API: CRM, orders, AR, onboarding, ccp)   │
   │  service-billing  service-invoice  service-payment  service-revenue           │
   │  service-usage    service-mediation                                           │
   │  jobs-common (scheduled jobs)   batch-process (bulk billing/invoicing/usage)  │
   └───────┬───────────────┬─────────────┬──────────────┬───────────┬─────────────┘
           │ JMS (AMQ)     │ jOOQ (RDS)  │ Jedis (Redis)│ HTTP      │
           ▼               ▼             ▼              ▼ (to gateways)
   [[ Amazon MQ ]]   (coredb-<tnt>)  (ccpPropertiesMap)  ┌──────────────────────────┐
                                                          │ GATEWAYS (external I/O)  │
                                                          │ crm · payment · finance  │
                                                          │ tax (+tax-engine) · prov │
                                                          └───────────┬──────────────┘
                                                                      ▼  external systems
                                                          (COOPEWEB, NetSuite, NOKIA, …)
            vault-interface  <- every component reads secrets via VAULT_API
```

---

## 1 — Core services (repo `core/`, the 11 `MODULES`)

| Service | Domain hub | Purpose | Mandatory for minimal? | Provisioning notes |
|---------|-----------|---------|------------------------|--------------------|
| **service-transactional** | all (CRM, orders, AR, opsHub) | **THE primary GraphQL API.** Hosts `createTenant`, `setCcpProperties`, `createUser`, `createGatewayApiMapping`, account/order/AR mutations. | **YES** — it's the seeding entry point | `tenant.id` = its `app.tenantId`. You POST §5/§6/§7 mutations here. |
| **service-billing** | billingHub (rating) | Cycle billing, rating, charge generation; AMQ consumer. | **YES** (boot) | Reads ccp flags (`batchSizeBilling`, billing flags). Needs cache reload after §6. |
| **service-invoice** | billingHub (invoicing) | Invoice generation + PDF/XML (uses `templateType`, document gateway). | **YES** (boot) | `generateInvoicePdf`, `sendInvoicePdfAndXml` flags. Needs `output_template` data for real PDFs (Coope has 1757 rows — template is tenant-specific styling). |
| **service-payment** | arHub (payment) | Payment capture/allocation, payment notifications. | **YES** (boot) | `useAutoAllocation`, `paymentNotification`. Calls payment-gateway when a processor is live. |
| **service-revenue** | revenueHub | Revenue recognition, GL/finance extract. | **YES** (boot) | Uses `config_gl_account`, `operating_unit`, `useGLCombination`. |
| **service-usage** | usageProcessHub | Usage/CDR rating pipeline. | Only if usage tenant | `allowUsageProcessing`, `usageProcessBatchSize`; needs `rate_units`, `zones`. A pure-subscription tenant can run it idle. |
| **service-mediation** | mediationHub | CDR ingestion/normalization before usage rating. | Only if usage tenant | Needs mediation config (`config_mediation_*`) — empty on a non-usage tenant. |
| **service-proxy** | — (facade) | Front router/aggregator; its Helm has `COMMON_URL, BILLING_URL, INVOICING_URL, PAYMENT_URL, BATCH_PROCESS_URL` — it fans requests out to those. | **YES** (boot) | No tenant-specific config of its own; just needs the sibling URLs correct. |
| **service-sso** | opsHub (auth) | SSO / token issuance (`/generate-token`), login. | **YES** | `ssoEnabled` flag governs external SSO; internal token issuance works regardless. Bootstrap admin (§7) logs in via here. |
| **jobs-common** | jobs-common | Scheduled-job framework (cron-like jobs: reminders, collections, close). | **YES** (boot) | Jobs are config-driven (`config_job`, `config_job_list` — Coope has 9). Minimal tenant can start with none/defaults. |
| **batch-process** | batch-process | Bulk/batch execution (batch billing, invoicing, usage); calls `TRANSACTIONAL_URL`, `USAGE_PROCESS_URL`. | **YES** (boot) | `noOfBatchProcessThreads`, `batchProcessSleepValue`. Drives the heavy periodic runs. |

**Why "boot" services are still mandatory even if a tenant isn't using that domain yet:** they all consume from the shared AMQ broker and read `ccpPropertiesMap`; leaving one undeployed means messages for that domain pile up and some cross-domain flows (order→bill→invoice→payment) break. Deploy all 11; let unused domains sit idle (the `if(flag)` model keeps them quiet).

---

## 2 — Gateways (separate repos; the external-integration boundary)

Gateways are also Spring Boot + GraphQL, but their job is to translate Embrix's canonical model ↔ an external provider's API (this is what the §4 canonical maps drive). `MerchantType` (§5) and `providername` (§4) line up with these.

| Gateway | Repo | Talks to (providers seen in §4) | Mandatory for minimal? | Provisioning notes |
|---------|------|---------------------------------|------------------------|--------------------|
| **tax-gateway** + **tax-engine** | `tax-gateway`, `tax-engine` | `EMBRIX` (internal calc) or external (Avalara/Vertex) | **YES** | `createTenant` requires a TAX_GATEWAY merchant. `tax-engine` is the **internal** calculator → a tenant can do tax with **no external vendor** (provider `EMBRIX`, §4 minimal map). `taxApplicable=true` needs this. |
| **finance-gateway** | `finance-gateway` | `NETSUITE`, `COOPEWEB`, QuickBooks | Deploy (merchant required) | `createTenant` requires a FINANCE_GATEWAY merchant (17 URL types). Set merchant `INACTIVE` + flags off (`realTimeFinanceSync=false`) until an ERP is wired. |
| **payment-gateway** | `payment-gateway` | CardPointe/Fiserv, BrainTree | Deploy (merchant required) | `createTenant` requires a PAYMENT_GATEWAY merchant (9 URL types). INACTIVE until a processor is wired; `paymentNotification` still works internally. |
| **crm-gateway** | `crm_gateway` | `COOPEWEB`, SFDC, ServiceNow | Optional | Not required by `createTenant`. Add a CRM merchant + replay its §4 maps when the tenant integrates an external CRM. Has `DATA_DIR` + `SKIP_JOOQ_GENERATION`. |
| **provision-gateway** | `provision_gateway` | `NOKIA`, `MOTV`, `PORTAONE`, `NETUP`, `COOPEWEB` | Optional | Network provisioning. Off until the tenant has network kit; `provisioningEnabled`, `sendAllDataToProvisioning` stay false. Provisioning sequences (`config_prov_sequence`) are tenant/vendor-specific. |

**The createTenant constraint restated in service terms (from §5):** even a "no integration" tenant must declare **TAX + FINANCE + PAYMENT** merchants. So those three gateways' Services must exist (deploy them) so their URLs resolve; CRM + provisioning are genuinely optional at provisioning time.

---

## 3 — UIs and support

| Component | Repo | Purpose | Mandatory? | Notes |
|-----------|------|---------|-----------|-------|
| **core-ui** ("Congero") | `ui-core` | Back-office operator UI (React/Apollo). Where operators run billing, AR, onboarding screens. | **YES** (operators need it) | Talks to `service-transactional`/`service-proxy` GraphQL. The §1.2 "Congero UI write path" = this hitting `setCcpProperties`/`createTenant`. |
| **selfcare-ui** | `selfcare` | Customer self-care portal. | Optional | Needs `selfcare_config` + `selfcareRole` (§7). Deploy when the tenant offers self-care. |
| **vault-interface** | (support) | In-cluster broker to Vault; every backend reads secrets via `VAULT_API=http://<tenant>-vault-interface/`. | **YES** | Holds DB password, integration creds, and the user password vault refs (§7). Must be up before backends boot. |

---

## 4 — The minimal deploy set (what to actually stand up first)

For a brand-new tenant **before** knowing detailed requirements, deploy this set — it boots cleanly, passes `createTenant`, and runs order→invoice→payment internally:

**Mandatory:** `vault-interface`, all 11 core services, `tax-gateway` + `tax-engine`, `finance-gateway`, `payment-gateway`, `core-ui`.
**Defer (add per requirement):** `crm-gateway`, `provision-gateway`, `selfcare-ui`.

This maps directly to which `helm_values/<tenant>/*.yaml` files you create in Part A §A.5 and which deploy jobs you add in §A.6. The deferred ones get added when the corresponding integration is scoped — and that's also when you replay their §4 canonical-map bundle and flip their §6 flags on.

---

## 5 — How this catalog feeds the template

- **Part A (infra)** deploys the §4 mandatory set; the deferred set is commented in the render template.
- **§4 (canonical)** seeds only `EMBRIX` (tax) for the minimal set; CRM/finance/payment/provision bundles are replayed per-integration.
- **§5 (tenant)** declares TAX+FINANCE+PAYMENT merchants (matching the mandatory gateways), INACTIVE where no external vendor yet.
- **§6 (flags)** keeps integration flags (`provisioningEnabled`, `realTimeFinanceSync`, `pacEnabled`, …) OFF until the matching gateway/integration is enabled.
- **§8 (reload)** must restart **all** engine-bearing services (this catalog's §1) because they each cache `ccpPropertiesMap`.

> Net: the catalog is the "what exists / what's mandatory" map; the §-sections are the "how to seed each" steps. Together they let you provision a working skeleton tenant first, then switch on integrations one at a time as requirements land.
