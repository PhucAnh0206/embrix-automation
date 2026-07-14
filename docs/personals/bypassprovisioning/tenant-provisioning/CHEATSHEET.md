# Cheat Sheet — provision a tenant (commands only)

> One screen, no prose. For someone who's done it once and just needs the sequence. Full explanation: `RUN-ORDER.md` / `ROLES-AND-RUNBOOK.md`. First time ever → `DRY-RUN-CHECKLIST.md`.
> Replace `acme` everywhere with your tenant code. 🟦=DevOps · 🟩=Developer · 🟨=QE.

```bash
# ───────────────────────────────────────── PHASE 0: profile (🟩) ─────────────
cp -r tenants/_TEMPLATE tenants/acme
vi tenants/acme/tenant.env                 # name, TENANT_ID, currency, GL, tax item, vault keys, AMQ prefix
export DB_APP_PASSWORD='…'  ADMIN_PASSWORD='…'   # secrets — never commit

# ───────────────────────────────────────── PHASE 1: AWS + EKS + Helm (🟦) ────
# assume role + context (NON-PROD)
eks=( $(aws sts assume-role --role-arn "$EKS_ROLE_ARN" --role-session-name prov-acme \
        --query "Credentials.[AccessKeyId,SecretAccessKey,SessionToken]" --output text) )
export AWS_ACCESS_KEY_ID=${eks[0]} AWS_SECRET_ACCESS_KEY=${eks[1]} AWS_SESSION_TOKEN=${eks[2]}
aws eks --region us-east-1 update-kubeconfig --name dev-embrix-eks-dev-eks
kubectl config current-context             # MUST be non-prod

# RDS db (run as admin on the shared instance)
psql "$ADMIN_DSN/postgres" -v ON_ERROR_STOP=1 -c \
  'CREATE ROLE acme_app LOGIN PASSWORD :p; CREATE DATABASE "coredb-acme" OWNER acme_app;'

# namespace + secrets
kubectl create namespace acme
kubectl -n acme create secret generic pg-secret       --from-literal=username=acme_app --from-literal=password="$DB_APP_PASSWORD"
kubectl -n acme create secret generic app-vault-token --from-literal=token="$VAULT_TOKEN"

# deploy (mandatory set) — repeat the loop for gateway/UI repos too
helm repo add stable-embrix s3://embrix-helm3-repo/stable/ ; helm repo update
for m in jobs-common service-usage batch-process service-proxy service-billing service-invoice \
         service-payment service-revenue service-mediation service-transactional service-sso; do
  helm upgrade -i acme-$m stable-embrix/$m --wait -n acme \
    -f core/helm_values/acme/$m.yaml --set image.tag=develop --version 1.0.0
done
kubectl -n acme get pods                    # all Running

# Flyway (L0) against coredb-acme  → see PART-A §2.3

# ───────────────────────────────────────── PHASE 2: Vault (🟦) ───────────────
vault secrets enable -path=transit transit          # if not enabled
vault write -f transit/keys/tenantId123             # password key (🔎 confirm name in PGUserService)
vault write -f transit/keys/acme-mq                 # MQ key (= transit.key)
# store encrypted MQ creds + KV (license) → PART-A2 §A2.2
# CRITICAL round-trip (must return vault:v1:… not null):
kubectl -n acme exec deploy/acme-service-transactional -- sh -c \
  'curl -s -X POST "$VAULT_API"encrypt -H "transit-key: tenantId123" -d "{\"password\":\"x\"}"'

# ───────────────────────────────────────── PHASE 3: seed config (🟩) ─────────
# prechecks (resolve unknowns) — see PART-B-S3 §3.0.3 (enums) and PART-B-S5 §5.2.1 (gateway url-types)
psql "$ACME_DSN" -f sql/00-verify-schema.sql        # L0 gate
./scripts/provision.sh tenants/acme/tenant.env      # render → 05 → 10 → 20 (+21 if WITH_XML) →
                                                    #   createTenant → flags → rbac → createUser →
                                                    #   30/31/32/34/35 → reload → smoke-verify
# (provision.sh is idempotent — re-run to resume after any fix)

# ───────────────────────────────────────── PHASE 4: verify (🟨) ──────────────
./scripts/reload.sh acme                            # if not already done by provision.sh
# log in to core-ui as acmeadmin; then order→invoice→payment (PART-C §10.2)
psql "$ACME_DSN" -f build/sql/00-params.sql -f sql/smoke-verify.sql   # POINTERS all = t

# ───────────────────────────────────────── ADD AN INTEGRATION LATER ──────────
./scripts/replay-canonical.sh "$GOLDEN_DSN" "$ACME_DSN" NOKIA        # vendor maps
# + deploy its gateway, seed config_prov_sequence*, flip its flags, then:
./scripts/reload.sh acme

# ───────────────────────────────────────── BACKOUT / TEARDOWN ────────────────
./scripts/backout.sh tenants/acme/tenant.env        # revert config (NOT prod without sign-off)
# sandbox full reset: DROP DATABASE "coredb-acme"; + re-run Flyway
```

## Gate quick-reference (what "good" looks like)
| After | Check | Pass = |
|-------|-------|--------|
| Phase 2 | Vault encrypt round-trip | returns `vault:v1:…` (not null) |
| Phase 3 L5 | §3.14 gate | `default_gl_ok=t`, counts ≥1 |
| Phase 3 L1 | §6.4 pointer gate | gl/tax/currency/payterm/prodfamily all `t` |
| Phase 3 L6 | §7.6 gate | admin `pwd_format='vault:…'`, linked to ADMIN |
| Phase 4 | `smoke-verify.sql` | all `POINTERS` = `t`; order→invoice→payment OK |

## Seed-file order (what provision.sh runs)
`00-verify-schema` → `05-bootstrap-singletons` → `10-reference-seed` → `20-canonical-embrix` (→ `21-canonical-jars` if `WITH_XML=1`) → `createTenant.graphql` → `setCcpProperties`(flags) → `replay-rbac.sh` → `createUser.graphql` → user-pointer flags → `30-oms-tasks` `31-jobs` `32-collections` `34-correspondence` `35-invoice-template` → `reload.sh` → `smoke-verify`.
```
