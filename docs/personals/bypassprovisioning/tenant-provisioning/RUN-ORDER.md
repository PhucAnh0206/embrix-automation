# RUN-ORDER — The master tenant-provisioning runbook

> **This is the final outcome.** One ordered checklist to take a brand-new tenant from nothing → a working, minimal, integration-free Embrix environment. Fill `tenants/<tenant>/tenant-profile.yaml` once, then execute top to bottom. Every step links to the section that explains it and the artifact that does it.
>
> **Golden rule (why the order is fixed):** seed **bottom-up** — each layer points at the one below it (`DIAGRAMS.md` D3). Reference data before the flags that reference it; tenant/merchants before canonical lookups; everything before the cache reload.
>
> Legend: 🖥️ shell · 🗄️ psql · 🔌 GraphQL · ☁️ AWS/Vault/k8s · ✅ verify gate.

---

## Phase 0 — Inputs (once per tenant)

Fill `tenants/<tenant>/tenant-profile.yaml` (the only human-authored file). Drives every render below.

| Param | Example | Feeds |
|-------|---------|-------|
| `TENANT` / `TENANT_NS` | `acme` | namespace, helm releases, svc DNS, queue prefix |
| `TENANT_ID` | `TIDLT-100010` | Helm `app.tenantId` (= the tenant's identity; createTenant reads it) |
| `DB_NAME` | `coredb-acme` | RDS database / DSN |
| `CURRENCY` / `COUNTRY` / `LEGAL_ENTITY` / `SELLING_COMPANY` | `USD`/`United States`/`Acme Inc`/`0900` | L5 + L1 |
| `DEFAULT_GL` / `TAX_ITEM_ID` | `10001` / `ACME-TaxationItemId` | L5↔L1 pointers |
| `AMQ_PREFIX` | `ACME.` | queue isolation |
| `ENV_PROFILE` | `sandbox`/`production` | `useCcpTime`/`testMode` flags |
| `LICENSE_KEY`, `VAULT_PATH` | … | tenant row, Vault |

---

## Phase 1 — Infrastructure (Part A) ☁️

| # | Do | How | Ref |
|---|----|-----|-----|
| 1.1 | Assume EKS role, set kube context | `aws sts assume-role …` → `aws eks update-kubeconfig --name dev-embrix-eks-dev-eks` | A.1.2 |
| 1.2 | Create RDS database `coredb-<tenant>` (+ app role, extensions) | `psql … CREATE DATABASE` | A.2.1 |
| 1.3 | Provision/confirm Redis (own replication group — avoid `ccpPropertiesMap` collision) | `aws elasticache …` | A.2.2 |
| 1.4 | Confirm shared Amazon MQ broker; set unique `AMQ_PREFIX` | broker URL in Helm env | A.2.3 |
| 1.5 | Create namespace + secrets `pg-secret`, `app-vault-token` | `kubectl create namespace` / `create secret` | A.3 |
| 1.6 | Render per-tenant `helm_values/<tenant>/*.yaml` (all mandatory services) | `scripts/render.sh` | A.5.2 |
| 1.7 | `helm upgrade -i` the **mandatory deploy set** | A.5.3 loop | A.5 / SERVICES §4 |
| ✅ | All pods Running; `service-transactional` boots clean | `kubectl get pods` | A.8 |

**Mandatory deploy set** (SERVICES-AND-GATEWAYS §4): `vault-interface` + 11 core services + `tax-gateway`+`tax-engine` + `finance-gateway` + `payment-gateway` + `core-ui`. Defer crm/provision/selfcare.

---

## Phase 2 — Vault & secrets (Part A2) ☁️ — **before users/queues**

| # | Do | How | Ref |
|---|----|-----|-----|
| 2.1 | Enable transit engine | `vault secrets enable transit` | A2.2 |
| 2.2 | Create transit keys: `tenantId123` (passwords) + `<transit.key>` (MQ) | `vault write -f transit/keys/…` | A2.1 |
| 2.3 | Encrypt + store MQ broker creds → set `mq.username`/`mq.password` | `vault write transit/encrypt/…` | A2.2 |
| 2.4 | Populate tenant KV (license, gateway creds) | `vault kv put secret/<tenant>/…` | A2.2 |
| ✅ | **Encrypt round-trip returns `vault:v1:…` (not null)** | A2.3 curl test | A2.3 |

> 🔎 Confirm the transit-key name in your branch (`grep tenantToken` in `PGUserService`) — it's hardcoded `tenantId123` with a TODO; if changed, create that name.

---

## Phase 3 — Database config seed (Part B), bottom-up

> All run against `TARGET_DSN = postgresql://<app>:<pwd>@<host>:5432/coredb-<tenant>?sslmode=require`. Every script idempotent.

| # | Layer | Do | Artifact | Ref |
|---|-------|----|----------|-----|
| 3.1 | L0 | Flyway migrate (only if brand-new DB) | engine `V*.sql` | §2 |
| ✅ | L0 | schemas + enums loaded; tenant tables empty | `sql/00-verify-schema.sql` | §2.5 |
| 3.2 | L5b | 🗄️ singletons (invoice seq, ccp_time, token, calendar) | `sql/05-bootstrap-singletons.sql` | §8.1 |
| 3.3 | L5 | 🗄️ reference data (currency/GL/tax/AR/payment/product…) | `sql/10-reference-seed.sql` | §3 |
| ✅ | L5 | `default_gl_ok=true`, all counts ≥1 | §3.14 gate | §3.14 |
| 3.4 | L4 | 🖥️ replay canonical maps — EMBRIX (+JARS if XML) | `scripts/replay-canonical.sh … EMBRIX` | §4.3 |
| ✅ | L4 | `tax_map_ok=true`, no orphans | §4.6 gate | §4.6 |
| 3.5 | L2/L3 | 🔌 `createTenant` (tenant + 3 mandatory merchants) | `graphql/createTenant.graphql` + rendered vars | §5.3 |
| ✅ | L2/L3 | 1 tenant, 3 merchants, attrs counts (6/9/17) | §5.7 gate | §5.7 |
| 3.6 | L1 | 🔌 `setCcpProperties` (full minimal flag set) | `graphql/setCcpProperties.graphql` + `templates/minimal/flags.json` | §6.3 |
| ✅ | L1 | **pointer gate: gl/tax/currency/payterm/prodfamily all true** | §6.4 gate | §6.4 |
| 3.7 | L6 | 🖥️ replay role catalog | `scripts/replay-rbac.sh` | §7.2 |
| 3.8 | L6 | 🔌 `createUser` bootstrap admin (Vault-encrypted pwd) | `graphql/createUser.graphql` + rendered vars | §7.3 |
| 3.9 | L6 | 🔌 set `selfcareRole` + `sysAdminUser` flags (resolved by name) | `setCcpProperties` | §7.4/7.5 |
| ✅ | L6 | admin exists, `pwd_format='vault:…'`, linked to ADMIN | §7.6 gate | §7.6 |
| 3.10 | §8 | 🗄️ supporting config (OMS/jobs/collections/correspondence/templates) | `sql/30,31,32,34,35` | §8 |
| ✅ | §8 | invseq/pay-alloc/workweek ok; 6 order types; 8 jobs | §8.7 gate | §8.7 |
| 3.11 | files | ☁️ upload correspondence `.html` + template `.xsl` to S3 (or keep PDF off) | S3 `embrix-static-files/<tenant>/…` | §8.5/8.6 |

---

## Phase 4 — Reload & verify (Part C) 

| # | Do | How | Ref |
|---|----|-----|-----|
| 4.1 | Rollout-restart ALL engine-bearing services | §9.2 loop | §9.2 |
| 4.2 | Gateway `/reload` (or restart) | §9.2 | §9.2 |
| 4.3 | (if re-seeded flags) clear Redis `ccpPropertiesMap` then restart | §9.3 | §9.3 |
| ✅ | pods Ready; non-writer service sees flags | §9.4 | §9.4 |
| 4.4 | Smoke: createPriceOffer → account → order → invoice → payment | `scripts/smoke.sh` | §10.2 |
| ✅ | **steps 1–10 pass; `gl_ok=tax_ok=invseq_ok=true`; no "config not found"** | §10.3 gate | §10.3 |

**At this ✅ the tenant is provisioned.**

---

## Phase 5 — Repeatability & teardown

| Do | How | Ref |
|----|-----|-----|
| Make it one-click | run the GitLab provision pipeline (render→preflight→seed*→reload→verify) | §11 |
| Add an integration later | deploy its gateway + `replay-canonical.sh <PROVIDER>` + seed `config_prov_sequence*` + flip its flags + reload | §4 / DOMAIN-FLOWS §4 |
| Revert | `scripts/backout.sh` (surgical / wipe / drop-db) | §12 |

---

## The whole thing on one screen

```
PROFILE  ─ fill tenant-profile.yaml
   │
PHASE 1  ☁️ RDS db · Redis · MQ prefix · namespace+secrets · helm deploy (mandatory set)         [Part A]
PHASE 2  ☁️ Vault: transit engine + keys (tenantId123,<transit.key>) + MQ creds + KV  ✅round-trip [Part A2]
PHASE 3  🗄️🔌 L0 schema → 05 singletons → 10 reference → 20 canonical(EMBRIX)
            → createTenant(L2/L3) → setCcpProperties(L1) ✅pointers
            → replay-rbac + createUser(L6) → 30/31/32/34/35 supporting(§8)                        [Part B]
PHASE 4  🖥️ rollout restart all + gateway /reload  →  smoke order→invoice→payment  ✅             [Part C]
PHASE 5  🔁 GitLab pipeline = one-click · add integrations per requirement · backout              [Part C]
```

> **Minimal-template guarantee:** after Phase 4 the tenant can log in, create accounts/orders, bill, invoice (numbered), take payment, recognize revenue, and run daily jobs + dunning — **with zero external integrations**. Product catalogue, branded documents, and each external system (CRM/finance/payment/provisioning vendors) are switched on later, per requirement, each via its now-documented seed + flag + gateway. That is the "minimal structure before knowing their requirements" you asked for.
```
