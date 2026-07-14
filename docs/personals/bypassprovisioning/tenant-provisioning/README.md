# Embrix O2X — New-Tenant Provisioning Template

**Goal:** stand up a brand-new tenant (minimal, integration-free, working order-to-cash) by **filling one file and running one script** — instead of copying another tenant's config and hoping.

```
   cp -r tenants/_TEMPLATE tenants/bob        # 1. copy the template
   vi tenants/bob/tenant.env                  # 2. fill in name, currency, db, etc.
   export DB_APP_PASSWORD=...  ADMIN_PASSWORD=...   # 3. secrets (never committed)
   ./scripts/provision.sh tenants/bob/tenant.env    # 4. run — seeds everything in order
   # ✅ done: bob can log in, create accounts/orders, bill, invoice, take payment
```

That's the whole idea. Everything below is the detail behind those four lines.

> **New to this / leading a team?** Start with **`ROLES-AND-RUNBOOK.md`** (who does what — DevOps vs Developer vs QE, and the Helm-vs-DB config split) and **`SCRIPTS-REFERENCE.md`** (every script explained in plain language). Those two are the easiest on-ramp.
>
> **First time actually running it?** Do the **`DRY-RUN-CHECKLIST.md`** on a throwaway `dryrun` tenant — a guided 1–2 hr rehearsal (all 3 roles, exact commands, expected output at each gate). It proves the process and resolves the last 2 live-only unknowns before you provision a real tenant.

---

## What you must do BEFORE `provision.sh` (one-time per tenant, infra)

`provision.sh` seeds **configuration** into an already-running, schema-ready tenant. The infra/boot prerequisites (done once) are:

1. **Part A** (`PART-A-INFRASTRUCTURE.md`): RDS database `coredb-<tenant>`, Redis, MQ prefix, EKS namespace + `pg-secret`/`app-vault-token`, `helm upgrade` the mandatory service set.
2. **Part A2** (`PART-A2-VAULT-SECRETS.md`): Vault transit keys (`tenantId123` for passwords, the MQ key) — **verify the encrypt round-trip** or `createUser` + queues silently fail.
3. **L0 schema**: Flyway migrate the empty DB (or confirm already migrated).

`provision.sh` runs `00-verify-schema.sql` first and stops if these aren't ready.

---

## What `provision.sh` does (in order — bottom-up by dependency)

| Step | Layer | Artifact | Why this order |
|------|-------|----------|----------------|
| render | — | `scripts/render.sh` → `build/` | substitute `tenant.env` into all params/templates |
| verify | L0 | `sql/00-verify-schema.sql` | schema+enums present, tables empty |
| singletons | L5b | `sql/05-bootstrap-singletons.sql` | invoice-number seq, clock, calendar, token |
| reference | L5 | `sql/10-reference-seed.sql` | currency/GL/tax/AR/payment/product **(L1 points at these)** |
| canonical | L4 | `sql/20-canonical-embrix.sql` (checked-in) | internal tax map (gateway lookups resolve); vendor maps added later via `replay-canonical.sh` |
| tenant | L2/L3 | `graphql/createTenant` | tenant + 3 mandatory merchants |
| flags | L1 | `graphql/setCcpProperties` + `templates/minimal/flags.json` | the ~62 minimal feature flags (point at L5; Coope-isms trimmed) |
| users | L6 | `scripts/replay-rbac.sh` + `graphql/createUser` | role catalog + bootstrap admin (Vault pwd) |
| supporting | §8 | `sql/30,31,32,34,35` | OMS tasks, jobs, dunning, correspondence, templates |
| reload | — | `scripts/reload.sh` | restart pods so every service re-reads config |
| verify | — | `sql/smoke-verify.sql` | **pointer gate** — every flag resolves to a real row |

Re-runnable: every seed is idempotent (`ON CONFLICT DO NOTHING`), so a failed run resumes safely.

---

## The one file you edit: `tenants/<tenant>/tenant.env`

Identity, DB, currency/GL/tax, admin user, Vault keys, MQ prefix, S3 template paths. Secrets (`DB_APP_PASSWORD`, `ADMIN_PASSWORD`, `LICENSE_KEY`) are passed as **environment variables at runtime**, never written into the file. See the heavily-commented `tenants/_TEMPLATE/tenant.env`.

---

## Folder map

```
tenant-provisioning/
├── README.md                  ← you are here (copy/fill/run)
├── ROLES-AND-RUNBOOK.md       ← who does what (DevOps/Dev/QE) + Helm-vs-DB config model
├── SCRIPTS-REFERENCE.md       ← every script in plain language (what/how/expect)
├── DRY-RUN-CHECKLIST.md       ← guided first rehearsal (per-role commands + gates + ✅ boxes)
├── RUN-ORDER.md               ← the master ordered runbook (human checklist)
├── GUIDE.md                   ← index + §1 config model + §2 L0 schema
├── DIAGRAMS.md                ← ASCII flow diagrams
├── SERVICES-AND-GATEWAYS.md   ← every service/gateway: purpose, mandatory-vs-defer
├── DOMAIN-FLOWS.md            ← order-to-cash + provisioning + supporting flows
├── PART-A-INFRASTRUCTURE.md   ← AWS/EKS/Helm (infra prereq)
├── PART-A2-VAULT-SECRETS.md   ← Vault transit-key setup (prereq, silent-fail gap)
├── PART-B-S3..S8 + ...        ← per-layer detail (reference/canonical/tenant/flags/users/supporting)
├── PART-C-OPS.md              ← reload, smoke, CI/CD pipeline, backout
├── CHEATSHEET.md              ← one-screen commands-only sequence
├── tenants/
│   ├── _TEMPLATE/tenant.env   ← copy this per tenant
│   └── <tenant>/tenant.env
├── scripts/
│   ├── provision.sh           ← THE orchestrator
│   └── render.sh  gql.sh  reload.sh  replay-canonical.sh  replay-rbac.sh  backout.sh
├── sql/                       ← 00-verify · 00-params.tmpl · 05-singletons · 10-reference
│                                · 20-canonical-embrix · 21-canonical-jars(opt) · 30-oms · 31-jobs
│                                · 32-collections · 34-correspondence · 35-invoice-template · smoke-verify
├── graphql/                   ← createTenant / setCcpProperties / createUser (+ .vars.tmpl)
├── templates/minimal/flags.json   ← the ~62-flag minimal set (${} placeholders)
└── build/                     ← generated by render.sh (git-ignored)
```

---

## Add an integration later (after the minimal tenant works)

The minimal tenant has **no external integrations** by design. To switch one on (e.g. NOKIA provisioning, NetSuite finance, a real payment processor):
1. Deploy its gateway (add `helm_values/<tenant>/<gw>.yaml` + deploy job).
2. `scripts/replay-canonical.sh "$GOLDEN_DSN" "$DSN" <PROVIDER>` — its field maps.
3. Seed any vendor sequences (`config_prov_sequence*` for provisioning) via extract-replay.
4. Flip the matching flags (`provisioningEnabled`, `realTimeFinanceSync`, …) via `setCcpProperties`.
5. `scripts/reload.sh`.

Each integration is independent — that's the payoff of the minimal-template approach.

---

## Honest status

**Works as a template:** fill `tenant.env` → `provision.sh` runs L0→…→reload→verify, parameterized, idempotent. This replaces the copy-from-another-tenant approach.

**Verify-in-your-build before first prod use (marked 🔎 in the docs):**
- Enum values in the SQL (tax/AR/collection enums) — confirm against `core_enums.*`.
- The Vault password transit-key name (`tenantId123` is hardcoded with a TODO in `PGUserService`).
- The smoke test's `PriceOfferInput` shape (pricingHub schema) — test-time, not template.
- Upload the correspondence `.html` / invoice `.xsl` files to S3, or keep `GENERATE_INVOICE_PDF=false`.

Run it first against a **throwaway sandbox tenant**, fix any enum/⟦⟧ mismatch the gates surface, then it's repeatable for real tenants.
