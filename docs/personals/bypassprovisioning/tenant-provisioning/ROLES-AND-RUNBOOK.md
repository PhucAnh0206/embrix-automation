# Roles & Runbook — who does what to provision a tenant

> This is the **team playbook**. It answers: *who* does each step (DevOps / Developer / QE), *in what order*, and *where one role hands off to the next*. If you read nothing else, read this — it tells you which parts of the heavy reference docs are even your job.
>
> The detailed "why" lives in the other docs; this is the "who + when."

---

## 1. The one mental model that makes everything click

Embrix tenant config comes in **two kinds**, injected two different ways, owned by two different people:

| | **(A) Infrastructure / runtime config** | **(B) Business / tenant config** |
|---|---|---|
| **What** | DB URL, Redis host, MQ broker URL, `mq.queue.prefix`, `transit.key`, `VAULT_API`, `tenantId`, `tenantName`, gateway URLs, `XMX`, `TZ`, image tag | `ccp_properties` (feature flags), currency/GL/tax/AR reference data, tenant + merchants, canonical maps, users/roles, OMS tasks, jobs, dunning |
| **Injected via** | Helm values (env vars) | the database (SQL seeds + GraphQL mutations) |
| **Where** | `helm_values/<tenant>/<svc>.yaml` | `scripts/provision.sh` → RDS DB |
| **How** | `helm upgrade -i …` | `psql` seeds + GraphQL mutations |
| **Owner** | **DevOps** | **Developer** (with QE verifying) |

**Why this split matters:** a pod with correct Helm config but an empty DB **boots fine and does nothing** (every `if (flag)` is false). A seeded DB with wrong Helm config **can't even connect**. You need *both*, and they're done by *different people in sequence* — DevOps lays the infra + injects runtime config via Helm, then the Developer injects business config into the DB, then QE proves it works.

> You said "we normally inject config through Helm" — that's exactly kind (A). Kind (B) is the part that's been painful (the copy-from-another-tenant problem), and it's what `provision.sh` automates.

---

## 2. The three roles and their access

| Role | Has access to | Owns in provisioning | Does NOT touch |
|------|---------------|----------------------|----------------|
| **DevOps** | Kubernetes (kubectl/helm), AWS (RDS/ElastiCache/MQ/EKS), Vault admin | Phase 1 (infra) + Phase 2 (Vault) + Helm config injection + `reload` | business config / SQL seeds |
| **Developer** | DB (psql to `coredb-<tenant>`), GraphQL endpoint, the `tenant-provisioning` repo | Phase 3 (DB config seed) via `provision.sh` | cluster/AWS/Vault internals |
| **QE** | GraphQL endpoint, read DB, the UI | Phase 4 (smoke test + sign-off) | infra changes / seeding |

> Single-DevOps reality: since one person holds k8s/AWS/Vault, Phases 1–2 are a **DevOps handoff gate** — nothing in Phase 3 works until DevOps says "infra + Vault green." Build the handoff checklist (§5) into your process so the Developer isn't blocked guessing.

---

## 3. RACI at a glance

`R`=does it, `A`=accountable/sign-off, `C`=consulted, `I`=informed.

| Step | DevOps | Developer | QE |
|------|:---:|:---:|:---:|
| 1. AWS: RDS DB, Redis, MQ prefix | **R/A** | C | I |
| 2. EKS namespace + k8s secrets | **R/A** | I | I |
| 3. Helm: render values + `helm upgrade` (inject runtime config) | **R/A** | C | I |
| 4. Vault: transit keys + secrets + verify round-trip | **R/A** | C | I |
| 5. Flyway: migrate schema (L0) | **R** | C | I |
| 6. `provision.sh` (seed L5→L6 + supporting) | C | **R/A** | I |
| 7. `reload.sh` (restart pods) | **R** | C | I |
| 8. Smoke test (order→invoice→payment) | I | C | **R/A** |
| 9. Sign-off "tenant ready" | I | C | **A** |

---

## 4. The runbook, phase by phase, by role

### PHASE 1 — DevOps: AWS infrastructure
**Goal:** the tenant's cloud resources exist. **Detail:** `PART-A-INFRASTRUCTURE.md §A.2`.

1. **RDS database** (database-per-tenant on the shared instance):
   ```bash
   psql "postgresql://<admin>@embrix-rds-dev-db….rds.amazonaws.com:5432/postgres" -v ON_ERROR_STOP=1 <<'SQL'
   CREATE ROLE acme_app LOGIN PASSWORD '<gen>';
   CREATE DATABASE "coredb-acme" OWNER acme_app;
   \connect coredb-acme
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pgcrypto;
   SQL
   ```
   → Hand the JDBC URL (`…/coredb-acme?stringtype=unspecified&sslmode=require`) to step 3.
2. **Redis** — reuse shared **or** create a dedicated replication group (⚠️ `ccpPropertiesMap` is a fixed key → tenants on the same node collide; prefer a dedicated group). Record the endpoint.
3. **Amazon MQ** — reuse the shared broker; **assign a unique queue prefix** `AMQ_PREFIX=ACME.` (this is the AMQ-consolidation isolation rule).
4. **S3** — shared buckets, no action.
**Handoff:** DB URL, Redis host, MQ broker URL + prefix → into the Helm values (step 3).

### PHASE 1b — DevOps: EKS namespace + secrets
**Detail:** `PART-A §A.3`.
```bash
kubectl create namespace acme
kubectl -n acme create secret generic pg-secret       --from-literal=username=acme_app --from-literal=password='<gen>'
kubectl -n acme create secret generic app-vault-token --from-literal=token='<vault-token>'
```

### PHASE 1c — DevOps: Helm — inject runtime config + deploy (this is "config via Helm")
**Detail:** `PART-A §A.5`, `SERVICES-AND-GATEWAYS.md §4` (which services).
This is where **kind-(A) config** is injected. For each service, the per-tenant `helm_values/acme/<svc>.yaml` carries the env vars; `helm upgrade` applies them.
```bash
helm repo add stable-embrix s3://embrix-helm3-repo/stable/ ; helm repo update
for m in jobs-common service-usage batch-process service-proxy service-billing \
         service-invoice service-payment service-revenue service-mediation service-transactional service-sso; do
  helm upgrade -i acme-$m stable-embrix/$m --wait -n acme \
    -f core/helm_values/acme/$m.yaml --set image.tag=develop --version 1.0.0
done
# + gateways (tax/finance/payment mandatory) + core-ui + vault-interface
```
**Key env vars DevOps must get right in the values file** (these are the kind-(A) config the app reads):
| Env var | Value | Consumed by |
|---------|-------|-------------|
| `postgres.url` | the `coredb-acme` JDBC URL | jOOQ datasource |
| `REDIS_HOST/PORT` | tenant Redis | ccpPropertiesMap cache |
| `AMQ_BROKER_URL` | shared broker | messaging |
| `mq.queue.prefix` | `ACME.` | **queue isolation** |
| `transit.key` | tenant MQ transit key | MQ cred decryption (Vault) |
| `VAULT_API` | `http://acme-vault-interface/` | secrets |
| `app.tenantId` | `TIDLT-100010` | **the tenant's identity** (createTenant reads it) |
| `<X>_GATEWAY_URL` | `http://acme-<gw>` | inter-service routing |
| `TZ`, `XMX_VALUE` | per tenant | timezone, heap |
**Handoff:** `kubectl -n acme get pods` all Running → tell Developer "pods up."

### PHASE 2 — DevOps: Vault (the silent-failure prerequisite)
**Detail:** `PART-A2-VAULT-SECRETS.md`. **Do this before the Developer creates users.**
```bash
vault secrets enable -path=transit transit                 # if not enabled
vault write -f transit/keys/tenantId123                     # user-password key (🔎 confirm name)
vault write -f transit/keys/acme-mq                         # MQ-cred key (= transit.key)
# encrypt + store MQ broker creds; populate KV (license) at secret/acme/…
```
**Verify (mandatory — failures are silent):**
```bash
kubectl -n acme exec deploy/acme-service-transactional -- sh -c \
 'curl -s -X POST "$VAULT_API"encrypt -H "transit-key: tenantId123" -d "{\"password\":\"x\"}"'
# must return a vault:v1:… ciphertext, NOT null
```
**Handoff:** "Vault round-trip green" → Developer may proceed to user creation.

### PHASE 3 — Developer: seed the business config
**Goal:** the DB holds a complete, minimal, consistent tenant config. **Detail:** `README.md`, `PART-B-S3..S8`.
```bash
cp -r tenants/_TEMPLATE tenants/acme
vi tenants/acme/tenant.env                 # fill identity/currency/GL/tax/admin/vault keys/MQ prefix
export DB_APP_PASSWORD='…' ADMIN_PASSWORD='…'      # secrets, never committed
# (one-time, if brand-new DB) DevOps or Dev runs Flyway migrate first — see PART-A §2.3
./scripts/provision.sh tenants/acme/tenant.env
```
`provision.sh` runs everything in dependency order (render → verify schema → singletons → reference → canonical → createTenant → flags → RBAC → admin user → supporting → reload → pointer-verify). It's idempotent — re-run on failure. **Detail of each step:** `SCRIPTS-REFERENCE.md`.
**Handoff:** the run ends with the pointer gate all-true → tell QE "tenant seeded."

### PHASE 4 — QE: prove it works, then sign off
**Goal:** order→invoice→payment runs end-to-end. **Detail:** `PART-C-OPS.md §10`.
1. Log in to `core-ui` as the bootstrap admin (`acmeadmin`).
2. Create a throwaway price offer, an account, a NEW order → confirm it reaches ACTIVE.
3. Run/await billing → invoice generated **and numbered** → record a payment.
4. Run `sql/smoke-verify.sql` → every `POINTERS` column must be `t`.
**Sign-off criteria:** no "Tenant not configured" / "Canonical … not found"; invoice numbered; pointer gate all true. → **Tenant ready.**

---

## 5. Handoff checklists (paste into your ticket per tenant)

**DevOps → Developer (infra ready):**
- [ ] `coredb-<tenant>` created, app role + extensions, JDBC URL shared
- [ ] Redis endpoint (dedicated or confirmed-isolated)
- [ ] MQ prefix `<TENANT>.` set in all service values
- [ ] namespace + `pg-secret` + `app-vault-token` created
- [ ] all mandatory services Running (`kubectl get pods`)
- [ ] Helm values: `app.tenantId`, `mq.queue.prefix`, `transit.key`, `VAULT_API`, gateway URLs correct
- [ ] **Vault: transit keys created + encrypt round-trip returns `vault:…`**
- [ ] Flyway schema migrated (L0 verify passes)

**Developer → QE (config seeded):**
- [ ] `provision.sh` completed without error
- [ ] `smoke-verify.sql` POINTERS all `t`
- [ ] bootstrap admin password handed over (securely)
- [ ] correspondence `.html` / invoice `.xsl` uploaded to S3 **or** PDF kept off

**QE → sign-off (tenant ready):**
- [ ] login works; account+order→ACTIVE; invoice numbered; payment applied
- [ ] no config-not-found errors in logs

---

## 6. Common failures → who fixes
| Symptom | Likely cause | Owner |
|---------|--------------|-------|
| Pod `CrashLoopBackOff` | bad JDBC url / missing secret / license | DevOps |
| `createUser` stores null password | Vault transit key missing | DevOps (Phase 2) |
| messages don't flow / queues stuck | wrong/duplicate `mq.queue.prefix` or MQ creds | DevOps |
| "Canonical response config mapping not found" | missing L4 map | Developer (`replay-canonical.sh`) |
| flag set but ignored by some service | cache not reloaded | DevOps (`reload.sh`) |
| "config not found" on GL/tax | L1 pointer → missing L5 row | Developer (pointer gate shows which) |
| invoice has no number | `INVOICE_DB_SEQ` not seeded | Developer (`05-bootstrap-singletons.sql`) |

---

## 7. Where to read more
- **`README.md`** — the 4-line quickstart.
- **`SCRIPTS-REFERENCE.md`** — every script explained plainly (what/how/expect).
- **`RUN-ORDER.md`** — the full ordered checklist.
- **`PART-A`/`PART-A2`** — DevOps detail (AWS/Helm/Vault).
- **`PART-B-S3..S8`** — Developer detail (each config layer).
- **`PART-C-OPS.md`** — reload, smoke, CI/CD, backout.
- **`SERVICES-AND-GATEWAYS.md`** / **`DOMAIN-FLOWS.md`** — what the system is and how it runs.
