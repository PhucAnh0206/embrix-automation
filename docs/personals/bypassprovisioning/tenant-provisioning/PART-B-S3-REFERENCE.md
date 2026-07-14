# Part B · §3 — L5: Reference data seed (currency, GL, tax, AR, product, payment)

> **This is the layer that has been costing you days.** Jeremy described it exactly: *"currency, gl, ar, product catalogue, tax… mostly trial and error."* L5 is the set of reference rows that the L1 feature flags **point at**. Get L5 right and consistent, and the dreaded `defaultGLAccount=10001 → row not found` class of failure disappears.
>
> Everything below is column-exact — every `INSERT` matches the real DDL in `engine/src/main/resources/db/migration/V3_*__Create_*_Config_Tables.sql`. Enum-referenced columns are flagged `⟦enum⟧` with a discovery query so you confirm allowed values against your DB before running.
>
> **Apply method:** versioned SQL (this data is *tenant-identical in shape*, only the IDs/currency/company differ → parameterize, don't hand-copy). **Order:** run this whole section as one transaction *after* L0 (schema) and *before* L4/L2/L1.

---

> ⚠️ **AUTHORITATIVE SOURCE:** the runnable, enum-corrected seed is **`sql/10-reference-seed.sql`** + the verified-values table in **§3.0.4**. The inline `INSERT` snippets in §3.5–§3.12 below are *illustrative for understanding* — a few still show the original assumed enum literals that §3.0.4 corrected (e.g. `INTERNAL`→`PRODUCT_CODES`, `MAIN`→`MAIN_TAX`, `NORMAL`→`POSTPAID`). **Run `sql/10`, not the snippets.**

## 3.0 — Mental model: L5 is the "vocabulary of money"

Before a tenant can issue a single invoice, the platform needs to know:

- **What currency** amounts are in, and how to round them (`currency` / `currencyList`).
- **Which country/countries** addresses and tax jurisdictions resolve against (`country_codes`).
- **What unit of measure** quantities are expressed in (`config_uom` / `config_uom_list`).
- **What product hierarchy** every charge rolls up to (`product_family` / `product_family_list`).
- **Which General Ledger accounts** revenue/AR/tax post to (`config_chart_of_account` / `_list`, `config_gl_account` / `_segments`).
- **How tax is structured** — tax types, product tax codes, jurisdictions (`tax_config`, `config_tax_type` / `_types`, `config_tax_product_taxes`, `tax_config_product_codes`).
- **What AR item types and reason codes** exist for invoices, adjustments, credit/debit notes (`ar_item_config` / `ar_item_types_config`, `ar_reason_code` / `ar_reason_code_types`).
- **Payment terms** (`payment_config` / `payment_terms`).
- **Credit profile** defaults (`credit_profile` / `credit_profiles`).
- **Operating unit / set of books** for finance (`operating_unit` / `operating_unit_list`).
- **Invoice header/company** identity (`invoice_tenant_config`).
- (If usage/rating) **rate units** (`rate_unit` / `rate_units`).

On the demo (Coope) DB these are populated as: `config_chart_of_account_list`=33, `config_tax_types`=9, `ar_item_types_config`=11, `currencylist`=3, `country_codes`=6, `product_family_list`=16, `config_uom_list`=1, `operating_unit_list`=1. **The minimal generic template needs far fewer rows than Coope carries** — we seed the smallest internally-consistent set and let the tenant grow it via the UI later. The numbers below are the *minimal* set, not a copy of Coope.

### 3.0.1 The parent/child (`*` / `*_list`) pattern — read once, applies everywhere

Almost every config object in Embrix is a **header row** in table `X` (holds an `id`, sometimes a `type`) plus **detail rows** in table `X_list` (or `X_types`) that reference `X.id` and carry an `index`. Examples: `currency`→`currencyList`, `config_chart_of_account`→`config_chart_of_account_list`, `product_family`→`product_family_list`, `ar_item_config`→`ar_item_types_config`, `payment_config`→`payment_terms`. **You always insert the header first, then the list rows.** This is why ordering inside L5 matters too, not just between layers.

### 3.0.2 Parameters (psql variables — set once at the top)

The seed script is parameterized with `psql` `\set` variables. Edit only this block per tenant (it comes from the Part A parameter sheet / `tenant-profile.yaml`):

```sql
\set ON_ERROR_STOP on
-- ===== per-tenant parameters =====
\set tenant_id        '''acme'''                 -- logical config owner id used in *.id columns
\set currency_code    '''USD'''                  -- ISO currency
\set currency_symbol  '''$'''
\set currency_name    '''US Dollar'''
\set country_name     '''United States'''
\set country_a2       '''US'''
\set country_a3       '''USA'''
\set legal_entity     '''Acme Inc'''
\set selling_company  '''0900'''
\set default_gl       '''10001'''                -- MUST equal ccp_properties.defaultGLAccount (L1)
\set tax_item_id      '''ACME-TaxationItemId'''  -- MUST equal ccp_properties.taxationItemId (L1)
-- =================================
```

> The `'''x'''` triple-quote is the psql idiom to produce a *quoted* literal `'x'` when the variable is substituted into SQL. Use `:currency_code` (no quotes) in statements; it expands to `'USD'`.

### 3.0.3 Enum discovery (run FIRST — do not guess enum values)

Several L5 columns FK-reference `core_enums.*`. Confirm the exact allowed strings before seeding (your inventory already proved these tables are populated — e.g. `rounding_method`, `tax_jurisdiction`, `account_type`):

```sql
-- one paste, all enums L5 touches:
SELECT 'rounding_method'   AS enum, string_agg(name, ', ') FROM core_enums.rounding_method
UNION ALL SELECT 'config_type',        string_agg(name, ', ') FROM core_enums.config_type
UNION ALL SELECT 'ar_item_type',       string_agg(name, ', ') FROM core_enums.ar_item_type
UNION ALL SELECT 'arops_reason',       string_agg(name, ', ') FROM core_enums.arops_reason
UNION ALL SELECT 'ar_reason_code_object_type', string_agg(name, ', ') FROM core_enums.ar_reason_code_object_type
UNION ALL SELECT 'ar_reason_code_status',      string_agg(name, ', ') FROM core_enums.ar_reason_code_status
UNION ALL SELECT 'tax_config_type',    string_agg(name, ', ') FROM core_enums.tax_config_type
UNION ALL SELECT 'tax_type',           string_agg(name, ', ') FROM core_enums.tax_type
UNION ALL SELECT 'tax_jurisdiction',   string_agg(name, ', ') FROM core_enums.tax_jurisdiction
UNION ALL SELECT 'payment_config_type',string_agg(name, ', ') FROM core_enums.payment_config_type
UNION ALL SELECT 'payment_working_day',string_agg(name, ', ') FROM core_enums.payment_working_day
UNION ALL SELECT 'revenue_config_type',string_agg(name, ', ') FROM core_enums.revenue_config_type
UNION ALL SELECT 'gl_segment_name',    string_agg(name, ', ') FROM core_enums.gl_segment_name
UNION ALL SELECT 'customer_segment',   string_agg(name, ', ') FROM core_enums.customer_segment
UNION ALL SELECT 'account_type',       string_agg(name, ', ') FROM core_enums.account_type
UNION ALL SELECT 'account_category',   string_agg(name, ', ') FROM core_enums.account_category
ORDER BY 1;
```

Wherever a value below is marked `⟦enum: X⟧`, replace it with a real value from this dump if your enum differs from the assumed one.

### 3.0.4 VERIFIED enum values (live DB, 2026-05-30) — the seed scripts now use these

The query above was run against the live DB and **corrected several wrong guesses** in the seed SQL. These are the verified values `sql/10-reference-seed.sql` now uses (don't revert them):

| Column / use | ✅ Verified value | ❌ Earlier wrong guess |
|--------------|------------------|------------------------|
| `config_gl_account.type` (revenue_config_type) | `GENERAL_LEDGER` | ~~GL_ACCOUNT~~ |
| `tax_config.type` (tax_config_type) | `PRODUCT_CODES` (only value) | ~~INTERNAL~~ |
| `config_tax_types.taxtype` (tax_type) | `MAIN_TAX` (or `ADDITIONAL_TAX`) | ~~MAIN~~ |
| `ar_item_config.type` / `ar_reason_code.type` (config_type) | `AR_ITEM_CONFIG` / `AR_REASON_CODE` | ~~AR_ITEM~~ / ~~AR_REASON~~ |
| `ar_item_types_config.artype` (ar_item_type) | `PAYMENT, CREDIT_ADJUSTMENT, DEBIT_ADJUSTMENT, WRITE_OFF` (+ DISPUTE/SETTLEMENT/REFUND/…) | ~~INVOICE, CREDIT_NOTE, DEBIT_NOTE~~ (not valid) |
| `ar_reason_code_types.reasoncode` (arops_reason) | `DATA_ERROR` (+ PRICING_ERROR, BAD_DEBT_WRITE_OFF, …) | ~~BILLING_ERROR~~ |
| `payment_config.paymentconfigtype` (payment_config_type) | `PAYMENT_TERMS`, `PAYMENT_METHODS` (separate headers) | ~~PAYMENT_TERM~~ (single) |
| `payment_terms.paymentworkingday` (payment_working_day) | `NEXT_WORKING_DAY` / `LAST_WORKING_DAY` (or NULL) | ~~CALENDAR_DAY~~ (not valid) |
| `payment_methods.method` (payment_method) | `CHECK, MANUAL, ACH, CREDIT_CARD, ECHECK, NON_PAYING` | ~~CASH~~ (not valid) |
| `credit_profile.accountcategory` (account_category) | `POSTPAID` / `PREPAID` / `HYBRID` | ~~NORMAL~~ |
| `rate_units.unit` (scale_unit) | `ONE` / `NONE` (+ MINUTE, MEGABYTE, KWH, …) | ~~UNIT~~ |
| `rounding_method` | `HALF_UP` ✓ (also DOWN/HALF_DOWN/NEAREST/UP) | — was correct |
| `gl_segment_name` | `ACCOUNT` ✓ | — was correct |
| `tax_jurisdiction` | `FEDERAL` ✓ (also STATE/CITY/COUNTY/…) | — was correct |
| `account_type` | `RESIDENTIAL` ✓ (golden-confirmed) | — was correct |
| `account_role` (contact/address role) | `BILLING` ✓ (also PAYMENT/SERVICE/SOLD_TO) | — was correct |

> **Lesson for the team:** these names are stable Embrix vocabulary, but **never assume** — run §3.0.3 against the target tenant's DB first. The seeds are atomic, so one wrong enum just rolls the transaction back with a clear FK error naming the column.

---

## 3.1 — Currency (`currency` + `currencyList`)

**Satisfies L1 pointers:** `currency`, `defaultCurrency`, and the multi-currency machinery. **DDL recap:** `currency(id PK)`; `currencyList(id→currency, index, currencyid, symbol, name, roundingmethod ⟦enum: rounding_method⟧, roundingprecision, paymentthreshold, paymentexchangethreshold)`.

```sql
-- header
INSERT INTO core_config.currency (id, createddate)
VALUES (:currency_code, now())
ON CONFLICT (id) DO NOTHING;

-- detail: one row per supported currency. Minimal = the tenant's home currency only.
INSERT INTO core_config.currencyList
  (id, index, currencyid, symbol, name, roundingmethod, roundingprecision,
   paymentthreshold, paymentexchangethreshold)
VALUES
  (:currency_code, 0, :currency_code, :currency_symbol, :currency_name,
   'HALF_UP',          -- ⟦enum: rounding_method⟧ confirm (demo uses HALF_UP-style)
   2, 0.00, 0.05)
ON CONFLICT (id, index) DO NOTHING;
```

**Why precision/threshold matter:** `roundingprecision=2` is normal for USD; for currencies like CRC/CLP you may use 0. `paymentexchangethreshold=0.05` mirrors the demo flag `exchangeThreshold=0.05` — keep them consistent.

**Verify:** `SELECT * FROM core_config.currencyList WHERE id = :currency_code;` → 1 row.

---

## 3.2 — Country codes (`country_codes`)

**Satisfies:** address validation, tax jurisdiction resolution, `tenant_profile.country`, `user_address.country`. **DDL recap:** `country_codes(name PK, alpha2, alpha3, numcode, isdcode, continent, region1, region2)` — all `NOT NULL`.

```sql
INSERT INTO core_config.country_codes
  (name, alpha2, alpha3, numcode, isdcode, continent, region1, region2)
VALUES
  (:country_name, :country_a2, :country_a3, '840', '1',
   'North America', 'Americas', 'Northern America')
ON CONFLICT (name) DO NOTHING;
```

> Minimal = the tenant's operating country only. Add neighbours later if `crossCountryPurchase/Payment` flags get turned on. `numcode`/`isdcode` are real ISO‑3166 / calling codes — `840`/`1` for the US; look these up per country (don't invent).

**Verify:** `SELECT name, alpha2 FROM core_config.country_codes;`

---

## 3.3 — Unit of measure (`config_uom` + `config_uom_list`)

**Satisfies:** product quantities, rating units. **DDL recap:** `config_uom(id PK, name)`; `config_uom_list(id→config_uom, index, unitid, name, description, startdate, enddate, symbol, …)`.

```sql
INSERT INTO core_config.config_uom (id, name, createddate)
VALUES (:tenant_id || '-UOM', 'UOM CONFIG', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO core_config.config_uom_list
  (id, index, unitid, name, description, startdate, symbol)
VALUES
  (:tenant_id || '-UOM', 0, 'EACH', 'Each', 'Per-unit quantity', now(), 'EA')
ON CONFLICT (id, index) DO NOTHING;
```

> Minimal = a single `EACH` unit (covers per-subscription, per-line charges). Telecom usage tenants add `MIN`, `MB`, `SMS` etc. later, tied to `rate_units` (§3.12).

---

## 3.4 — Product hierarchy (`product_family` + `product_family_list`)

**Satisfies L1 pointers:** `productCompany`, `productFamily`, `productLine`, `productType`, `productSubType` (all five are `ccp_properties` keys and all five are `NOT NULL` columns here). **DDL recap:** `product_family(id PK)`; `product_family_list(id, index, productcompany, productfamily, productline, producttype, productsubtype)` — unique on the 5-tuple.

```sql
INSERT INTO core_config.product_family (id, createddate)
VALUES (:tenant_id || '-PF', now())
ON CONFLICT (id) DO NOTHING;

-- Minimal = one DEFAULT hierarchy row. Every product/charge can roll up to this
-- until the real catalogue is built in the UI.
INSERT INTO core_config.product_family_list
  (id, index, productcompany, productfamily, productline, producttype, productsubtype)
VALUES
  (:tenant_id || '-PF', 0, :selling_company, 'DEFAULT', 'DEFAULT', 'DEFAULT', 'DEFAULT')
ON CONFLICT (id, index) DO NOTHING;
```

> ⚠️ **Critical consistency rule:** the L1 flags `productFamily/productLine/productType/productSubType` you set in §6 **must** be one of the 5-tuples present here. If §6 sets `productFamily=BASE` but L5 only has `DEFAULT`, order creation that stamps the product hierarchy will fail the FK/lookup. The template keeps both at `DEFAULT` to stay consistent; if you parameterize one, parameterize the other in lock-step.

---

## 3.5 — Chart of Accounts + GL (`config_chart_of_account` (+`_list`), `config_gl_account` (+`_segments`))

**Satisfies L1 pointers:** `defaultGLAccount`, `useGLCombination`, all revenue/AR/tax GL postings. This is the layer where `defaultGLAccount=10001` becomes real. **DDL recap:**
- `config_chart_of_account(id PK, name, userId)`; `config_chart_of_account_list(id, index, accountnumber UNIQUE, name UNIQUE, type, detailtype, description, notesaccount, notesname)`.
- `config_gl_account(id PK, type ⟦enum: revenue_config_type⟧, delimiter)`; `config_gl_account_segments(id, index, name ⟦enum: gl_segment_name⟧, length, leadingzeroes)`.

```sql
-- Chart of Accounts header
INSERT INTO core_config.config_chart_of_account (id, name, userId, createddate)
VALUES (:tenant_id || '-COA', 'Default Chart of Accounts', 'system', now())
ON CONFLICT (id) DO NOTHING;

-- Minimal GL accounts. accountnumber 10001 == :default_gl (the L1 pointer target).
-- A real tenant has dozens (demo=33); minimal needs the few that postings reference:
--   revenue, AR/receivable, tax payable, suspense/clearing.
INSERT INTO core_config.config_chart_of_account_list
  (id, index, accountnumber, name, type, detailtype, description)
VALUES
  (:tenant_id || '-COA', 0, :default_gl,  'Default Revenue', 'Revenue',   'Income',          'Default revenue account'),
  (:tenant_id || '-COA', 1, '10002',      'Accounts Receivable', 'Asset', 'Accounts Receivable', 'AR control'),
  (:tenant_id || '-COA', 2, '10003',      'Tax Payable',   'Liability', 'Tax',             'Output tax payable'),
  (:tenant_id || '-COA', 3, '10004',      'Payment Suspense', 'Asset', 'Other Current Asset', 'Unapplied payments'),
  (:tenant_id || '-COA', 4, '10005',      'Pending Deposit', 'Liability', 'Other Current Liability', 'Pending deposits')
ON CONFLICT (id, index) DO NOTHING;

-- GL account structure (segments). Minimal = single-segment GL ("natural account").
INSERT INTO core_config.config_gl_account (uuid, id, type, delimiter, createddate)
VALUES (gen_random_uuid()::text, :tenant_id || '-GL',
        'GL_ACCOUNT',   -- ⟦enum: revenue_config_type⟧ confirm exact value
        '-', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO core_config.config_gl_account_segments (id, index, name, length, leadingzeroes)
VALUES
  (:tenant_id || '-GL', 0,
   'ACCOUNT',   -- ⟦enum: gl_segment_name⟧ confirm (demo has 5 segment names)
   6, true)
ON CONFLICT (id, index, name) DO NOTHING;
```

> **Pointers this satisfies, made explicit:** L1 `defaultGLAccount` → `config_chart_of_account_list.accountnumber`. L1 `paymentSuspenseAccount`, `pendingDepositAccount` (empty on demo, but if you set them) → must also be account numbers seeded here. The minimal 5 accounts cover the standard order→invoice→payment postings. `useGLCombination=true` (demo) means postings build a combined GL string from segments — hence the single `ACCOUNT` segment above; if you keep `useGLCombination=false` for the new tenant, the segment rows are still harmless.

**Verify (this is the anti-"config not found" check):**
```sql
SELECT (SELECT count(*) FROM core_config.config_chart_of_account_list WHERE id = :tenant_id||'-COA') AS coa_rows,
       EXISTS(SELECT 1 FROM core_config.config_chart_of_account_list
              WHERE accountnumber = :default_gl) AS default_gl_exists;  -- MUST be true
```

---

## 3.6 — Tax (`tax_config`, `config_tax_type`(+`_types`), `config_tax_product_taxes`, `tax_config_product_codes`)

**Satisfies L1 pointers:** `taxApplicable`, `taxationItemId`, `primaryTaxType`, `addOnTaxType`, `splitTaxCalculationByItem`, `taxByLineItem`, `useProviderForARTax`. **DDL recap:**
- `tax_config(uuid, id, type ⟦enum: tax_config_type⟧ UNIQUE, createddate)`.
- `config_tax_type(uuid, id PK, name default 'TAX TYPES CONFIG')`; `config_tax_types(id→config_tax_type, index, name UNIQUE, code UNIQUE, startdate, enddate, description, taxtype ⟦enum: tax_type⟧, itemid)`.
- `config_tax_product_taxes(id, index, refindex, jurisdiction ⟦enum: tax_jurisdiction⟧, …, taxpercent, …)`.

```sql
-- top-level tax config (the 'kind' of tax setup; type is enum-bound + UNIQUE)
INSERT INTO core_config.tax_config (uuid, id, type, createddate)
VALUES (gen_random_uuid()::text, :tenant_id || '-TAXCFG',
        'INTERNAL',   -- ⟦enum: tax_config_type⟧ confirm (INTERNAL vs PROVIDER etc.)
        now())
ON CONFLICT (type) DO NOTHING;

-- tax type header
INSERT INTO core_config.config_tax_type (uuid, id, name, createddate)
VALUES (gen_random_uuid()::text, :tenant_id || '-TAXTYPE', 'TAX TYPES CONFIG', now())
ON CONFLICT (id) DO NOTHING;

-- tax type detail. itemid links the tax to a billable item == :tax_item_id (L1 pointer).
INSERT INTO core_config.config_tax_types
  (id, index, name, code, startdate, description, taxtype, itemid)
VALUES
  (:tenant_id || '-TAXTYPE', 0, 'Standard VAT', 'VAT', now(),
   'Standard value-added tax',
   'MAIN',           -- ⟦enum: tax_type⟧ confirm (demo primaryTaxType=Main)
   :tax_item_id)
ON CONFLICT (id, index) DO NOTHING;

-- product tax rates (rate the engine applies). Minimal = one standard rate.
INSERT INTO core_config.config_tax_product_taxes
  (id, index, refindex, jurisdiction, taxpercent, startdate, name, description)
VALUES
  (:tenant_id || '-TAXTYPE', 0, 0,
   'FEDERAL',         -- ⟦enum: tax_jurisdiction⟧ confirm
   13.00, now(), 'Standard VAT', '13% standard rate')
ON CONFLICT (id, index, refindex) DO NOTHING;
```

> If the tenant uses an **external tax provider** (Vertex/Avalara via `tax-gateway`) you set `useProviderForARTax=true` and the canonical maps in L4 carry the integration — but you still seed a minimal local `config_tax_types` so non-provider paths and `taxationItemId` resolve. The 13% is a placeholder; set the tenant's real standard rate.

**Verify:** `SELECT name, code, itemid FROM core_config.config_tax_types WHERE id = :tenant_id||'-TAXTYPE';` and confirm `itemid = :tax_item_id`.

---

## 3.7 — AR item types + reason codes (`ar_item_config`(+`ar_item_types_config`), `ar_reason_code`(+`_types`))

**Satisfies:** invoicing, adjustments, credit/debit notes, write-offs, disputes — i.e. every AR operation needs an item type and a reason code. **DDL recap:**
- `ar_item_config(uuid, id, type ⟦enum: config_type⟧ UNIQUE)`; `ar_item_types_config(id, index, artype ⟦enum: ar_item_type⟧ UNIQUE, itemid, company)`.
- `ar_reason_code(uuid, id, type ⟦enum: config_type⟧ UNIQUE)`; `ar_reason_code_types(id, index, reasoncode ⟦enum: arops_reason⟧, description, customreasoncode, objecttype ⟦enum⟧, status ⟦enum⟧, …)`.

```sql
-- AR item types header
INSERT INTO core_config.ar_item_config (uuid, id, type, createddate)
VALUES (gen_random_uuid()::text, :tenant_id || '-ARITEM',
        'AR_ITEM',   -- ⟦enum: config_type⟧ confirm
        now())
ON CONFLICT (type) DO NOTHING;

-- One row per ar_item_type the tenant uses. Demo has 11; minimal covers the core flows.
-- artype is enum-bound (core_enums.ar_item_type has 12 values) and UNIQUE.
INSERT INTO core_config.ar_item_types_config (id, index, artype, itemid, company)
VALUES
  (:tenant_id || '-ARITEM', 0, 'INVOICE',     :tenant_id || '-INV-ITEM',  :selling_company),
  (:tenant_id || '-ARITEM', 1, 'CREDIT_NOTE', :tenant_id || '-CN-ITEM',   :selling_company),
  (:tenant_id || '-ARITEM', 2, 'DEBIT_NOTE',  :tenant_id || '-DN-ITEM',   :selling_company),
  (:tenant_id || '-ARITEM', 3, 'PAYMENT',     :tenant_id || '-PAY-ITEM',  :selling_company)
ON CONFLICT (artype) DO NOTHING;   -- ⟦confirm artype values against ar_item_type dump⟧

-- AR reason codes header + minimal codes
INSERT INTO core_config.ar_reason_code (uuid, id, type, createddate)
VALUES (gen_random_uuid()::text, :tenant_id || '-ARREASON',
        'AR_REASON',  -- ⟦enum: config_type⟧ confirm
        now())
ON CONFLICT (type) DO NOTHING;

INSERT INTO core_config.ar_reason_code_types
  (id, index, reasoncode, description, customreasoncode, objecttype, status)
VALUES
  (:tenant_id || '-ARREASON', 0, 'BILLING_ERROR', 'Billing error correction', 'BILL_ERR',
   'INVOICE',   -- ⟦enum: ar_reason_code_object_type⟧
   'ACTIVE')    -- ⟦enum: ar_reason_code_status⟧
ON CONFLICT (reasoncode) DO NOTHING;
```

> The `itemid` values here are referenced by revenue/finance postings; they don't have to pre-exist elsewhere (they're declared here), but they **must** be unique and stable — don't churn them after go-live. `reasoncode` is enum-bound to `core_enums.arops_reason` (10 values); pick real ones from the dump.

---

## 3.8 — Payment config + terms (`payment_config` + `payment_terms`)

**Satisfies L1 pointers:** `paymentTerm` (demo=`NET_15`), `paymentMethod`, payment allocation. **DDL recap:** `payment_config(id PK, paymentconfigtype ⟦enum: payment_config_type⟧)`; `payment_terms(id→payment_config, index, paymentterm UNIQUE, days, "offset", paymentworkingday ⟦enum⟧, externalrefid)`; `payment_methods(id, index, method ⟦enum: payment_method⟧)`.

```sql
INSERT INTO core_config.payment_config (id, paymentconfigtype, createddate)
VALUES (:tenant_id || '-PAYCFG',
        'PAYMENT_TERM',  -- ⟦enum: payment_config_type⟧ confirm (3 values exist)
        now())
ON CONFLICT (id) DO NOTHING;

-- payment terms. paymentterm string must match what L1 paymentTerm references (NET_15 etc.)
INSERT INTO core_config.payment_terms
  (id, index, paymentterm, days, "offset", paymentworkingday)
VALUES
  (:tenant_id || '-PAYCFG', 0, 'NET_15', 15, 0,
   'CALENDAR_DAY'),   -- ⟦enum: payment_working_day⟧ confirm
  (:tenant_id || '-PAYCFG', 1, 'NET_30', 30, 0, 'CALENDAR_DAY')
ON CONFLICT (id, index) DO NOTHING;

-- accepted payment methods (method is enum-bound; demo default paymentMethod=CHECK)
INSERT INTO core_config.payment_methods (id, index, method)
VALUES
  (:tenant_id || '-PAYCFG', 0, 'CHECK'),   -- ⟦enum: payment_method⟧ (6 values)
  (:tenant_id || '-PAYCFG', 1, 'CASH')
ON CONFLICT (id, index) DO NOTHING;
```

> ⚠️ `paymentterm` is `UNIQUE` across the table — if another tenant already seeded `NET_15` into the *same* DB you'd collide, but since each tenant has its **own database** (`coredb-<tenant>`) this is safe. The L1 flag `paymentTerm=NET_15` must be one of the strings seeded here.

---

## 3.9 — Credit profile (`credit_profile` + `credit_profiles`)

**Satisfies:** account credit limits, `throwCreditLimitBreachException`. **DDL recap:** `credit_profile(id PK, name UNIQUE, customersegment ⟦enum⟧, saleschannel ⟦enum⟧, marketsegment ⟦enum⟧, accounttype ⟦enum⟧, accountsubtype ⟦enum⟧, sellingcompany default '0900', legalentity, accountcategory ⟦enum⟧)`; `credit_profiles(id, index, currency, creditlimit, …)`.

```sql
INSERT INTO core_config.credit_profile
  (id, name, customersegment, saleschannel, marketsegment,
   accounttype, accountsubtype, sellingcompany, legalentity, accountcategory)
VALUES
  (:tenant_id || '-CREDIT', 'Default Credit Profile',
   'B2C',          -- ⟦enum: customer_segment⟧ (demo customerSegment=B2C)
   'NONE',         -- ⟦enum: sales_channel⟧
   'NONE',         -- ⟦enum: market_segment⟧
   'RESIDENTIAL',  -- ⟦enum: account_type⟧
   'NONE',         -- ⟦enum: account_sub_type⟧
   :selling_company, :legal_entity,
   'NORMAL')       -- ⟦enum: account_category⟧ confirm
ON CONFLICT (id) DO NOTHING;

INSERT INTO core_config.credit_profiles (id, index, currency, creditlimit)
VALUES (:tenant_id || '-CREDIT', 0, :currency_code, 1000000.00)
ON CONFLICT (id, index) DO NOTHING;
```

> The enum values here are exactly the demo's `accountType=RESIDENTIAL`, `customerSegment=B2C`, etc. — they must match the L1 enum-default flags you set in §6 so new accounts created with the tenant defaults map to this profile.

---

## 3.10 — Operating unit / set of books (`operating_unit` + `operating_unit_list`)

**Satisfies:** finance extract, `setOfBooks` L1 pointer, GL combination. **DDL recap:** `operating_unit(uuid, id PK)`; `operating_unit_list(id, index, operatingunitname, operatingunitid, setofbooksid, setofbookscode VARCHAR(3), setofbooksname)`.

```sql
INSERT INTO core_config.operating_unit (uuid, id, createddate)
VALUES (gen_random_uuid()::text, :tenant_id || '-OU', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO core_config.operating_unit_list
  (id, index, operatingunitname, operatingunitid, setofbooksid, setofbookscode, setofbooksname)
VALUES
  (:tenant_id || '-OU', 0, :legal_entity, 1, 1, 'SOB', :legal_entity || ' Books')
ON CONFLICT (operatingunitid) DO NOTHING;
```

> L1 `setOfBooks` (demo had it via `SET_OF_BOOKS`) should reference `setofbookscode`/`setofbooksid` seeded here. `setofbookscode` is capped at 3 chars.

---

## 3.11 — Invoice tenant config (`invoice_tenant_config`)

**Satisfies:** invoice header/company identity on generated PDFs. **DDL recap:** `invoice_tenant_config(uuid, id PK, nameofthecompany, taxid, message, customermemo)`.

```sql
INSERT INTO core_config.invoice_tenant_config
  (uuid, id, nameofthecompany, taxid, message, customermemo, createddate)
VALUES
  (gen_random_uuid()::text, :tenant_id || '-INVCFG', :legal_entity,
   'TAXID-PLACEHOLDER', 'Thank you for your business.',
   'Please remit payment by the due date.', now())
ON CONFLICT (id) DO NOTHING;
```

> Replace `TAXID-PLACEHOLDER` with the tenant's real tax/company registration id (this prints on invoices). This pairs with `tenant_profile.companytaxid` set during `createTenant` (L2).

---

## 3.12 — (Usage tenants only) Rate units (`rate_unit` + `rate_units`)

**Satisfies:** usage rating (`allowUsageProcessing=true`). Skip for a pure subscription tenant with no usage. **DDL recap:** `rate_unit(uuid, id PK)`; `rate_units(id, code UNIQUE, expression, unit ⟦enum: scale_unit⟧, status ⟦enum: rate_unit_status⟧, isquantityscalable)`.

```sql
INSERT INTO core_config.rate_unit (uuid, id, createddate)
VALUES (gen_random_uuid()::text, :tenant_id || '-RU', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO core_config.rate_units (id, code, expression, unit, status, isquantityscalable)
VALUES
  (:tenant_id || '-RU', 'EACH', '1', 'UNIT',  -- ⟦enum: scale_unit⟧ confirm
   'ACTIVE',                                   -- ⟦enum: rate_unit_status⟧
   false)
ON CONFLICT (code) DO NOTHING;
```

---

## 3.13 — Assembling the L5 seed script + transaction wrapper

Put all of the above into `sql/10-reference-seed.sql`, wrapped so it's **atomic** (all-or-nothing) and **idempotent** (re-runnable). The `ON CONFLICT … DO NOTHING` on every insert means a second run is a no-op, not a duplicate-key crash.

```sql
\set ON_ERROR_STOP on
BEGIN;
-- (parameter \set block from 3.0.2)
-- (3.1 currency) … (3.11 invoice config) … (3.12 rate units if usage)
COMMIT;
```

Run it:
```bash
psql "postgresql://acme_app:<pwd>@embrix-rds-dev-db….rds.amazonaws.com:5432/coredb-acme?sslmode=require" \
     -v ON_ERROR_STOP=1 -f sql/10-reference-seed.sql
```

---

## 3.14 — L5 verification gate (run before L4)

```sql
SELECT 'L5_GATE' AS gate,
  (SELECT count(*) FROM core_config.currencyList            WHERE id = :tenant_id||'')                 AS currencies,
  (SELECT count(*) FROM core_config.country_codes)                                                     AS countries,
  (SELECT count(*) FROM core_config.config_chart_of_account_list WHERE id = :tenant_id||'-COA')        AS gl_accounts,
  EXISTS(SELECT 1 FROM core_config.config_chart_of_account_list WHERE accountnumber = :default_gl)      AS default_gl_ok,
  (SELECT count(*) FROM core_config.config_tax_types        WHERE id = :tenant_id||'-TAXTYPE')         AS tax_types,
  (SELECT count(*) FROM core_config.ar_item_types_config    WHERE id = :tenant_id||'-ARITEM')          AS ar_items,
  (SELECT count(*) FROM core_config.payment_terms           WHERE id = :tenant_id||'-PAYCFG')          AS pay_terms,
  (SELECT count(*) FROM core_config.product_family_list     WHERE id = :tenant_id||'-PF')              AS prod_families;
```
**Pass criteria:** every count ≥ 1 and `default_gl_ok = true`. If `default_gl_ok` is false, **stop** — your L1 `defaultGLAccount` will be a dangling pointer.

---

## 3.15 — Backout (revert L5 for this tenant)

Because each row is scoped by `:tenant_id`-prefixed `id`, backout is precise (run in reverse FK order — list/детail first, then header):

```sql
BEGIN;
DELETE FROM core_config.config_chart_of_account_list WHERE id = :tenant_id||'-COA';
DELETE FROM core_config.config_chart_of_account      WHERE id = :tenant_id||'-COA';
DELETE FROM core_config.config_tax_types             WHERE id = :tenant_id||'-TAXTYPE';
DELETE FROM core_config.config_tax_type              WHERE id = :tenant_id||'-TAXTYPE';
DELETE FROM core_config.config_tax_product_taxes     WHERE id = :tenant_id||'-TAXTYPE';
DELETE FROM core_config.ar_item_types_config         WHERE id = :tenant_id||'-ARITEM';
DELETE FROM core_config.ar_item_config               WHERE id = :tenant_id||'-ARITEM';
DELETE FROM core_config.ar_reason_code_types         WHERE id = :tenant_id||'-ARREASON';
DELETE FROM core_config.ar_reason_code               WHERE id = :tenant_id||'-ARREASON';
DELETE FROM core_config.payment_terms                WHERE id = :tenant_id||'-PAYCFG';
DELETE FROM core_config.payment_methods              WHERE id = :tenant_id||'-PAYCFG';
DELETE FROM core_config.payment_config               WHERE id = :tenant_id||'-PAYCFG';
DELETE FROM core_config.credit_profiles              WHERE id = :tenant_id||'-CREDIT';
DELETE FROM core_config.credit_profile               WHERE id = :tenant_id||'-CREDIT';
DELETE FROM core_config.operating_unit_list          WHERE id = :tenant_id||'-OU';
DELETE FROM core_config.operating_unit               WHERE id = :tenant_id||'-OU';
DELETE FROM core_config.product_family_list          WHERE id = :tenant_id||'-PF';
DELETE FROM core_config.product_family               WHERE id = :tenant_id||'-PF';
DELETE FROM core_config.config_uom_list              WHERE id = :tenant_id||'-UOM';
DELETE FROM core_config.config_uom                   WHERE id = :tenant_id||'-UOM';
DELETE FROM core_config.invoice_tenant_config        WHERE id = :tenant_id||'-INVCFG';
-- currency/country are often shared-safe; delete only if tenant-exclusive
COMMIT;
```

---

## 3.16 — What §3 produced / next

You now have a minimal, internally-consistent **reference layer**: a currency, a country, a UOM, a default product hierarchy, a 5-account chart with the `defaultGLAccount` present, a standard tax type/rate, core AR item types + reason codes, payment terms, a credit profile, an operating unit, and invoice company identity. Every L1 pointer you'll set in §6 now has a real row to resolve to.

**Next: §4 (L4 canonical maps)** — the `gateway_api_map` (+request/response) rows. On the demo these are large (`gateway_api_map`=64, `gateway_api_requestmap`=851, `gateway_api_responsemap`=471) and mostly **tenant-identical**, so the strategy there is *extract-once from a golden tenant → parameterize the few tenant-specific values → replay as SQL*, rather than hand-authoring. I'll need one targeted dump of a few `gateway_api_map` rows to show the exact extract/replay pattern.
