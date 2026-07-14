# Part B · §4 — L4: Canonical maps (gateway integration catalog)

> Canonical maps are the **field-translation contract** between Embrix's internal ("canonical") data model and each external system's API payload. They are why an Embrix `accountId` becomes COOPEWEB's `customer_code`, or why NOKIA's `optical_sn` becomes Embrix's `serviceUnitId`. Miss a row and you get the infamous **`Canonical response config mapping not found`**.
>
> **The big realization from your catalog dump:** `providername` is an **external system** (COOPEWEB, NETSUITE, JARS, MOTV, NOKIA, NETUP, PORTAONE, EMBRIX), *not* tenant data. So L4 is an **integration catalog**, and a brand-new "no integration yet" tenant needs **almost none of it** — only the internal `EMBRIX` maps. Provider maps are added **per integration**, by replaying a known-good provider bundle. That is the entire strategy of this section: *don't hand-author canonical maps; extract a provider's bundle once from a golden DB and replay it.*

---

## 4.0 — What a canonical map actually is (and the read path that fails)

When a gateway calls an external provider, two translations happen:
1. **Request map** — Embrix builds a canonical request, then `gateway_api_requestmap` rows say "canonical field `X` → provider source field `Y`."
2. **Response map** — the provider replies, and `gateway_api_responsemap` rows say "provider field `Y` (optionally with a fixed `value`) → canonical field `X`."

The lookup (verified earlier in `gateway-common/.../CanonicalMapServiceImpl.groovy` and `GatewayApiMapServiceImpl.groovy`) is:

```
mapResponse(gateway, api, provider, data, req)
  → getGatewayApiResponseMapping(gateway, api, provider)
    → SELECT * FROM core_config.gateway_api_map
       WHERE gatewayname = ? AND providername = ? AND apiname = ?
    → + JOIN gateway_api_requestmap  ON  .id
    → + JOIN gateway_api_responsemap ON  .id
```

If the `gateway_api_map` row for that `(gatewayname, providername, apiname)` triple is missing, the lookup returns nothing and the caller throws **`Canonical response config mapping not found`**. This is the single most common "config not found" your team hits, and it is *purely* an L4 problem. The fix is always: seed the map row (+ its child request/response rows) for that exact triple.

### 4.0.1 The three tables (column-exact, from `V3_6__Create_OpsHub_Config_Tables.sql`)

```sql
-- PARENT: one row per (gateway, provider, api)
core_config.gateway_api_map (
  uuid            VARCHAR(255) NOT NULL,
  id              VARCHAR(255) UNIQUE,                                   -- links children
  gatewayname     VARCHAR(50) NOT NULL  → core_enums.merchant_type(name) -- ⟦enum⟧ e.g. CRM_GATEWAY
  providername    VARCHAR(50) NOT NULL,                                  -- external system, e.g. COOPEWEB
  apiname         VARCHAR(50) NOT NULL  → core_enums.gateway_api(name)   -- ⟦enum⟧ 131 values, e.g. APPLY_PAYMENT
  objecttype      VARCHAR(50)           → core_enums.object_type(name)   -- ⟦enum⟧ optional
  country         VARCHAR(3),                                            -- optional country scoping
  payloadtemplatepath VARCHAR(255),                                      -- optional XSLT/template path
  createddate     DATE DEFAULT now()
)
-- CHILD: request field mapping (canonical → source)
core_config.gateway_api_requestmap (
  id              → gateway_api_map(id),
  index           INTEGER,
  sourcename      VARCHAR(255),    -- provider's field name / path
  canonicalname   VARCHAR(255)     -- Embrix canonical field
)  UNIQUE(id, index)
-- CHILD: response field mapping (source → canonical, optional fixed value)
core_config.gateway_api_responsemap (
  id              → gateway_api_map(id),
  index           INTEGER,
  sourcename      VARCHAR(255),
  value           VARCHAR(255),    -- fixed/derived value (nullable)
  canonicalname   VARCHAR(255)
)  UNIQUE(id, index)
```

> **Linking rule:** all three tables share the same `id`. The parent's `id` is `UNIQUE`; children reference it. When you replay a provider bundle into a new tenant DB, **keep the same `id` values** so parent↔child linkage is preserved (each tenant has its own database — see PART-A — so there's no cross-tenant collision). Only `uuid` (unreferenced) may be regenerated.

### 4.0.2 The `gateway_api` enum (131 values) is the API vocabulary

`apiname` is FK-bound to `core_enums.gateway_api` (your inventory: **131 rows**). That means the *set of possible* API names is fixed by the platform (created in L0). The canonical map just says "for THIS provider, THIS api is wired, and here are its field translations." You will never invent an `apiname`; you pick from the enum. To see them:
```sql
SELECT name FROM core_enums.gateway_api ORDER BY name;
```

---

## 4.1 — Your catalog, dissected (minimal vs per-integration)

The 64 rows you dumped, grouped by provider, with the provisioning verdict:

| Provider | Gateway(s) | What it is | New-tenant verdict |
|----------|-----------|------------|--------------------|
| **EMBRIX** | TAX_GATEWAY | Embrix's **internal** tax engine (`CALCULATE_TAX`) | **MINIMAL — seed always** (tax is core) |
| **JARS** | DOCUMENT_GATEWAY | XML doc generation (`CREATE_XML_INVOICE/CREDIT_NOTE/DEBIT_NOTE`) | **MINIMAL if** `sendInvoicePdfAndXml`/CFDI-style XML needed |
| **COOPEWEB** | CRM/FINANCE/OPERATION/PROVISIONING | Coope's **own portal** (payments, accounting extract, SMS, work orders) | **per-integration** — Coope-specific, NOT generic |
| **NETSUITE** | FINANCE/CRM | ERP integration (invoices, credit notes, due-date) | **per-integration** (only if tenant uses NetSuite) |
| **MOTV / NOKIA / NETUP / PORTAONE** | PROVISIONING | Network provisioning vendors (STB, IPTV, optical, VoIP) | **per-integration** (only the vendor the tenant runs) |

**Conclusion that shapes the template:**
- The **minimal generic L4** = `EMBRIX/TAX_GATEWAY/CALCULATE_TAX` (+ optionally the three `JARS` document maps if the tenant issues XML invoices). That's **1–4 map rows**, not 64.
- Everything else is an **integration pack** you replay when, and only when, that integration is turned on. A "no integration yet" tenant is *correct* with just the internal maps; the provider-specific flags (`sendAllDataToProvisioning`, `pacEnabled`, etc.) stay OFF until the pack is loaded (this is the `if(flag)->do X` model working in your favour).

---

## 4.2 — Minimal L4 seed = a checked-in static seed (no golden DB needed)

The `EMBRIX/CALCULATE_TAX` map is platform-internal and identical across tenants, so for the **minimal** path it's shipped as a **self-contained, version-controlled seed** rather than a runtime extract — meaning a brand-new environment can be provisioned **without** a golden DB being reachable.

➡️ **`sql/20-canonical-embrix.sql`** — captured verbatim from the golden `GID-100000` (the real internal tax contract): the parent `gateway_api_map` row + **30 request** + **25 response** field mappings, re-keyed to `<tenant>-TAX-CALC`. `provision.sh` runs it directly. Field names are copied exactly (never guessed — they're the internal canonical↔source contract).

This is the right split:
- **Minimal / internal maps (EMBRIX tax)** → checked-in seed (`sql/20`). Self-contained.
- **External-vendor maps (JARS doc-XML, NOKIA/MOTV/PORTAONE provisioning, NETSUITE finance)** → runtime **extract-replay** from a golden DB (§4.3/§4.4), added per-integration. These are large and tenant/vendor-specific, so they stay out of the minimal template.

> Why not extract EMBRIX at runtime too? Because the minimal tenant must provision even when no golden DB is available (a true greenfield), and the EMBRIX map is small + stable. Vendor bundles are big and only needed once an integration is scoped, so extract-replay fits them better.

---

## 4.3 — The extract-once → replay pattern (THE method for L4)

This is portable (no `dblink`/FDW needed) and matches the "run this query, get a script, run the script" workflow.

### Step 1 — On a GOLDEN DB, generate runnable INSERTs for one provider

Run this on a known-good environment (e.g. the demo/Coope DB). It emits a `.sql` file containing the full bundle (parent + both child tables) for `:provider`, ordered parent-first so FKs satisfy:

```sql
-- Run on GOLDEN db. Set :provider then capture output to a .sql file.
\set provider '''EMBRIX'''
\pset format unaligned
\pset tuples_only on
\o /tmp/canonical-EMBRIX.sql

WITH m AS (
  SELECT * FROM core_config.gateway_api_map WHERE providername = :provider
)
SELECT stmt FROM (
  -- 1) parents first
  SELECT 1 AS ord, m.id AS k, 0 AS idx,
    format(
     'INSERT INTO core_config.gateway_api_map (uuid,id,gatewayname,providername,apiname,objecttype,country,payloadtemplatepath,createddate) VALUES (%L,%L,%L,%L,%L,%L,%L,%L,now()) ON CONFLICT (id) DO NOTHING;',
     gen_random_uuid()::text, m.id, m.gatewayname, m.providername, m.apiname, m.objecttype, m.country, m.payloadtemplatepath) AS stmt
  FROM m
  UNION ALL
  -- 2) request maps
  SELECT 2, r.id, r.index,
    format(
     'INSERT INTO core_config.gateway_api_requestmap (id,index,sourcename,canonicalname) VALUES (%L,%s,%L,%L) ON CONFLICT (id,index) DO NOTHING;',
     r.id, r.index, r.sourcename, r.canonicalname)
  FROM core_config.gateway_api_requestmap r JOIN m ON r.id = m.id
  UNION ALL
  -- 3) response maps
  SELECT 3, rs.id, rs.index,
    format(
     'INSERT INTO core_config.gateway_api_responsemap (id,index,sourcename,value,canonicalname) VALUES (%L,%s,%L,%L,%L) ON CONFLICT (id,index) DO NOTHING;',
     rs.id, rs.index, rs.sourcename, rs.value, rs.canonicalname)
  FROM core_config.gateway_api_responsemap rs JOIN m ON rs.id = m.id
) s
ORDER BY ord, k, idx;

\o
\pset tuples_only off
\pset format aligned
```

`%L` is `format()`'s **quote-as-SQL-literal** specifier — it handles NULLs (emits `NULL`), embedded quotes, etc., so the generated INSERTs are safe even for messy field names. `%s` is used for the integer `index`.

### Step 2 — Inspect, then replay into the new tenant DB
```bash
head -5 /tmp/canonical-EMBRIX.sql          # eyeball it
psql "postgresql://acme_app:<pwd>@<host>:5432/coredb-acme?sslmode=require" \
     -v ON_ERROR_STOP=1 --single-transaction -f /tmp/canonical-EMBRIX.sql
```

`--single-transaction` makes the whole bundle atomic; `ON CONFLICT DO NOTHING` makes re-runs safe.

### Step 3 — Build the per-tenant L4 by composing bundles
- **Always:** `EMBRIX` (tax). Optionally `JARS` (document XML).
- **When an integration is enabled:** generate + replay that provider's bundle. E.g. tenant goes live with NOKIA provisioning → run Step 1 with `:provider='NOKIA'`, replay into `coredb-<tenant>`.

This turns "wire up a new integration" from a multi-day field-mapping exercise into a single generate+replay.

---

## 4.4 — Reusable replay script (`scripts/replay-canonical.sh`)

Parameterize the whole thing so the team runs one command per provider:

```bash
#!/usr/bin/env bash
# replay-canonical.sh GOLDEN_DSN TARGET_DSN PROVIDER
# e.g. ./replay-canonical.sh "$GOLDEN_DSN" "$ACME_DSN" EMBRIX
set -euo pipefail
GOLDEN="$1"; TARGET="$2"; PROVIDER="$3"
TMP="$(mktemp /tmp/canonical-${PROVIDER}.XXXX.sql)"

echo ">> extracting ${PROVIDER} bundle from golden..."
psql "$GOLDEN" -v ON_ERROR_STOP=1 -At \
  -v provider="'${PROVIDER}'" \
  -f - > "$TMP" <<'SQL'
WITH m AS (SELECT * FROM core_config.gateway_api_map WHERE providername = :provider)
SELECT stmt FROM (
  SELECT 1 ord, m.id k, 0 idx, format('INSERT INTO core_config.gateway_api_map (uuid,id,gatewayname,providername,apiname,objecttype,country,payloadtemplatepath,createddate) VALUES (%L,%L,%L,%L,%L,%L,%L,%L,now()) ON CONFLICT (id) DO NOTHING;', gen_random_uuid()::text,m.id,m.gatewayname,m.providername,m.apiname,m.objecttype,m.country,m.payloadtemplatepath) stmt FROM m
  UNION ALL SELECT 2,r.id,r.index, format('INSERT INTO core_config.gateway_api_requestmap (id,index,sourcename,canonicalname) VALUES (%L,%s,%L,%L) ON CONFLICT (id,index) DO NOTHING;', r.id,r.index,r.sourcename,r.canonicalname) FROM core_config.gateway_api_requestmap r JOIN m ON r.id=m.id
  UNION ALL SELECT 3,rs.id,rs.index, format('INSERT INTO core_config.gateway_api_responsemap (id,index,sourcename,value,canonicalname) VALUES (%L,%s,%L,%L,%L) ON CONFLICT (id,index) DO NOTHING;', rs.id,rs.index,rs.sourcename,rs.value,rs.canonicalname) FROM core_config.gateway_api_responsemap rs JOIN m ON rs.id=m.id
) s ORDER BY ord,k,idx;
SQL

LINES=$(wc -l < "$TMP")
echo ">> generated ${LINES} statements; replaying into target..."
psql "$TARGET" -v ON_ERROR_STOP=1 --single-transaction -f "$TMP"
echo ">> done. (kept $TMP for audit)"
```

Usage for a minimal tenant:
```bash
./scripts/replay-canonical.sh "$GOLDEN_DSN" "$ACME_DSN" EMBRIX
./scripts/replay-canonical.sh "$GOLDEN_DSN" "$ACME_DSN" JARS      # if XML invoices
# later, per integration:
./scripts/replay-canonical.sh "$GOLDEN_DSN" "$ACME_DSN" NOKIA
```

---

## 4.5 — `objecttype`, `country`, `payloadtemplatepath` (the optional columns)

- **`objecttype`** (⟦enum `object_type`⟧, 18 values) — used by some APIs to disambiguate which canonical object the map applies to. Preserved verbatim by the extract; don't change it.
- **`country`** — only set when a map is country-scoped (multi-country tenants). For a single-country tenant the golden rows will usually have it NULL; the extract preserves whatever's there.
- **`payloadtemplatepath`** — path to an XSLT/template (e.g. for `JARS` XML). If the golden value points to a template file delivered with the gateway image, it's portable as-is. **Check:** if it references a per-tenant S3 path, parameterize it during replay (sed the `.sql`, or extend the generator to substitute). For minimal/EMBRIX it's typically NULL.

> This is the one place L4 can carry a tenant-specific value. The generator copies it literally; review the emitted `payloadtemplatepath` values before replay and substitute if they embed a tenant/env path.

---

## 4.6 — Verification gate (kills "Canonical response config mapping not found")

```sql
-- every parent has at least its request OR response children, and the minimal triples exist
SELECT 'L4_GATE' AS gate,
  (SELECT count(*) FROM core_config.gateway_api_map)                                   AS map_rows,
  (SELECT count(*) FROM core_config.gateway_api_requestmap)                            AS req_rows,
  (SELECT count(*) FROM core_config.gateway_api_responsemap)                           AS resp_rows,
  EXISTS(SELECT 1 FROM core_config.gateway_api_map
         WHERE gatewayname='TAX_GATEWAY' AND providername='EMBRIX' AND apiname='CALCULATE_TAX') AS tax_map_ok;

-- orphan check: child rows whose parent id is missing (would mean a broken/partial replay)
SELECT 'orphans' AS check,
  (SELECT count(*) FROM core_config.gateway_api_requestmap r
     WHERE NOT EXISTS (SELECT 1 FROM core_config.gateway_api_map m WHERE m.id=r.id))  AS req_orphans,
  (SELECT count(*) FROM core_config.gateway_api_responsemap rs
     WHERE NOT EXISTS (SELECT 1 FROM core_config.gateway_api_map m WHERE m.id=rs.id)) AS resp_orphans;
```
**Pass:** `tax_map_ok = true`; `req_orphans = resp_orphans = 0`. If you later enable an integration and the gateway throws "mapping not found," re-run this filtered to that provider's triples — the missing row is your culprit.

---

## 4.7 — Backout (remove a provider bundle)

Because everything is keyed by the parent `id` (and children FK to it), backout is "delete children then parents for the provider":
```sql
-- remove one provider's bundle from a tenant DB
WITH m AS (SELECT id FROM core_config.gateway_api_map WHERE providername = :provider)
DELETE FROM core_config.gateway_api_requestmap  WHERE id IN (SELECT id FROM m);
WITH m AS (SELECT id FROM core_config.gateway_api_map WHERE providername = :provider)
DELETE FROM core_config.gateway_api_responsemap WHERE id IN (SELECT id FROM m);
DELETE FROM core_config.gateway_api_map WHERE providername = :provider;
```
(Run inside a transaction. To revert the whole tenant's L4, repeat per provider, or just drop/reseed since each tenant DB is isolated.)

---

## 4.8 — What §4 produced / next

You now have: a precise understanding that L4 is an integration catalog keyed by external `providername`; a **minimal** tenant carrying only the internal `EMBRIX` (tax) bundle (+ optional `JARS` document); and a **repeatable extract→replay tool** (`scripts/replay-canonical.sh`) to add any provider's field-mapping bundle on demand — turning integration enablement into one command.

**Next: §5 (L2/L3 — tenant identity + merchants) via the GraphQL onboarding API.** This is where we stop using SQL and start driving `createTenant(TenantInput)` on `service-transactional`, because tenant/merchant creation has validation + cache-reload side effects (`reloadMerchantGateway`) that raw SQL would bypass. I have the `tenant`, `tenant_profile`, `tenant_merchants`, and `*_gateway_attributes` DDL already (from §2 prep), so §5 needs no new DB dump — but I'll want one short thing from you: the GraphQL **schema** for `TenantInput` (the `.graphqls` file) so the mutation variables I give you match the real input type exactly.
