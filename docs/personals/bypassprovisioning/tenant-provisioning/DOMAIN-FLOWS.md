# Embrix O2X — Domain Flows & Remaining Config Areas (the "what actually happens" companion)

> `SERVICES-AND-GATEWAYS.md` says *what each component is*. This doc says *what happens across them* — the business lifecycles (order→bill→invoice→payment→revenue, provisioning, dunning), the AMQ message backbone that ties services together, the document/PDF rendering layer, and the **remaining config areas** the earlier sections didn't cover (jobs, collections, accumulators, custom attributes, dashboards, OMS tasks).
>
> **Why this matters for provisioning:** to build a *minimal template before requirements are known*, you must know, for each flow, **the smallest config that lets the flow run** vs. **the config that's tenant/requirement-specific** (and therefore deferred). Every table named here is in your live inventory; DDL claims are from the real migrations (`V3_*`); the queue behaviour is from `PGQueueManageService`.
>
> Notation: ✅ = minimal template seeds it · ⛔ = deferred (tenant-specific / integration-specific) · 🔎 = verify against the running build.

---

## 0 — The platform in one paragraph

Embrix is an **order-to-cash + provisioning** OSS/BSS. A customer **account** is created; an **order** places a **subscription** to a **price offer**; orders may trigger **provisioning** (activating service on network kit) via the provision-gateway; a periodic **billing** run rates charges into **pending bills**; **invoicing** turns those into invoices (with **PDF/XML** documents); **payment** is captured/allocated; **AR** handles adjustments/disputes/write-offs/collections; **revenue** recognizes and extracts to finance/ERP. Each stage is a service (`SERVICES-AND-GATEWAYS.md`), they hand work to each other over **ActiveMQ queues**, and every behavioural branch is gated by a `ccp_properties` flag (§6). The config you seed decides which branches fire.

---

## 1 — The AMQ message backbone (how services hand off work)

### 1.1 The mechanism (verified in `PGQueueManageService`)
- Producers call `publishInQueue(session, payload, queueName)`. The actual destination is **`queuePrefix + queueName`**, where `queuePrefix` = the Spring property `${mq.queue.prefix:}` (empty by default).
- Connection creds come from **Vault** (`vaultService.decryptData(... mq.username/mq.password)`), broker URL from `${activemq.broker-url}` (= Helm `AMQ_BROKER_URL`, the shared SSL broker).
- Consumers are Camel `RouteBuilder`s / JMS listeners in the domain services (billing/invoice/payment/usage/transactional), reading the same prefixed queues.

### 1.2 The provisioning consequence (the AMQ-consolidation lesson, made concrete)
Because the destination is `queuePrefix + queueName`, **every tenant on the shared broker MUST set a unique `mq.queue.prefix`** (the Part A `AMQ_PREFIX`). If two tenants run with an empty/identical prefix on the same broker, they consume each other's messages — the exact bug class fixed in the AMQ consolidation. So in the provisioning template:
- ✅ Set `mq.queue.prefix=<TENANT_PREFIX>` (e.g. `ACME.`) in the Helm env of **every** backend service (not just one — producers and consumers must agree).
- 🔎 Confirm the property name your build reads (`mq.queue.prefix` here; some services historically used a `static final` queue name — those were migrated to the `@Value` form during consolidation). Grep `queue.prefix` / `@Value` in each service before go-live.

### 1.3 What rides the queues (the inter-service contracts)
The major asynchronous handoffs (names illustrative — confirm against each `RouteBuilder`):
- **Order → Provisioning:** `service-transactional`/OMS publishes a provisioning request; provision-gateway consumes, calls the vendor, publishes a response; a `ProvisioningResponseProcessor` consumes the response and advances the order. (This is the path behind the "stuck in PROVISIONING_INITIATED" incidents.)
- **Billing → Invoicing:** pending-bill / invoice-trigger messages.
- **Payment notification:** `paymentNotification` flag → message to CRM/finance.
- **Batch fan-out:** `batch-process` drives bulk billing/invoice/usage cycles, calling `TRANSACTIONAL_URL`/`USAGE_PROCESS_URL` and enqueuing per-account work.

> Provisioning note for the minimal template: with `provisioningEnabled=false` (§6 default) and no provision-gateway deployed, **no provisioning messages are produced** — so the order flow completes without the network round-trip. That's the correct "no integration yet" behaviour.

---

## 2 — The order-to-cash lifecycle (the spine every tenant needs)

This is the flow your smoke test (§8) will exercise. Below: each stage, the **service**, the **config it reads**, and the **minimal seed**.

### 2.1 Account & order creation
- **Service:** `service-transactional` (customerHub/orderManagement).
- **Reads:** `ccp` enum defaults (`accountType`, `customerSegment`, `contactRole`, `addressRole`, `paymentMethod`, `billingFrequency`, `billingDom`, term defaults), `credit_profile` (§3.9), `product_family_list` (§3.4), `config_oms`/`config_oms_tasks` (order task pipeline).
- **Minimal seed:** ✅ all of the above are in §3/§6. The order references a **price offer** — which is **pricing/product-catalogue (core_pricing)**, see §2.6.
- **Flag branches that matter:** `accountOrderWrapperAPI` (one wrapper call vs per-type), `allowInFlightOrders`, `multiSubscriptionEnabled`, `firstInvoicePaymentActivation` vs `eliminateFirstInvoice` (mutually exclusive first-invoice behaviour — §6.1.5).

### 2.2 OMS task pipeline (`config_oms` + `config_oms_tasks`)
- **What it is:** per `order_type`, an ordered list of **tasks** the order must pass through (`config_oms_tasks.task` ∈ `core_enums.oms_tasks`; `taskexecutiontype`). The demo has `config_oms`=6 (one per order type) and `config_oms_tasks`=12.
- **DDL:** `config_oms(id, ordertype→order_type)`, `config_oms_tasks(id→config_oms, index, name, task→oms_tasks, taskexecutiontype)`.
- **Minimal seed:** ✅ but it's **order-type-specific**. The template should seed a minimal task pipeline for the order types the tenant will use first (`NEW`, at least). This is a small **extract-replay** candidate (like §4) from a golden tenant, filtered to the order types you need. 🔎 Confirm which `oms_tasks` are mandatory for a `NEW` order to reach `ACTIVE` without provisioning.

### 2.3 Billing / rating
- **Service:** `service-billing` (billingHub/rating).
- **Reads:** `ccp` (`batchSizeBilling`, `useShortBillingCycle`, `support29_30_31DayBilling`, `prorate*`, `recurringPeriodInInvoice`, `advanceBillingInNoOfDays`), the price offer's pricing model, `config_in_advance_billing` (advance vs arrears), `future_cycle_config`.
- **Minimal seed:** ✅ flags in §6. ⛔ advance-billing exceptions / future-cycle nuances are tenant-specific (Coope has `config_in_advance_billing`=1).
- **Output:** pending bill entries (transactions) on the account.

### 2.4 Invoicing + document rendering
- **Service:** `service-invoice` (billingHub/invoicing) + **document-gateway** (provider `JARS` for XML) + the **template/output_template** layer (§3 of this doc, below).
- **Reads:** `ccp` (`generateInvoicePdf`, `sendInvoicePdfAndXml`, `invoiceType=SUMMARY`, `invoiceEndDateInclusive`, `templateType=XSLT`, `returnPDFBase64`), `invoice_tenant_config` (§3.11 — company header), `output_template*`, `template*`, `location_template_mapping`.
- **Minimal seed:** ✅ `invoice_tenant_config` + flags. ⛔ **the actual PDF/XML templates are tenant-branded** (Coope: `output_template_target`=1757) — see §3 below; minimal ships a plain/default template or defers PDF.

### 2.5 Payment
- **Service:** `service-payment` (arHub/payment) + **payment-gateway** (when a processor is live).
- **Reads:** `ccp` (`useAutoAllocation`, `paymentNotification`, `paymentFailureNotification`, `collectDebtFirst`, `autoAllocateFullDebtOnly`), `payment_config`/`payment_terms` (§3.8), `config_payment_allocation`(+sequence).
- **Minimal seed:** ✅ payment terms + allocation in §3 + flags in §6. ⛔ external processor (CardPointe/Fiserv) deferred — payment can be recorded manually (`paymentMethod=CHECK/CASH`) without it.

### 2.6 Pricing / product catalogue (`core_pricing`) — the deliberate gap
- **What it is:** `core_pricing` (bundle=330, discount=24, price offers, accumulators on Coope) = the **product catalogue**: what the tenant sells, at what price, with what discounts/grants.
- **Minimal seed:** ⛔ **NOT in the template.** This is the most tenant-specific data in the system — it *is* the tenant's business. The template provides the *scaffolding* (`product_family_list` hierarchy, `rate_units`, `config_uom`) so catalogue items have something to roll up to, but the catalogue itself is built post-provisioning (UI or a tenant-specific seed) once products are known.
- **Why this is correct:** you asked for "a minimal template before knowing their requirements." Product/pricing *is* the requirement. Seeding a fake catalogue would create exactly the "copied junk" problem we're eliminating. The smoke test (§8) uses **one throwaway price offer** created at test time, not shipped in the template.

### 2.7 Revenue + finance/ERP extract
- **Service:** `service-revenue` (revenueHub).
- **Reads:** `ccp` (`revenueTracking`, `useGLCombination`, `realTimeFinanceSync`, `paymentFinanceSync`, `batchFinancialExtract`, `skipNetZeroGLExtract`, `itemizeARRevenueExtract`), `config_chart_of_account*`, `config_gl_account*`, `operating_unit*` (§3.5/§3.10).
- **Minimal seed:** ✅ GL skeleton + flags. ⛔ ERP sync (NetSuite via finance-gateway) deferred — `realTimeFinanceSync=false` until wired; revenue still recognizes internally.

---

## 3 — Document & invoice rendering layer (the `template` / `output_template` tables)

This is the layer that makes invoices/notes look like the tenant's brand. It's **why Coope carries 1,757 `output_template_target` rows** — and why none of that belongs in a generic template.

### 3.1 The tables (real DDL)
- **`template` / `template_files` / `template_supplementary_files`** — named template definitions. `template_files(name, type→template_type, filetype→template_file_type, status, country, filepath, lineofbusiness, accounttype, accountcategory)`. So a template file is **scoped** by type/country/LOB/account-type — i.e. you can have different invoice layouts per segment. `filepath` points at the actual XSLT/HTML (delivered with the invoice service image or on S3).
- **`output_template` / `output_template_source` / `output_template_target`** — `output_template(id, type→output_template_types, userid)`; source/target are `(id, index, name)` lists. This is a **field-projection map**: which data fields (`source`) map to which output positions (`name`/`target`) for a given output type. The 88 `output_template_types` enum values × field lists = the 1,757 target rows on Coope.
- **`location_template_mapping`** (28 on Coope) — maps a service **location** to a template (multi-site tenants render differently per location).

### 3.2 Minimal vs deferred
- ✅ **Minimal:** seed `invoice_tenant_config` (company header, §3.11) and either (a) point `templateType=XSLT` at a **default** template file shipped with the invoice-service image, or (b) set `generateInvoicePdf=false` initially and turn it on once a template is designed.
- ⛔ **Deferred / extract-replay:** the full `output_template*` field maps and branded `template_files`. These are a clean **extract-replay** candidate (same technique as §4/§7) from a golden tenant **if** the new tenant wants the same layout — but usually a new tenant brings its own invoice design, so this is post-provisioning design work, not template content.
- 🔎 **Verify before go-live:** the invoice service will fail/blank-render if `generateInvoicePdf=true` but no template file resolves for the account's type/country/LOB. So either ship a catch-all `template_files` row (`name=DEFAULT`, broad scope) or keep PDF off until designed.

---

## 4 — Provisioning flow (`config_prov_sequence` family) — the network-activation engine

This is the most integration-specific subsystem and the source of the "stuck order" incidents. It's **entirely deferred** for a no-integration tenant, but you must understand it to know *why* it's safe to defer.

### 4.1 The tables (real DDL)
- **`config_prov_sequence`** — per `(ordertype, servicetype)`, an ordered provisioning sequence (`provisioningsequence`).
- **`config_prov_sequence_list`** — the steps: `apiname`, `apicategory`, `merchantname→merchant_name` (which vendor: NOKIA/MOTV/PORTAONE…), `queuename`, retry/timeout/wait config, `onerrorresubmit`, `synchronousresponse`, `errorapiname`, `restartapionerror`. **This is the per-step orchestration** the provision-gateway executes.
- **`config_prov_inputs`** — input mappings per step (action/level/service-types → API).
- **`prerequisite_inbound_sequence`** — ordering prerequisites between steps.
- **`prov_sequence_data`** — static attribute/value pairs fed into steps.
- **`config_provisioning_attributes`(+`_list`,`+_lovs`)**, **`provisioning_template_mapping`**, **`device_attributes_mapping`**, **`optical_data_mapping`** — vendor/device attribute schemas (NOKIA optical, STB, etc.).

### 4.2 Minimal vs deferred
- ⛔ **Entirely deferred.** All of the above is meaningless without a real provisioning vendor. On Coope: `config_prov_sequence`=14, `_list`=65, etc. — all NOKIA/MOTV/PORTAONE-specific.
- ✅ **Minimal template:** `provisioningEnabled=false`, `sendAllDataToProvisioning=false`, no provision-gateway deployed, no `config_prov_*` rows. Orders reach `ACTIVE` via the OMS pipeline (§2.2) **without** a provisioning round-trip.
- **Enable later (per integration):** deploy provision-gateway → replay the vendor's §4 canonical-map bundle → seed `config_prov_sequence*` for that vendor (extract-replay from a tenant already on that vendor) → flip `provisioningEnabled=true` + `provisioningForSuspendResumeCancel` as needed. The "stuck in PROVISIONING_INITIATED" incidents are almost always a missing/incorrect `config_prov_sequence_list` step or a vendor outbound failure — so this config must be complete before enabling.

---

## 5 — AR operations & collections/dunning

### 5.1 AR operations
- **Service:** `service-transactional` (arHub/arOps) + `service-payment`.
- **Reads:** `ar_item_types_config`, `ar_reason_code_types` (§3.7), `ccp` (`withTaxARRule`, `useProviderForARTax`, `fixedTaxRuleForAROps`, `defaultTaxRuleForAROps`, `notesOnDispute`, `autoReverseWriteoffOnPayment`).
- **Minimal seed:** ✅ AR item types + reason codes (§3.7) cover adjustments/credit-debit notes/write-offs/disputes.

### 5.2 Collections / dunning (`config_collection_*`)
- **What it is:** `config_collection_schedule`(+`_list`), `config_collection_actions`(+`_list`), `config_collection_agent`(+`_list`), `account_collection_profile_map` — the **dunning ladder**: when an account is overdue, what actions fire on which days (notifications, suspend, etc.). Coope: schedule=7, schedule_list=13, actions, agents=6.
- **Reads:** `ccp` (`notificationOnCollectionEntry`, `isCollectionScheduleCached`).
- **Minimal seed:** ⛔ mostly deferred (the ladder is a tenant policy decision), but ✅ a **minimal default schedule** is advisable so overdue accounts don't error. Extract-replay a simple schedule from a golden tenant, or seed one schedule with a couple of actions. 🔎 Confirm whether the billing/AR run errors if **no** collection schedule exists for an account profile.

---

## 6 — Scheduled jobs (`config_job` / `config_job_list`)

- **Service:** `jobs-common` + `batch-process`.
- **What it is:** the cron-like job catalog — billing-cycle close, invoice generation, reminders, collection runs, finance extract, etc. `config_job(ordertype/type)`, `config_job_list` (the schedule entries). Coope: `config_job`=2, `config_job_list`=9. `core_enums.job_type` has 58 possible jobs.
- **Reads:** `ccp` thread/batch sizing (`noOfJobThreads`, `noOfBatchProcessThreads`, `batchSize*`).
- **Minimal seed:** ✅ but **carefully**. A new tenant needs the **core periodic jobs** (cycle close → bill → invoice; payment processing; reminders) scheduled, or nothing happens automatically. This is an **extract-replay** candidate: take a golden tenant's `config_job*`, keep the core jobs, drop tenant-specific ones, and **adjust schedules/timezone** (`TZ` per tenant). 🔎 Decide which `job_type`s are the minimal must-run set; everything else deferred.

> ⚠️ Demo Flyway is frozen and demo job config reflects Coope's cadence — treat the golden job set as a starting point, not gospel; validate `job_type` names against the running `core_enums.job_type`.

---

## 7 — Accumulators, grants, custom attributes, dashboards (supporting config)

| Area | Tables (Coope counts) | What it is | Minimal? |
|------|----------------------|------------|----------|
| **Accumulators / grants** | `config_accumulators`(2), `config_accumulator_list`(6), `config_grants`(1), `config_grant_list`(1) | Usage/credit buckets for prepaid/volume pricing | ⛔ deferred — usage/prepaid-specific; tied to product catalogue |
| **Custom attributes** | `custom_attributes`(104), `custom_attribute_lovs`(5), `config_custom_attribute`(2), `config_flex_attribute*` | Tenant-defined extra fields on accounts/orders/etc. | ⛔ deferred — by definition tenant-specific; `isCustomAttributeCached` flag ✅ |
| **Dashboards** | `config_dashboards`(3), `config_user_preferences`(1) | Per-user UI dashboards | ⛔ deferred — created per user in UI |
| **Correspondence templates** | `correspondence_template`(1), `_list`(24) | Email/SMS notification templates | ✅/⛔ — notifications fire (`*Notification` flags on) but need at least default templates; extract-replay defaults |
| **Exchange rates** | `config_exchange_rate`(909!), `_list`(1818) | FX rates (multi-currency tenants) | ⛔ deferred unless `multiCurrency=true`; loaded from a rate feed, not hand-seeded |
| **Calendars / cost centers / business units / legal entities** | `config_calendar*`, `config_cost_center*`, `config_business_unit*`, `config_legal_entity*` | Finance dimensions | ⛔ mostly empty on Coope too; seed only if the tenant's finance setup needs them |
| **Holidays / work week** | `holiday_special_config`(13), `work_week_config`(1), `time_unit_config`(1) | Business-day calculations (payment working day, collections) | ✅ minimal — seed work-week + a default (possibly empty) holiday set so date math works |
| **Zones** | `zones`(870!), `zone_unit`(1) | Usage rating zones (telecom geography) | ⛔ deferred — usage-rating-specific |
| **Regulatory / SAT / PAC** | `regulatory_product_codes`(15), `pac_product_codes`, `tax_exempt_taxcode_map`(8) | Mexico CFDI / regulatory | ⛔ deferred — region-specific (MX) |

---

## 8 — The minimal-template config footprint (the synthesis)

Pulling §1–§7 together, here's what the **generic minimal template** actually seeds vs. defers — the answer to "what do we set up before knowing requirements":

**✅ SEED (template):**
- L0 schema+enums; L5 reference (currency, country, UOM, product-family scaffold, GL skeleton, tax skeleton, AR items/reasons, payment terms, credit profile, operating unit, invoice company config); L4 internal `EMBRIX` tax map; L2/L3 tenant + 3 mandatory merchants; L1 ~90 flags; L6 role catalog + bootstrap admin.
- Minimal supporting config: a **default OMS task pipeline** for `NEW` orders, **core scheduled jobs** (cycle/bill/invoice/payment/reminders), a **default collection schedule**, **work-week/holiday** calendar basics, **default correspondence templates**, a **catch-all invoice template** (or PDF off).

**⛔ DEFER (post-provisioning / per-requirement, via UI or targeted extract-replay):**
- Product/pricing catalogue (`core_pricing`) — the tenant's actual products.
- Branded invoice/document templates (`output_template*` field maps).
- All provisioning sequences + vendor integrations (`config_prov_*`, provision-gateway, CRM/finance/payment external providers).
- Accumulators/grants, custom attributes, dashboards, zones, exchange rates, MX/PAC regulatory, multi-currency.

**The discipline:** the template gets a tenant to "**can log in, create an account, place an order, run a billing cycle, generate an invoice, record a payment, recognize revenue — all internally, no external integration**." Everything beyond that is switched on per requirement, each with its own (now-documented) seed + flag + gateway.

---

## 9 — New seed artifacts implied by this doc (to build next)

These are the "minimal supporting config" seeds §8 calls for but earlier sections didn't cover. Each is a small **extract-replay** (golden → parameterize → replay), mirroring §4/§7:
1. `sql/30-oms-tasks.sql` — `config_oms` + `config_oms_tasks` for `NEW` (+ core order types).
2. `sql/31-jobs.sql` — `config_job` + `config_job_list` core periodic jobs (timezone-adjusted).
3. `sql/32-collections.sql` — one default `config_collection_schedule` + actions + `account_collection_profile_map`.
4. `sql/33-calendar-basics.sql` — `work_week_config`, `time_unit_config`, default `holiday_special_config`.
5. `sql/34-correspondence.sql` — default `correspondence_template` set (notifications need these).
6. `sql/35-invoice-template-default.sql` — a catch-all `template`/`template_files`/`output_template` (or document: keep `generateInvoicePdf=false` until designed).

> Each of these needs **one golden-DB extract query** to capture the real rows/columns (I'll request them one at a time as we build, same as §4/§7). They are intentionally **not guessed** — the tables have many enum-bound columns (`oms_tasks`, `job_type`, `collection_action`, `template_type`) that must match the running build.

---

## 10 — Honest status of THIS doc

This now covers, at depth: the AMQ backbone + queue-prefix isolation, the full order-to-cash lifecycle with per-stage config, OMS tasks, provisioning, document/invoice rendering, AR/collections, scheduled jobs, and the long tail of supporting config — each tagged seed/defer/verify. **Gaps that remain by design** (not thinness): the *actual row-level seeds* for the §9 supporting tables need golden-DB extracts (enum-bound, must not be guessed), and the per-vendor provisioning sequences are out of scope until an integration is chosen. If you want, the next step is to capture those §9 extracts (one query each) so the supporting seeds become concrete scripts — or proceed to Part C (reload/verify/CI/CD/backout) and fold §9 into the CI pipeline as optional stages.
