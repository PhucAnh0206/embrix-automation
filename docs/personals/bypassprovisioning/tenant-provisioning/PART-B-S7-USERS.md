# Part B · §7 — L6: Users + RBAC (role catalog + bootstrap admin)

> The platform is unusable without (a) a **role catalog** (the permission definitions) and (b) at least one **admin user** to log in and operate. This layer is large and split-personality: the role *definitions* are bulky and standard (replay them), while the bootstrap user is tiny and security-sensitive (create it via the API so the password is vaulted).
>
> Grounded in your **real demo RBAC dump** + the verified write path (`PGUserService.create` → `vaultSrvc.encryptData(...)` for the password, then cascades to `user_roles`).

---

## 7.0 — What the demo dump taught us (so we don't build the wrong thing)

| Observation (from your query) | Consequence for the template |
|---|---|
| `role_groups` and `user_role_groups` returned **no rows** | Coope wires users **directly via `user_roles` → `roles`**, not via role-groups. Our bootstrap uses `user_roles`. (`userInMultipleGroups` flag and the group layer are optional/unused here.) |
| `ADMIN`=`500078`, `Self-Care`=`500076`, `CCP-SYSTEM-ROLE`=`500003`; plus `Solo lectura`/`Módulo …` roles | The English platform roles (ADMIN, Self-Care, CCP-SYSTEM-ROLE, read-only) are generic; the Spanish "Módulo …" roles are **Coope UI labels** — keep the platform ones, treat the rest as tenant-specific. |
| `selfcareRole=500076` resolves to `ROLE:Self-Care` | The §6 `selfcareRole` flag must point at the **Self-Care role id you seed** — not a hardcoded `500076`. |
| user passwords = `vault:v1:…` (53–65 chars); only system users (`ebrxadmin`=`test`, `authembrix`) are plaintext | Passwords are **Vault references**, written by `vaultSrvc.encryptData`. ⇒ **create users via GraphQL `createUser`, never raw SQL** (raw SQL can't produce the vault ref). |
| `congeroadmin` row has null cred/status/password (the historical hardcoded admin) | The `sysAdminUser` flag (§6) exists precisely to replace the hardcoded `congeroadmin`; set it to your new bootstrap admin. |
| `category` ∈ {CUSTOMER, AGENT, SYSTEM}; `credentialType` ∈ {CORE_UI, SELFCARE_UI, …} | Bootstrap admin = `category: SYSTEM`, `credentialType: CORE_UI`, `status: ACTIVE`. |

---

## 7.1 — The two halves of L6

```
L6a  ROLE CATALOG  (definitions)  -> bulky, standard      -> EXTRACT-REPLAY via pg_dump
        roles  +  roles_*_modules  +  roles_*_permissions  +  role_groups/role_group_roles
L6b  BOOTSTRAP ADMIN USER         -> tiny, secret-bearing  -> GraphQL createUser (vaulted password)
        users + user_contact + user_address + user_roles(-> ADMIN role)
```

### Why replay the role catalog (not hand-author)
A single role like `ADMIN` is not one row — it's a row in `roles` **plus** child rows across ~25 permission tables (`roles_customer_permissions`=405, `roles_pricing_permissions`=557, `roles_report_permissions`=632, … on Coope). Hand-authoring hundreds of permission rows correctly is infeasible and error-prone. The permission *vocabulary* (modules/permissions) is platform-standard (defined by `core_enums.*_module_permissions`), so the role definitions are tenant-identical → **extract once from a golden DB, replay into the new tenant.**

---

## 7.2 — L6a: Extract-replay the role catalog (`scripts/replay-rbac.sh`)

`pg_dump` orders tables by FK dependency, so `roles` lands before `roles_*`, and `role_groups` before `role_group_roles` — no manual ordering needed. Because L0 leaves these tables **empty** on a fresh tenant, a plain data dump loads cleanly (no conflicts).

```bash
#!/usr/bin/env bash
# replay-rbac.sh GOLDEN_DSN TARGET_DSN
# Replays the role catalog (roles + all roles_* + role_groups + role_group_roles) from golden into a fresh tenant.
set -euo pipefail
GOLDEN="${1:?golden DSN}"; TARGET="${2:?target DSN}"
OUT="$(mktemp /tmp/rbac.XXXX.sql)"

echo ">> dumping role catalog from golden..."
pg_dump "$GOLDEN" --data-only --inserts --no-owner --no-privileges \
  -t 'core_config.roles' \
  -t 'core_config.roles_*' \
  -t 'core_config.role_groups' \
  -t 'core_config.role_group_roles' \
  > "$OUT"

echo ">> loading into target (must be a FRESH tenant: roles_* empty)..."
psql "$TARGET" -v ON_ERROR_STOP=1 --single-transaction -f "$OUT"
echo ">> done. $(grep -c 'INSERT INTO' "$OUT") inserts applied. kept $OUT"
```

> **Curate for "generic":** the dump carries Coope's Spanish "Módulo …" roles too. Two options: (a) ship the **full** catalog (harmless extra roles — simplest, recommended for v1 of the template), or (b) post-prune to the platform roles only:
> ```sql
> -- keep only generic platform roles; adjust the keep-list to your golden's English roles
> DELETE FROM core_config.roles WHERE name LIKE 'Módulo %' OR name = 'Solo lectura' OR name LIKE '%Solo lectura';
> -- (cascade-delete their child permission rows first, or rely on FK ON DELETE if defined)
> ```
> For the **minimal template** the must-keep roles are: `ADMIN`, `Self-Care`, `CCP-SYSTEM-ROLE` (+ a read-only role if you want one). Note their ids from your golden (`500078`, `500076`, `500003`) — but **don't assume the same ids on every golden**; resolve by `name` (see §7.4).

**Verify L6a:**
```sql
SELECT 'L6a' AS gate,
  (SELECT count(*) FROM core_config.roles)                          AS roles,
  EXISTS(SELECT 1 FROM core_config.roles WHERE name='ADMIN')        AS admin_role_ok,
  EXISTS(SELECT 1 FROM core_config.roles WHERE name='Self-Care')    AS selfcare_role_ok,
  (SELECT count(*) FROM core_config.roles_customer_permissions)     AS sample_perm_rows;  -- > 0 if dump loaded
```

---

## 7.3 — L6b: Create the bootstrap admin via GraphQL `createUser`

`UserInput` (real schema):
```graphql
input UserInput {
  userId: String!
  password: String!            # plaintext here; PGUserService vault-encrypts before storing
  type: String!                # free-text label (e.g. "READ_WRITE")
  credentialType: CredentialType   # CORE_UI | SELFCARE_UI | ...
  status: AccountStatus            # ACTIVE | INACTIVE | ...
  category: UserCategory!          # SYSTEM | AGENT | CUSTOMER
  address: [UserAddressInput]
  contact: [UserContactInput]
  roles: [UserRolesInput]          # -> user_roles cascade (roleId per role)
  roleGroups: [UserRoleGroupsInput]
  profilePicturePath: String
}
```

Mutation (`graphql/createUser.graphql`):
```graphql
mutation CreateUser($u: UserInput!) {
  createUser(input: $u) { id userId }
}
```

Variables (`graphql/createUser.vars.json`) — a SYSTEM admin linked to the `ADMIN` role:
```jsonc
{
  "u": {
    "userId": "acmeadmin",
    "password": "<strong-bootstrap-password>",   // sent to Vault by the service; never stored plaintext
    "type": "READ_WRITE",
    "credentialType": "CORE_UI",
    "status": "ACTIVE",
    "category": "SYSTEM",
    "contact": [{
      "salutation": "Mr", "firstName": "Acme", "lastName": "Admin",
      "email": "admin@acme.example"
    }],
    "address": [{
      "street": "1 Main St", "city": "San Jose", "state": "CA",
      "country": "US", "postalCode": "95110"
    }],
    "roles": [{ "roleId": "<ADMIN role id resolved by name in 7.4>" }]
  }
}
```
Call it the same way as §5.4 (port-forward `service-transactional`, POST to `/graphql`). On success the service: inserts `users` (password = `vaultSrvc.encryptData(...)` ⇒ a `vault:v1:…` ref), then cascades `user_roles` (id=userId, index auto, roleId), and you can add `user_contact`/`user_address` rows.

> ⚠️ Confirm `UserRolesInput`'s field name (`roleId`) against `…/inputs/UserRolesInput.graphqls` in your build; the resolver maps it to `UserRoles` and calls `userRolesService.create`. If your env requires auth to call `createUser`, bootstrap via the `skipGatewayAuthorizationApis` bypass or a system token (§5.4 note).

---

## 7.4 — Resolve role ids by NAME (don't hardcode 500078)

Role ids are sequence-assigned and differ per environment. After L6a, resolve the ids you need by name and feed them into §7.3 and the §6 flags:

```sql
SELECT name, id FROM core_config.roles
WHERE name IN ('ADMIN','Self-Care','CCP-SYSTEM-ROLE');
```
Use the returned `ADMIN` id in `createUser.roles[].roleId`, and the `Self-Care` id as the value of the §6 `selfcareRole` flag.

---

## 7.5 — Wire the L1 flags that point at L6 (close the loop from §6.1.1)

Two `ccp_properties` keys are **deferred pointers** that we said in §6 we'd resolve here:
```graphql
# setCcpProperties — run after the admin user + roles exist
mutation { setCcpProperties(input:{ ccpPropertyList:[
  { property:"selfcareRole",  value:"<Self-Care role id from 7.4>" },
  { property:"sysAdminUser",  value:"acmeadmin" }
]}){ ccpPropertyList { property } } }
```
- `selfcareRole` → the Self-Care role id (self-care portal users get this role).
- `sysAdminUser` → the bootstrap admin `userId` (replaces the historical hardcoded `congeroadmin` for system-attributed activities).
- (`sysAdminAccount` points at a customer **account**, which doesn't exist until business data is created — leave unset at provisioning time; set it once a system account exists.)

---

## 7.6 — Verification gate (L6 done)

```sql
SELECT 'L6_GATE' AS gate,
  (SELECT count(*) FROM core_config.roles)                                   AS roles,
  (SELECT count(*) FROM core_config.users)                                   AS users,           -- >= 1
  EXISTS(SELECT 1 FROM core_config.users WHERE userid='acmeadmin')           AS admin_exists,
  (SELECT left(password,7) FROM core_config.users WHERE userid='acmeadmin')  AS pwd_format,       -- 'vault:v…'
  EXISTS(SELECT 1 FROM core_config.user_roles ur
         JOIN core_config.roles r ON r.id=ur.roleid
         WHERE ur.id='acmeadmin' AND r.name='ADMIN')                         AS admin_linked,
  ((SELECT value FROM core_config.ccp_properties WHERE property='sysAdminUser')='acmeadmin') AS sysadmin_flag_ok;
```
**Pass:** `admin_exists` + `admin_linked` true, `pwd_format` starts `vault:` (proves the vault path ran), `sysadmin_flag_ok` true. Then confirm you can actually **log in** via the UI/`generate-token` with `acmeadmin` + the bootstrap password.

---

## 7.7 — Backout
```sql
BEGIN;
DELETE FROM core_config.user_roles    WHERE id = 'acmeadmin';
DELETE FROM core_config.user_contact  WHERE id = 'acmeadmin';
DELETE FROM core_config.user_address  WHERE id = 'acmeadmin';
DELETE FROM core_config.users         WHERE userid = 'acmeadmin';
-- role catalog: only remove if reverting the whole tenant (it's shared platform definitions)
-- TRUNCATE the roles_* set in reverse-FK order, or drop/reseed the fresh DB.
COMMIT;
```
Also unset the §7.5 flags in `ccp_properties` if fully reverting.

---

## 7.8 — What §7 produced / next
The tenant now has: the full role catalog (permissions), one working **admin** user (vaulted password, linked to `ADMIN`), and the `selfcareRole`/`sysAdminUser` pointer flags resolved. Combined with §2–§6, the database is now a **complete, minimal, internally-consistent tenant config** — every layer seeded, every pointer resolving.

**Next: Part C (`PART-C-OPS.md`)** — §8 cache reload + full smoke verification (the order→invoice→payment proof), §9 the GitLab provision pipeline that runs §3–§7 in order, §10 backout orchestration; then **`RUN-ORDER.md`**, the single ordered runbook. I also owe you a **component catalog of every service + gateway** (your standing reminder) — I'll add `SERVICES-AND-GATEWAYS.md` so the template is grounded in what each of the 11 core services + 5 gateways + 2 UIs actually does and needs. No new query needed for those; I have the code + Helm.
