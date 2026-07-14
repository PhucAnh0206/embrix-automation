# Part A — Infrastructure build (AWS → EKS → Helm → running pods)

> Goal of Part A: take "nothing" and end with **all Embrix services running (but unseeded)** for a new tenant `<TENANT>`. After Part A the pods are up and healthy against an empty database; Parts B/C seed the config that makes them useful.
>
> Everything here is grounded in your **actual** `core/.gitlab-ci.yml`, `core/helm_values/*/service-transactional.yaml`, and `core/service-transactional/Dockerfile`. Resource names quoted (e.g. `embrix-rds-dev-db`, `dev-embrix-eks-dev-eks`, `embrix-helm3-repo`) are the real ones from those files.
>
> ⚠️ **Production safety:** `coopeg-prod-eks` / namespace `coopeg` / `coopeg-prd` values are **PRODUCTION**. Never run the create/destroy commands in this part against prod unless that is the explicit, signed-off task. The worked examples below use a fictitious `<TENANT>=acme` on the **non-prod** cluster `dev-embrix-eks-dev-eks`.
>
> 🔒 **AWS CLI is run by *you*, not pasted blindly.** Every `aws …` command below is something a human with the right role runs and inspects. Treat them as a runbook, not an automated script, until they're reviewed.

---

## A.0 — What "a tenant" physically is (inventory)

From the Helm values and CI, a single tenant is the sum of these resources. Use this as the master checklist; every row has a step below.

| # | Resource | Scope | Real example (coopegenergy) | New-tenant action |
|---|----------|-------|------------------------------|-------------------|
| 1 | RDS **database** | per-tenant DB on a shared instance | `coredb-energy` on `embrix-rds-dev-db…rds.amazonaws.com` | `CREATE DATABASE coredb-<tenant>` |
| 2 | ElastiCache Redis | logical (own host or shared) | `master.coopeg-energy-dev-cache-rg….cache.amazonaws.com:6379` | reuse shared, or new replication group |
| 3 | Amazon MQ (ActiveMQ) | shared broker, per-tenant **queue prefix** | `ssl://b-f7aa…mq.us-east-1.amazonaws.com:61617` | reuse broker; set `<TENANT>` queue prefix |
| 4 | S3 | shared | `embrix-static-files`, `embrix-helm3-repo` | reuse |
| 5 | EKS **namespace** | per-tenant | ns `coopegenergy` on `dev-embrix-eks-dev-eks` | `kubectl create namespace <tenant>` |
| 6 | K8s secrets | per-namespace | `pg-secret`, `app-vault-token` | create in new ns |
| 7 | Vault path | per-tenant | `vault-interface`, `vaultPath` | create tenant secret path |
| 8 | Embrix **license** | per-tenant | `licenseKey` + `vaultUri`/`vaultPath` on `tenant` row | issue license (Embrix licensing) |
| 9 | Container images | shared (per branch tag) | `${CI_REGISTRY_IMAGE}/service-transactional:<tag>` | reuse existing tag |
| 10 | Helm releases | per-tenant | `coopegenergy-service-transactional` etc. | `helm upgrade -i <tenant>-<module>` |
| 11 | `helm_values/<tenant>/` | per-tenant, per-repo | `core/helm_values/coopegenergy/*.yaml` | create dir + 1 file per module |
| 12 | GitLab deploy job | per-tenant, per-repo | `coopegenergy-eks-deploy:` | add job to each `.gitlab-ci.yml` |

The service set (what gets deployed into the namespace):

- **Core (11 modules, repo `core/`):** `service-transactional`, `service-billing`, `service-invoice`, `service-payment`, `service-revenue`, `service-usage`, `service-mediation`, `service-proxy`, `service-sso`, `jobs-common`, `batch-process`.
- **Gateways (separate repos):** `crm-gateway`, `payment-gateway`, `finance-gateway`, `tax-gateway` (+ `tax-engine`), `provision-gateway`.
- **UIs:** `core-ui` (repo `ui-core`), `selfcare-ui` (repo `selfcare`).
- **Support:** `vault-interface` (referenced by `VAULT_API`).

---

## A.1 — Pre-flight: tooling, identity, naming

### A.1.1 Tools the operator needs locally
```bash
aws --version          # AWS CLI v2
kubectl version --client
helm version           # v3
helm plugin install https://github.com/hypnoglow/helm-s3.git   # S3 chart repo (same as CI)
psql --version         # libpq client
```

### A.1.2 Assume the deployment role (same mechanism as CI)
Your CI does `aws sts assume-role --role-arn $EKS_ROLE_ARN` then `aws eks update-kubeconfig`. Do the same locally so your `kubectl`/`helm` context is the cluster:
```bash
export AWS_REGION=us-east-1
eks=( $(aws sts assume-role \
          --role-arn "$EKS_ROLE_ARN" \
          --role-session-name "provision-<tenant>" \
          --query "Credentials.[AccessKeyId,SecretAccessKey,SessionToken]" --output text) )
export AWS_ACCESS_KEY_ID=${eks[0]} AWS_SECRET_ACCESS_KEY=${eks[1]} AWS_SESSION_TOKEN=${eks[2]}

# NON-PROD cluster:
aws eks --region $AWS_REGION update-kubeconfig --name dev-embrix-eks-dev-eks
kubectl config current-context     # sanity check — make sure it is NOT prod
```

### A.1.3 Naming convention (lock this before anything else)
Pick a short tenant code and derive everything from it. Worked example `acme`:

| Variable | Value (example) | Used by |
|----------|-----------------|---------|
| `TENANT` | `acme` | helm release prefix, namespace |
| `TENANT_NS` | `acme` | k8s namespace |
| `TENANT_ID` | `TIDLT-100010` | `tenant.id` / Helm `app.tenantId` / engine |
| `DB_NAME` | `coredb-acme` | RDS database |
| `HELM_VALUES_DIR` | `acme` | `helm_values/<dir>/` |
| `AMQ_PREFIX` | `ACME` | Amazon MQ queue prefix |
| `TZ` | `America/Costa_Rica` | container env |
| `CURRENCY` | `USD` | seed (Part B) |

> `TENANT_ID` format `TIDLT-1000NN` is the real pattern (`coopegenergy` = `TIDLT-100007`). Get the next free number from the licensing team; it is embedded in the license.

---

## A.2 — AWS resources

### A.2.1 RDS database (database-per-tenant on a shared instance)
Embrix runs **one Postgres database per tenant** on a shared RDS instance (e.g. `coredb-energy`, `coredb-coopegsbx`). You do **not** create a new RDS *instance* per tenant in non-prod — you create a new **database** inside the existing instance.

Connect to the shared instance as an admin and create the database + app role:
```bash
# Host from the helm values: embrix-rds-dev-db.chg5bgdk4yyp.us-east-1.rds.amazonaws.com
psql "postgresql://<admin>:<pwd>@embrix-rds-dev-db.chg5bgdk4yyp.us-east-1.rds.amazonaws.com:5432/postgres" \
     -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE acme_app LOGIN PASSWORD '<generated>';
CREATE DATABASE "coredb-acme" OWNER acme_app;
\connect coredb-acme
-- Embrix relies on these; create up-front so Flyway/jOOQ don't trip:
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON DATABASE "coredb-acme" TO acme_app;
SQL
```
The resulting JDBC URL (note the **required** query params, copied from the real values file):
```
jdbc:postgresql://embrix-rds-dev-db.chg5bgdk4yyp.us-east-1.rds.amazonaws.com:5432/coredb-acme?stringtype=unspecified&sslmode=require
```
`stringtype=unspecified` is mandatory — Embrix passes enum values as plain strings and relies on Postgres implicit casting; without it you get `column is of type X but expression is of type character varying`.

> **Production note:** prod (`coopeg-prod-eks`) typically uses a dedicated instance, encryption, automated backups, and a Multi-AZ standby. Creating a prod tenant DB is a DBA task with a change ticket — out of scope for this runbook's worked example.

### A.2.2 ElastiCache Redis
Redis stores the `ccpPropertiesMap` hash (and other caches). Two options:
- **Reuse** the shared cluster (simplest for sandbox) — just point `REDIS_HOST` at the existing endpoint. Risk: key collisions if two tenants share a node and both write `ccpPropertiesMap`. Mitigate by giving each tenant its **own logical DB index** or its **own replication group**.
- **Dedicated replication group** (cleaner isolation; matches the per-tenant naming `coopeg-energy-dev-cache-rg`):
```bash
aws elasticache create-replication-group \
  --replication-group-id acme-dev-cache-rg \
  --replication-group-description "Embrix acme cache" \
  --engine redis --cache-node-type cache.t3.small \
  --num-node-groups 1 --replicas-per-node-group 1 \
  --region us-east-1
# Endpoint → REDIS_HOST in the helm values
```
> ⚠️ Because `ccpPropertiesMap` is a **fixed key name** (not namespaced by tenant), two tenants on the **same** Redis node WILL clobber each other's flags. For a real multi-tenant build, give each tenant a dedicated replication group (or distinct Redis DB index). This is a genuine isolation requirement, not a nicety.

### A.2.3 Amazon MQ (ActiveMQ) — shared broker, per-tenant queue prefix
You consolidated onto a shared Amazon MQ broker (the AMQ consolidation work). Tenants are separated by a **queue name prefix**, not separate brokers. The broker URL (`ssl://b-…mq.us-east-1.amazonaws.com:61617`) is shared; the prefix keeps tenants' messages apart.

- Reuse the existing broker URL in `AMQ_BROKER_URL`.
- Set the tenant's queue prefix (engine `queuePrefix` / the `@Value` introduced in the consolidation fix) so queues become `ACME.<queue>` instead of colliding on bare names.
- No queue pre-creation is required — ActiveMQ auto-creates on first send — but document the prefix in the parameter sheet (A.7) so monitoring/DLQ rules can target it.

> This ties directly to the consolidation runsheet: the bug class you fixed (static queue names leaking across tenants) is exactly what the prefix prevents. A new tenant MUST get a unique `AMQ_PREFIX`.

### A.2.4 S3 + Vault + License
- **S3**: shared buckets `embrix-static-files` (assets, `AWS_S3_PUBLICURL`) and `embrix-helm3-repo` (Helm charts). No per-tenant action.
- **Vault**: secrets (DB password, integration creds, license) live in Vault, surfaced via the in-cluster `vault-interface` service (`VAULT_API=http://<tenant>-vault-interface/`). Create the tenant's Vault path and store: DB password, license token. The `tenant` row carries `vaultUri` + `vaultPath`.
- **License**: Embrix is license-gated (`LICENSE_PATH`, `VAULT_LICENSE_API`, `LICENSE_DECRYPT_KEY` in CI; `licenseKey` on the `tenant` row). A new tenant needs a license issued for its `TENANT_ID`. Request it from licensing **before** Part B step "createTenant" — `tenant.licensekey` is `NOT NULL`.

---

## A.3 — EKS namespace + secrets

```bash
# 1) Namespace
kubectl create namespace acme

# 2) Postgres secret (referenced as postgres.secret: pg-secret in the values file)
kubectl -n acme create secret generic pg-secret \
  --from-literal=username=acme_app \
  --from-literal=password='<the password from A.2.1>'

# 3) Vault token secret (referenced as vault.secret: app-vault-token)
kubectl -n acme create secret generic app-vault-token \
  --from-literal=token='<vault token issued for acme>'

# 4) (if pulling from a private registry) image pull secret
kubectl -n acme create secret docker-registry regcred \
  --docker-server="$CI_REGISTRY" --docker-username='<user>' --docker-password='<token>'

kubectl -n acme get secrets   # verify pg-secret, app-vault-token present
```

The Helm chart wires these in via `app.postgres.secret` and `app.vault.secret` (seen in the values file). If the secret names differ from what the chart expects, the pods will `CreateContainerConfigError` — check `kubectl describe pod`.

---

## A.4 — Container images (already built; understand, don't rebuild)

You do **not** build images per tenant. Images are built once per branch by the existing `Image Build` job and tagged with the sanitized branch name (`develop`, `maintenance`, `feature-…`). A tenant just **references** an existing tag via `image.tag` in its values file.

The Dockerfile (real, `core/service-transactional/Dockerfile`) is a thin JRE runtime:
```dockerfile
FROM eclipse-temurin:8-jre
COPY --chown=core:core target/service-transactional-*.jar /app/service-transactional.jar
ENTRYPOINT ["/bin/sh","-c","exec java -Xms${XMX_VALUE} -Xmx${XMX_VALUE} \
  -Dlogging.logstash.host=${LOGSTASH_HOST} -jar -noverify service-transactional.jar"]
EXPOSE 8080
```
Takeaways for provisioning:
- The container is configured **entirely by environment variables** (DB URL, Redis, MQ, gateway URLs, tenantId). That's why the Helm values file is the real per-tenant config surface — see A.5.
- `XMX_VALUE` (heap) and `resources.limits.memory` must agree (values file sets `XMX_VALUE=2048M` with `memory: 3Gi`). Set both per tenant based on expected load.
- The build image is `maven:3.5.3-jdk-8` and runtime `eclipse-temurin:8-jre` — **Java 8**. (The separate dependency-upgrade project moves some repos to newer Java; until merged, assume 8.)

---

## A.5 — Helm: per-tenant values + deploy

### A.5.1 The chart source (S3 repo, same as CI)
```bash
helm repo add stable-embrix s3://embrix-helm3-repo/stable/
helm repo update stable-embrix
helm search repo stable-embrix          # lists the per-module charts
```
Each module is its own chart (`stable-embrix/service-transactional`, `stable-embrix/crm-gateway`, …), pinned to `CHART_VERSION=1.0.0`.

### A.5.2 Create the per-tenant values directory
For repo `core/`, create `core/helm_values/acme/` with one file per module. Start from the real `coopegenergy` file and substitute. Annotated template for `service-transactional` (every per-tenant field marked `# <<`):

```yaml
# core/helm_values/acme/service-transactional.yaml
app:
  env: develop                              # << matches the branch/image tag family
  envMap:
    - {name: LOGS_DIR,  value: /logs}
    - {name: LOG_LEVEL, value: INFO}
    - {name: TZ,        value: "America/Costa_Rica"}   # << tenant timezone
    - {name: REDIS_HOST, value: master.acme-dev-cache-rg.xxxx.use1.cache.amazonaws.com}  # << A.2.2
    - {name: REDIS_PORT, value: "6379"}
    - {name: AWS_S3_PUBLICURL, value: https://embrix-static-files.s3.amazonaws.com}
    - {name: AMQ_BROKER_URL,   value: "ssl://b-f7aa….mq.us-east-1.amazonaws.com:61617"} # << shared broker
    - {name: TAX_GATEWAY_URL,        value: http://acme-tax-gateway}        # << internal svc DNS = <tenant>-<svc>
    - {name: PAYMENT_GATEWAY_URL,    value: http://acme-payment-gateway}    # <<
    - {name: FINANCE_GATEWAY_URL,    value: http://acme-finance-gateway}    # <<
    - {name: PROVISIONING_GATEWAY_URL, value: http://acme-provision-gateway}# <<
    - {name: CRM_GATEWAY_URL,        value: http://acme-crm-gateway}        # <<
    - {name: VAULT_API,              value: http://acme-vault-interface/}   # <<
    - {name: XMX_VALUE,              value: "2048M"}
    - {name: SPRING_DATASOURCE_HIKARI_CONNECTION_MIN_IDLE,   value: "1"}
    - {name: SPRING_DATASOURCE_HIKARI_CONNECTION_MAX_ACTIVE, value: "20"}
  postgres:
    secret: pg-secret                       # << k8s secret created in A.3
    url: jdbc:postgresql://embrix-rds-dev-db.chg5bgdk4yyp.us-east-1.rds.amazonaws.com:5432/coredb-acme?stringtype=unspecified&sslmode=require  # << A.2.1
  spring: {port: 8080, profile: pg}
  tenantId: TIDLT-100010                     # << A.1.3
  tenantName: acme                           # <<
  vault:
    secret: app-vault-token                  # << k8s secret created in A.3
  volumes:
    dataPvc: acme-data-pvc                    # << per-tenant PVC
fullnameOverride: acme-service-transactional # << drives the in-cluster service DNS name
image:
  pullPolicy: Always
  tag: develop                               # << existing image tag to run
resources:
  limits:   {memory: 3Gi}
  requests: {memory: 3Gi}
```

> The internal gateway URLs follow the pattern `http://<tenant>-<service>` because `fullnameOverride: <tenant>-<service>` makes the k8s Service name exactly that. Keep the prefix consistent across **all** files or services won't find each other.

Repeat (substituting the same tenant fields) for the other 10 core modules, then the gateway repos (`crm_gateway/helm_values/acme/crm-gateway.yaml`, etc.) and UIs (`ui-core/helm_values/acme/core-ui.yaml`, `selfcare/helm_values/acme/selfcare-ui.yaml`). A render script (Part C) generates all of these from one `tenant-profile.yaml` so you don't hand-edit ~20 files.

### A.5.3 Deploy (the real command, parameterized)
This is the exact loop from `core/.gitlab-ci.yml`, run for the new tenant:
```bash
TENANT=acme; TENANT_NS=acme; HELM_VALUES_DIR=acme; DOCKER_TAG=develop; CHART_VERSION=1.0.0
MODULES="jobs-common service-usage batch-process service-proxy service-billing \
         service-invoice service-payment service-revenue service-mediation service-transactional service-sso"
for module in $MODULES; do
  helm upgrade -i ${TENANT}-${module} stable-embrix/${module} \
    --wait --namespace ${TENANT_NS} \
    -f core/helm_values/${HELM_VALUES_DIR}/${module}.yaml \
    --set image.tag=${DOCKER_TAG} --set image.pullPolicy=Always \
    --version ${CHART_VERSION}
done
# then repeat per gateway/UI repo with their own charts + values
```

---

## A.6 — The new GitLab deploy job (copy-paste)

Add a job to `core/.gitlab-ci.yml` reusing the existing `.aws-k8s-deploy` anchor. This is identical in shape to `coopegenergy-eks-deploy:` — only the variables change:
```yaml
acme-eks-deploy:
  <<: *aws-k8s-deployment-template
  tags: [dev-k8s-runner]
  rules:
    - if: '$CI_COMMIT_REF_NAME == "develop"'
      when: manual
  variables:
    AWS_REGION: "us-east-1"
    K8S_CLUSTER: "dev-embrix-eks-dev-eks"
    TENANT: "acme"
    TENANT_NS: "acme"
    HELM_VALUES_DIR: "acme"
    CHART_VERSION: "1.0.0"
    DEPLOYMENT_ROLE_ARN: $EKS_ROLE_ARN
  cache: {}
```
Add the equivalent job to every repo that deploys into the namespace (`crm_gateway`, `payment-gateway`, `finance-gateway`, `tax-gateway`, `tax-engine`, `provision_gateway`, `ui-core`, `selfcare`). The render script in Part C can append these too.

---

## A.7 — Per-tenant parameter sheet (single source of truth)

Fill this once per tenant; every step above and Parts B/C read from it. (This becomes `tenants/<tenant>/tenant-profile.yaml`.)

| Key | Example | Where used |
|-----|---------|------------|
| `TENANT` / `TENANT_NS` | `acme` | namespace, helm release, svc DNS |
| `TENANT_ID` | `TIDLT-100010` | helm `app.tenantId`, engine, license |
| `DB_HOST` | `embrix-rds-dev-db….rds.amazonaws.com` | JDBC url |
| `DB_NAME` | `coredb-acme` | JDBC url |
| `DB_APP_USER` / pwd | `acme_app` / (Vault) | `pg-secret` |
| `REDIS_HOST` / port | `master.acme-dev-cache-rg….` / 6379 | helm env |
| `AMQ_BROKER_URL` | `ssl://b-f7aa….:61617` | helm env |
| `AMQ_PREFIX` | `ACME` | engine queue prefix |
| `VAULT_PATH` / `vaultUri` | `secret/acme` / `http://acme-vault-interface/` | tenant row, helm |
| `LICENSE_KEY` | (from licensing) | tenant row |
| `IMAGE_TAG` | `develop` | helm `image.tag` |
| `CHART_VERSION` | `1.0.0` | helm `--version` |
| `K8S_CLUSTER` | `dev-embrix-eks-dev-eks` | deploy |
| `EKS_ROLE_ARN` | (CI var) | sts assume-role |
| `TZ` | `America/Costa_Rica` | helm env |
| `CURRENCY` / `COUNTRY` / `LEGAL_ENTITY` | `USD` / `US` / `Acme Inc` | Part B seed |

---

## A.8 — Part A verification (gate before Part B)

```bash
# 1) All core pods Running/Ready in the tenant namespace
kubectl -n acme get pods
kubectl -n acme get pods --field-selector=status.phase!=Running   # should be empty

# 2) A core service can reach the DB (it boots = Flyway/datasource OK once DB exists)
kubectl -n acme logs deploy/acme-service-transactional | tail -50   # look for "Started ... in N seconds", no datasource errors

# 3) Redis reachable from a pod
kubectl -n acme exec deploy/acme-service-transactional -- sh -c 'nc -zv $REDIS_HOST 6379 || true'

# 4) GraphQL endpoint answers (used in Part B)
kubectl -n acme port-forward svc/acme-service-transactional 8080:8080 &
curl -s localhost:8080/actuator/health 2>/dev/null || echo "check /graphql instead"
```
Expected: all pods Running; `service-transactional` log shows a clean Spring Boot start; Redis port reachable. The DB will be **empty of config** — that's fine; Part B fills it. If pods `CrashLoopBackOff`, 90% of the time it's (a) wrong JDBC url / missing `stringtype=unspecified`, (b) missing `pg-secret`/`app-vault-token`, or (c) license invalid for `TENANT_ID`.

---

## A.9 — What Part A produced / what's next

End state: a namespace `acme` with all services Running against `coredb-acme`, Redis, and the shared MQ broker — **structurally alive, functionally empty.** Proceed to **Part B (database config layers, `GUIDE.md` §2–§7)**: schema bootstrap (if not already run), then seed L5 → L4 → L2/L3 → L1 → L6, then Part C operations (reload + verify + CI/CD + backout).
