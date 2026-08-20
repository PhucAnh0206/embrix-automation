# JASEC — How to Run the Automated Tests

Step-by-step guide for running the JASEC (Energía Prepago) Playwright suites on **jasec-dev**.

Owner: Anh Tran. Complements `docs/EMBRIX_AUTO_GUIDE.md` (which covers the CoopeG / platform suites, not JASEC).

---

## 0. Read this first — shared-environment rules

The JASEC suites are **not** read-only. Before you run anything:

| Rule | Why |
|------|-----|
| **Every JASEC test resets the tenant CCP clock to `2026-07-15`** | An auto-fixture (`jasecCcpBaseline` in `fixtures/jasec-fixtures.ts`) does this before *each* test so tests don't inherit each other's dates. The CCP clock is **tenant-global and shared** — if a colleague is mid-way through a billing or notification run, your test run moves the date under them. Announce in the team channel before a full run. |
| **TS-03 moves the clock across months** (3.2, 3.5, 3.6 → `2026-08-05`) | Same shared-clock concern, bigger jump. |
| **Tests create accounts, orders and meters, and never clean up** | Each run leaves new `TEST_ID-001-<suffix>` accounts on jasec-dev. That is by design (evidence trail), but the tenant grows. |
| **Do not raise `workers` or enable `fullyParallel`** | `playwright.config.ts` pins `workers: 1` / `fullyParallel: false`. Embrix tests share account, billing-cycle and clock state — parallel runs corrupt each other. |
| **jasec-dev only** | Never point these at a production tenant. |

---

## 1. Prerequisites

- **Node.js 18+** — check with `node -v` (20 or 22 LTS recommended).
- **Git**.
- **Embrix Core UI account on jasec-dev** — the same username/password you use at `https://core-ui.jasec-dev.embrix.org/`. The suite logs in with it on both Core UI and Self Care.
- **AWS VPN** — only needed for **TC 3.2** (the one test that seeds debt directly in the DB). Everything else runs over the public HTTPS UIs without VPN.
- No DBeaver or Postman needed to run the tests.

Environments the suite talks to:

| Surface | URL |
|---------|-----|
| Core UI | `https://core-ui.jasec-dev.embrix.org/` |
| Self Care | `https://selfcare-ui.jasec-dev.embrix.org/` |
| GraphQL | `https://service-transactional.jasec-dev.embrix.org/graphql` |
| DB | `coredb-jasec-dev` (SSL + VPN, TC 3.2 only) |

---

## 2. Get the code

Run from **`new_main`**. Note the repo's default branch on clone is `main`, which does **not** have the JASEC suites — you have to check `new_main` out explicitly.

First time (fresh clone):

```
git clone https://github.com/alkadhuri-gif/embrix_auto_test.git; cd embrix_auto_test; git checkout new_main
```

Already have the repo:

```
git fetch origin; git checkout new_main; git pull origin new_main
```

`anh-tran/jasec` is the development branch — new JASEC work lands there first and is merged into `new_main` once it's stable. You only need it if you're picking up work in progress. The notification suite (JEPYP-230) is still on that branch and **not** published yet, so it isn't in `new_main` and isn't covered by this guide.

Confirm you are on the right branch and the JASEC files are there:

```
git rev-parse --abbrev-ref HEAD; ls tests/regression/jasec tests/regression/jasec/top-up
```

You should see `ts-01-prepaid-account-creation.spec.ts` plus the three `top-up/ts-0*.spec.ts` files.

---

## 3. Install

```
npm install
```

That also downloads the Chromium build Playwright uses (`postinstall` runs `playwright install`). If Chromium goes missing later, run `npx playwright install chromium`.

---

## 4. Configure `.env`

The branch already ships a `.env` (it is tracked in this repo). Open it and confirm these values before your first run:

```
TEST_ENV=jasec-dev
EMBRIX_BASE_URL=https://core-ui.jasec-dev.embrix.org/
SELFCARE_BASE_URL=https://selfcare-ui.jasec-dev.embrix.org/
EMBRIX_USER=<your Core UI username>
EMBRIX_PASSWORD=<your Core UI password>
```

`EMBRIX_BASE_URL` **overrides** `TEST_ENV`. If the two disagree, the URL wins — that has caused cross-tenant runs before. When in doubt, set both.

Only needed for **TC 3.2** — skip if you are not running it, otherwise the test fails with a clear `DbHelper` error:

```
DB_HOST=<jasec-dev RDS host>
DB_PORT=5432
DB_NAME=coredb-jasec-dev
DB_USER=<db user>
DB_PASSWORD=<db password>
DB_SSL=require
```

Optional flags:

| Var | Default | Use |
|-----|---------|-----|
| `TOPUP_RECEIPTS_ENABLED` | `true` | Set to `false` if the Self Care `topupReceiptsEnabled` feature flag is OFF on your environment. TC 2.6–2.10 then **skip** with a reason instead of failing on a missing Receipt column — which reads like a product defect but isn't. |
| `CLEAN_LOGS_ON_START` | `true` | Wipes `test-results/logs/` before each run. |
| `SLOW_MO` | unset | Milliseconds to slow each action down — handy with `--headed`. |

`.env.example` is the reference template if you want to build your own from scratch.

⚠️ This GitHub repo is **public**. Do not add any new secret to `.env`, `.env.example` or any other committed file.

---

## 5. Run the tests

All commands run from the repo root. Playwright logs in once (the `setup` project) and reuses the session — you do not need to run setup separately, it is a declared dependency of both JASEC projects.

### 5.1 Everything JASEC (22 tests)

```
npx playwright test --project=jasec-regression --project=jasec-top-up
```

### 5.2 One project at a time

```
npx playwright test --project=jasec-regression
```

```
npx playwright test --project=jasec-top-up
```

### 5.3 One spec file

```
npx playwright test --project=jasec-top-up tests/regression/jasec/top-up/ts-02-topup.spec.ts
```

### 5.4 One specific test case

Match on the case number in the test title (`--grep` is a regex, so escape the dot):

```
npx playwright test --project=jasec-top-up --grep "2\.2:"
```

```
npx playwright test --project=jasec-top-up --grep "3\.4:"
```

### 5.5 By tag

Every case carries a `@tc-<suite>-<case>` tag:

```
npx playwright test --project=jasec-top-up --grep "@tc-2-5"
```

Whole-suite tags: `@ts-01` (prepaid account creation), `@ts-topup-01` (card management), `@ts-02` (top-up), `@ts-03` (min amount).

Note `--grep "@tc-2-3"` also matches `@tc-2-3a` and `@tc-2-3b`. Use the full tag when you want just one.

### 5.6 Watch it happen (headed) / debug

```
npx playwright test --project=jasec-top-up --grep "2\.2:" --headed
```

```
npx playwright test --project=jasec-top-up --ui
```

UI mode is the easiest way to pick single cases, re-run them, and step through with a DOM snapshot per action.

### 5.7 Just refresh the login session

```
npx playwright test --project=setup
```

Writes `playwright/.auth/user.json`. Run it if you start seeing login failures across the board.

### 5.8 Report

```
npx playwright show-report
```

Or `npm run report`. Artefacts:

| Path | Contents |
|------|----------|
| `playwright-report/` | HTML report — open this first |
| `test-results/` | Trace, screenshot and video for every failure |
| `test-results/logs/` | Per-test step log |
| `test-results/junit.xml` | JUnit XML for CI |

Failures keep a trace: `npx playwright show-trace test-results/<folder>/trace.zip`.

---

## 6. What each suite covers

### `jasec-regression` — 1 test

| Case | Title | Notes |
|------|-------|-------|
| TS-01 (`@tc-c01`) | Prepaid Account Creation (Energía Prepago) | Creates the residential prepaid account, raises a NEW order, adds bundle `B-100000-E`, attaches the meter's provisioning data, submits, and asserts the order reaches COMPLETED. **Needs the tenant's ELECTRICITY provisioning type configured** — without it the "View Provisioning Data" modal never opens. No teardown. |

This is the setup path the top-up suites reuse internally, so if it fails, expect the others to fail too.

### `jasec-top-up` — 21 tests

**TS-01 — Manage Credit Card** (4). Each test creates its own fresh account.

| Case | Title |
|------|-------|
| 1.1 | Save a valid test card via PlaceToPay tokenization |
| 1.2 | Abandon PlaceToPay session — no card saved |
| 1.3 | Declined card submission — no card saved |
| 1.4 | Delete a previously saved card |

**TS-02 — Top-Up** (11).

| Case | Title |
|------|-------|
| 2.1 | Top-Up history table only shows current-period entries |
| 2.2 | Top Up using Pay Now with a saved card |
| 2.3a | Pay with PlaceToPay — APPROVE card |
| 2.3b | Pay with PlaceToPay — DECLINE card, no top-up recorded |
| 2.4 | Rapid double-click Pay Now — frontend idempotency |
| 2.5 | Duplicate transaction blocked — same-reference backend idempotency |
| 2.6 | Receipt column visible when the feature flag is on |
| 2.7 | Receipt column header localized (Receipt / Recibo) |
| 2.8 | View / Download Receipt opens PDF in a new tab |
| 2.9 | Re-clicking Receipt returns the same cached PDF |
| 2.10 | Receipt PDF contains required fields |

2.2, 2.3a, 2.6, 2.7 and 2.8 share **one** account: whichever runs first creates it (~4 min), the rest attach to it (~20 sec each). Running any of them alone still works — the helper bootstraps the account on demand, so a single-case run pays the full ~4 min.

2.6–2.10 need `topupReceiptsEnabled` ON in Self Care — see `TOPUP_RECEIPTS_ENABLED` in section 4.

**TS-03 — Minimum Amount business logic** (6). Expected values derive from `MIN_AMOUNT_BASE` in the spec: base **2920** CRC in the account's first effective month, **3300** CRC from the second month on. Displayed value = `MAX(0, base − credit + debt)`; the section hides at ≤ 0. Balance uses the inverted CRC sign — positive = debt, negative = credit.

| Case | Title | Extra needs |
|------|-------|-------------|
| 3.1 | Min Amount visible mid-month when value > 0 | — |
| 3.2 | Account in debt — month A 3420, month B 3800 | **DB + VPN** (debt is seeded directly; JASEC only produces a positive CRC balance through kWh consumption) |
| 3.3 | Partial credit — top up 1000 → Min 1920 | — |
| 3.4 | Fully covered — top up 5000 → box hidden | — |
| 3.5 | Cross-month base flip 2920 → 3300, no top-up | Moves clock to month B |
| 3.6 | Cross-month base flip with credit carried over | Moves clock to month B |

If either regulated base changes, update `MIN_AMOUNT_BASE` in `ts-03-min-amount.spec.ts` — every expected value derives from it.

---

## 7. Timing

Account creation dominates the runtime: each account-creating test spends roughly **4–5 minutes** in the Core UI order flow, and `workers: 1` means nothing overlaps. Per-test timeout is 10 minutes.

Rough budget — measure on your own first run:

| Command | Order of magnitude |
|---------|--------------------|
| A single case that creates its own account | ~5 min |
| A single case attaching to the shared account (2.2 / 2.3a / 2.6 / 2.7 / 2.8, after the first) | ~1 min |
| `--project=jasec-regression` | ~5 min |
| `--project=jasec-top-up` | ~1–1.5 h |
| Everything | ~1.5 h |

Start with one case, not the full suite.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Every test fails at login; app bounces back to `/login` | SPA hydration race — the auth token is dropped if the form is filled before Apollo wires up | Already handled in `auth.setup.ts` (`networkidle` wait). If it still happens, re-run `--project=setup` and check the environment is actually up. |
| `EMBRIX_USER and EMBRIX_PASSWORD must be set` | `.env` missing or not filled | Section 4. |
| `DbHelper` connection error on TC 3.2 | `DB_*` not filled, or VPN down | Fill `DB_*`, connect the VPN, or skip 3.2. |
| TS-01 stalls — "View Provisioning Data" modal never opens | Tenant's ELECTRICITY provisioning type not configured | Environment config issue, not a test bug. Raise it before re-running. |
| TC 2.6–2.10 fail on a missing Receipt column | Feature flag off | Set `TOPUP_RECEIPTS_ENABLED=false` — they will skip with a reason. |
| Account creation fails "not effective until future" | CCP clock parked in the future by an earlier run | The `jasecCcpBaseline` fixture normally handles this. Check the current clock before blaming the test. |
| PlaceToPay page times out | Third-party sandbox slow or down | Re-run the single case, confirm with `--headed` before filing anything. |
| Tests interfere with each other, or dates look wrong | Parallelism, or a colleague moving the clock | Keep `workers: 1`; check the team channel. |
| Wrong tenant got the test accounts | `EMBRIX_BASE_URL` disagreeing with `TEST_ENV` | Section 4 — the URL wins. |

Before filing a defect: re-run the single case with `--headed`, keep the trace, and check the HTML report. Note that **cent-level proration and rounding deltas are documented Embrix behaviour**, not defects.

---

## 9. Adding a case

Conventions live in `docs/PLAYWRIGHT_CONVENTIONS.md`. In short: page objects under `pages/`, shared setup in `fixtures/create-prepaid-account.helper.ts`, JASEC fixtures in `fixtures/jasec-fixtures.ts`, data in `test-data/jasec-prepaid-accounts.data.json`. Tag every test `@tc-<suite>-<case>` so it can be run on its own. New spec files under `tests/regression/jasec/` are picked up by `jasec-regression`; under `tests/regression/jasec/top-up/` by `jasec-top-up`.
