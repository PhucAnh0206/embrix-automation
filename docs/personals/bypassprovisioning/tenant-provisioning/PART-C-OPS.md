# Part C — Operations: cache reload, smoke verification, CI/CD pipeline, backout

> Parts A/A2/B got the tenant **deployed + fully seeded**. Part C makes it **trustworthy and repeatable**: refresh the caches so every service sees the config (§9), prove the order-to-cash chain works end-to-end (§10), wrap the whole thing in a parameterized GitLab pipeline (§11), and define a clean revert (§12).

---

## §9 — Cache reload & propagation (mandatory before you trust anything)

### 9.1 Why this step exists
From §1/§6: `ccpPropertiesMap` lives in Redis **and** in a JVM-static cache built per service at `@PostConstruct`. `setCcpProperties` live-updates Redis on the **writing** pod only; merchant/gateway config is cached **inside the gateways** and only refreshed on `reloadMerchantGateway` / `/reload`. So immediately after seeding:
- `service-transactional` sees the new flags (it did the write),
- but `service-billing`, `service-invoice`, `service-payment`, `service-revenue`, `service-usage`, `service-mediation`, `jobs-common`, `batch-process` may still hold **stale/empty** caches from their boot,
- and the **gateways** hold stale merchant config.

Until you reload, you get the classic "works in one service, ignored in another."

### 9.2 The reload procedure (run after §8, before §10)
```bash
TENANT_NS=acme

# 1) Engine-bearing services: restart so each re-runs @PostConstruct getCcpProperties()
#    (re-reads ccp_properties from DB into its JVM cache + warms Redis).
for d in service-transactional service-billing service-invoice service-payment \
         service-revenue service-usage service-mediation jobs-common batch-process service-proxy service-sso; do
  kubectl -n $TENANT_NS rollout restart deploy/${TENANT_NS}-$d
done
kubectl -n $TENANT_NS rollout status deploy/${TENANT_NS}-service-transactional --timeout=180s

# 2) Gateways: hit /reload (it's in skipGatewayAuthorizationApis bypass, so no token needed),
#    OR rollout restart them too.
for g in crm-gateway payment-gateway finance-gateway tax-gateway provision-gateway; do
  kubectl -n $TENANT_NS exec deploy/${TENANT_NS}-$g -- sh -c 'curl -s -o /dev/null -w "%{http_code} " http://localhost:8080/reload' 2>/dev/null || \
    kubectl -n $TENANT_NS rollout restart deploy/${TENANT_NS}-$g
done
```

### 9.3 Optional hard-reset of the Redis hash
If you suspect a stale `ccpPropertiesMap` (e.g. you re-seeded flags), clear it and let the next boot/read rebuild from DB:
```bash
# from a pod that can reach Redis (or redis-cli with the ElastiCache endpoint)
redis-cli -h "$REDIS_HOST" -p 6379 DEL ccpPropertiesMap
# then the rollout restart in 9.2 repopulates it via getCcpProperties()
```
> ⚠️ Multi-tenant Redis caveat (Part A §A.2.2): `ccpPropertiesMap` is a **fixed key**. If two tenants share a Redis node, `DEL ccpPropertiesMap` affects both. Use per-tenant Redis (or DB index) — restated here because this is where it bites.

### 9.4 Reload verification
```bash
# every engine-bearing pod should be Ready and recently restarted
kubectl -n $TENANT_NS get pods -o wide
# spot-check a non-writer service sees a flag (exec + a health/diagnostic endpoint, or check logs for ccp load)
kubectl -n $TENANT_NS logs deploy/${TENANT_NS}-service-billing | grep -i "ccpPropertiesMap\|getCcpProperties" | tail -3
```

---

## §10 — Smoke verification (the definition of "provisioned OK")

This is the acceptance test: a tenant is "provisioned" when it can run **account → order → invoice → payment** internally. It also surfaces any dangling pointer (the failure class we've been killing).

### 10.1 The throwaway smoke catalogue (NOT template content)
The order needs *something sellable*. Per the design (product catalogue = tenant business, `DOMAIN-FLOWS.md` §2.6), we do **not** ship a catalogue in the template — instead the smoke test creates **one throwaway price offer** via the pricing GraphQL API, then (optionally) deletes it. This proves the pricing→billing→invoice chain without polluting the template.

**Verified enum values for the smoke price offer (live DB, 2026-05-30):**
| Field | Use this value | From enum (other options) |
|-------|----------------|----------------------------|
| `serviceType` | `DEFAULT` | `service_type` (INTERNET, IPTV, VOICE, DATA, TV, …) |
| `pricingModel` | `RECURRING` | `pricing_model` (FLAT, TIERED, COMPLEX, USAGE_ATTRIBUTE_BASED, …) |
| `chargeType` | `R` (recurring) | `charge_type` = `M` / `R` / `U` (one-time / recurring / usage) |
| `recurringType` | `ARREARS` | `recurring_type` = `ARREARS` / `FORWARD` |
| `status` | `SELLABLE` | `price_offer_status` (CREATE, APPROVED, NON_SELLABLE, SUNSET) |
| product hierarchy | `DEFAULT`×4 | must match the §3.4 product_family_list row |

```graphql
# Minimal recurring price offer for the smoke test. 🔎 Field NAMES are from the pricingHub
# schema (PriceOfferInput/ChargeInput) — confirm against …/graphql/pricingHub/** in your build;
# the ENUM VALUES above are verified. Create via service-transactional GraphQL or the core-ui.
mutation { createPriceOffer(input:{
  name: "SMOKE-PO",
  serviceType: DEFAULT,
  pricingModel: RECURRING,
  status: SELLABLE,
  currency: "USD",
  productFamily: "DEFAULT", productLine: "DEFAULT", productType: "DEFAULT", productSubType: "DEFAULT",
  charges: [{ chargeType: R, recurringType: ARREARS, amount: 10.00, frequency: MONTHLY }]
}){ id name } }
```
> The enum values are now pinned; only the exact input *field names* (`charges`/`amount`/`frequency` wording) need a 1-minute confirm against the pricingHub `.graphqls`. This stays **test-time** — a throwaway PO, never shipped in the template (product catalogue = tenant business, `DOMAIN-FLOWS §2.6`).

### 10.2 The end-to-end smoke script (GraphQL, against service-transactional)
```
1. createUser admin (§7)          -> can authenticate (password is vault:..)         [proves Vault A2 + L6]
2. generate-token (login)          -> get a session token                            [proves SSO]
3. createPriceOffer SMOKE-PO       -> sellable product exists                         [proves pricing scaffold L5]
4. createAccount (RESIDENTIAL,B2C) -> account created with tenant defaults            [proves L1 enum defaults + credit profile]
5. createOrder NEW (SMOKE-PO)      -> order runs OMS tasks PROVISION->BILL -> ACTIVE  [proves §8 OMS + provisioningEnabled=false pass-through]
6. run BILL_CHECK (or wait job)    -> pending bill generated                          [proves billing + GL pointers L5.5]
7. run INVOICE_CHECK               -> invoice generated, numbered (INVOICE_DB_SEQ)    [proves §8 invoice sequence + tax L5.6]
8. (if generateInvoicePdf) PDF     -> invoice PDF renders                             [proves §8 template + S3 file]
9. recordPayment (CHECK)           -> payment allocated to invoice                    [proves payment terms + allocation §8]
10. revenue recognized             -> revenue entry created                           [proves GL/operating-unit L5]
```
Each step maps to a layer; a failure at step N tells you exactly which layer's seed is wrong.

### 10.3 The consolidated verification query (run at the end)
```sql
SELECT 'SMOKE' AS check,
  (SELECT count(*) FROM core_config.tenant)                              AS tenant,        -- 1
  (SELECT count(*) FROM core_config.users WHERE category='SYSTEM')       AS sys_users,     -- >=1
  (SELECT count(*) FROM core_oms."order")                               AS orders,         -- >=1 after smoke
  (SELECT count(*) FROM core_oms.order_services)                         AS order_services,
  -- pointer integrity (the anti-"config not found" gate, repeated):
  EXISTS(SELECT 1 FROM core_config.config_chart_of_account_list
         WHERE accountnumber=(SELECT value FROM core_config.ccp_properties WHERE property='defaultGLAccount')) AS gl_ok,
  EXISTS(SELECT 1 FROM core_config.config_tax_types
         WHERE itemid=(SELECT value FROM core_config.ccp_properties WHERE property='taxationItemId'))           AS tax_ok,
  EXISTS(SELECT 1 FROM core_config.custom_db_sequence_object WHERE objecttype='INVOICE_DB_SEQ')                 AS invseq_ok;
```
> 🔎 `core_oms` table names (`order`, `order_services`) per your inventory; quote `"order"` (reserved word).

### 10.4 Acceptance criteria
**Provisioned OK** = steps 1–10 succeed with no "Tenant not configured" / "Canonical response config mapping not found" / null-pointer, and the smoke query shows `gl_ok=tax_ok=invseq_ok=true`. Tear down the smoke account/PO afterward (or use a disposable smoke tenant).

---

## §11 — GitLab CI/CD provision pipeline (the repeatable runner)

Wraps Parts A2→B→C into a parameterized, manual-trigger pipeline. Lives in the new `tenant-provisioning/` repo (or a `provision/` stage in an existing repo). Mirrors the conventions in `core/.gitlab-ci.yml` (manual jobs, `aws sts assume-role`, per-tenant vars).

```yaml
# tenant-provisioning/.gitlab-ci.yml
stages: [render, preflight, schema, seed-reference, seed-canonical, onboard, seed-flags, seed-users, seed-supporting, reload, verify, backout]

variables:
  TENANT: ""                 # e.g. acme           (pipeline input)
  ENV_PROFILE: "sandbox"     # sandbox | production
  TARGET_DSN: ""             # psql DSN to coredb-<tenant>  (from CI secret)
  GRAPHQL_URL: ""            # http://<tenant>-service-transactional:8080/graphql (via runner in-cluster) 
  K8S_CLUSTER: "dev-embrix-eks-dev-eks"

default:
  image: alpine/k8s:1.28.2   # has kubectl/helm/psql-ish; add postgresql-client + jq + curl
  before_script:
    - apk add --no-cache postgresql-client jq curl
    - export TENANT_NS=$TENANT

render:                       # substitute tenant-profile.yaml into the SQL/JSON/Helm templates
  stage: render
  script:
    - ./scripts/render.sh tenants/$TENANT/tenant-profile.yaml
  artifacts: { paths: [ build/ ] }

preflight:                    # Vault transit-key round-trip (A2.3) + DB reachable + schema present (L0 gate)
  stage: preflight
  script:
    - psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -f sql/00-verify-schema.sql
    - ./scripts/check-vault.sh         # the A2.3 encrypt round-trip; fail pipeline if null
  rules: [ { when: manual } ]

schema:                       # L0 — only if a brand-new DB (skip if Flyway already ran in app CI)
  stage: schema
  when: manual
  script:
    - echo "Run Flyway migrate against $TARGET_DSN (PART-A §2.3) — gated manual"

seed-reference:               # L5 + singletons
  stage: seed-reference
  script:
    - psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -f build/sql/05-bootstrap-singletons.sql
    - psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -f build/sql/10-reference-seed.sql
    - psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -f sql/L5-verify.sql

seed-canonical:               # L4 — replay EMBRIX (+JARS) from golden
  stage: seed-canonical
  script:
    - ./scripts/replay-canonical.sh "$GOLDEN_DSN" "$TARGET_DSN" EMBRIX
    - '[ "$WITH_XML" = "1" ] && ./scripts/replay-canonical.sh "$GOLDEN_DSN" "$TARGET_DSN" JARS || true'

onboard:                      # L2/L3 — createTenant via GraphQL
  stage: onboard
  script:
    - ./scripts/gql.sh "$GRAPHQL_URL" graphql/createTenant.graphql build/graphql/createTenant.vars.json

seed-flags:                   # L1 — setCcpProperties
  stage: seed-flags
  script:
    - ./scripts/gql.sh "$GRAPHQL_URL" graphql/setCcpProperties.graphql build/templates/minimal/flags.rendered.json

seed-users:                   # L6 — replay role catalog + createUser admin
  stage: seed-users
  script:
    - ./scripts/replay-rbac.sh "$GOLDEN_DSN" "$TARGET_DSN"
    - ./scripts/gql.sh "$GRAPHQL_URL" graphql/createUser.graphql build/graphql/createUser.vars.json
    - ./scripts/gql.sh "$GRAPHQL_URL" graphql/setCcpProperties.graphql build/graphql/ccp-userpointers.json  # selfcareRole/sysAdminUser

seed-supporting:              # §8 — OMS/jobs/collections/calendar/correspondence/templates
  stage: seed-supporting
  script:
    - for f in 30-oms-tasks 31-jobs 32-collections 34-correspondence 35-invoice-template; do
        psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -f build/sql/$f.sql ; done

reload:                       # §9 — rollout restart + gateway /reload
  stage: reload
  before_script:
    - aws eks --region us-east-1 update-kubeconfig --name $K8S_CLUSTER
  script:
    - ./scripts/reload.sh $TENANT_NS

verify:                       # §10 — smoke + pointer gate
  stage: verify
  script:
    - psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -f sql/smoke-verify.sql
    - ./scripts/smoke.sh "$GRAPHQL_URL"     # optional full order->invoice->payment

backout:                      # §12 — manual revert
  stage: backout
  when: manual
  script:
    - ./scripts/backout.sh "$TARGET_DSN" $TENANT
```

**Inputs** (GitLab "Run pipeline" form): `TENANT`, `ENV_PROFILE`, `TARGET_DSN`, `GRAPHQL_URL`, `GOLDEN_DSN`. **Secrets** (CI variables): DSNs, `EKS_ROLE_ARN`, Vault token. **Production** runs the same pipeline against the prod cluster/DB with `ENV_PROFILE=production` (which flips `useCcpTime/testMode` off via the rendered flags).

> The pipeline is **resumable per stage** — every seed is idempotent, so re-running a failed stage is safe. That's the operational payoff of all the `ON CONFLICT DO NOTHING`.

---

## §12 — Backout (revert to out-of-box)

### 12.1 Strategy
Three levels, pick by blast radius:
1. **Surgical** — each section (§3–§8, §5, §6, §7) has its own scoped backout block (delete `:tenant_id`-prefixed rows in reverse-FK order). Use to undo one layer.
2. **Config wipe** — run all section backouts in reverse order (§8→§7→§6→§5→§4→§3) + clear Redis `ccpPropertiesMap` + rollout restart. Returns the DB to "schema only."
3. **Nuke & repave** — because each tenant has its **own database** (`coredb-<tenant>`), the cleanest full revert is `DROP DATABASE coredb-<tenant>` + recreate + re-run Flyway. Fastest for a sandbox; obviously never for prod.

### 12.2 `scripts/backout.sh` (orchestrated, reverse order)
```bash
#!/usr/bin/env bash
# backout.sh TARGET_DSN TENANT  — reverts all seeded layers (config wipe). NOT for prod without sign-off.
set -euo pipefail
DSN="$1"; T="$2"
psql "$DSN" -v ON_ERROR_STOP=1 -v tenant_id="'$T'" <<'SQL'
BEGIN;
\i sql/backout/08-supporting.sql
\i sql/backout/07-users.sql
\i sql/backout/06-flags.sql
\i sql/backout/05-tenant.sql
\i sql/backout/04-canonical.sql
\i sql/backout/03-reference.sql
-- one-time junk cleanup (inherited messy envs):
DELETE FROM core_config.ccp_properties WHERE property IN ('','property','2023-11-15','2024-01-01');
COMMIT;
SQL
echo ">> config wiped for $T. Clearing Redis + rolling pods..."
redis-cli -h "$REDIS_HOST" DEL ccpPropertiesMap || true
kubectl -n "$T" rollout restart deploy
```
(The `sql/backout/*.sql` files are the per-section backout blocks already written in §3.15, §4.7, §5.8, §6.6, §7.7, §8.8 — extract them into that folder.)

### 12.3 Backout verification
```sql
SELECT 'BACKOUT' AS check,
  (SELECT count(*) FROM core_config.tenant)         AS tenants,      -- 0 after full wipe
  (SELECT count(*) FROM core_config.ccp_properties) AS ccp,          -- 0 (or only inherited)
  (SELECT count(*) FROM core_config.tenant_merchants) AS merchants;  -- 0
```

---

## Part C outcome
Reload makes every service honour the seeded config; the smoke test proves order-to-cash end-to-end and pinpoints any bad layer; the GitLab pipeline makes the whole Part A2→B→C sequence a **one-click, resumable, per-tenant** run; backout gives a clean revert. With this, provisioning a new tenant is: fill `tenant-profile.yaml` → run the pipeline → smoke-verify. The master ordered checklist is **`RUN-ORDER.md`**.
