# Dry-Run Checklist — first supervised provisioning rehearsal

> **Purpose:** prove the whole template end-to-end on a **throwaway sandbox tenant**, with all three roles present, before you ever run it for a real tenant. Every step has the **exact command**, **who runs it**, the **expected output**, and a **✅/❌ box** to record the result. The two "live-only unknowns" (gateway enum precheck, pricingHub fields) get resolved here.
>
> Treat this as a 1–2 hour working session. Use a disposable tenant code like **`dryrun`** on the **non-prod** cluster. Nothing here touches production.
>
> Fill the **Result** column as you go — the completed sheet is your evidence the template works (and your Monday demo artifact).

---

## 0. Pre-session setup (15 min, before everyone joins)

| # | Who | Do | Expected | Result |
|---|-----|----|----------|--------|
| 0.1 | Lead | Pick tenant code `dryrun`, tenant id (ask licensing for a spare `TIDLT-1000NN`, or reuse a sandbox id) | code + id agreed | ☐ |
| 0.2 | Dev | `cp -r tenants/_TEMPLATE tenants/dryrun` then fill `tenants/dryrun/tenant.env` (currency USD, country, GL 10001, etc.) | file filled | ☐ |
| 0.3 | All | Confirm you can reach the non-prod cluster: `kubectl config current-context` shows `dev-embrix-eks-dev-eks` (NOT prod) | non-prod context | ☐ |
| 0.4 | DevOps | Have the golden DSN handy (`GOLDEN_DSN`) for the RBAC replay step | DSN ready | ☐ |

> If you'd rather not stand up fresh infra, you can dry-run **Phase 3 only** (the DB seed) against an existing sandbox DB that's already migrated + has services running. Skip Phases 1–2 and start at §3. That still validates the riskiest part (the config seed).

---

## 1. Phase 1 — Infra (DevOps) — skip if reusing a sandbox

| # | Do | Command | Expected | Result |
|---|----|---------|----------|--------|
| 1.1 | RDS database | `CREATE DATABASE "coredb-dryrun" OWNER dryrun_app;` (+ extensions, see PART-A §A.2.1) | DB created | ☐ |
| 1.2 | Namespace + secrets | `kubectl create namespace dryrun` ; create `pg-secret`, `app-vault-token` (PART-A §A.3) | secrets present | ☐ |
| 1.3 | Helm deploy mandatory set | the `helm upgrade -i` loop (PART-A §A.5.3) for 11 core + tax/finance/payment gw + vault-interface + core-ui | — | ☐ |
| 1.4 | Pods up | `kubectl -n dryrun get pods` | all `Running`/`Ready` | ☐ |
| 1.5 | Flyway migrate (L0) | run migrate against `coredb-dryrun` (PART-A §2.3) | migrations applied | ☐ |

---

## 2. Phase 2 — Vault (DevOps) — the silent-failure gate

| # | Do | Command | Expected | Result |
|---|----|---------|----------|--------|
| 2.1 | Transit keys | `vault write -f transit/keys/tenantId123` ; `vault write -f transit/keys/dryrun-mq` | keys created | ☐ |
| 2.2 | Store MQ creds (encrypted) → set `mq.username`/`mq.password` | PART-A2 §A2.2 step 3 | ciphertext stored | ☐ |
| 2.3 | **Encrypt round-trip (CRITICAL)** | `kubectl -n dryrun exec deploy/dryrun-service-transactional -- sh -c 'curl -s -X POST "$VAULT_API"encrypt -H "transit-key: tenantId123" -d "{\"password\":\"x\"}"'` | returns `vault:v1:…` ciphertext, **NOT null/empty** | ☐ |

> ❌ If 2.3 returns null → **stop**. Fix the transit key (name must match `PGUserService`'s `tenantToken`; `grep tenantToken` in your branch) before Phase 3, or `createUser` will silently store a null password.

---

## 3. Phase 3 — DB config seed (Developer) — the core of the dry-run

### 3a. The live-only PRECHECKS (resolve the two unknowns first)

| # | Do | Command | Record what you see | Result |
|---|----|---------|---------------------|--------|
| 3.1 | **Enum check** (L5 values) | run `PART-B-S3 §3.0.3` query on `coredb-dryrun` | confirm tax/AR/payment/etc. enums match `sql/10` (already fixed to verified values) | ☐ |
| 3.2 | **Gateway URL-type precheck** | `PART-B-S5 §5.2.1` query on `coredb-dryrun` | write the tax/finance/payment URL-type sets here → adjust `createTenant.vars` if they differ from the shipped sets | finance=____ payment=____ ☐ |
| 3.3 | **pricingHub fields** (smoke) | open `…/graphql/pricingHub/**/PriceOfferInput.graphqls` in the repo | note the real field names for `charges`/`amount`/`frequency` | ☐ |

> These three are the only things the docs flag as 🔎 "verify on the target." After this dry-run they're known facts, and you can hard-code them in the template.

### 3b. Run the orchestrator

| # | Do | Command | Expected | Result |
|---|----|---------|----------|--------|
| 3.4 | Set secrets (not in tenant.env) | `export DB_APP_PASSWORD='…' ADMIN_PASSWORD='…'` | — | ☐ |
| 3.5 | **Provision** | `./scripts/provision.sh tenants/dryrun/tenant.env` | step banners L0→…→reload→verify; ends `== DONE ==` | ☐ |
| 3.6 | Watch for the gates | (provision.sh runs them) | L5 gate counts ≥1; L1 **pointer gate all `t`** | ☐ |

> If a step fails: the banner names the layer, every seed is idempotent, fix the one thing and re-run `provision.sh` (it skips what's already seeded). Common failures → owner table in `ROLES-AND-RUNBOOK §6`.

### 3c. Per-layer spot-checks (optional but reassuring)

| # | Check | Query | Expected | Result |
|---|-------|-------|----------|--------|
| 3.7 | L5 reference | `sql/10` §3.14 gate | `default_gl_ok=t`, counts ≥1 | ☐ |
| 3.8 | L4 tax map | `SELECT count(*) FROM core_config.gateway_api_requestmap WHERE id='dryrun-TAX-CALC';` | `30` | ☐ |
| 3.9 | L2/L3 tenant | `sql` §5.7 gate | 1 tenant, 3 merchants, attrs 6/9/(16-17) | ☐ |
| 3.10 | L6 admin | `sql` §7.6 gate | admin exists, `pwd_format='vault:…'`, linked to ADMIN | ☐ |
| 3.11 | §8 supporting | `sql` §8.7 gate | invseq/pay-alloc/workweek ok; 6 OMS types; 8 jobs | ☐ |

---

## 4. Phase 4 — Smoke test (QE) — prove order-to-cash

| # | Do | How | Expected | Result |
|---|----|-----|----------|--------|
| 4.1 | Reload caches | `./scripts/reload.sh dryrun` | pods rolled, gateways reloaded | ☐ |
| 4.2 | Log in | `core-ui` as `dryrunadmin` + the bootstrap password | login succeeds (proves Vault + L6) | ☐ |
| 4.3 | Create price offer | `createPriceOffer` (PART-C §10.1, using the fields confirmed in 3.3) | PO `SMOKE-PO` created | ☐ |
| 4.4 | Create account | RESIDENTIAL/B2C account | account created with tenant defaults | ☐ |
| 4.5 | Create NEW order | order on `SMOKE-PO` | order → `ACTIVE` (proves OMS tasks + provisioning-off pass-through) | ☐ |
| 4.6 | Bill + invoice | run `BILL_CHECK` then `INVOICE_CHECK` (or await daily job) | invoice generated **and numbered** (proves §8 invoice seq + tax map) | ☐ |
| 4.7 | Payment | record a CHECK payment | payment allocated to the invoice | ☐ |
| 4.8 | Final gate | `psql … -f build/sql/00-params.sql -f sql/smoke-verify.sql` | every `POINTERS` column `t` | ☐ |

**Acceptance:** 4.2–4.8 pass, no "Tenant not configured" / "Canonical … not found" in logs.

---

## 5. Sign-off & teardown

| # | Who | Do | Result |
|---|-----|----|--------|
| 5.1 | QE | Mark the run **PASS/FAIL**; attach this filled sheet | ☐ |
| 5.2 | Lead | Record the 3 precheck answers (3.1/3.2/3.3) → fold any corrections back into the template so the next run has zero unknowns | ☐ |
| 5.3 | Dev | Tear down: `./scripts/backout.sh tenants/dryrun/tenant.env` (or drop `coredb-dryrun`) | ☐ |
| 5.4 | DevOps | (if infra was created) delete namespace `dryrun` | ☐ |

---

## 6. What this rehearsal proves (and what to fix after)

A clean dry-run validates, in one pass:
- **Infra + Helm config injection** (pods boot against the tenant DB/Redis/MQ).
- **Vault transit keys** (the encrypt round-trip + a real `vault:` password).
- **The full bottom-up seed** (L0→L6 + supporting + canonical) — parameterized from one `tenant.env`, idempotent.
- **Every L1→L5 pointer resolves** (the pointer gate — the anti-"config not found" guarantee).
- **Order→bill→invoice→payment→revenue** runs internally with **zero external integrations**.

**After the run, do these (≤30 min) so the next tenant has no unknowns:**
1. If 3.2 showed a gateway enum mismatch → update `graphql/createTenant.vars.json.tmpl` to the target's real URL-type sets (or note the SQL-merchant fallback).
2. Fill the real pricingHub field names from 3.3 into `PART-C §10.1`.
3. Commit `tenants/dryrun/tenant.env` as a worked example (scrub secrets) for the next person to copy.

> Once this sheet reads all-✅, you have a **repeatable, proven** provisioning process — the thing the copy-from-Congero approach never gave you. The next real tenant is: copy `tenant.env`, fill the name, run `provision.sh`, smoke-test, sign off.
