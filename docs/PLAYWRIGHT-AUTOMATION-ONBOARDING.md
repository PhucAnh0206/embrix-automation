# Playwright automation onboarding

The onboarding guide to our Playwright test automation. It covers every environment ("tenant") this repo tests. The first part is common to all of them. After that, each tenant has its own
part, with everything you need to run its cases.

When you finish, you will be able to:

- set up your device once, for any tenant
- run **one case**, **one functionality** or **everything** on a tenant, in the right order
- **watch a case run step by step** in Playwright's visual UI, to learn how the business flow works
- read the results and tell apart a real failure, a missing precondition and a case that needs a switch

---

## Contents

**Common to every tenant**

1. [What we test, and the tenants](#part-1--what-we-test-and-the-tenants)
2. [Playwright, in 10 minutes](#part-2--playwright-in-10-minutes)
3. [Set up your device (once)](#part-3--set-up-your-device-once)
4. [Choosing what runs](#part-4--choosing-what-runs)
5. [Watch a case in the visual UI](#part-5--watch-a-case-in-the-visual-ui)

**One part per tenant**

6. [JASEC dev and preprod](#part-6--jasec-dev-and-preprod)
7. [JASEC dev on OCI](#part-7--jasec-dev-on-oci)
8. [CoopeG NetSuite (coopegsbx2)](#part-8--coopeg-netsuite-coopegsbx2)
9. [Embrix platform on Congero (OCI)](#part-9--embrix-platform-on-congero-oci)

**Afterwards**

10. [Reading results and fixing common problems](#part-10--reading-results-and-fixing-common-problems)
11. [Cheat sheet](#part-11--cheat-sheet)
12. [Rules](#part-12--rules)

---

## Part 1 — What we test, and the tenants

**Embrix** is a billing platform. Companies use it to sell a service, charge customers for it and collect the money.
Each company (or copy of the system) using Embrix is a **tenant**. Each tenant has its own web screens, database and
settings, and **its own settings file in this repo**.

### The tenants

| Part | Tenant | Client and service | What the tests cover | Settings file | `TEST_ENV` |
|---|---|---|---|---|---|
| 6 | **JASEC dev** | JASEC, a Costa Rican electricity company: **prepaid electricity** | the full prepaid flow: customers, top-ups, meter readings, cuts, e-mails, billing, accounting | `.env.dev` | `jasec-dev` |
| 6 | **JASEC preprod** | same as dev. **The main test environment.** | same as dev | `.env.preprod` | `jasec-preprod` |
| 7 | **JASEC dev on OCI** | JASEC dev, moved to Oracle Cloud (OCI) | same JASEC cases, a few routes differ | `.env.oci-dev` | `jasec-oci-dev` |
| 8 | **coopegsbx2** | CoopeGuanacaste (CoopeG), internet service, connected to **Oracle NetSuite** (their accounting system) | invoices, customers, payments and credit notes reaching NetSuite | `.env.coopegsbx2` | `coopegsbx2` |
| 9 | **congero-oci** | Embrix's own platform tenant, on OCI | the general Embrix platform regression (customers, orders, billing, invoices) | `.env.congero-oci` | `congero-oci` |

The tenant you pick decides **which tests exist**. Playwright only offers the projects that belong to the active
tenant, so a JASEC project shows **0 tests** while you are on coopegsbx2, and the other way round.

### The screens you will see

| Screen | Who uses it | What for |
|---|---|---|
| **Core UI** | the client's staff (we call them *agents*) | create customers, orders, view balances, invoices, bills, run billing. Organised into "hubs": Customer, Billing, Operations, Pricing… Every tenant has one. |
| **Self Care** | the end customer | log in, see the balance, **top up** (JASEC) |
| **PlaceToPay** | payment provider (JASEC) | the card-payment page Self Care sends the customer to. In test it takes test cards and moves no real money. |
| **NetSuite** | CoopeG's accounting (coopegsbx2) | where invoices and payments must arrive. The tests only **look**, never change anything there. |

### Words you will meet everywhere

| Word | Meaning |
|---|---|
| **Account / customer** | one customer of the client. Test customers are named `E2E…` or `QA…`, and JASEC test meters `M-QA…`. |
| **Order** | what creates or changes a customer's service (new service, suspend, resume, cancel). |
| **Balance** | the customer's money position, in colones (₡). For JASEC it is prepaid credit. |
| **The clock** | each tenant runs on its own **simulated date**, not today's date, so tests can jump to a billing day. The clock is **shared by everyone on that tenant**. |
| **Billing run / Daily Schedule** | the job that makes invoices for every customer whose billing day it is. Started from Core UI → Operations → **Daily Schedule**. |
| **Invoice** | the monthly bill. |

---

## Part 2 — Playwright, in 10 minutes

**Playwright** is a tool that drives a real web browser from code: it opens pages, clicks, types and checks what is on
the screen, like a person would, but repeatably. Our tests are written in **TypeScript** (JavaScript with types). You
don't need to write code to *run* tests, but these terms make the rest of this guide make sense.

### The terms

| Term | What it is | In our repo |
|---|---|---|
| **Spec file** | a file of tests, name ends in `.spec.ts` | `tests/regression/jasec/top-up/ts-02-topup.spec.ts` |
| **Test** | one scenario: a name plus a list of actions and checks | `test('2.3a: Top Up using Pay with PlaceToPay — APPROVE card', …)` |
| **describe** | a group of tests inside one file | `test.describe('TS-02 Top-up', …)` |
| **Step** | a named part of a test, shown as a heading in the reports | `test.step('ACTIVE subscription', …)` |
| **Locator** | how the test finds something on the page ("the button called *Pay*") | inside the page objects |
| **Assertion** | a check. If it is false, the test **fails**. `expect(balance).toBe(500)` | everywhere |
| **Page object** | a class for one screen, with methods named after user actions (`enterAmount(500)`). Tests call these instead of clicking raw HTML. | `pages/` |
| **Fixture** | something Playwright prepares *for* the test before it starts (logged-in browser, page objects, the clock set) | `fixtures/` |
| **Helper** | code that talks to the system *behind* the screens: database, API, mailbox | `helpers/` |
| **Project** | a named group of spec files with shared settings: **one project per functionality** | `playwright.config.ts` |
| **Tag** | a label on a test, used to pick it out. JASEC official cases are tagged `@tc-NN`. | `{ tag: ['@tc-11'] }` |
| **Serial group** | tests that must run in order, because each uses what the one before created. If one fails, the rest are skipped. | `test.describe.configure({ mode: 'serial' })` |
| **Headed / headless** | headed = you see the browser. Headless = hidden, faster (default). | `--headed` |
| **Trace** | a recording of a test: every action, screenshots before/after, network, console | kept when a test fails |
| **Report** | an HTML page with every test of the last run: steps, errors, screenshots, video, trace | `playwright-report/` |

### What a test looks like

The real JASEC top-up test for case 11 (shortened). Read it as a list of user steps:

```ts
test(
  '2.3a: Top Up using Pay with PlaceToPay — APPROVE card',      // the test's name
  { tag: ['@tc-2-3', '@tc-2-3a', '@tc-11'] },                   // its tags: @tc-11 = official case 11
  async ({ selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage, dbHelper, ... }) => {
                                                                // ↑ fixtures: page objects and helpers, ready to use
    const accountId = await ensureSharedAccountAndAttach(...);  // make (or reuse) a test customer + order in Core UI
    const before = await dbHelper.getCrcBalanceAnyState(accountId);   // helper: read the balance first

    await selfcareActivityPage.navigateToTopUp();               // Self Care: open Top Up
    await selfcareTopupPage.enterAmount(500);                   // type 500
    await selfcareTopupPage.clickPayWithPlaceToPay();           // go to the payment page
    await placeToPayCheckoutPage.completePaymentFlow('approve');// pay with an "approve" test card

    await selfcareTopupPage.assertPaymentSuccess();             // CHECK: Self Care says it worked
    await agentSeesTopUp(page, accountId, before, 500);         // CHECK: the agent sees +500 in Core UI
  },
);
```

### How a run works

```text
you type:  npx playwright test --grep "@tc-11\b" --headed
  1. Playwright reads playwright.config.ts and your .env file (which tenant, which login)
  2. the "setup" project logs in to Core UI once and saves the session      (every other project depends on it)
  3. it finds every test of this tenant whose name or tags match "@tc-11"
  4. fixtures run: browser opened, page objects created, the clock set to the test's start date
  5. the test runs its steps; each assertion passes or fails
  6. results: a line per test in the terminal (✓ / ✘ / -), the HTML report, and for failures a trace, screenshot and video
```

Two settings from `playwright.config.ts` worth knowing:

- **One test at a time** (`workers: 1`). Tests share customers, the clock and billing days, so they never run in
  parallel. **Never start two runs at once on the same tenant**, even from two devices.
- **Long timeout (10 minutes per test).** Some tests wait for real background jobs. A slow test is not a stuck test.

---

## Part 3 — Set up your device (once)

This part is the same for every tenant. Each tenant part then lists the **settings file** and any **extra access** it
needs.

### 3.1 What to ask for

You get **your own** access. Credentials are never shared and never committed. Ask your lead for:

| What | Needed for |
|---|---|
| the **VPN** profile for JASEC dev/preprod | JASEC dev/preprod, and the database steps of coopegsbx2 |
| a **Core UI user** on each tenant you will test | all |
| **database read access** per tenant | JASEC tenants, coopegsbx2 |
| a **test mailbox** + its app password | JASEC e-mail tests, coopegsbx2 |
| an **SSH user on the control server** | JASEC dev/preprod meter-reading cases |
| an **OCI SSH key** (SFTP + database tunnel) | JASEC dev on OCI |
| a **NetSuite sandbox tester login** | coopegsbx2 |

### 3.2 Install the tools

| Tool | How | Check |
|---|---|---|
| **Node.js 20 or newer** | nodejs.org, LTS installer | `node -v` |
| **Git for Windows** | git-scm.com (also gives Git Bash and `ssh`) | `git --version` |
| **VS Code** (recommended) | code.visualstudio.com | |
| VS Code extension **"Playwright Test for VSCode"** (Microsoft) | Extensions panel, search "Playwright" | a flask icon on the left bar |

If PowerShell says *"running scripts is disabled"*, fix it once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 3.3 Get the code

All the test code is in one public repository: **https://github.com/PhucAnh0206/embrix-automation** (branch `main`).
No access request is needed to clone it.

```powershell
cd D:\Work                                   # any folder you like
git clone https://github.com/PhucAnh0206/embrix-automation.git
cd embrix-automation
npm ci                                        # installs the libraries
npx playwright install chromium               # downloads the browser Playwright drives
```

To get the latest changes later: `git pull` in the same folder, then `npm ci` again if `package-lock.json` changed.

> **Windows trap.** Always `cd` into the folder with its **exact letter casing**. If the folder is `D:\Work\Embrix\…`
> and you type `cd d:\work\embrix\…`, Playwright finds **no tests**. Use Tab completion to get the casing right.

### 3.4 Settings files: one per tenant

The tests read their settings (which tenant, your logins) from a file called **`.env`** in the repo folder. You keep
**one file per tenant** (`.env.preprod`, `.env.coopegsbx2`, …) and **switch** which one is active:

```powershell
.\switch-env.ps1 preprod        # copies .env.preprod to .env → you are now on JASEC preprod
.\switch-env.ps1 coopegsbx2     # copies .env.coopegsbx2 to .env
.\switch-env.ps1                # no argument: shows which tenant is active
```

How to create a settings file:

1. Copy the example: `.env.example` for JASEC tenants and Congero, `.env.coopegsbx2.example` for coopegsbx2.
2. Rename the copy `.env.<name>` (the name you'll pass to `switch-env`).
3. Fill in the values. **Each tenant part says which keys** and what goes in them.

`.env*` files are ignored by Git. Never paste their contents into chats or tickets.

**Check the active tenant before every session.** Forgetting to switch is the most common way to test the wrong
system.

### 3.5 SSH keys (only for tenants that need them)

```powershell
ssh-keygen -t ed25519 -C "your.name@company.com"     # press Enter for the defaults
```

Send the **public** key (`C:\Users\<you>\.ssh\id_ed25519.pub`, the `.pub` file, never the other one) to your lead.
The tenant parts say where it is used.

### 3.6 Check it works

Connect the VPN, then (here for JASEC preprod; use your tenant's name):

```powershell
.\switch-env.ps1 preprod
npx playwright test --project=setup --project=unit
```

- `setup` logs in to Core UI and saves the session. If it fails: VPN off, wrong user/password, wrong `TEST_ENV`.
- `unit` runs small offline checks of our own code. They need no tenant.

### 3.7 Prerequisites at a glance

What must be in place **before** you run anything on a tenant. A missing item doesn't always fail loudly: the test
may report **BLOCKED** or be **skipped**. When a run behaves oddly, check this table first.

| Prerequisite | JASEC dev / preprod | JASEC dev on OCI | coopegsbx2 (NetSuite) | congero-oci |
|---|---|---|---|---|
| **VPN** (JASEC dev/preprod profile) | **always** | no | for database steps and the billing cycle | no |
| **Core UI login** (your own) | yes | yes | yes | yes |
| **Database access** | yes, most tests | yes, **only through the SSH tunnel** (7.2) | yes, + `netsuite-suite\tools\.pg-coopegsbx-dev.json` | no |
| **Test mailbox** (IMAP + app password) | e-mail tests, some customer and billing tests | same | yes | no |
| **SSH to the control server** (`ssh embrix-dev`) | usage, some billing and provisioning tests, control-server cases | – (there is none) | no | no |
| **OCI SSH key** (tunnel + SFTP) | no | **yes** | no | no |
| **NetSuite sandbox tester login** | no | no | **yes** | no |
| **Costa Rica weekday daytime** (Mon–Fri 08:00–20:00 CR, no holidays) | cut / reconnect tests | same | no | no |
| **Nobody else running** on the tenant | yes | yes | yes, + say so in the team chat | yes |
| **Clock baseline set** before running | no (tests handle it) | no | **yes**: `NS_BASELINE` (8.3) | no (TC-00 sets it) |

Each tenant part starts with a **"Before you run" checklist**. Part 6.5 lists what **each JASEC functionality**
needs.

---

## Part 4 — Choosing what runs

Commands run in the repo folder, after `.\switch-env.ps1 <tenant>`.

| To run… | Command |
|---|---|
| **one case** (by its tag) | `npx playwright test --grep "@tc-11\b"` |
| **several cases** | `npx playwright test --grep "@tc-11\b\|@tc-12\b"` (`\|` = "or") |
| **one functionality** (a project) | `npx playwright test --project=jasec-top-up` |
| **one file** | `npx playwright test tests/regression/jasec/top-up/ts-02-topup.spec.ts` |
| **one test in a file, by line** | `npx playwright test tests/regression/jasec/top-up/ts-02-topup.spec.ts:335` |
| **by words in the test name** | `npx playwright test --grep "PlaceToPay"` |
| **everything except** something | `--grep-invert "@tc-64x"` |
| **only list** what would run (runs nothing) | add `--list` |
| **with the browser visible** | add `--headed` |
| **step by step** | add `--debug` |
| **in the visual UI** | `npx playwright test --ui` |
| **only what failed last time** | add `--last-failed` |

- **The `\b` after a tag** means "the tag ends here": `@tc-11\b` does **not** also pick `@tc-110`, `@tc-111`… Always add it.
- **`--list` first.** Before a big run, add `--list` to see exactly what your filter picks.
- **Tags and projects combine:** `--project=jasec-billing-run --grep "@tc-147"`.

### Switches: the safety catch

Some tests do things that **cannot be undone** or that **affect everyone on the tenant**: billing customers, cutting
meters, posting accounting entries, moving the clock. Each checks for its own **switch**, an environment variable set
to `true`. Without it, the test **skips itself** and says which switch it needs.

```powershell
$env:JASEC_BILL_RUN='true'                   # turn the switch on, in THIS PowerShell window
npx playwright test --grep "@tc-147" --headed
```

The switch stays on **until you close that window** (or `$env:JASEC_BILL_RUN=''`). Good habit: a fresh window per
switch, close it when done.

> A test that needs a switch and doesn't get one is **skipped**, not passed. "0 failed" does not mean it was tested.

---

## Part 5 — Watch a case in the visual UI

Playwright's **UI mode** shows what a test does, step by step, with a screenshot of the page at every step. Use it to
learn how a business flow works before reading any code. It works the same on every tenant.

### 5.1 Open it

```powershell
.\switch-env.ps1 preprod
npx playwright test --ui                     # or: npm run test:ui
```

```text
┌──────────────────────┬──────────────────────────────────────────────────────────┐
│ TESTS (left panel)   │  TIMELINE (top): a film strip of the page over time      │
│  ▸ setup             ├──────────────────────────────────────────────────────────┤
│  ▸ jasec-top-up      │  ACTIONS list        │  SCREENSHOT of the page at the     │
│    ▸ ts-02-topup     │  (each click, type,  │  selected action: before / action  │
│      ▶ 2.3a: Top Up  │   check, in order)   │  / after tabs                      │
│  ▸ jasec-billing-... │                      │                                    │
│ [filter: @tc-11 ]    ├──────────────────────┴────────────────────────────────────┤
│ ☐ projects           │  Source · Log · Errors · Network · Console (bottom tabs)  │
└──────────────────────┴───────────────────────────────────────────────────────────┘
```

Only the active tenant's projects are listed.

### 5.2 Run one case and follow it

1. Type the tag or a word of the test name in the **filter box** at the top left, e.g. `@tc-11`.
2. In the **Projects** filter, tick `setup` and the project of your test (see your tenant's part).
3. Press **▶** next to the test. UI mode runs headless by default. Turn on **Show browser** in the UI mode settings
   to also see a live browser.
4. When it finishes, click any line in the **Actions** list:
   - the big screenshot shows the page **before / during / after** that action, with the clicked element highlighted
   - **Source** shows the line of the test that did it
   - **Log** shows what Playwright waited for, **Console / Network** what the page did
5. Drag along the **timeline** to scrub through the run like a video.

The action names come from our page objects (`enterAmount`, `clickPayWithPlaceToPay`, `assertPaymentSuccess`…), so
the list reads like the user's steps.

### 5.3 Other ways to watch

| You want to… | Do this |
|---|---|
| see the browser while it runs | add `--headed` |
| go one action at a time and pause | add `--debug` (Playwright Inspector: *Step over* to advance) |
| replay a **failed** run | `npx playwright show-report` → the failed test → **Trace** |
| watch the video of a failed run | in the report, under the failed test → **Video** |
| run from VS Code | the **Testing** (flask) panel → pick a test → ▶. Tick *Show browser* at the bottom of the panel. |
| keep a trace of a **passing** run | add `--trace on` (and `--video on`). By default they are kept only for failures. |

---

## Part 6 — JASEC dev and preprod

**Preprod is the main test environment.** Dev is the developers' copy: use it when your lead asks. Everything in this
part works the same on both. Only the settings file differs.

**Before you run, check:**

- [ ] VPN connected
- [ ] `.\switch-env.ps1` shows `jasec-preprod` (or `jasec-dev`)
- [ ] `npx playwright test --project=setup` passes (your login works)
- [ ] database keys filled in `.env.preprod` (nearly every test reads the database)
- [ ] for e-mail tests: mailbox keys filled in
- [ ] for usage, billing-run, breach, balance-transfer and auto cut/reconnect tests: `ssh embrix-dev echo ok` prints `ok`
- [ ] for cut / reconnect tests: it is Mon–Fri, 08:00–20:00 **Costa Rica** time
- [ ] nobody else is running tests on the same environment
- [ ] the switch for what you're about to run is set in **this** window (6.5)

### 6.1 The business: a prepaid electricity customer

```text
 1. An agent creates the customer in Core UI, with an order and a meter (the electricity counter)
 2. The meter is switched on at JASEC's meter system (called AMI)
 3. The customer tops up in Self Care, paying through PlaceToPay        → balance goes up
 4. The meter sends readings (kWh used) in files to the platform
 5. The platform checks those files, prices the kWh and adds taxes      → balance goes down
 6. Balance runs out → warning e-mail, then the meter is cut
 7. The customer tops up again → the meter is reconnected
 8. Once a month, billing produces an invoice
 9. The money movements are sent to accounting
```

Every functionality in 6.6 is one or more of these steps.

### 6.2 Settings files and access

Create `.env.dev` and `.env.preprod` from `.env.example`:

| Key | What to put |
|---|---|
| `TEST_ENV` | `jasec-dev` / `jasec-preprod`. This picks the web addresses for you (`config/tenants.ts`). |
| `EMBRIX_USER` / `EMBRIX_PASSWORD` | your Core UI login for that environment |
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` `DB_SSL` | the database details you were given |
| `NOTIFY_IMAP_HOST` `NOTIFY_IMAP_PORT` `NOTIFY_IMAP_USER` `NOTIFY_IMAP_PASSWORD` | the test mailbox. Gmail: `imap.gmail.com`, `993`, and an **app password** (Google Account → Security → 2-Step Verification → App passwords). |
| `NOTIFY_EMAIL_TO` | the same mailbox address |
| the rest | as in `.env.example` |

You also need:

- **VPN on**, always.
- **SSH to the control server** only for the meter-reading cases. After sending your public key (3.5), add to
  `C:\Users\<you>\.ssh\config`:

  ```text
  Host embrix-dev
    HostName <control server address - from your lead>
    User <your SSH user>
    IdentityFile ~/.ssh/id_ed25519
  ```

  Check: `ssh embrix-dev echo ok` prints `ok`.

### 6.3 Your first run

```powershell
.\switch-env.ps1 preprod
npx playwright test --grep "@tc-11\b" --headed
```

What you will see:

1. **Core UI**: a prepaid test customer is created with an order and a test meter. (Several top-up tests share one
   customer, so if it already exists, it is reused.)
2. **Self Care**: the customer logs in, opens *Top Up*, types 500 and chooses *Pay with PlaceToPay*.
3. **PlaceToPay** test checkout: an approved test card is entered.
4. Back in Self Care: payment success. Then **Core UI** again: the agent sees the top-up and the balance is ₡500 higher.

Then `npx playwright show-report`, click the test, and read its steps and log lines (customer number, balances).

### 6.4 Learning path: watch these in UI mode, in order

| # | Case | Filter | What it teaches |
|---|---|---|---|
| 1 | Customer created by an agent | `@tc-01\b` | Core UI: the customer form, order, meter |
| 2 | Customer tops up | `@tc-11\b` | Self Care + PlaceToPay + agent check |
| 3 | Invoice as an agent sees it | `@tc-144` | Core UI billing screens, read-only |
| 4 | Billing run from the Daily Schedule screen | `@tc-147` (switch `JASEC_BILL_RUN`) | the clock, a billing run, an invoice made and checked line by line |
| 5 | Top-up confirmation e-mail | `@tc-69\b` | the e-mails the customer receives |

### 6.5 What each functionality needs

VPN and your Core UI login are needed for **everything** on dev/preprod, so they're not repeated below. ✔ = needed.
**Switch** = must be set to `true` in the same window, or the test is skipped.

| Project | Database | Mailbox | SSH control server | CR weekday daytime | Switch | Also needs |
|---|---|---|---|---|---|---|
| `setup` | | | | | – | |
| `unit` | | | | | – | nothing (works offline) |
| `jasec-regression` | ✔ | ✔ (main-contact test) | | | – | |
| `jasec-balance-transfer` | ✔ | | ✔ | ✔ (debt / cut checks) | `JASEC_BALANCE_TRANSFER_RUN` + `JASEC_JEPYP475_DEPLOYED` | `@tc-154`: **preprod only** |
| `jasec-top-up` | ✔ | | | | – | PlaceToPay test checkout reachable |
| `jasec-usage-charges` | ✔ | | | | – | the results file of a tariff-calculation run on this tenant (`artifacts/<tenant>/block-e-results.json`): run with your lead, else BLOCKED |
| `jasec-usage-run` | ✔ | | ✔ | ✔ | `JASEC_USAGE_RUN` | |
| `jasec-usage-screens` | ✔ | | ✔ | | `JASEC_USAGE_UI_RUN` | |
| `jasec-billing-trueup` | ✔ | | | | `JASEC_TRUEUP_RUN` | a free billing day (found by the test) |
| `jasec-provisioning` | ✔ | | | | `JASEC_DISPATCH_RUN` (+ `JASEC_BATCH_N=2`) for dispatch | |
| `jasec-provisioning-orders` | ✔ | | ✔ (automatic cut/reconnect) | ✔ | `JASEC_SUSPEND_ORDERS_RUN` / `JASEC_AUTO_PROV_RUN` / `JASEC_REPROCESS_RUN` | some tests: a customer already in the right state (else BLOCKED) |
| `jasec-notification-content` | ✔ | ✔ | | | – | |
| `jasec-notification` | ✔ | ✔ | | | – | |
| `jasec-notification-reconnect` | ✔ | ✔ | | ✔ | – | |
| `jasec-billing-breach` | ✔ | ✔ | ✔ | | `JASEC_BREACH_RUN` | a free billing day |
| `jasec-seed` (cohort) | ✔ | ✔ | | | `JASEC_SEED_RUN` (+ `JASEC_CLOCK_KEEP`) | |
| `jasec-notification-live` | ✔ | ✔ | | ✔ | `JEPYP230_LIVE_RUN` | a seeded group + its bill date |
| `jasec-notification-tiers` | ✔ | ✔ | | | `JEPYP230_TIER_RUN` | a second seeded group + its bill date |
| `jasec-billing-savedcard` | ✔ | | | | `JASEC_SAVEDCARD_RUN` | a free billing day |
| `jasec-billing-run` · `ts-06` | ✔ | | ✔ | | `JASEC_BILL_RUN` | a free billing day, ≤ 5 customers due |
| `jasec-billing-run` · `ts-07` | | | | | – | existing invoices on the tenant |
| `jasec-billing-settlement` | ✔ | | | | – | |
| `jasec-billing-statement` | | | | | – | `JASEC_TWO_CYCLE_ACCOUNT` (ask your lead) |
| `jasec-billing-refused` | ✔ | | | ✔ | `JASEC_REFUSED_BILL_RUN` | **preprod only** |
| `jasec-billing-read` | ✔ | ✔ (invoice-format test) | | | – | |
| `jasec-accounting` | ✔ | | | | – | |
| `jasec-accounting-run` | ✔ | | | | `JASEC_EBS_RUN` | your lead's OK: **irreversible** |
| control-server scripts (6.8) | | ✔ (error-e-mail scripts) | ✔ | | – | your lead, for the error-e-mail scripts |

### 6.6 Functionality map

Each row: the **project**, the **switch** (if any), whether it **changes data**, and the case numbers. Specs are in
`tests/regression/jasec/`.

#### Customers

| What | Project | Switch | Changes data | Cases |
|---|---|---|---|---|
| Create prepaid customers in Core UI, form details, main contact | `jasec-regression` | – | yes, creates customers | 01–03 |
| A cancelled service's balance moves to the new service | `jasec-balance-transfer` | `JASEC_BALANCE_TRANSFER_RUN` + `JASEC_JEPYP475_DEPLOYED` | yes, cancels and recreates a service, moves the clock | 04 |

```powershell
npx playwright test --project=jasec-regression --grep-invert "@tc-64x"     # @tc-64x is parked: left out on purpose
$env:JASEC_BALANCE_TRANSFER_RUN='true'; $env:JASEC_JEPYP475_DEPLOYED='true'
npx playwright test --project=jasec-balance-transfer --grep "@tc-04\b"
```

#### Top-up

| What | Project | Switch | Changes data | Cases |
|---|---|---|---|---|
| Self Care top-ups: PlaceToPay approve / reject / pending, saved card, minimum amounts, credit after debt | `jasec-top-up` | – | yes, test payments (no real money) | 05–25, 42, 51 |

```powershell
npx playwright test --project=jasec-top-up
```

#### Usage and rating (meter readings priced into charges)

| What | Project | Switch | Changes data | Cases |
|---|---|---|---|---|
| Usage charges shown on screen (needs a tariff-calculation run first, see 6.5) | `jasec-usage-charges` | – | no | on-screen half of the rating cases |
| A reading billed into debt, then recovered by a top-up | `jasec-usage-run` | `JASEC_USAGE_RUN` | yes, sends readings (needs SSH) | 60 |
| The usage screens | `jasec-usage-screens` | `JASEC_USAGE_UI_RUN` | yes | 63 |
| First-cycle true-up | `jasec-billing-trueup` | `JASEC_TRUEUP_RUN` | yes, bills | 61, 62 |

The **file checks and tariff calculations** for meter readings are not Playwright tests: they run on the control
server (6.8).

#### Provisioning (meters switched on, cut, reconnected)

| What | Project | Switch | Changes data | Cases |
|---|---|---|---|---|
| Order contracts, dispatch to the meter system, order integrity | `jasec-provisioning` | `JASEC_DISPATCH_RUN` (+ `JASEC_BATCH_N=2`) | yes, sends commands | 113–120, 122, 124, 126, 127 |
| Suspend / resume orders, automatic cut and reconnect, reprocess a failed step | `jasec-provisioning-orders` | `JASEC_SUSPEND_ORDERS_RUN`, `JASEC_AUTO_PROV_RUN`, `JASEC_REPROCESS_RUN` | yes | 84, 119, 121–123, 125, 128–134 |

- Test meters (`M-QA…`) don't exist at JASEC's real meter system, so it answers **"El Medidor No existe"**. That is
  **expected** in test. The tests check what Embrix does with the answer.
- **Cuts only happen Monday–Friday, 08:00–20:00 Costa Rica time** (no holidays). Outside that, cut tests report
  BLOCKED.
- In `jasec-provisioning-orders`, run **one tag at a time**:

```powershell
$env:JASEC_DISPATCH_RUN='true'; $env:JASEC_BATCH_N='2'
npx playwright test --project=jasec-provisioning

$env:JASEC_SUSPEND_ORDERS_RUN='true'
$f='tests/regression/jasec/provisioning/suspend-resume-orders.spec.ts'
npx playwright test --project=jasec-provisioning-orders $f --grep "@order-journey"
npx playwright test --project=jasec-provisioning-orders $f --grep "@resume-billing-only-suspend"
npx playwright test --project=jasec-provisioning-orders $f --grep "@api-control"

$env:JASEC_AUTO_PROV_RUN='true'
$f='tests/regression/jasec/provisioning/auto-suspend-resume.spec.ts'
# one at a time, in this order: @tc-131  @auto-nise  @tc-128  @tc-132  @tc-133  @tc-134  @tc-129
npx playwright test --project=jasec-provisioning-orders $f --grep "@tc-131\b"
```

Some provisioning tests need a customer already in a particular state (e.g. suspended). When none exists they report
**BLOCKED** and say what they need.

#### Notifications (e-mails to the customer)

| What | Project | Switch | Changes data | Cases |
|---|---|---|---|---|
| E-mail content (wording, amounts), replayed from stored e-mails | `jasec-notification-content` | – | no | 65–94 content |
| Top-up confirmation e-mails | `jasec-notification` | – | yes, top-ups | 69, 70 |
| Reconnection e-mails | `jasec-notification-reconnect` | – | yes | 85, 86 |
| "Saldo Agotado" after a credit-limit breach | `jasec-billing-breach` | `JASEC_BREACH_RUN` | yes, bills | 88, 89 |
| E-mails sent by a real billing run | `jasec-notification-live` | `JEPYP230_LIVE_RUN` | yes, bills | 65–94 |
| Warning thresholds (tiers) | `jasec-notification-tiers` | `JEPYP230_TIER_RUN` | yes, bills | 65–94 |

The **live** and **tiers** runs need a group of fresh customers to bill. The seeding test makes them and prints the
bill date to use:

```powershell
$env:JASEC_SEED_RUN='true'; $env:JASEC_CLOCK_KEEP='true'
npx playwright test --project=jasec-seed tests/regression/jasec/seed/seed-notification-cohort.spec.ts
#   → look for the line:  COHORT ... | bill date 2026-08-04
$env:JEPYP230_LIVE_RUN='true'; $env:JEPYP230_SCHEDULE_DATE='2026-08-04'; $env:JASEC_WARN_PROFILE='prepaid'
npx playwright test --project=jasec-notification-live
```

For **tiers**, seed a second group whose bill date is **different** from the first, then
`$env:JEPYP230_TIER_RUN='true'; $env:JEPYP230_TIER_DATE='<its bill date>'` and run `--project=jasec-notification-tiers`.
Without a date, both look for a usable day themselves, and report BLOCKED if there is none.

#### Billing

| What | Project | Switch | Changes data | Cases |
|---|---|---|---|---|
| Invoice e-mail has one document; the tax-authority document | `jasec-notification-content` `--grep "JEPYP-54\|JEPYP-45"` | – | no | 145, 146 |
| Saved-card customer still invoiced; a top-up inside the cycle is on the invoice | `jasec-billing-savedcard` | `JASEC_SAVEDCARD_RUN` | yes, bills | 148, 149 |
| **Billing run from the Daily Schedule screen** | `jasec-billing-run`, file `ts-06` | `JASEC_BILL_RUN` | yes, bills | 147 |
| **Invoice as an agent sees it** | `jasec-billing-run`, file `ts-07` | – | no | 144 |
| Prepaid invoices settled, never in collections | `jasec-billing-settlement` | – | no | 150 |
| Account statement shows the full chain | `jasec-billing-statement` | – (needs `JASEC_TWO_CYCLE_ACCOUNT`) | no | 151 |
| Month-end bill into debt → cut → reconnect | `jasec-billing-refused` | `JASEC_REFUSED_BILL_RUN` | yes, bills, cuts | 153 |
| Service cancelled mid-month billed one minimum | `jasec-balance-transfer` `--grep "@tc-154"` | `JASEC_BALANCE_TRANSFER_RUN` + `JASEC_JEPYP475_DEPLOYED` | yes, bills | 154 |
| Invoice bands, format, cycles, statement, tariff guards | `jasec-billing-read` | – | no | 135–143, 151, 152 |

```powershell
$env:JASEC_BILL_RUN='true'
npx playwright test --project=jasec-billing-run tests/regression/jasec/billing/ts-06-billing-run.spec.ts --headed
npx playwright test --project=jasec-billing-run tests/regression/jasec/billing/ts-07-invoice-document.spec.ts
npx playwright test --project=jasec-billing-read --grep-invert "@aresep"        # @aresep is parked
```

- **A billing run bills every customer due that day**, not only ours. So billing tests **create their own customer and
  find a "free" billing day** themselves. You don't pick dates.
- They **move the clock forward** to that day. The *Process* button only works when the clock is on the run's date.
  **The clock is not put back afterwards.** The next test picks its own date, forward from wherever the clock is.
- The Daily Schedule test stops itself if more than **5** customers would be billed that day (`JASEC_BILL_MAX_ACCOUNTS`
  changes the cap).
- `jasec-billing-statement` needs a customer with two billed cycles in `JASEC_TWO_CYCLE_ACCOUNT` (ask your lead).
  Without it: BLOCKED.
- `jasec-billing-refused` and `@tc-154` run the full daily billing chain, which would also cut other customers on dev.
  **Preprod only**, in Costa Rica weekday daytime.

#### Accounting

| What | Project | Switch | Changes data | Cases |
|---|---|---|---|---|
| Accounting extract checks | `jasec-accounting` | – | no | 155–158 |
| Run the accounting extract | `jasec-accounting-run` | `JASEC_EBS_RUN` | **yes, irreversible: posts journals** | 155–158 |

```powershell
npx playwright test --project=jasec-accounting
$env:JASEC_EBS_RUN='true'; npx playwright test --project=jasec-accounting-run
npx playwright test --project=jasec-accounting          # read again: now an extract exists
```

#### Not part of the official set

`jasec-billing-explore`, `jasec-customer-form-explore`, `jasec-evidence-video`, `dev`: exploratory or one-off.

### 6.7 Running everything, in order

There is no single "run all" button. Run the functionalities **one after another, in this order**. Later ones use what
earlier ones create, and some must not overlap.

Before you start: **preprod**, VPN on, **tell the team nobody else runs on preprod meanwhile**, **Costa Rica weekday
daytime** for steps 6 and 8. It takes most of a day. Use a fresh PowerShell window per step so switches don't leak.

| # | Step | What to run | Notes |
|---|---|---|---|
| 0 | Check | `--project=setup --project=unit` | must be green |
| 1 | Customers | `jasec-regression --grep-invert "@tc-64x"`, then `@tc-04` | |
| 2 | Top-up | `jasec-top-up` | |
| 3 | Meter-reading files | control server: `./run-all-mdr.sh` (6.8) | SSH |
| 4 | Usage and rating | `jasec-usage-charges`, `jasec-usage-run`, `jasec-usage-screens`, `jasec-billing-trueup` | SSH for usage-run |
| 5 | Meter-reading error e-mails | control-server scripts, with your lead (6.8) | |
| 6 | Provisioning | `jasec-provisioning`, then `jasec-provisioning-orders` tag by tag | CR daytime. **Before** step 7. |
| 7 | Notifications | `jasec-notification-content`, `jasec-notification`, `jasec-notification-reconnect`, `jasec-billing-breach`, seed + `jasec-notification-live`, seed + `jasec-notification-tiers` | |
| 8 | Billing | invoice-mail grep, `jasec-billing-savedcard`, `ts-06`, `ts-07`, `jasec-billing-settlement`, `jasec-billing-statement`, `jasec-billing-refused`, `@tc-154`, `jasec-billing-read --grep-invert "@aresep"`, then `jasec-notification-content` again | read-only checks **last** |
| 9 | Accounting | `jasec-accounting`, `jasec-accounting-run`, `jasec-accounting` | always last |

`jasec-notification-content` runs twice because on a fresh environment some e-mail types only exist once billing has
run. After each step, open `npx playwright show-report` and note the failed and BLOCKED tests: the report keeps only
the **last** run.

### 6.8 Cases that run on the control server

The meter-reading **file** cases (is a file accepted or rejected, error e-mails, tariff calculations, fixed charges)
are **shell scripts on the control server**, not Playwright tests. The folder picks the environment:

| Environment | Folder |
|---|---|
| dev | `/jasec-energy/data/jasec/usage/energy` |
| preprod | `/jasec-energy/data/jasec-preprod/usage/energy` |

```bash
ssh embrix-dev
cd /jasec-energy/data/jasec-preprod/usage/energy
ls *.sh calc/*.sh            # the scripts; each starts with a comment explaining it
./run-all-mdr.sh             # file checks: each case prints PASS / FAIL / BLOCKED
```

The error-e-mail scripts temporarily change a shared setting (who receives the error e-mails). **Run those with your
lead** the first time.

---

## Part 7 — JASEC dev on OCI

The same JASEC system as dev, moved to **Oracle Cloud (OCI)**. **The cases and commands are the same as Part 6.**
This part only lists what is different.

**Before you run, check:**

- [ ] `.\switch-env.ps1` shows `jasec-oci-dev`
- [ ] the **database tunnel** window is open (7.2): without it every database step fails
- [ ] `npx playwright test --project=setup` passes
- [ ] mailbox keys filled in (e-mail tests), and no e-mail tests running on preprod at the same time
- [ ] for SFTP checks: your OCI key works (`sftp` connects, 7.3)
- [ ] long run: `$env:JASEC_FORCE_RELOGIN='true'` set
- [ ] nobody else is running tests on OCI dev
- [ ] know what can't run here: meter-reading tests (need your lead) and cut-window cases 129, 130, 153 (BLOCKED by design)

### 7.1 Settings file and access

Create `.env.oci-dev` from `.env.example` with `TEST_ENV=jasec-oci-dev`, your OCI Core UI login and the test mailbox,
as in 6.2. Then:

```powershell
.\switch-env.ps1 oci-dev
```

What differs:

| | JASEC dev / preprod | JASEC dev on OCI |
|---|---|---|
| Network | VPN | **no VPN needed** for the screens |
| Database | direct, over the VPN | only through an **SSH tunnel** (7.2) |
| Meter-reading files | dropped on the control server | uploaded over **SFTP** (7.3). There is **no control server**. |
| Meter commands (cut / reconnect at the meter system) | sent, refused for test meters | **switched off** on OCI |

### 7.2 Open the database tunnel

The OCI database only accepts connections from inside OCI. You reach it through a tunnel, using the OCI key your lead
set up for you:

```powershell
ssh -N -L 15432:<database address>:5432 -i ~/.ssh/<your OCI key> <your tunnel user>@<OCI SFTP server>
```

(addresses and user: from your lead). Leave that window open while you test. In `.env.oci-dev` set
`DB_HOST=127.0.0.1` and `DB_PORT=15432`, plus the database name, user and password you were given.

Without the tunnel, every test that reads the database fails at its first database step. Check the tunnel window
first.

### 7.3 Meter readings over SFTP

Reading files go into an SFTP inbox. A loader picks them up every minute and moves each to `processed/` (accepted) or
`error/` with a `.error.txt` explaining why (rejected):

```powershell
sftp -i ~/.ssh/<your OCI key> <your SFTP user>@<OCI SFTP server>
#   sftp> ls /jasec/energymdr/input        files waiting
#   sftp> ls /jasec/energymdr/processed    accepted
#   sftp> ls /jasec/energymdr/error        rejected (+ .error.txt)
```

The Playwright tests that drop readings (`jasec-usage-run`) and the meter-reading file cases need tooling for OCI that
is **not in this repo yet**. Run those with your lead.

### 7.4 Things to know on OCI

- **Cases that need a meter command can't complete here**: the automatic cut-window cases (129, 130) and the month-end
  cut (153) report BLOCKED. That's expected on OCI.
- **Long runs: force a fresh login.** After several hours the saved Core UI login can expire while still looking
  valid, and tests land on the sign-in page. For a long run set `$env:JASEC_FORCE_RELOGIN='true'` first.
- **Dropped connections.** OCI sometimes drops idle connections (`UND_ERR_SOCKET`, "socket hang up"). Re-run the test.
- **One mailbox.** OCI uses the same test mailbox as dev/preprod. Don't run e-mail tests on OCI and preprod at the same
  time.
- Run order: as in 6.7, without the control-server steps.

---

## Part 8 — CoopeG NetSuite (coopegsbx2)

**Before you run, check:**

- [ ] `.env.coopegsbx2` filled in, including the NetSuite sandbox tester login (`NS_SANDBOX_*`)
- [ ] `netsuite-suite\tools\.pg-coopegsbx-dev.json` created (database for the tools)
- [ ] VPN connected (needed for database steps and the billing cycle)
- [ ] the clock read and `$env:NS_BASELINE` set to it (8.3)
- [ ] you told the team chat you are starting, and nobody else is running on coopegsbx2
- [ ] `.\ns.ps1 smoke` passes before anything else
- [ ] for `ns-cycle.ps1` (the first time): your lead is with you

### 8.1 The business

CoopeGuanacaste (CoopeG) sells internet service. Its customers have **contracts** with a device at home (an **ONT**,
the fibre box). Embrix bills them, and every **invoice, customer, payment and credit note** must also reach CoopeG's
accounting system, **Oracle NetSuite**. These tests check that: something is done in Embrix (Core UI or the tools),
then it is checked in the Embrix database and **in the NetSuite sandbox** (view only).

Cases have IDs like `INV-003` (invoices), `CRM-001` (customers), `PAY-001` (payments), `CRN-001` (credit notes), `AR-…`,
`MAP-…`, `ENV-…`. The full list with expected results is the client file
`netsuite-suite\NetSuite_Regression_TestSuite - NetSuite_Regression_TestSuit.csv`.

### 8.2 Settings files and access

| File | Copy from | Holds |
|---|---|---|
| `.env.coopegsbx2` | `.env.coopegsbx2.example` | `TEST_ENV=coopegsbx2`, your Core UI login, database, test mailbox, NetSuite sandbox tester login (`NS_SANDBOX_*`), `NS_ALLOW_CLOCK` |
| `netsuite-suite\tools\.pg-coopegsbx-dev.json` | `netsuite-suite\tools\pg-config.example.json` | the database connection the tools use |

The **VPN** (the same as JASEC dev/preprod) must be on for the cases that read the database and for the billing cycle.

### 8.3 Before every run

Others move this clock too (the team, CoopeG). Read it and make it the date every runner returns to:

```powershell
node netsuite-suite\tools\clock.js get        # e.g. 2027-03-15
$env:NS_BASELINE='2027-03-15'                 # runners put the clock back here at the end
```

If a run is killed half-way, put it back by hand: `node netsuite-suite\tools\clock.js set $env:NS_BASELINE`.

**One person at a time** on coopegsbx2: the clock, Daily Schedules and test ONTs belong to the whole environment. Say
in the team chat when you start and stop.

### 8.4 Run cases: `ns.ps1`

`ns.ps1` uses `.env.coopegsbx2` for that run only (no need to `switch-env`). It refuses to start if someone else's run
is still going on this device.

```powershell
.\ns.ps1 smoke                          # quick health check: settings, NetSuite reachable. Start here.
.\ns.ps1 INV-003                        # one case
.\ns.ps1 INV-003 INV-018 PAY-001        # several
.\ns.ps1 billing                        # one area
.\ns.ps1 INV-003 -Headed -SlowMo 300    # watch it in the browser, slowed down (ms per action)
```

| Area | Cases |
|---|---|
| `smoke` | ENV-004, AR-003, AUTH-004 |
| `billing` | INV-003, RET-003, MAP-006, MAP-001, MAP-004, AUTH-001, INV-006, INV-009, REG-003 |
| `customer` | CRM-001, CRM-005, CRM-004 |
| `inbound` | AR-001, AR-003, AR-004, PAY-001 |
| `credits` | ENG-006-01, CRN-001, CRN-010 |
| `screens` | INV-005, CRN-008 (PDF screen) |
| `exempt` | MAP-002 |
| `basics` | all of the above |

To watch a NetSuite case in UI mode: `.\switch-env.ps1 coopegsbx2`, then `npx playwright test --ui`, project
`netsuite`, filter by the case ID (e.g. `INV-003:`).

### 8.5 The billing cycle on a new contract: `ns-cycle.ps1`

About 45 minutes. It creates a contract, bills three months, then goes through collection, suspension, payment,
reconnection, a plan change and cancellation, checking NetSuite at each step:

```powershell
.\ns-cycle.ps1 full -Start <YYYY-MM-01> -CleanSchedules
```

The first time, run it **with your lead**. It moves the clock a lot and uses the shared test ONT.

### 8.6 Every other case, and order

The runbook **`netsuite-suite\docs\NEXT-RUN.md`** lists every case, its command and its prerequisites, in the order to
run them (build check → `ns.ps1` → `ns-cycle.ps1` → cases on existing contracts → NetSuite sandbox check). Some paths in
it are written from another folder layout: `tools\` there is `netsuite-suite\tools\` here.

### 8.7 Results

- `netsuite-suite\results\NetSuite_Regression_TestSuite_R2_<date>.csv`: the client file with this run's *Actual
  Result* and *Status* per case.
- `test-results\` and `netsuite-suite\evidence\`: screenshots and what was sent / received per case.

### 8.8 Rules

- Change only **QA test contracts** and the team's test account. CoopeG's own contracts only where the runbook says.
- The **NetSuite sandbox is view only**: the automation searches, never edits. Don't edit it by hand either.
- **Daily Schedules bill every account due on that date.**
- Use only the ONTs the runbook names. The runners refuse the others.

---

## Part 9 — Embrix platform on Congero (OCI)

**Before you run, check:**

- [ ] `.env.congero-oci` has `TEST_ENV=congero-oci` and your Congero Core UI login (no VPN, database or mailbox needed)
- [ ] `.\switch-env.ps1` shows `congero-oci`
- [ ] `npx playwright test --project=setup` passes
- [ ] nobody else is running on Congero (TC-00 moves the shared clock)
- [ ] for a single case: you include `TC-00:` in the filter (9.3)
- [ ] you know which cases are waiting on tenant configuration (ask your lead)

### 9.1 The business

**Congero** is Embrix's own platform tenant on Oracle Cloud. Its regression is the general Embrix flow, not a client's:
create a customer and order, run billing over several months, invoices, payments, suspend and cancel.

### 9.2 Settings file

Create `.env.congero-oci` from `.env.example` with `TEST_ENV=congero-oci` and your Congero Core UI login
(`EMBRIX_USER` / `EMBRIX_PASSWORD`). No database or mailbox keys are needed. No VPN.

```powershell
.\switch-env.ps1 congero-oci
```

### 9.3 Run it

The whole regression is **one file of about 40 tests in a fixed order**: `tests/regression/embrixPlatform/ts-02.spec.ts`,
project `embrix-platform`. Tests are named `TC-00: …`, `TC-01: …`.

```powershell
npx playwright test --project=embrix-platform                       # everything, in order
npx playwright test --project=embrix-platform --headed              # watching
npx playwright test --project=embrix-platform --grep "TC-00:|TC-54:"   # one case: ALWAYS together with TC-00
```

- **TC-00 must always run first.** It moves the clock to a **random future date** and works out the dates every other
  case uses. A single case without TC-00 has no dates.
- Each full run creates **a new customer** and works on it from case to case. When one case fails, the cases after it
  that depend on it can fail or skip too. Fix or understand the **first** failure first.
- Some cases depend on how the tenant is configured (catalog, taxes, payment gateway). Ask your lead which ones are
  known to be waiting on configuration before reporting them.

### 9.4 Related

- `coopeg-sandbox` in `config/tenants.ts` is an older CoopeG sandbox that can also run `embrix-platform` and
  `coopeg-lifecycle`. Ask your lead before using it.
- CoopeG's own lifecycle automation lives in a separate repo: https://github.com/KietCongero/EmbrixAutomation.

---

## Part 10 — Reading results and fixing common problems

### The four results

| Result | In the terminal | Meaning | What to do |
|---|---|---|---|
| **Passed** | `✓` | every check held | nothing |
| **Failed** | `✘` | the system did something other than expected | report → error, screenshot, trace. Re-run that test alone once. If it fails again, it's a finding. |
| **Skipped** | `-` | didn't run: its **switch** is off, it's parked, or an earlier test in its serial group failed | read the reason |
| **BLOCKED** | `-`, reason starts with `BLOCKED` | a **precondition** was missing (no free billing day, outside CR daytime, no SSH, no suitable customer) | **not a defect**. Fix the precondition, run again. |

- Read the **first** error of a failure, not the last.
- In a serial group, re-run the **whole group** to re-check, not just the failed test.
- If the database is right but **the screen shows a wrong value**, it's a failure. The customer sees the screen.

### Where things are after a run

| Path | What |
|---|---|
| `playwright-report/` | HTML report (`npx playwright show-report`). Last run only. |
| `test-results/` | per-test folders for failures: `trace.zip`, screenshots, `video.webm` |
| `netsuite-suite\results\` | NetSuite client file per run (Part 8) |

### Common problems

| You see | Cause | Fix |
|---|---|---|
| `No tests found` / 0 tests | wrong folder casing (3.3), a filter that matches nothing, or **the project belongs to another tenant** | exact casing. Check with `--list`. `.\switch-env.ps1` to check the tenant. |
| `setup` fails at login | VPN off, wrong password, wrong tenant | VPN, `.env.<tenant>`, `.\switch-env.ps1` |
| `Executable doesn't exist … chromium` | browser not installed | `npx playwright install chromium` |
| everything **skipped** | the switch isn't on in **this** window | `$env:<SWITCH>='true'` in the same window |
| `page.goto: Timeout` on the first page | slow network. Core UI is a big download. | re-run. On a slow link: `$env:PW_NAV_TIMEOUT='300000'` |
| database errors on OCI dev | tunnel closed | reopen the tunnel (7.2) |
| `UND_ERR_SOCKET` / socket hang up (OCI) | dropped connection | re-run |
| tests land on a **Sign In** page mid-run | the saved login expired | `$env:JASEC_FORCE_RELOGIN='true'` and re-run |
| `BLOCKED … no free billing day` | every candidate day is taken | try later, or ask your lead |
| `BLOCKED … Costa Rica` / window | cut tests outside Mon–Fri 08–20 CR | run in CR daytime |
| `coopegsbx2 is already running` | another `ns.ps1` run on this device | wait for it to finish |
| a date on screen isn't today | the tenant's simulated clock | expected |
| values differ between tenants | tenants are configured differently | compare with your lead before reporting |

---

## Part 11 — Cheat sheet

```powershell
# ── every session ────────────────────────────────────────────────
cd <repo folder, exact casing>
.\switch-env.ps1                              # which tenant is active?
.\switch-env.ps1 preprod                      # dev | preprod | oci-dev | coopegsbx2 | congero-oci

# ── common Playwright ────────────────────────────────────────────
npx playwright test --ui                      # visual mode
npx playwright test --project=<project> --list
npx playwright test --grep "@tc-11\b" --headed
npx playwright test --grep "@tc-11\b" --debug
npx playwright show-report

# ── JASEC dev / preprod ──────────────────────────────────────────
npx playwright test --project=jasec-top-up
$env:JASEC_BILL_RUN='true'; npx playwright test --grep "@tc-147" --headed
ssh embrix-dev                                # control-server cases

# ── JASEC dev on OCI ─────────────────────────────────────────────
ssh -N -L 15432:<db address>:5432 -i ~/.ssh/<OCI key> <tunnel user>@<SFTP server>   # keep open
$env:JASEC_FORCE_RELOGIN='true'               # long runs

# ── CoopeG NetSuite (coopegsbx2) ─────────────────────────────────
node netsuite-suite\tools\clock.js get; $env:NS_BASELINE='<that date>'
.\ns.ps1 smoke
.\ns.ps1 INV-003 -Headed -SlowMo 300
.\ns.ps1 billing

# ── Embrix platform on Congero ───────────────────────────────────
npx playwright test --project=embrix-platform
npx playwright test --project=embrix-platform --grep "TC-00:|TC-54:"
```

---

## Part 12 — Rules

1. **Check the active tenant** (`.\switch-env.ps1`) before every session.
2. **One run at a time per tenant.** The clock, billing days and test devices are shared. Say in the team channel
   before a long run.
3. **One mailbox:** don't run e-mail tests on two tenants at once.
4. **Only test data.** `E2E…` / `QA…` customers, `M-QA…` meters, QA contracts. Don't change other people's data by hand.
5. **Switches on purpose**, in a fresh window, closed afterwards. **Irreversible steps** (accounting run, billing runs)
   only when you mean to.
6. **Clocks:** JASEC tests move the clock forward and leave it there. coopegsbx2 runners put it back to
   `NS_BASELINE`. Don't move any clock by hand unless your lead asks.
7. **NetSuite is view only.**
8. **BLOCKED is not a bug. Skipped is not a pass.** Report both honestly.
9. **Credentials are personal.** Keep them in your `.env.*` files only.
