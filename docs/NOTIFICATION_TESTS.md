# Notification Tests — JEPYP-230 (TS-01, TS-02, TS-03)

Asserts the content of the emails Embrix sends for JASEC prepaid events, field
by field, against the template specs in JEPYP-230.

Currently covers **JEPYP-49 — Top Up Confirmation**. The remaining templates
(JEPYP-50 low balance, -51 balance ended, -52 reconnection, -53 minimum top-up,
-54 invoice + statement) plug into the same machinery — see
[Adding a template](#adding-a-template).

---

## 1. How it works

1. Creates a fresh prepaid account whose billing contact carries the
   IMAP-monitored address (`setUpAccountInSelfCare`).
2. Triggers the event — for TC 4.1, a Self Care → PlaceToPay top-up of 5000 CRC.
3. Confirms the balance actually moved (`DbHelper.assertTopUpApplied`), so a
   missing email is never mis-blamed on the notification engine.
4. Polls IMAP until the email arrives, matching on the **account id in the
   body**, never on the subject alone. The account id is unique per run, which
   is what stops a re-run asserting against a stale message.
5. Evaluates every check in the template and emits a Jira-ready table.

It reads a **real mailbox**, not a mail catcher. Deliberate: the JEPYP-230 work
was blocked for a week by an SMTP transport defect (no STARTTLS, JavaMail pinned
to TLSv1). A catcher that bypasses the tenant's SMTP server would have reported
green the whole time.

---

## 2. Setup

Add the `NOTIFY_*` block from `.env.example` to your env file.

> `switch-env.ps1` copies `.env.dev` / `.env.preprod` over `.env`, so put these
> in the per-env file you actually use — not only in `.env`, or the next switch
> wipes them.

* **Google Workspace / Gmail** — `imap.gmail.com:993` with an **app password**
  (not the account password). Needs 2FA on the account and app passwords
  permitted by the Workspace admin.
* **Microsoft 365** — Microsoft has disabled basic-auth IMAP. Use a Gmail test
  mailbox, or add an OAuth2 flow. Note this is *us reading* mail; it is
  unrelated to the tenant's own SMTP being Office 365.

Then `npm install` (adds `imapflow` + `mailparser`).

---

## 3. Running

```bash
npm run test:unit                      # helper logic only — no browser, VPN or mailbox
npm run test:notification:jasec        # full end-to-end, needs VPN + DB + IMAP
npm run test:notification:jasec:headed
```

Run `test:unit` first — it takes ~2 s and catches the parsing regressions that
would otherwise look like "the field is missing from the email".

---

## 4. Output

Each run writes a Jira-ready table to
`test-results/notification-reports/<TEMPLATE_KEY>_<accountId>.md`, attaches it to
the HTML report, and prints it to the console:

```
| Field | Expected Value | Pass / Fail |
|---|---|---|
| Subject | Jasec - Servicio Eléctrico Prepago - Recarga | Pass |
| Fecha y Hora | 2026-07-15 HH:mm:ss — actual date AND time | Fail (known) — got "2026-07-15 00:00:00" |
```

The received HTML is attached to the report too, as evidence.

---

## 5. Known defects

A check carrying `knownDefect` is still evaluated and still reported as **Fail**,
but the spec does not assert it — so the suite stays usable as a regression gate
while defects are open.

**Delete the `knownDefect` property when the fix lands** and the check becomes
blocking again. If a known-defect check starts passing, the log says so
explicitly so the marker does not linger.

Currently marked on `Fecha y Hora` (JEPYP-49 — renders `00:00:00`, identical
across two separate top-ups minutes apart, so it is not the real transaction
time).

Two things the automation deliberately does **not** settle:

* **`Saldo Actual`** is compared as an absolute value, because JASEC stores
  credit as a negative balance and the email renders it unsigned. The
  sign-convention defect only shows on a **debt** balance, which the happy path
  never produces — it needs a dedicated debt-scenario spec.
* **`Saldo kWh Aproximados`** asserts the code matches the formula dev confirmed
  (`floor(balance ÷ 123.067)`). It does **not** validate that formula against the
  T-RP tariff, where ₡123.067/kWh sits 37% above the ₡89.903 maximum legal kWh
  price. That is a spec question; no test can answer it.

---

## 6. Adding a template

1. Copy `test-data/notifications/topup-confirmation.template.ts`; adjust `key`,
   `ticket`, `subject` and the `checks` array.
2. Add a test in `tests/regression/jasec/notification/` that triggers the event,
   waits via `emailHelper.waitForEmail()`, then calls
   `reportHelper.evaluateAll(yourTemplate, ctx)` and asserts the results.
3. If the template needs data the context does not carry, add optional fields to
   `NotificationContext` in `test-data/notifications/types.ts`.

`EmailHelper`, `NotificationReportHelper` and the report format are
template-agnostic and need no changes.

---

## 7. Key files

| File | Purpose |
|---|---|
| `helpers/email.helper.ts` | IMAP client, HTML→text, entity decoding, CRC/kWh formatting |
| `helpers/notification-report.helper.ts` | Evaluates checks, builds the Jira table. No Playwright imports (conventions §6.1) — the spec owns the assertions |
| `test-data/notifications/types.ts` | `NotificationTemplate` / `FieldCheck` / `NotificationContext` |
| `test-data/notifications/topup-confirmation.template.ts` | JEPYP-49 field expectations |
| `tests/regression/jasec/notification/ts-01-topup-confirmation.spec.ts` | TC 4.1 |
| `tests/unit/email-parsing.spec.ts` | Helper unit tests (`unit` project, no browser) |

---

## 8. Gotchas

* **Match on body content, not subject.** Every notification for a tenant shares
  a subject line; only the account id makes a message unique to a run.
* **Spam folder.** `NOTIFY_SEARCH_FOLDERS` includes it by default. A policy
  change that reroutes JASEC mail to Spam is otherwise indistinguishable from a
  delivery failure.
* **Silent skip.** Embrix skips the send entirely when no template row is mapped
  to the event type + account category — no error is raised. A timeout here
  usually means missing config, not a broken mail server. The timeout message
  lists this explicitly.
* **CCP time.** The `jasecCcpBaseline` auto-fixture resets CCP to
  `JASEC_CCP_BASELINE` before every JASEC test. The spec reads it back rather
  than hardcoding, so the date assertion follows the baseline if it changes.
* **`EXPECTED_PAYMENT_SOURCE`** in the template is `CREDIT_CARD`, observed on a
  Self Care card top-up. The JASEC payment application and POS-API are expected
  to send different values — one constant at the top of the template file.

---

# The three suites

JEPYP-230 is covered by three independent Playwright projects. **Each runs on its
own** — no shared fixtures, no ordering requirement, no manual setup between them.
Pick by what you need and what you are willing to spend.

| Project | Needs | Touches the environment? | Covers |
|---|---|---|---|
| `unit` | nothing | no | band arithmetic, amount parsing, month names |
| `jasec-notification-content` | VPN + `DB_*` | **no** — read only | rendered body of all 9 templates |
| `jasec-notification-live` | VPN + `DB_*` + `EMBRIX_USER/PASSWORD` | **yes, irreversibly** | triggers and asserts events 1, 3, 4, 5, 7 |
| `jasec-notification` (TS-01) | + browser, IMAP, `NOTIFY_*` | creates an account | event 2 end-to-end incl. delivery |

```bash
npm run test:unit                  # instant, offline
npm run test:notification:content  # ~35s, safe to run any time
npm run test:notification:live     # ~3min, CONSUMES a schedule slot
npm run test:notification:all      # unit -> live -> content
```

## Which one to reach for

**Changed a template?** `test:notification:content`. It replays bodies already in
`core_engine.email_notification`, so it needs no billing run, no schedule slot and
no clock move. This is the everyday regression gate.

**Changed billing, pricing or the notification trigger logic?**
`test:notification:live`. It is the only suite that proves the right event fires
for a given balance, and the only one that can assert amounts against the
formulas.

**On a fresh tenant with no notification history?** `live` first — `content` has
nothing to replay and will skip every template. That is the one ordering
dependency, and it is a property of the data, not the code.

## Why content assertions come from the database

`email_notification.content` holds the full rendered HTML, written **before** the
SMTP send, so the body survives a delivery failure. SMTP on this tenant loses
~5% of sends at `batchSizeBilling=60` (4.7% and 5.2% measured on two independent
runs) — asserting bodies over IMAP would fail roughly a third of multi-account
runs for reasons unrelated to the templates. IMAP is used only for what the
database cannot answer: that mail was actually delivered, and what was attached.

## The live-run gate

`jasec-notification-live` moves the tenant-global CCP clock and spends one of the
two `job_schedule` slots on its target date. It therefore runs **only** when the
project is named:

```bash
npm run test:notification:live          # runs
npx playwright test                     # skips all 6 — verified
npx playwright test tests/.../notification-live/   # skips: path != project name
```

Detection lives in `playwright.config.ts`, not in the spec. A spec executes in a
worker process whose `process.argv` carries no `--project`, so gating inside the
spec silently skipped the suite even when it was explicitly requested.

## What the live run costs, every time

- **The CCP clock moves forward** to the chosen date. Fine on dev/preprod (the
  clock can be set either way there) but it is shared, so it disrupts anyone
  mid-test.
- **One schedule slot is spent.** `job_schedule` is `UNIQUE(schedulefrequency,
  scheduledate)` and only `DAILY`/`SCHEDULED` exist — two slots per date, and a
  spent slot must be deleted (children first) to reuse the date.
- **Every account on that date is billed**, not just the seven staged. 76 on the
  2026-12-09 run. `BILL_CHECK` selects on `required_scheduledate`; nothing in the
  spec can narrow it.
- Balances and staged kWh rows **are restored automatically** in `afterAll`, so a
  mid-run failure no longer leaves the environment dirty.
  `test-results/jepyp230-restore.json` is written before any write, as the
  fallback record.

## Switching environment

Change `.env` only. Nothing in `helpers/` or `test-data/` is environment-specific.

```
DB_HOST / DB_NAME / DB_USER / DB_PASSWORD    connection
EMBRIX_GRAPHQL_URL                            API (proxy URL is derived from it)
NOTIFY_EMAIL_TO                               which accounts the run may use
JASEC_PRICE_OFFER_ID                          drives X (minimumtopupamount)
JASEC_THRESHOLD_BASE / _HIGH                  event 3 balance thresholds
JASEC_CYCLE_CHARGE                            fallback C when unmeasurable
```

Verify `JASEC_PRICE_OFFER_ID` per tenant — a wrong id does not error, it returns a
different X and silently shifts every balance band.

`jasec-preprod` is absent from the URL map in `playwright.config.ts`, so
`.env.preprod` **must** set `EMBRIX_GRAPHQL_URL` or it falls back to CoopeG.

## Undocumented constraints this suite encodes

Each of these costs a billing run to rediscover by hand:

| Constraint | Consequence if ignored |
|---|---|
| `job_schedule_list.name` is unique **table-wide** | second run fails with a duplicate-key error |
| `job_schedule` is `UNIQUE(schedulefrequency, scheduledate)` | only two runs per date, ever |
| `createddate` is **CCP-stamped**, not wall time | "last N minutes" matches every future-dated row; scope by the id watermark instead |
| C must come from the most recent **non-zero** invoice | an in-debt account is invoiced 0.00, collapsing every derived band |
| Runbook's `get_usage_po_by_account_id()` does not exist | the runbook's X query errors out |
| Runbook's `core_engine.object_file` does not exist | invoice files are at `invoice_unit.filepath`; `invoicebase64pdf` is NULL |
| `<title>` is not the email subject | subject comes from `correspondence_template_list.emailsubject`; they differ on BALANCE_TOPUP |

## Not covered

- **Section 8** (client rendering, dark mode) — inherently manual.
- **Report cases 7.2 / 7.4** (PDF field content) — skeleton is in place at
  `step 4b` and self-detects: while stamping is on, generation yields a ~15-byte
  stub, so content assertions are deferred rather than failed. When stamping goes
  off it starts asserting with no code change.
- **Sections 4 and 5** — blocked upstream: an account staged to cross its credit
  limit produces no invoice and no notification at all (reproduced on ACT-100189
  and ACT-100217, two separate runs).
