# Part B · §8 — Supporting operational config (OMS, jobs, collections, calendar, correspondence, templates, singletons)

> §3–§7 seed the *structural* tenant (reference data, maps, tenant/merchants, flags, users). But a tenant that can't run its daily jobs, doesn't number its invoices, has no dunning ladder, and renders no documents is not actually operable. §8 fills that **operational** layer — the config that makes the order-to-cash machine *run on a schedule*, not just exist.
>
> Every script here is built from the **real golden (Coope) rows** you extracted (so enum values + shapes are accurate), then generalized + parameterized. All are idempotent (`ON CONFLICT DO NOTHING`) and atomic (`BEGIN/COMMIT`). This section closes the §9 gap identified in `DOMAIN-FLOWS.md`.
>
> **Run order within §8:** `05-bootstrap-singletons.sql` first (other layers depend on the invoice sequence + clock), then `30`/`31`/`32`/`34`/`35` in any order, but **after** users (§7) since jobs/collections reference a userid.

---

## 8.0 — Why these six, and what breaks without them

| Script | Seeds | If missing… |
|--------|-------|-------------|
| `05-bootstrap-singletons.sql` | `ccp_time`, `custom_db_sequence`(+object), `config_tenant_token_data`(+list), `work_week_config`, `time_unit_config`, `holiday_special_config` | **Invoices can't get a number** (no `INVOICE_DB_SEQ`); auth-token issuance has no expiry config; business-day math (collections/payment-working-day) has no calendar; simulated clock undefined |
| `30-oms-tasks.sql` | `config_oms` + `config_oms_tasks` (6 order types) | Orders have **no task pipeline** → an order can't progress NEW→ACTIVE |
| `31-jobs.sql` | `config_job` (DAILY) + `config_job_list` (8 core jobs) | **Nothing runs automatically** — no cycle close, no `BILL_CHECK`/`INVOICE_CHECK`, no dunning |
| `32-collections.sql` | `config_collection_*` ladder + `account_collection_profile_map` + `config_payment_allocation` | Overdue accounts get no dunning; payments may not allocate |
| `34-correspondence.sql` | `correspondence_template`(+list) | Notifications (the `*Notification` flags in §6) have **no template** → emails/SMS fail to render |
| `35-invoice-template.sql` | `template` + `template_files` | With `generateInvoicePdf=true`, invoice/credit-note PDF render **fails** (no stylesheet resolves) |

---

## 8.1 — `05-bootstrap-singletons.sql` (the easy-to-miss essentials)

These are single-row ("singleton") config objects keyed by fixed ids. From your golden dump:

- **`ccp_time`** — one column `ccptime DATE`. Golden = `2027-03-09` (a **future simulated date** — sandbox runs the clock ahead to test future-dated billing). The DB function `getccptime()` falls back to `CURRENT_DATE` if empty, so it's not a hard crash, but `useCcpTime=true` (§6 sandbox) expects a row. **Production:** set `useCcpTime=false` and seed `ccptime=CURRENT_DATE` (or leave fallback). Param `sim_date` = `CURRENT` or a literal date.
- **`custom_db_sequence` + `custom_db_sequence_object`** — the **invoice-number generator**. Golden: `objecttype=INVOICE_DB_SEQ`, `sequenceseed=1`, `minimumlength=6`. This is genuinely load-bearing — invoicing looks up `INVOICE_DB_SEQ` to stamp invoice numbers. The template seeds one with no prefix; set `inv_prefix` if the tenant wants e.g. `ACME000001`.
- **`config_tenant_token_data` + list** — JWT auth-token expiry. Golden: `authtype=JSON_WEB_TOKEN`, `expirytime=15552000000` (180 days in ms). Used when SSO/`generate-token` issues tokens.
- **`work_week_config`** — golden Coope = MON–THU (their work week); generic default **MON–FRI**. Drives "next working day" in collections + payment working-day.
- **`time_unit_config`** — `usestarttime=true` (mirrors the `useUsageStartTime` flag).
- **`holiday_special_config`** — non-working days for date math. Minimal seeds New Year only; **add the tenant's national holidays per year** (these are country-specific — Coope's are Costa Rican).

> All six share simple shapes; the script is safe to re-run. The invoice sequence is the one people forget — call it out in review.

---

## 8.2 — `30-oms-tasks.sql` (the order task pipeline)

Your golden dump revealed a beautifully uniform, generic pattern: **all 6 order types** (`NEW, MODIFY, CANCEL, SUSPEND, RESUME, RELOCATION`) run exactly two tasks — `PROVISION_ORDER` (index 1) then `BILL_ORDER` (index 2), both `AUTOMATIC`. That uniformity is why this is safe to ship generically.

- **For a no-provisioning tenant:** `PROVISION_ORDER` runs but, with `provisioningEnabled=false` (§6) and no provision-gateway, it's a pass-through — the order advances to `BILL_ORDER` without a network round-trip. 🔎 *Verify on the first `NEW` order* that it reaches `ACTIVE`; if `PROVISION_ORDER` blocks when provisioning is off, drop the index-1 row for that order type (the script is structured so you can).
- `task` values are `core_enums.oms_tasks`; `taskexecutiontype=AUTOMATIC` (vs MANUAL, where an operator must advance the order — e.g. the Coope ISP "wait for NOC serial number" flow uses a manual task; the generic template stays AUTOMATIC).

---

## 8.3 — `31-jobs.sql` (the daily heartbeat)

One `DAILY` schedule running the 8 core order-to-cash jobs from golden, in order: `CANCEL_SUBSCRIPTION, FUTURE_CANCEL, FUTURE_PURCHASE, COLLECTION_ACTIONS, BILL_CHECK, INVOICE_CHECK, COLLECTION_CREATE, CRDR_NOTES`.

- `BILL_CHECK` → triggers cycle billing; `INVOICE_CHECK` → generates invoices; `COLLECTION_CREATE`/`COLLECTION_ACTIONS` → dunning; `CRDR_NOTES` → credit/debit notes; `FUTURE_*` → scheduled future orders.
- `jobname` ∈ `core_enums.job_type` (58 values). These 8 are the minimal must-run set; the platform offers many more (revenue extract, finance sync, reminders) — add per requirement.
- **`userid`** must be a real SYSTEM user — wire it to the §7 bootstrap admin (`job_user` param). That's why §7 runs before §8.
- **Timezone:** the schedule window is platform-side; the tenant's `TZ` (Helm env) decides when "daily" fires. 🔎 Ensure `BILL_CHECK`/`INVOICE_CHECK` land *after* cycle close in the tenant's timezone.

> The golden also had a prepaid-specific schedule (`CJ-47228` "Prepaid Suspend Subscription"); deliberately excluded from the generic template (prepaid is a requirement, not a default).

---

## 8.4 — `32-collections.sql` (dunning ladder + payment allocation)

A minimal but complete dunning ladder, generalized from golden:

- **Actions catalog** (`config_collection_action_list`): `FIRST_REMINDER_EMAIL, SECOND_REMINDER_EMAIL, INACTIVATE_SUBSCRIPTION, NOTIFY_CANCELLATION_TO_CRM`.
- **Schedule** (`config_collection_schedule_list`): day 1 first reminder → day 5 second reminder → day 7 suspend (next-working-day) → day 39 notify CRM. (Coope's exact offsets varied per profile; this is a sane generic ladder — tune to tenant policy.)
- **Profile map** (`account_collection_profile_map`): default + RESIDENTIAL account types → `NORMAL` profile. Golden had several profiles (`NO CORTA`, `ESPECIAL`, `FONATEL_OR_USD`…) — those are Coope policies; generic ships one `NORMAL`.
- **Collection agents**: wired to the §7 admin user.
- **`config_payment_allocation`**: one ACTIVE rule + a default sequence step, so payments allocate to open items (oldest-first default). Golden's `CoopeG_Allocation_Rule` is the model.

> `collection_action` and `collection_action_working_day` are enum-bound — 🔎 confirm the values against `core_enums` before running (the script flags this).

---

## 8.5 — `34-correspondence.sql` (notification templates)

Registers the notification template set keyed by event **type** — the generic order-to-cash set: `PAYMENT_SUCCESS, NEW_SUBSCRIPTION, {FIRST,SECOND,THIRD}_PAYMENT_REMINDER, SUSPEND/RESUME/CANCEL_SUBSCRIPTION, INVOICE_READY, CREDIT_NOTE_READY, COLLECTION_ENTRY, CREDIT_LIMIT_BREACH`. (Golden had 24 incl. prepaid/topup types — those are requirement-specific.)

- **Two-part dependency:** the row stores a `filepath` to an **`.html` file in S3** (`embrix-static-files/<tenant>/template/correspondence/…`). The seed registers the row; **you must upload the actual HTML files** (start from the golden tenant's, re-brand). Without the file, the notification fails to render even though the flag is on.
- `type` is enum-bound (`notification_type` / `notification_template_type`); `messagetype=CUSTOMER`. 🔎 confirm the type set against your build.

---

## 8.6 — `35-invoice-template.sql` (document stylesheets)

Registers catch-all `DEFAULT` XSLT stylesheets for `INVOICE`, `CREDIT_NOTE`, `DEBIT_NOTE`. From golden `TP-100020`, `template_files` is scoped by `type` (+ optional country/LOB/accounttype); the `DEFAULT`-named row per type is the fallback the invoice service uses when no narrower match exists.

- **Same two-part dependency:** rows reference `.xsl` files in S3 that must be uploaded. **Decision point:** either (a) upload a generic stylesheet and ship these rows, or (b) keep `generateInvoicePdf=false` (§6) until the tenant's invoice is designed — then add the rows. With the flag **on** and no resolvable template, PDF generation fails.
- Golden also had `PAYMENT_AGREEMENT`, `PAYMENT_INSTALLMENT_REPORT`, `USAGE_CONSUMPTION_STATEMENT` — add only when those documents are needed.

---

## 8.7 — Verification gate (§8 done)

```sql
SELECT 'S8_GATE' AS gate,
  EXISTS(SELECT 1 FROM core_config.custom_db_sequence_object WHERE objecttype='INVOICE_DB_SEQ')   AS inv_seq_ok,
  (SELECT count(*) FROM core_config.ccp_time)                                                     AS ccp_time_rows,   -- 1
  (SELECT count(DISTINCT id) FROM core_config.config_oms)                                         AS oms_order_types, -- 6
  (SELECT count(*) FROM core_config.config_job_list)                                              AS daily_jobs,      -- 8
  (SELECT count(*) FROM core_config.config_collection_schedule_list)                              AS dunning_steps,   -- 4
  EXISTS(SELECT 1 FROM core_config.config_payment_allocation WHERE status='ACTIVE')               AS pay_alloc_ok,
  (SELECT count(*) FROM core_config.correspondence_template_list)                                 AS notif_templates,
  EXISTS(SELECT 1 FROM core_config.template_files WHERE type='INVOICE' AND status='ACTIVE')       AS invoice_tpl_ok,
  EXISTS(SELECT 1 FROM core_config.work_week_config)                                              AS workweek_ok;
```
**Pass:** `inv_seq_ok` + `pay_alloc_ok` + `workweek_ok` true; `oms_order_types`=6; `daily_jobs`=8; `notif_templates`>0. (`invoice_tpl_ok` may be intentionally false if you chose PDF-off.)

---

## 8.8 — Backout
```sql
BEGIN;
DELETE FROM core_config.config_oms_tasks            WHERE id LIKE :tenant_id||'-OMS-%';
DELETE FROM core_config.config_oms                  WHERE id LIKE :tenant_id||'-OMS-%';
DELETE FROM core_config.config_job_list             WHERE id = :tenant_id||'-JOB-DAILY';
DELETE FROM core_config.config_job                  WHERE id = :tenant_id||'-JOB-DAILY';
DELETE FROM core_config.config_collection_schedule_list WHERE id = :tenant_id||'-COLSCHED';
DELETE FROM core_config.config_collection_schedule  WHERE id = :tenant_id||'-COLSCHED';
DELETE FROM core_config.config_collection_action_list   WHERE id = :tenant_id||'-COLACT';
DELETE FROM core_config.config_collection_actions   WHERE id = :tenant_id||'-COLACT';
DELETE FROM core_config.config_collection_agent_list WHERE id = :tenant_id||'-COLAGENT';
DELETE FROM core_config.config_collection_agent     WHERE id = :tenant_id||'-COLAGENT';
DELETE FROM core_config.account_collection_profile_map WHERE id LIKE :tenant_id||'-PROFILEMAP-%';
DELETE FROM core_config.config_payment_allocation_sequence WHERE id = :tenant_id||'-PAYALLOC';
DELETE FROM core_config.config_payment_allocation   WHERE id = :tenant_id||'-PAYALLOC';
DELETE FROM core_config.correspondence_template_list WHERE id = :tenant_id||'-CORR';
DELETE FROM core_config.correspondence_template     WHERE id = :tenant_id||'-CORR';
DELETE FROM core_config.template_files              WHERE id = :tenant_id||'-TPL';
DELETE FROM core_config.template                    WHERE id = :tenant_id||'-TPL';
DELETE FROM core_config.custom_db_sequence_object   WHERE id = :tenant_id||'-INVSEQ';
DELETE FROM core_config.custom_db_sequence          WHERE id = :tenant_id||'-INVSEQ';
DELETE FROM core_config.config_tenant_token_data_list WHERE id = :tenant_id||'-TOKEN';
DELETE FROM core_config.config_tenant_token_data    WHERE id = :tenant_id||'-TOKEN';
-- ccp_time / work_week_config / time_unit_config / holiday: singletons keyed 'TimeUnitConfig'
-- — only remove on full teardown.
COMMIT;
```

---

## 8.9 — What §8 produced / what remains
The tenant is now **operationally complete**: orders flow through a task pipeline, a daily job set drives billing/invoicing/dunning automatically, invoices get numbered, notifications and documents have templates, and payments allocate. Combined with §2–§7, this is a tenant that can run the **full order→bill→invoice→payment→dunning cycle end-to-end, internally**.

**Two file-delivery to-dos** (not SQL): upload the correspondence `.html` and template `.xsl` files to S3 (§8.5/§8.6) — or keep PDF/those notifications off until designed.

**Still to write (continuing):** the **Vault transit-key setup** (critical boot dependency, folds into Part A) + the **`core_pricing` smoke-catalogue** the verification test needs, then **Part C** (§9 reload+verify, §10 CI/CD, §11 backout) and the **`RUN-ORDER.md`** master runbook.
