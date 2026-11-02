# Embrix Automation Test Guide — EmbrixAuto

This document provides step‑by‑step instructions for setting up, configuring, and running the automated test suite for the Embrix O2X platform using Playwright + TypeScript.

---

## 1. Prerequisites

Make sure the following are installed on your machine:

- **Node.js** – version 18 or newer (LTS recommended). Verify with `node -v`.
- **Git** – to clone the repository if you haven't already.

---

## 2. Installation

Open a terminal in the `EmbrixAuto/` directory and run:

```bash
npm install
```

> **Note**
> This command installs all required npm packages and automatically downloads the Chromium browser used by Playwright (via the `postinstall` script).

---

## 3. Environment Configuration

### 3.1. `.env` file

Create a copy of the example file and fill in your credentials:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and provide the following values:

```bash
# Target environment (currently only sandbox is provided)
TEST_ENV=sandbox

# UI login credentials
EMBRIX_USER=your.user@domain.com
EMBRIX_PASSWORD=your_password_here

# JWT Bearer token for the CRM Gateway API
EMBRIX_API_BEARER_TOKEN=your_jwt_bearer_token_here

# Database connection (PostgreSQL via AWS RDS)
DB_HOST=your-rds-host.us-east-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=coredb
DB_USER=dbuser
DB_PASSWORD=your_db_password

# Optional: automatically clean old logs on each run
CLEAN_LOGS_ON_START=false
```

> ⚠️ **Important**: The `.env` file is listed in `.gitignore` – never commit it to the repository.

### 3.2. Override URLs (optional)

If you need to run against a different environment, override the base URL at runtime:

```powershell
$env:EMBRIX_BASE_URL="https://coreui.custom-env.embrix.org"; npm test
```

### 3.3. Default URLs

| Service           | Default URL                                         |
| ----------------- | --------------------------------------------------- |
| CoreUI (Base URL) | `https://coreui.coopeg.embrix.org`                |
| GraphQL Server    | `https://transactional.coopeg.embrix.org/graphql` |
| CRM Gateway API   | `https://crm-gateway.coopegsbx.embrix.org`        |

---

## 4. Running Tests

### 4.1. Setup Session (required before regression)

Log in once and save the authenticated session:

```bash
npx playwright test --project=setup
```

### 4.2. Smoke Tests – quick health check

```bash
# Headless (fast, used in CI)
npx playwright test --project=smoke

# Headed (with a visible browser, useful for observation)
npx playwright test --project=smoke --headed
```

### 4.3. Regression Tests – full business‑logic verification

```bash
# Headless
npx playwright test --project=regression

# Headed
npx playwright test --project=regression --headed
```

### 4.4. Run a single test file

```bash
# Run the TS‑01 spec (regression suite)
npx playwright test tests/regression/coopeguanacaste/ts-01.spec.ts --project=regression

# Headed mode
npx playwright test tests/regression/coopeguanacaste/ts-01.spec.ts --project=regression --headed
```

> **Important**
> When targeting a specific file within the regression suite, always include `--project=regression` so Playwright loads the proper configuration and the stored session.

### 4.5. Running Tests by Tags

Playwright supports filtering and running tests using tags. You can declare tags in test suites/cases and filter them from the command line.

#### Declaring Tags in Tests

1. **In the Title String** (most common): Add `@tagname` directly to your `test` or `test.describe` title.
   ```typescript
   test.describe('REGRESSION: Test Suite - 01 @regression @coopeguanacaste', () => {
     test('TC-01: Residential Account Creation @smoke', async ({ page }) => {
       // ...
     });
   });
   ```

2. **Using the Test Configuration Object** (Playwright 1.42+):
   ```typescript
   test('TC-01: Residential Account Creation', { tag: ['@regression', '@coopeguanacaste'] }, async ({ page }) => {
     // ...
   });
   ```

> **Note on Comment Tags**:
> Comment blocks at the top of a file (e.g. `* Tags: @regression`) are for documentation/reference. To filter tests via the Playwright CLI, the tags must be defined in the title or the test configuration object as shown above.

#### Filtering from Command Line

Use the `--grep` (or `-g`) and `--grep-invert` options to filter your test runs:

- **Run tests matching a specific tag**:
  ```bash
  npx playwright test --grep "@regression"
  ```

- **Run tests matching either tag (OR logic)**:
  ```bash
  npx playwright test --grep "@regression|@coopeguanacaste"
  ```

- **Run tests matching both tags (AND logic)**:
  ```bash
  npx playwright test --grep "(?=.*@regression)(?=.*@coopeguanacaste)"
  ```

- **Skip/exclude tests matching a specific tag**:
  ```bash
  npx playwright test --grep-invert "@smoke"
  ```

### 4.6. Debugging with Playwright UI Mode

The UI mode gives you an interactive test runner where you can step through each action:

```bash
npx playwright test --ui
```

### 4.6. npm shortcut scripts

| Script                      | Description                                   |
| --------------------------- | --------------------------------------------- |
| `npm test`                | Run**all** tests in headless mode       |
| `npm run test:headed`     | Run**all** tests with a visible browser |
| `npm run test:ui`         | Launch Playwright UI Mode                     |
| `npm run test:setup`      | Execute only the authentication‑setup test   |
| `npm run test:smoke`      | Execute only the smoke suite                  |
| `npm run test:regression` | Execute only the regression suite             |
| `npm run report`          | Open the generated HTML report                |

---

## 5. Viewing the Report

After a test run Playwright generates an HTML report automatically. If it does not open on its own, run:

```bash
npx playwright show-report
```

The report includes:

- ✅ Pass/fail status for each test case
- ⏱️ Execution time per test
- 📎 Log files attached (generated by `TestLogger`)
- 📸 Screenshots for any failures
- 🎥 Video recordings for any failures
- 🔍 Trace viewer for retried tests

---

## 6. Project Directory Overview

| Folder                | Purpose                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `tests/`            | Contains all test specifications (`*.spec.ts`), organized by type (smoke, regression)     |
| `pages/`            | Page‑Object Model – one file per screen/section of the UI                                 |
| `pages/components/` | Reusable UI components such as Toast, ReactSelect, Table, Sidebar                           |
| `helpers/db/`       | Database helpers encapsulating SQL operations (e.g. JobScheduleDbHelper)                    |
| `fixtures/`         | Playwright fixtures that inject page objects, helpers, and components into the test context |
| `helpers/`          | Utility modules: API helpers, structured logger, timeout constants                          |
| `test-data/`        | JSON files that provide input data for the tests                                            |
| `playwright/`       | Internal Playwright data: session storage and shared test context                           |
| `docs/`             | Project documentation (this guide, project structure, demo scripts, etc.)                   |

> For a deeper dive into each file, see **[PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)**.

---

## 7. Existing Test Suites

### 7.1. Smoke Tests (`tests/smoke/`)

| Test ID   | Description                                       |
| --------- | ------------------------------------------------- |
| SMOKE‑01 | Verify the login page renders all required fields |
| SMOKE‑02 | Successful login with valid credentials           |
| SMOKE‑03 | Proper error message when credentials are invalid |
| SMOKE‑04 | Page title is populated (basic SEO sanity)        |

### 7.2. Regression Tests (`tests/regression/coopeguanacaste/`)

**TS‑01** – Full Order‑to‑Cash flow:

| Test ID | Description                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| TC‑00  | Set CCP (system) time via GraphQL – uses a random future date                                                          |
| TC‑01  | Create a residential account via API and verify it appears in the UI                                                    |
| TC‑02  | Read the installation invoice, assert all values, pay via API, verify status becomes **CLOSED**                         |
| TC‑03  | Create a provisioning order through the UI wizard, wait for completion, and verify the final status **FINALIZADO**      |
| TC‑04  | Grace Period Billing – run daily job schedule, process all jobs, poll until all complete                                |
| TC‑05  | Recurring Billing Month 01 – verify recurring jobs processing and invoice generation                                    |

---

## 8. Coding Conventions & Best Practices

### 8.1. File & Folder Naming

- **Always use `kebab-case`** (lower‑case with hyphens) for file and folder names.
- Example: `customer-management.page.ts`, `account-order-api.helper.ts`.
- **Why**: Prevents case‑sensitivity issues between Windows (case‑insensitive) and Linux CI environments.

### 8.2. Serial Test Pattern (shared state)

When tests depend on one another, use `test.describe.serial()` with a shared `state` object:

```typescript
interface SuiteState {
  accountId: string;
  orderId: string;
  // …additional fields as needed
}
const state: Partial<SuiteState> = {};

test.describe.serial('Order‑to‑Cash Suite', () => {
  test('TC‑01', async ({ fixture }) => {
    state.accountId = 'AC‑123'; // write
  });
  test('TC‑02', async ({ fixture }) => {
    console.log(state.accountId); // read
  });
});
```

### 8.3. Table Interaction Performance

- **Do not** loop over rows with `await cell.innerText()` – results in N CDP requests.
- **Instead**, fetch all cell texts at once using `allTextContents()` and process them locally:

```typescript
// Fast – one CDP request
const cellTexts = await rows.locator('td:nth-child(2)').allTextContents();
const rowIndex = cellTexts.findIndex(t => t.trim() === targetValue);
```

### 8.4. Locator Priority

Prefer the following locator strategies (in order):

1. Accessible roles (`page.getByRole`) with a descriptive name.
2. Labels (`page.getByLabel`).
3. `data-testid` attributes (`page.getByTestId`).
4. XPath only when necessary for complex hierarchical queries.
5. Avoid relying on CSS class names alone – they are fragile.

### 8.5. Test Data Management

- Never hard‑code values in the spec files. Load them from JSON files in `test-data/` or through API helpers.
- Generate **unique IDs** for each run to avoid collisions.
- Keep sensitive information (credentials, tokens) in the `.env` file – never commit them.

---

## 9. CI/CD Pipeline (GitLab)

The repository includes a pre‑configured GitLab CI pipeline that runs inside the official Playwright Docker image (`mcr.microsoft.com/playwright:v1.49.0-jammy`).

```text
pipeline: setup → smoke → regression → e2e
```

| Stage          | When it runs                             | Description                            |
| -------------- | ---------------------------------------- | -------------------------------------- |
| `setup`      | Always                                   | Log in and persist the session         |
| `smoke`      | Always                                   | Quick health‑check of the application |
| `regression` | Merge requests or the `develop` branch | Full regression suite                  |
| `e2e`        | `main` or `release` branches         | End‑to‑end scenarios                 |

**Required GitLab CI variables** (set under *Settings → CI/CD → Variables*):

- `QA_BASE_URL` – base URL of the target environment
- `QA_EMBRIX_USER` – automation username
- `QA_EMBRIX_PASSWORD` – automation password
- `QA_DB_HOST`, `QA_DB_USER`, `QA_DB_PASSWORD` – database credentials

These variables feed into the generated `.env` at pipeline runtime.

---

*Document last updated: 2026‑06‑11 | Version 4.0 | Project: EmbrixAuto*
