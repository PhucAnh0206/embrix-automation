# Part A2 — Vault & Secrets setup (the hidden boot/runtime dependency)

> **Why this is its own section:** the original Part A deploys `vault-interface` and the k8s secrets, but that is *not enough*. Several core flows call HashiCorp Vault's **transit** (encrypt/decrypt) engine through `vault-interface`, and **they fail silently — returning `null` — if the expected transit keys or stored secrets are missing.** The two that bite first: **user password encryption** (`createUser`, §7) and **ActiveMQ credential decryption** (every queue publish, §1 of DOMAIN-FLOWS). This section is the missing setup that makes §5/§7/§8 actually work at runtime.
>
> Verified in `VaultServiceImpl` + `PGUserService` + `PGQueueManageService`. Run/confirm this **before** §7 (createUser) and before expecting any AMQ message to flow.

---

## A2.0 — How Embrix uses Vault (the real mechanism)

`VaultServiceImpl` (`engine/.../corevault/service/impl/VaultServiceImpl.groovy`) is a thin HTTP client to the in-cluster **`vault-interface`** service (`${vault.api}` = Helm `VAULT_API` = `http://<tenant>-vault-interface/`). It supports three operations, all POST/GET to `vault-interface`, which in turn talks to HashiCorp Vault:

| Method | Vault op | HTTP | Header | Purpose |
|--------|----------|------|--------|---------|
| `encryptData(transitKey, payload)` | `encrypt` | `POST <vault.api>encrypt` | `transit-key: <transitKey>` | encrypt a value (e.g. a user password) using a **named transit key** |
| `decryptData(transitKey, payload)` | `decrypt` | `POST <vault.api>decrypt` | `transit-key: <transitKey>` | decrypt (e.g. the stored MQ username/password) |
| `readSecrets(uri, path, token)` | read | `GET <uri>` | `path`, `transit-key` | read a KV secret at a path (e.g. license, gateway creds) |
| `writeData(vaultTransit)` | `write/tenant` | `POST <vault.api>write/tenant` | `path` | write a tenant secret |

**Critical behaviour (from `connect()`):** on **any** exception it logs and `return null` — it does **not** throw. So a misconfigured Vault doesn't crash the pod; it makes `encryptData` return `null`, and the caller stores `null`. That's why these failures are silent and look like "login doesn't work" / "messages don't flow" rather than a clear error. **You must verify Vault positively, not assume.**

---

## A2.1 — The transit keys you must create (the gap)

Vault's **transit** secrets engine holds named encryption keys. Embrix references specific transit-key names; each must exist (be created/enabled) in the tenant's Vault before the corresponding flow runs.

### A2.1.1 User-password transit key (blocks §7 `createUser`)
`PGUserService.create` (verified) builds the transit key as:
```groovy
String key = '123', tenantId = 'tenantId'      // ⚠️ hardcoded, with a TODO to make per-tenant
String tenantToken = tenantId.concat(key)        // => "tenantId123"
USERS.PASSWORD = vaultSrvc.encryptData(tenantToken, ['password': userInput.password]).get('password')
```
So the transit key name is literally **`tenantId123`** (unless your build has since fixed the TODO — 🔎 grep `tenantToken` in your branch's `PGUserService` to confirm). **Vault must have a transit key named `tenantId123` enabled**, or `encryptData` returns null → `users.password = null` → the bootstrap admin can never log in.

> This explains the demo dump: most users had `password = vault:v1:…` (successfully encrypted) — proving the transit key exists in the demo Vault. A fresh tenant's Vault won't have it unless you create it.

### A2.1.2 ActiveMQ credential transit key (blocks all queue publishing)
`PGQueueManageService.createConnection` (verified):
```groovy
@Value('${transit.key}')   private String transitKey
@Value('${mq.username}')   private String mqUser      // stored encrypted
@Value('${mq.password}')   private String mqPassword  // stored encrypted
...
Map creds = vaultService.decryptData(transitKey, ['queueuser': mqUser, 'queuepass': mqPassword])
connectionFactory.userName = creds.get('queueuser'); connectionFactory.password = creds.get('queuepass')
```
So: a transit key named by the Spring property **`transit.key`** must exist, and `mq.username`/`mq.password` (Helm/config) must be the **encrypted** forms decryptable by that key. If decryption returns null, the MQ connection authenticates with null creds → connection fails → **no async work flows** (billing/invoice/provisioning handoffs stall).

### A2.1.3 (If used) gateway / license secrets
`readSecrets(vaultUri, vaultPath, token)` reads KV secrets at the tenant's `vaultPath` (the `tenant.vaultUri`/`vaultPath` from §5). Gateway auth creds and the **license** may be read this way. Ensure the tenant's KV path is populated (A2.3).

---

## A2.2 — Setup steps (what to actually do)

> AWS/Vault admin actions — run by a human with Vault access. Adjust to your Vault deployment (the `vault-interface` abstracts the exact API, but the underlying transit engine + KV must be set up).

### Step 1 — Ensure the transit engine is enabled
```bash
# against the tenant's Vault (or shared Vault namespace)
vault secrets enable -path=transit transit            # if not already enabled
```

### Step 2 — Create the required transit keys
```bash
# user-password key (name must match PGUserService tenantToken — 'tenantId123' unless your build differs)
vault write -f transit/keys/tenantId123

# MQ-credential key (name must match the value of Spring prop transit.key for this tenant)
vault write -f transit/keys/<value-of-transit.key>
```
> 🔎 Resolve `<value-of-transit.key>` from the tenant's Spring config / Helm (`transit.key`). If your platform uses **one** shared transit key for both, create that one. The point is: **every transit-key name referenced by the running code must exist in Vault.**

### Step 3 — Store + encrypt the MQ credentials
The MQ broker user/pass must be stored as the **encrypted** forms that `mq.username`/`mq.password` point to. Encrypt the real broker creds with the MQ transit key, then put the ciphertext into the tenant's config (Helm/secret) as `mq.username`/`mq.password`:
```bash
vault write transit/encrypt/<mq-transit-key> plaintext=$(echo -n 'MQ_BROKER_USER' | base64)
vault write transit/encrypt/<mq-transit-key> plaintext=$(echo -n 'MQ_BROKER_PASS' | base64)
# take the returned ciphertext (vault:v1:...) -> set as mq.username / mq.password in the tenant config
```

### Step 4 — Populate the tenant KV path (license, gateway creds)
```bash
vault kv put secret/<tenant>/license   key='<license-token-for-TENANT_ID>'
# gateway creds, if any, under the tenant's vaultPath
```

### Step 5 — Wire the k8s token secret (already in Part A, restated)
`vault-interface` authenticates to Vault with the token in the `app-vault-token` k8s secret (Part A §A.3). Confirm it's present and valid for the tenant namespace:
```bash
kubectl -n <tenant> get secret app-vault-token -o jsonpath='{.data.token}' | base64 -d | head -c 8 ; echo '…'
```

---

## A2.3 — Verification (positive checks — do NOT assume)

Because failures are silent (`null`), verify each path explicitly **before** §7:

```bash
# 1) vault-interface reachable from a core pod
kubectl -n <tenant> exec deploy/<tenant>-service-transactional -- \
  sh -c 'curl -s -o /dev/null -w "%{http_code}" $VAULT_API' ; echo

# 2) encrypt round-trip with the user-password transit key (should return a vault:v1:... ciphertext, not null)
kubectl -n <tenant> exec deploy/<tenant>-service-transactional -- sh -c \
  'curl -s -X POST "$VAULT_API"encrypt -H "transit-key: tenantId123" -H "Content-Type: application/json" \
        -d "{\"password\":\"test123\"}"' ; echo
```
- (1) must be a 2xx/healthy code.
- (2) must return JSON containing an encrypted value (`vault:v1:…`), **not** empty/null. If null → the transit key `tenantId123` is missing (Step 2).

**Then** the real proof: run §7 `createUser`, and check `users.password` starts with `vault:` (the §7.6 gate already does this). If it's null/plaintext, Vault transit is misconfigured — fix before proceeding.

---

## A2.4 — Where this slots into the order of operations

```
Part A (infra) ─ deploy vault-interface + app-vault-token secret
   │
   ▼
Part A2 (THIS) ─ enable transit engine, create transit keys (tenantId123 + transit.key),
   │             encrypt+store MQ creds, populate KV (license), VERIFY round-trip
   ▼
L0 … §6 (schema/reference/maps/tenant/flags)   ← do not require user-password vault
   │
   ▼
§7 createUser  ← REQUIRES A2.1.1 (password transit key). Verify A2.3 first.
§8 jobs/queues ← REQUIRE A2.1.2 (MQ creds decrypt) for async work to flow.
```

> The schema/reference/tenant/flag layers (L0–§6) don't touch the password/MQ transit paths, so you can seed them before Vault is perfect. But **§7 and any async/queue behaviour are hard-blocked on A2** — so finish A2 before you create the admin user or expect billing/invoicing handoffs to run.

---

## A2.5 — Honest caveats / things to confirm in YOUR build

- **`tenantId123` is hardcoded with a TODO** (`// we need to set unique token for each tenant`). If a later commit made it per-tenant (e.g. read from `config_tenant_token_data` or a property), the transit-key name changes — **grep `tenantToken`/`transitKey` in your branch and create whatever name it actually uses.** This is the single most likely thing to differ.
- **`transit.key` property source** — confirm where it's set (Helm env / Spring config) per tenant; create that exact key name.
- **Shared vs per-tenant Vault** — if tenants share a Vault, a shared `tenantId123` transit key means all tenants' passwords are encrypted with the same key (a security consideration, and the reason for the TODO). For real multi-tenant isolation, push to fix the hardcoding so each tenant gets its own key — note this for the dev team as a provisioning-hardening item.
- **`vault-interface` image/config** — its own auth to Vault (the `app-vault-token`) must have policy to use `transit/encrypt`, `transit/decrypt`, and read the KV path. If the token's policy is too narrow, round-trips return null even though keys exist.

---

## A2.6 — What A2 produced
The tenant's Vault now has the transit keys + stored secrets the running code expects, verified by a positive encrypt round-trip. §7 `createUser` will produce a real `vault:` password, and §8 queue publishing can authenticate to the MQ broker. **This closes the highest-severity silent-failure gap in the whole process.**
