# Embrix O2X — Provisioning Flow Diagrams (text/ASCII)

> Visual companion to `GUIDE.md`. All diagrams are plain text so they render identically in any editor, GitLab, and Confluence (paste inside a code block / `{code}` macro). No Mermaid.

---

## D1 — System topology of one tenant (what we are provisioning)

A tenant = **one Kubernetes namespace** on a shared EKS cluster + its **own RDS database** + **shared** Redis / Amazon MQ / S3 / Vault (logically partitioned).

```
                          AWS account — region us-east-1
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  EKS cluster: dev-embrix-eks-dev-eks   (prod: coopeg-prod-eks)             │
  │  ┌────────────────────────────────────────────────────────────────────┐  │
  │  │  Namespace: <TENANT_NS>            (ONE namespace == ONE tenant)     │  │
  │  │                                                                      │  │
  │  │   [ core-ui ] [ selfcare-ui ]              <-- UIs (React)           │  │
  │  │        |                                                             │  │
  │  │        v   GraphQL                                                   │  │
  │  │   [ crm-gw ] [ payment-gw ] [ finance-gw ] [ tax-gw ] [ provision-gw]│  │
  │  │        |                                                             │  │
  │  │        v   GraphQL                                                   │  │
  │  │   [ service-transactional | billing | invoice | payment | revenue   │  │
  │  │     usage | mediation | proxy | sso | jobs-common | batch-process ]  │  │
  │  │        |            |             |              |                   │  │
  │  └────────│────────────│─────────────│──────────────│───────────────────┘  │
  │           │ jOOQ/JDBC  │ Jedis       │ JMS/SSL      │ HTTP                  │
  │           v            v             v              v                       │
  │   ( RDS Postgres )  ( ElastiCache )  [[ Amazon MQ ]]  ( S3 + vault-iface )  │
  │   db: coredb-<tnt>   Redis hash:     queues:          embrix-static-files   │
  │   schemas:           ccpPropertiesMap <PREFIX>.*      embrix-helm3-repo     │
  │   core_config,...                                                          │
  └──────────────────────────────────────────────────────────────────────────┘
        ^                                                   gateways also call:
        └───────────────── external integrations ──────────> payment processor,
                                                              tax, COOPEWEB,
                                                              provisioning/MOTV/NOKIA
```

**Key insight:** infra gives you empty running pods. They boot fine against an *unseeded* DB — they just do nothing useful, and `ccpPropertiesMap` in Redis is empty. Config (the L-layers) is what makes them work.

---

## D2 — End-to-end provisioning sequence (the order you run things)

```
 STEP  ACTOR            ACTION                                         WRITES TO
 ----  ---------------  ---------------------------------------------  -----------------------
  1    Operator/CI  ->  Create RDS db coredb-<tnt>, MQ prefix, Redis   AWS            (PART-A)
  2    Operator/CI  ->  Create namespace + secrets (pg-secret,         EKS
                        app-vault-token)
  3    Flyway       ->  Migrate empty DB  ........................ ->   RDS: schemas/enums/
                                                                       tables/functions  (L0)
  4    Operator     ->  Seed L5 reference (currency, GL, tax, AR, UOM) RDS: core_config   (L5)
                        via SQL
  5    Operator     ->  Seed L4 canonical maps (gateway_api_map)       RDS: core_config   (L4)
                        via SQL
  6    Operator/CI  ->  helm upgrade -i  (all modules)  ........... ->  EKS: pods boot   (LA3)
  7    Operator     ->  GraphQL createTenant(TenantInput)  ........ ->  RDS: tenant,
                                                                       tenant_merchants,
                                                                       *_gateway_attrs (L2/L3)
  8    Operator     ->  GraphQL setCcpProperties + property defaults    RDS: ccp_properties
                                                              ........ ->  + Redis live    (L1)
  9    Operator     ->  Seed L6 users + RBAC (SQL/GraphQL)  ....... ->   RDS: users/roles* (L6)
 10    Operator     ->  Roll pods / hit /reload (cache refresh)        Redis/JVM caches
 11    Operator     ->  Smoke: create account -> order -> invoice      proves the chain
```

**Why this order — the dependency rule:** L5 reference rows must exist before L1 flags that *point at them* (e.g. `defaultGLAccount=10001` must be a row in `config_chart_of_account_list`). Tenant/merchant (L2/L3) must exist before any gateway canonical-map lookup resolves. Caches must refresh (step 10) before behaviour is trustworthy.

---

## D3 — Config dependency graph (what references what) — THE important one

Arrows mean **"points at / must already exist"**. Provision **bottom-up** (lowest box first). A flag in L1 that is a string ID is a *pointer* into L5/L6 — if the target row is missing, you get "config not found" or silent no-ops.

```
   L1  ccp_properties (flags)                         <-- seed LAST
       defaultGLAccount, currency, taxationItemId,
       productFamily, paymentTerm, billingFrequency,
       selfcareRole, ...
         |            |            |          |            \
         | points at  | points at  | pts at   | pts at      \ selfcareRole points at
         v            v            v          v               v
   ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  (L6 roles)
   │config_     │ │currency /│ │tax_config│ │product_family│
   │chart_of_   │ │currency  │ │/config_  │ │_list         │
   │account_list│ │list      │ │tax_types │ │              │
   └───────────┘ └──────────┘ └──────────┘ └──────────────┘
         ^  L5 reference data (core_config)               <-- seed EARLY (after L0)

   L2/L3 tenant + merchants + gateway attrs
   ┌────────┐      ┌────────────────┐      ┌──────────────────────┐
   │ tenant │ <--- │ tenant_merchants│ <--- │ *_gateway_attributes │
   └────────┘      └────────────────┘      └──────────────────────┘
                          |                          |          |
                          | name/type/status         | type     | maps to
                          v                          v          v
                   ┌───────────────┐          ┌──────────────┐ ┌───────────────┐
                   │ core_enums.    │          │ core_enums.  │ │ gateway_api_  │
                   │ merchant_*     │          │ *_url_type   │ │ map (L4)      │
                   └───────────────┘          └──────────────┘ └───────────────┘
                          ^  L0 enums (created+populated by Flyway V2*)

   L6 users / RBAC
   ┌───────┐  member of  ┌─────────────────────┐
   │ users │ ----------> │ roles_* / role_groups│
   └───────┘             └─────────────────────┘
       |  status/category
       v
   ┌──────────────────────────────┐
   │ core_enums.account_status,    │
   │ user_category, credential_type│
   └──────────────────────────────┘
```

**Reading order to SEED:** `core_enums` (L0, Flyway) → `config_chart_of_account*`, `currency*`, `tax_*`, `product_family*`, `ar_*` (L5) → `gateway_api_map*` (L4) → `tenant` → `tenant_merchants` → `*_gateway_attributes` (L2/L3) → `roles_*`/`users` (L6) → `ccp_properties` (L1, last, because it points at all of the above).

---

## D4 — CI/CD pipeline (current core repo + the new provisioning stage)

```
  EXISTING  (core/.gitlab-ci.yml)
  ┌────────┐   ┌──────────────────┐   ┌─────────────────────────────────────────┐
  │ build  │ ->│ image-build      │ ->│ deploy  (manual, per tenant)              │
  │ mvn    │   │ docker build/push│   │ aws sts assume-role -> eks update-kubeconfig
  │ install│   │  x11 modules     │   │ helm upgrade -i <tnt>-<module> --v 1.0.0  │
  └────────┘   └──────────────────┘   └─────────────────────────────────────────┘
                                                          |
                                                          v
  NEW  (tenant-provision pipeline, parameterized by TENANT_ID)
  ┌────────┐  ┌───────────┐  ┌────────────┐  ┌─────────┐  ┌────────┐  ┌─────────┐
  │ render │->│ seed-static│->│ seed-config│->│seed-rbac│->│ reload │->│ verify  │
  │ profile│  │ L5 + L4 SQL│  │ L1/L2/L3   │  │ L6      │  │ rollout│  │ smoke   │
  │ -> yaml│  │            │  │ GraphQL    │  │         │  │ +/reload│ │ order   │
  └────────┘  └───────────┘  └────────────┘  └─────────┘  └────────┘  └─────────┘
                                                                          |
                                                                          v
                                                                   [ backout ] (manual)
```

**Trigger model (your conventions):** deploy jobs are `when: manual`, keyed on branch — `develop`→sandbox (`coopegsbx`), `maintenance`→`demo`/`congero`, `$CI_COMMIT_TAG`→`coopeg-prod`. The new provision pipeline is also `when: manual`, parameterized by `TENANT_ID` / `ENV_PROFILE` / `TARGET`.

---

## D5 — Tenant isolation model (how one cluster hosts many tenants)

```
  EKS cluster: dev-embrix-eks-dev-eks (NON-PROD)        EKS: coopeg-prod-eks (PROD — do not touch)
  ┌──────────────────────────────────────────┐         ┌─────────────────────────────┐
  │ ns: coopegsbx   (develop -> sandbox)       │         │ ns: coopeg                  │
  │ ns: demo                                   │         │   |                         │
  │ ns: congero                                │         │   v                         │
  │ ns: urbanos                                │         │ ( prod RDS, prod MQ, ... )  │
  │ ns: coopegenergy                           │         └─────────────────────────────┘
  │ ns: <NEWTENANT>   <-- you add this          │
  └───────────────│────────────────────────────┘
                  │  each namespace -> its own DB
                  v
   ( RDS instance:  coredb-coopegsbx | coredb-energy | coredb-<NEWTENANT> | ... )
```

**Implication — adding a tenant = 4 templated actions:**
1. a new **namespace** (+ secrets),
2. a new **RDS database** on the shared instance,
3. a new `helm_values/<tenant>/` directory in **each** repo,
4. a new **deploy job** in each `.gitlab-ci.yml`.

All four are templated in `PART-A-INFRASTRUCTURE.md`.
```
```
