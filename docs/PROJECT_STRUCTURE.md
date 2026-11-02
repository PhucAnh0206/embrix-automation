# 📁 Project Structure — EmbrixAuto

> **Project**: Automation Testing for Embrix O2X Platform
> **Stack**: Playwright + TypeScript
> **Goal**: Automate UI, API, and E2E testing for the entire Order-to-Cash business workflow
> **Last updated**: 2026-06-11 | Version: 4.0

---

## 🗂️ Overview Structure Diagram

```
EmbrixAuto/
│
├── 📄 playwright.config.ts              ← Central Playwright configuration
├── 📄 package.json                      ← Dependencies & npm scripts
├── 📄 tsconfig.json                     ← TypeScript compiler configuration
├── 📄 .env.example                      ← Environment variables template (copy → .env)
├── 📄 .gitignore                        ← Git ignored files/folders
├── 📄 .gitlab-ci.yml                    ← GitLab CI/CD pipeline
├── 📄 README.md                         ← Project overview description
│
├── 📁 docs/                             ← Project documentation
│   ├── 📄 EMBRIX_AUTO_GUIDE.md       ← Quick start test guide
│   └── 📄 PROJECT_STRUCTURE.md       ← This file — project structure documentation
│
├── 📁 fixtures/                         ← Playwright Fixtures (Dependency Injection)
│   ├── 📄 page-factory.ts              ← ★ Main fixture — aggregates all fixtures into a single test context
│   ├── 📄 component-factory.ts          ← Fixture for Toast, ReactSelect components
│   ├── 📄 logger.fixture.ts             ← Fixture for TestLogger (attaches log to report)
│   ├── 📁 api-fixtures/                 ← Fixtures for API helpers
│   │   ├── 📄 account-order-api.fixture.ts  ← Fixture for AccountOrderApiHelper
│   │   └── 📄 server-api.fixture.ts         ← Fixture for ServerHelper
│   └── 📁 pages-fixtures/              ← Fixtures for Page Objects
│       ├── 📄 login.fixture.ts          ← Fixture for LoginPage
│       └── 📁 customer-hub/
│           ├── 📄 customer-manager.fixture.ts       ← Fixture for CustomerManagementPage
│           ├── 📄 order-management.fixture.ts       ← Fixture for OrderManagementPage
│           └── 📁 account-details/
│               ├── 📄 account-data-account-info.fixture.ts  ← Fixture for AccountInfoPage
│               └── 📄 billing-data-bills.fixture.ts         ← Fixture for BillsPage
│
├── 📁 pages/                            ← Page Object Model (POM)
│   ├── 📄 base.page.ts                 ← Abstract base class — nav, form, table helpers
│   ├── 📄 login.page.ts                ← LoginPage — login to Embrix CoreUI
│   ├── 📁 components/                   ← Reusable UI components (do not inherit BasePage)
│   │   ├── 📄 toast.component.ts        ← ToastComponent — assert Toastify notifications
│   │   ├── 📄 react-select.component.ts ← ReactSelectComponent — react-select dropdown
│   │   ├── 📄 table.component.ts        ← TableComponent — read/find/click cells in tables
│   │   └── 📄 sidebar.component.ts      ← SidebarComponent — reusable left sidebar navigation
│   ├── 📁 customer-hub/                 ← Customer Hub pages
│       ├── 📁 customer-management/
│       │   ├── 📄 customer-management.page.ts   ← Search accounts, view list
│       │   └── 📁 account-details/
│       │       ├── 📄 account-details-sidebar.ts        ← 3-level sidebar navigation
│       │       ├── 📁 account-data/
│       │       │   └── 📄 account-info.page.ts          ← Customer Activity, modal view
│       │       ├── 📁 billing-data/
│       │       │   └── 📄 bills.page.ts                 ← Open/Closed Bills table
│       │       └── 📁 subscription-data/
│       │           └── 📄 services.page.ts              ← In-Complete Orders, Service Units
│       └── 📁 order-management/
│           └── 📄 order-management.page.ts      ← Create order, provisioning workflow
│   └── 📁 operations-hub/              ← Operations Hub pages
│       └── 📁 jobs-management/
│           └── 📄 daily-schedule.page.ts         ← Daily Schedule — job cards, process, refresh
│
├── 📁 helpers/                          ← Utilities & API helpers
│   ├── 📁 db/                           ← Database specific helpers (encapsulating SQL)
│   │   └── 📄 job-schedule.db.ts        ← Job schedule database helper
│   ├── 📄 database.helper.ts           ← Generic PostgreSQL client (SSL, statement timeout, retry)
│   ├── 📄 screenshot.helper.ts         ← Screenshot capture and attach to HTML report
│   ├── 📄 account-order-api.helper.ts   ← API helper: create account, pay invoice via REST API
│   ├── 📄 test-context.helper.ts        ← Test context helper: load, update, save test-context.json
│   ├── 📄 server-api.helper.ts          ← API helper: GraphQL set/get CCP time
│   ├── 📄 test-logger.ts               ← Structured logging (LOG/DATA/API/ERROR)
│   └── 📄 timeouts.helper.ts           ← Timeout constants (SHORT → EXTRA_LONG)
│
├── 📁 tests/                            ← All test specs
│   ├── 📄 auth.setup.ts                ← Setup: login once, save session
│   ├── 📁 smoke/
│   │   └── 📄 health-check.spec.ts      ← SMOKE-01→04: login form, valid/invalid creds, page title
│   └── 📁 regression/
│       └── 📁 coopeguanacaste/          ← Regression tests for Coopeguanacaste customer
│           └── 📄 ts-01.spec.ts         ← TS-01: Account → Invoice → Provisioning → Verify
│
├── 📁 test-data/                        ← Test data JSON (input for tests)
│   ├── 📄 accounts.data.json           ← Account creation profile (RESIDENTIAL_DEFAULT)
│   ├── 📄 services.data.json           ← Services configuration (BDL_INT_100MBPS)
│   └── 📄 provisioning.data.json       ← Provisioning data (provisioningId, ontModel)
│
├── 📁 playwright/                       ← Playwright internal files
│   └── 📁 .auth/                       ← Session + test context (DO NOT commit)
│       ├── 📄 user.json                ← storageState after auth.setup.ts runs
│       └── 📄 test-context.json        ← Shared data between tests (accountId, orderId, ...)
│
├── 📁 playwright-report/               ← HTML report (auto-generated)
└── 📁 test-results/                     ← Test artifacts, screenshots, videos
    └── 📁 logs/                         ← Log files from TestLogger
```

---

## 📄 Detailed Descriptions of Key Files

---

### ⚙️ `playwright.config.ts`

**Purpose**: Central configuration file, defines how Playwright executes.

| Property          | Value                     | Description                                    |
| ----------------- | ------------------------- | ---------------------------------------------- |
| `testDir`       | `./tests`               | Directory containing test specs                |
| `fullyParallel` | `false`                 | Run sequentially (tests have dependent states) |
| `timeout`       | `600_000`               | 10 minutes / test case (long regression tests) |
| `retries`       | `2` (CI), `0` (local) | Number of retries when a test fails            |
| `workers`       | `1`                     | Single worker (avoids data conflicts)          |

**3 Projects (test suites)**:

| Project        | `testMatch`                               | Description              | Dependency |
| -------------- | ------------------------------------------- | ------------------------ | ---------- |
| `setup`      | `**/auth.setup.ts`                        | Login once, save session | —         |
| `smoke`      | `**/smoke/*.spec.ts`                      | Quick health check       | —         |
| `regression` | `**/regression/coopeguanacaste/*.spec.ts` | Full regression tests    | `setup`  |

**Multi-environment** (configured via `TEST_ENV` variable or direct override):

```
TEST_ENV=sandbox  → https://coreui.coopeg.embrix.org   (default)
                    GraphQL: https://transactional.coopeg.embrix.org/graphql
                    CRM Gateway: https://crm-gateway.coopegsbx.embrix.org
```

---

### 📄 `package.json`

**Purpose**: Declares dependencies and useful npm scripts.

**Main Scripts**:

```bash
npm test                           # Run all tests (headless)
npm run test:headed                # Run with browser headed
npm run test:ui                    # Open Playwright UI Mode (debug)

npm run test:setup                 # Only run auth setup
npm run test:smoke                 # Only run smoke tests
npm run test:smoke:headed          # Smoke tests (headed)
npm run test:regression            # Only run regression suite
npm run test:regression:headed     # Regression suite (headed)

npm run report                     # View HTML report
```

**Dependencies**:

- `@playwright/test ^1.49.0` — Main automation framework
- `dotenv ^16.4.5` — Loads environment variables from `.env` file
- `@types/node ^20.10.0` — TypeScript types for Node.js

---

### 📄 `tsconfig.json`

| Setting                              | Value        | Description                                        |
| ------------------------------------ | ------------ | -------------------------------------------------- |
| `target`                           | `ES2022`   | Compile to ES2022                                  |
| `module`                           | `commonjs` | Node.js module system                              |
| `strict`                           | `true`     | Enable strict type checking                        |
| `forceConsistentCasingInFileNames` | `true`     | Force consistent casing (prevents Linux CI issues) |

---

### 📄 `.env.example`

Template for the actual `.env` file. Key variables:

| Variable                    | Description                      |
| --------------------------- | -------------------------------- |
| `TEST_ENV`                | Target environment (`sandbox`) |
| `EMBRIX_USER`             | UI login username                |
| `EMBRIX_PASSWORD`         | UI login password                |
| `EMBRIX_API_BEARER_TOKEN` | JWT token for CRM Gateway API    |
| `CLEAN_LOGS_ON_START`     | Auto-clean old logs on start     |

> ⚠️ **Important**: Copy this file to `.env` and fill in real credentials. The `.env` file is gitignored.

---

### 📄 `.gitlab-ci.yml`

Automated CI/CD pipeline on GitLab using Docker image `mcr.microsoft.com/playwright:v1.49.0-jammy`.

| Stage          | Job                  | When it runs                   | Description         |
| -------------- | -------------------- | ------------------------------ | ------------------- |
| `setup`      | `auth-setup`       | Always runs                    | Login, save session |
| `smoke`      | `smoke-tests`      | Always runs                    | Quick health check  |
| `regression` | `regression-tests` | MR or `develop` branch       | Full regression     |
| `e2e`        | `e2e-tests`        | `main` or `release` branch | E2E scenarios       |

---

## 📁 The `fixtures/` Directory — Dependency Injection

### 📄 `fixtures/page-factory.ts` ★ Main Fixture

**Purpose**: Central fixture file, aggregates **all** fixtures (Page Objects, API Helpers, Components, Logger) into a single `test` context via `base.extend<AllFixtures>()`.

**Injected Fixtures**:

| Fixture                    | Type                                            | Description                                          |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `page`                   | `Page` (extended)                             | Playwright Page + custom `navigateToHome()`        |
| `testLogger`             | `TestLogger`                                  | Structured logger, auto-flushes + attaches to report |
| `loginPage`              | `LoginPage`                                   | Page Object for login screen                         |
| `customerManagementPage` | `CustomerManagementPage`                      | Page Object for account search                       |
| `billsPage`              | `BillsPage`                                   | Page Object for Bills screen                         |
| `orderManagementPage`    | `OrderManagementPage`                         | Page Object for Order Management                     |
| `accountInfoPage`        | `AccountInfoPage`                             | Page Object for Account Info / Customer Activity     |
| `accountDetailsSidebar`  | `AccountDetailsSidebar`                       | Legacy sidebar wrapper (delegates to SidebarComponent) |
| `sidebar`              | `SidebarComponent`                            | Reusable left sidebar navigation                       |
| `servicesPage`           | `ServicesPage`                                | Page Object for Services / In-Complete Orders        |
| `serverHelper`           | `ServerHelper`                                | API helper: GraphQL set/get CCP time                 |
| `accountOrderApiHelper`  | `AccountOrderApiHelper`                       | API helper: create account, pay invoice              |
| `jobScheduleDbHelper`    | `JobScheduleDbHelper`                         | Database helper: clean up / retrieve jobs from DB    |
| `toast`                  | `ToastComponent`                              | Assert Toastify success/error toasts                 |
| `reactSelect`            | Factory `(container) => ReactSelectComponent` | Creates react-select scoped to container             |
| `table`                  | Factory `(container) => TableComponent`       | Creates table component scoped to container          |

> Files in `api-fixtures/` and `pages-fixtures/` are separate fixture modules (legacy), currently not used directly as they are aggregated in `page-factory.ts`.

---

## 📁 The `pages/` Directory — Page Object Model

### 🏗️ POM Architecture

```
BasePage (abstract)
    ↑ extends
├── LoginPage
├── SearchAccountsPage
├── AccountInfoPage
├── BillsPage
├── ServicesPage
├── OrderManagementPage
└── DailySchedulePage

Standalone Components (do not inherit BasePage):
├── ToastComponent
├── ReactSelectComponent
├── TableComponent
└── SidebarComponent

Legacy Wrappers:
└── AccountDetailsSidebar  → delegates to SidebarComponent
```

---

### 📄 `pages/base.page.ts`

**Purpose**: Abstract base class that all Page Objects inherit.

| Group          | Methods                                          | Description                                       |
| -------------- | ------------------------------------------------ | ------------------------------------------------- |
| **Navigation** | `navigate()`, `hoverNavMenu()`, `clickNavLink()` | Page transitions and navigation                   |
| **Loading**    | `waitForLoadingToDisappear()`                    | Waits for the global loading spinner to disappear |
| **Utility**    | `dismissDropdowns()`                             | Dismisses dropdowns by clicking the body          |

---

### 📄 `pages/login.page.ts`

| Method                   | Description                                                                   |
| ------------------------ | ----------------------------------------------------------------------------- |
| `goto()`               | Navigates to the login page (root URL)                                        |
| `login(user, pass)`    | Fills credentials + submits, using `Promise.race()` to handle success/error |
| `assertLoginSuccess()` | Verifies the URL is no longer `/login`                                      |
| `assertLoginError()`   | Verifies an error message is displayed                                        |

---

### 📁 `pages/components/` — Reusable UI Components

| File                          | Class                    | Description                                                                                                                      |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `toast.component.ts`        | `ToastComponent`       | Asserts Toastify success/error toasts                                                                                            |
| `react-select.component.ts` | `ReactSelectComponent` | Scoped to container, provides `select()` + `typeAndSelect()`                                                                 |
| `table.component.ts`        | `TableComponent`       | `getHeaders()`, `getCellValue()`, `findRowIndex()`, `clickCellLink()` — lazy header parsing, bulk `allTextContents()` |
| `sidebar.component.ts`      | `SidebarComponent`     | Reusable left sidebar navigation — `navigateTo()` supports 2-3 levels, handles already-expanded menus                          |

> **Critical Design Detail**: `TableComponent` loads all cell texts using `allTextContents()` (1 CDP request) instead of looping over `await cell.innerText()` (N requests) → 10x to 50x faster.

---

### 📁 `pages/customer-hub/` — Customer Hub Pages

| File                            | Class                      | Key Functionality                                                                                                       |
| ------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `customer-management.page.ts` | `CustomerManagementPage` | Searches account by Account ID, reads search results, clicks on account link                                            |
| `account-details-sidebar.ts`  | `AccountDetailsSidebar`  | Legacy wrapper — delegates to `SidebarComponent` for backward compatibility                                            |
| `account-info.page.ts`        | `AccountInfoPage`        | Navigates to Customer Activity, CLEAR/SEARCH, clicks View by Api Name, reads modal Request content                      |
| `bills.page.ts`               | `BillsPage`              | Navigates to Bills via sidebar, reads Open/Closed Bills table                                                           |
| `services.page.ts`            | `ServicesPage`           | Navigates to Services via sidebar, reads In-Complete Orders table                                                       |
| `order-management.page.ts`    | `OrderManagementPage`    | Full provisioning workflow: create order → search account → select reference order → add provisioning data → submit |

---

## 📁 The `helpers/` Directory

### 📁 `helpers/db/`

Dedicated directory for database helpers encapsulating SQL operations.

#### 📄 `helpers/db/job-schedule.db.ts`

**Purpose**: Fetches and deletes Job Schedules inside database to set up or clean up test environments.

**Key Functions/Methods**:

| Function/Method | Description |
| --- | --- |
| `getJobSchedule(date)` | Retrieves all job schedules on a specific date. |
| `deleteJobScheduleById(id)` | Deletes a job schedule and its list items by ID. |

---

### 📄 `helpers/account-order-api.helper.ts`

**Purpose**: Central API helper for creating accounts, orders, and paying invoices via the CRM Gateway REST API.

**Key Functions/Methods**:

| Function/Method             | Description                                                                |
| --------------------------- | -------------------------------------------------------------------------- |
| `createAccountAndOrder()` | POST `/processAccountAndOrder` — creates account + order, saves context |
| `payInvoice()`            | POST `/applyPayment` — pays invoice                                     |

---

### 📄 `helpers/test-context.helper.ts`

**Purpose**: Helper for managing E2E test session context persistence (saving and loading progress).

**Key Functions/Methods**:

| Function/Method             | Description                                                                |
| --------------------------- | -------------------------------------------------------------------------- |
| `saveTestContext()`       | Writes entire context to `playwright/.auth/test-context.json`            |
| `loadTestContext()`       | Reads context from JSON file                                               |
| `updateTestContext()`     | Merges partial data into the current context                               |

**`SavedContext` Interface** — shared data between tests:

```typescript
interface SavedContext {
  testingDateObj?: { startDate, nextMonthFirstDate, nextTwoMonthsFirstDate };
  accountId: string;
  orderId: string;
  accountInfoPageUrl?: string;
  billsPageUrl?: string;
  invoiceId?: string;
  totalAmount?: string;
  provisioningOrderUrl?: string;
  provisioningOrderId?: string;
  requestContent?: string;
}
```

---

### 📄 `helpers/server-api.helper.ts`

**Purpose**: API helper for the GraphQL server — manages CCP time (system time for testing).

| Method                         | Description                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `generateRandomFutureDate()` | Generates a random future date (startDate, nextMonthFirstDate, nextTwoMonthsFirstDate) |
| `getCcpTime()`               | Queries GraphQL `getCcpDateTime`                                                     |
| `setCcpTime(date)`           | Mutations GraphQL `setCcpTime`                                                       |
| `setAndVerifyCcpTime(date)`  | Set + Get + Assert — verifies CCP time is updated                                     |

---

### 📄 `helpers/test-logger.ts`

**Purpose**: Structured logging — writes timestamped and categorized logs to file + console.

| Category    | Method      | Used for                                |
| ----------- | ----------- | --------------------------------------- |
| `[LOG]`   | `log()`   | General information                     |
| `[DATA]`  | `data()`  | Captured data (accountId, orderId, URL) |
| `[API]`   | `api()`   | API request/response details            |
| `[ERROR]` | `error()` | Errors and warnings                     |

Log file: `test-results/logs/{test-title}_{timestamp}.log`
Auto-attached to Playwright HTML report via `testInfo.attach()`.

---

### 📄 `helpers/timeouts.helper.ts`

**Purpose**: Centralized timeout constants; changing here affects the whole project.

| Constant            | Value | Used for                          |
| ------------------- | ----- | --------------------------------- |
| `SHORT_WAIT`      | 1s    | Transitions, dropdown menus       |
| `MEDIUM_WAIT`     | 5s    | Page navigation, form validation  |
| `LONG_WAIT`       | 10s   | Element rendering, toast messages |
| `VERY_LONG_WAIT`  | 20s   | Slow API response toasts          |
| `EXTRA_LONG_WAIT` | 30s   | Login, complex processes          |

---

## 📁 The `tests/` Directory

### 📄 `tests/auth.setup.ts`

**Purpose**: Runs **only once** before the regression suite. Logs in and saves the session to `playwright/.auth/user.json`. Subsequent tests reuse this session → saves 10-30s per test.

---

### 📁 `tests/smoke/health-check.spec.ts`

**Purpose**: Smoke tests — verifies the application is up and running. Runs on **every pipeline**, session not required.

| Test         | Description                                                |
| ------------ | ---------------------------------------------------------- |
| `SMOKE-01` | Login page renders completely (username, password, button) |
| `SMOKE-02` | Valid credentials → login successful                      |
| `SMOKE-03` | Invalid credentials → error message displayed             |
| `SMOKE-04` | Page title is not empty (basic SEO sanity check)           |

---

### 📁 `tests/regression/coopeguanacaste/ts-01.spec.ts`

**Purpose**: Full regression test suite for **Coopeguanacaste** customer, checking the end-to-end Order-to-Cash workflow.

**Pattern**: `test.describe.serial()` + shared mutable `state` object.

| Test      | Description                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `TC-00` | **Suite Setup** — Generate random future date, set CCP time                                                        |
| `TC-01` | **Residential Account Creation** — API creates account + UI verification                                           |
| `TC-02` | **Installation Invoice Payment** — Reads bill details, asserts values, pays via API, verifies CLOSED               |
| `TC-03` | **Provisioning Order** — Creates provisioning order, verifies In-Complete Orders, waits 5 min, verifies FINALIZADO |
| `TC-04` | **Grace Period Billing** — Navigate to Jobs Schedule, clear via DB, create & process jobs, poll until all complete |
| `TC-05` | **Recurring Billing Month 01** — Verify recurring jobs processing and invoice generation |

---

## 📁 The `test-data/` Directory

| File                       | Description                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `accounts.data.json`     | Account creation profile — currently contains `RESIDENTIAL_DEFAULT` (Costa Rica, Guanacaste, Nicoya) |
| `services.data.json`     | Service list —`BDL_INT_100MBPS` Internet 100Mbps                                                     |
| `provisioning.data.json` | Provisioning data — prefix `ALCLB3A`, ONT model `G-240W-G`                                         |

---

## 🔄 Test Execution Flow

```
npx playwright test --project=regression
         │
         ▼
[Project: setup]
  auth.setup.ts → Login → Save playwright/.auth/user.json
         │
         ▼
[Project: regression]  ← Uses storageState from step above
  regression/coopeguanacaste/ts-01.spec.ts
    │
    ├── TC-00: Set CCP Time (API)
    ├── TC-01: Create Account (API + UI verify)
    ├── TC-02: Pay Invoice (UI read + API pay + UI verify)
    └── TC-03: Provisioning Order (UI create + wait + UI verify)
         │
         ▼
  playwright-report/index.html  ← HTML Report
  test-results/junit.xml        ← JUnit XML (for GitLab CI)
  test-results/logs/*.log       ← Structured logs (attached to report)
```

---

## 📋 Key Conventions

### Naming Conventions

| Type            | Pattern                 | Example                                     |
| --------------- | ----------------------- | ------------------------------------------- |
| Test spec       | `{name}.spec.ts`      | `ts-01.spec.ts`, `health-check.spec.ts` |
| Page Object     | `{name}.page.ts`      | `customer-management.page.ts`             |
| Component       | `{name}.component.ts` | `toast.component.ts`                      |
| API Helper      | `{name}.helper.ts`    | `account-order-api.helper.ts`             |
| Fixture         | `{name}.fixture.ts`   | `logger.fixture.ts`                       |
| Test data       | `{name}.data.json`    | `accounts.data.json`                      |
| Sidebar         | `{name}-sidebar.ts`   | `account-details-sidebar.ts`              |
| Fixture factory | `{name}-factory.ts`   | `page-factory.ts`                         |

### File & Folder Naming

- Always use **`kebab-case`** (lowercase, words hyphen-separated)
- Reason: Prevents import errors due to case sensitivity differences between Windows (case-insensitive) and Linux CI/CD (case-sensitive)

### Serial Test Pattern (Shared State)

```typescript
// 1. Define interface at the suite level
interface SuiteState {
  accountId: string;
  orderId: string;
  // ...
}
const state: Partial<SuiteState> = {};

// 2. Use test.describe.serial() — if a test fails, subsequent tests are skipped
test.describe.serial('Suite Name', () => {
  test('TC-01', async ({ fixture }) => {
    state.accountId = 'AC-123';     // Write to state
  });
  test('TC-02', async ({ fixture }) => {
    console.log(state.accountId);   // Read from state
  });
});
```

### Table Interaction (Performance)

```typescript
// ✅ Correct — 1 CDP request, processed in memory
const allTexts = await rows.locator('td:nth-child(2)').allTextContents();
const index = allTexts.findIndex(t => t.trim() === targetValue);

// ❌ Incorrect — N CDP requests, slow
for (const row of await rows.all()) {
  const text = await row.locator('td').nth(1).innerText();
}
```

### Locator Priority (Priority Order)

```typescript
// ✅ 1. Accessible roles
page.getByRole('button', { name: 'Submit' })

// ✅ 2. Labels
page.getByLabel('Account Name')

// ✅ 3. data-testid
page.getByTestId('create-account-btn')

// ⚠️ 4. XPath (when needed to locate by text/position)
page.locator("//h5[contains(text(), 'title')]/following::table")

// ❌ 5. CSS class (avoid — brittle when UI changes)
page.locator('.MuiButton-contained.submit')
```

---

## 🚀 Quick Start

```powershell
# 1. Install dependencies
npm install

# 2. Copy and fill in credentials
Copy-Item .env.example .env
# Open .env and fill in EMBRIX_USER, EMBRIX_PASSWORD, EMBRIX_API_BEARER_TOKEN

# 3. Run smoke tests (requires credentials for SMOKE-02)
npx playwright test --project=smoke

# 4. Setup session
npx playwright test --project=setup

# 5. Run regression (headed — browser visible)
npx playwright test --project=regression --headed

# 6. Run a specific file
npx playwright test tests/regression/coopeguanacaste/ts-01.spec.ts --project=regression

# 7. View report
npx playwright show-report
```

---

*Document updated on 2026-06-11 | Version: 4.0 | Project: EmbrixAuto*
