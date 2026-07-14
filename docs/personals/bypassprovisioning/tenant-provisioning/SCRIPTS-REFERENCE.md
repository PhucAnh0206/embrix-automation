# Scripts & Artifacts Reference — what each one is, how to run it, what to expect

> Plain-language catalog of every script, SQL file, and template in this toolkit. For each: **what it's for**, **who runs it**, **what you need first**, **how to run**, **what you'll see**, and **if it fails**. Read this alongside `ROLES-AND-RUNBOOK.md`.
>
> You rarely run these one-by-one — `scripts/provision.sh` runs them in order. This reference is for understanding each piece and for debugging when a step fails.

---

## A. The orchestrator (run this; it calls the rest)

### `scripts/provision.sh`
- **For:** seeding the *entire* business config of a tenant in dependency order. The one command a Developer runs.
- **Who:** Developer. **Prereq:** DevOps Phases 1–2 done (infra+pods+Vault), schema migrated.
- **Learn first:** `ROLES-AND-RUNBOOK.md §4 Phase 3`, the layer model in `GUIDE.md`.
- **Run:**
  ```bash
  export DB_APP_PASSWORD='…'  ADMIN_PASSWORD='…'
  ./scripts/provision.sh tenants/acme/tenant.env
  ```
- **What it does (in order):** render → verify schema → `05` singletons → `10` reference → `replay-canonical EMBRIX` → `createTenant` → `setCcpProperties` (flags) → `replay-rbac` → resolve role ids → `createUser` → user-pointer flags → `30/31/32/34/35` supporting → `reload` → `smoke-verify`.
- **Expect:** a section banner per step (`== L5 reference ==` …) and a final `== DONE ==`. The closing `smoke-verify` prints `POINTERS` columns — all must be `t`.
- **If it fails:** it stops at the failing step (every seed is idempotent, so just fix and re-run the whole thing — already-seeded rows are skipped). The banner tells you which layer; jump to that script below.

---

## B. Helper scripts (called by the orchestrator; also usable standalone)

### `scripts/render.sh`
- **For:** turning your one `tenant.env` into concrete, runnable files in `build/` (substitutes every `${VAR}`).
- **Who:** runs automatically inside `provision.sh`; run alone to preview what will be applied.
- **Run:** `./scripts/render.sh tenants/acme/tenant.env`
- **Expect:** `build/sql/00-params.sql`, `build/templates/minimal/flags.rendered.json`, `build/graphql/*.json` created; it lists them.
- **If it fails:** usually a missing var in `tenant.env` (envsubst leaves `${VAR}` empty). Check the profile is complete.

### `scripts/gql.sh`
- **For:** posting a GraphQL mutation with a variables file and **failing loudly** if the response has `errors`.
- **Who:** called by `provision.sh` for `createTenant` / `setCcpProperties` / `createUser`. Standalone for ad-hoc calls.
- **Run:** `./scripts/gql.sh "$GRAPHQL_URL" graphql/createTenant.graphql build/graphql/createTenant.vars.json [BEARER]`
- **Expect:** the JSON response pretty-printed; exit 0 on success.
- **If it fails:** it prints the GraphQL error and exits 1. Map the error code: `MISSING_A_MERCHANT_FOR_A_GATEWAY` / `MISSING_MANDATORY_GATEWAY_INPUT` → the 3-merchant rule (`PART-B-S5 §5.2`); null password → Vault (`PART-A2`).

### `scripts/replay-canonical.sh`
- **For:** copying one external provider's **canonical field maps** from a golden DB into the tenant DB (extract→replay; no guessing field names).
- **Who:** `provision.sh` runs it for `EMBRIX` (internal tax). Run standalone to add an integration later (`NOKIA`, `NETSUITE`, …).
- **Learn first:** `PART-B-S4-CANONICAL.md` (what canonical maps are; why "Canonical … not found" happens).
- **Run:** `./scripts/replay-canonical.sh "$GOLDEN_DSN" "$TARGET_DSN" EMBRIX`
- **Expect:** `>> generated N statements; replaying…` then done. Idempotent.
- **If it fails:** golden DB unreachable, or provider has no maps in golden. Verify with the §4.6 query.

### `scripts/replay-rbac.sh`
- **For:** copying the **role catalog** (roles + all `roles_*` permission tables) from golden into a *fresh* tenant DB.
- **Who:** `provision.sh`. **Prereq:** target `roles_*` empty (fresh tenant).
- **Learn first:** `PART-B-S7-USERS.md §7.2`.
- **Run:** `./scripts/replay-rbac.sh "$GOLDEN_DSN" "$TARGET_DSN"`
- **Expect:** `>> loading N inserts…` (N is large — hundreds of permission rows). Idempotent on a fresh DB.
- **If it fails:** if `roles_*` already has rows, you'll get conflicts — only run on a fresh tenant, or prune first (§7.2).

### `scripts/reload.sh`
- **For:** making **every** service see the newly-seeded config (restart engine pods so they re-read `ccp_properties`; reload gateways).
- **Who:** DevOps (needs kubectl). `provision.sh` calls it; DevOps can run it after any later config change.
- **Learn first:** `PART-C-OPS.md §9` (why caches go stale).
- **Run:** `./scripts/reload.sh acme`   (arg = namespace)
- **Expect:** rollout restarts issued for all core services + gateway `/reload`; ends with `kubectl get pods`.
- **If it fails:** wrong namespace or no kube context — DevOps runs `aws eks update-kubeconfig` first.

### `scripts/backout.sh`
- **For:** reverting a tenant's seeded config (reverse-FK order) to re-do cleanly.
- **Who:** Developer/DevOps. **⚠️ never on prod without sign-off.**
- **Learn first:** `PART-C-OPS.md §12`.
- **Run:** `export DB_APP_PASSWORD='…'; ./scripts/backout.sh tenants/acme/tenant.env`
- **Expect:** scoped deletes for all `<tenant>-…` rows + Redis `ccpPropertiesMap` cleared + pods rolled.
- **If it fails / full reset:** for a sandbox the cleanest revert is `DROP DATABASE coredb-<tenant>` + re-run Flyway.

---

## C. SQL seeds (applied by `provision.sh`, prefixed with `build/sql/00-params.sql`)

> All are **idempotent** (`ON CONFLICT DO NOTHING`) and **atomic** (`BEGIN/COMMIT`). Run standalone with `psql "$DSN" -f build/sql/00-params.sql -f sql/<file>`.

| File | Layer | Seeds | Detail |
|------|-------|-------|--------|
| `00-verify-schema.sql` | L0 gate | checks schemas/enums present, tables empty | `GUIDE.md §2.5` |
| `00-params.sql.tmpl` | — | the `\set` param preamble (rendered to `build/`) | rendered by `render.sh` |
| `05-bootstrap-singletons.sql` | L5b | **invoice-number sequence**, ccp_time clock, JWT token expiry, work-week, holidays | `PART-B-S8 §8.1` |
| `10-reference-seed.sql` | L5 | currency, country, UOM, product family, **Chart-of-Accounts/GL**, tax, AR items+reasons, payment terms, credit profile, operating unit, invoice config | `PART-B-S3` |
| `20-canonical-embrix.sql` | L4 | **EMBRIX internal tax canonical map** (parent + 30 req + 25 resp field maps, verbatim from golden) — self-contained, no golden DB needed | `PART-B-S4 §4.2` |
| `21-canonical-jars.sql` | L4 (optional) | **JARS document-XML maps** (3 APIs: invoice/credit-note/debit-note, 45 req + 6 resp each). CR e-invoicing vendor — only applied when `WITH_XML=1`. NOT minimal | `PART-B-S4 §4.2` |
| `30-oms-tasks.sql` | §8 | OMS task pipeline for all 6 order types | `PART-B-S8 §8.2` |
| `31-jobs.sql` | §8 | daily job schedule (bill/invoice/dunning) | `PART-B-S8 §8.3` |
| `32-collections.sql` | §8 | dunning ladder + profile map + payment allocation | `PART-B-S8 §8.4` |
| `34-correspondence.sql` | §8 | notification template registry | `PART-B-S8 §8.5` |
| `35-invoice-template.sql` | §8 | invoice/credit/debit stylesheet registry | `PART-B-S8 §8.6` |
| `smoke-verify.sql` | verify | structure + **pointer gate** (every flag resolves) | `PART-C §10.3` |

> 🔎 **Enum caveat:** these contain enum-bound values (tax/AR/collection/template types). If your build's `core_enums.*` differ, an insert errors — confirm with the discovery query in `PART-B-S3 §3.0.3` and adjust. The `⟦enum⟧` comments mark every such column.

---

## D. GraphQL (applied by `gql.sh`)

| File | For | Detail |
|------|-----|--------|
| `graphql/createTenant.graphql` + `.vars.json.tmpl` | L2/L3 — tenant + 3 mandatory merchants | `PART-B-S5` |
| `graphql/setCcpProperties.graphql` | L1 — the ~90 feature flags + user-pointer flags | `PART-B-S6` |
| `graphql/createUser.graphql` + `.vars.json.tmpl` | L6 — bootstrap admin (Vault-encrypted password) | `PART-B-S7` |
| `graphql/ccp-userpointers.json.tmpl` | sets `selfcareRole`/`sysAdminUser` after role ids resolved | `PART-B-S7 §7.5` |
| `templates/minimal/flags.json` | the minimal flag set (`${}` placeholders) | `PART-B-S6 §6.2` |

> The `.vars.json.tmpl` files are rendered by `render.sh`; `createUser`/user-pointers are **re-rendered mid-run** by `provision.sh` after it resolves the `ADMIN`/`Self-Care` role ids by name (ids differ per env).

---

## E. The one file you edit

### `tenants/_TEMPLATE/tenant.env`
- **For:** the single source of all per-tenant values. Copy per tenant, fill, done.
- **Who:** Developer fills business values; DevOps confirms infra values (DB host, Vault key names, MQ prefix).
- **Contains:** identity, DB, golden DSN, GraphQL URL, k8s, currency/GL/tax, invoice/clock, admin user, Vault transit keys, MQ prefix, TZ, S3 template paths, toggles.
- **Secrets NOT in it:** `DB_APP_PASSWORD`, `ADMIN_PASSWORD`, `LICENSE_KEY` → passed as runtime env vars.

---

## F. Quick "I just want to…" index
| I want to… | Run | Role |
|------------|-----|------|
| provision a new tenant | `provision.sh tenants/<t>/tenant.env` | Dev |
| see what will be applied | `render.sh tenants/<t>/tenant.env` then read `build/` | Dev |
| add an integration (e.g. NOKIA) | `replay-canonical.sh GOLDEN TARGET NOKIA` + flip flags + `reload.sh` | Dev+DevOps |
| make services see a config change | `reload.sh <ns>` | DevOps |
| undo a tenant's config | `backout.sh tenants/<t>/tenant.env` | Dev/DevOps |
| check the tenant is consistent | `psql … -f build/sql/00-params.sql -f sql/smoke-verify.sql` | Dev/QE |
| prove order→invoice→payment | follow `PART-C §10.2` in `core-ui` | QE |
