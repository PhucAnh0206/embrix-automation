# Project Context & Memory

This file serves as a memory checkpoint for AI agents and developers. It captures the current state, progress, structural updates, and critical findings of the **Embrix Auto** project. Update this file at the end of each session.

---

## 1. Project Overview

* **Application**: Embrix CoreUI Automation
* **Tech Stack**: Playwright, TypeScript, Node.js, PostgreSQL (pg).
* **Architecture**: Page Object Model (POM) with a centralized page-factory fixture (`fixtures/page-factory.ts`), reusable UI components (`pages/components/`), database helpers (`helpers/db/`), and backend API orchestration helpers (`helpers/`).
* **Environment**: Sandbox (`TEST_ENV=sandbox`). Uses a GraphQL backend endpoint for setting system time (CCP Time), a CRM Gateway REST API for creating test accounts/paying invoices, and a PostgreSQL database (AWS RDS) for direct data verification and cleanup.

---

## 2. Current Project Status

### What is Completed & Working:
* **Auth Setup (`auth.setup.ts`)**: Successfully logs in and saves cookies/localStorage session state to `playwright/.auth/user.json`.
* **Conventions Documentation**: Created a unified guideline file at [PLAYWRIGHT_CONVENTIONS.md](file:///d:/Works/EMBRIX/Automation/EmbrixAuto/docs/PLAYWRIGHT_CONVENTIONS.md).
* **Reusable Components**: `ToastComponent`, `ReactSelectComponent`, `TableComponent`, `SidebarComponent` — all in `pages/components/`.
* **Database Integration**: Generic `DatabaseHelper` using `pg.Pool` (SSL, statement timeout, retry/poll) + domain-specific helpers in `helpers/db/` (e.g. `JobScheduleDbHelper`).
* **Test Suite 01 (`ts-01.spec.ts`)**: Runs sequentially under `test.describe.serial`.
  * **TC-00**: Sets system date on the server via GraphQL (generates up to 5 months in advance for recurring billing).
  * **TC-01**: Creates residential account and order via REST API, verifies customer details on UI.
  * **TC-02**: Detects first invoice, pays it via REST API, asserts status updates to `CLOSED` on UI.
  * **TC-03**: Creates provisioning order, waits for `FINALIZADO` status via Customer Activity polling.
  * **TC-04**: Grace Period Billing — navigates to Jobs Schedule via sidebar, clears existing schedules via DB, creates new schedule, processes all jobs, polls until all complete.
  * **TC-05 (In Progress)**: Recurring Billing Month 01.

---

## 3. Critical Technical Decisions & Fixes

* **Monkey Patching Playwright Page Interface**:
  * **Decision**: To avoid tight coupling and violating the "components do not inherit BasePage" rule, the `waitForLoadingToDisappear()` method was removed from `BasePage` and added directly to Playwright's native `Page` interface via `fixtures/page-factory.ts`. This allows `await this.page.waitForLoadingToDisappear()` to be used safely everywhere.
* **Database Helper Pool (`pg.Pool`)**:
  * **Issue**: `DatabaseHelper` initially used `pg.Client` and called `.end()` after the first query, throwing `Client has already been connected. You cannot reuse a client` on subsequent calls.
  * **Fix**: Switched to `pg.Pool`, which handles checkout, connection, execution, and release automatically, allowing multiple queries to be safely executed by the same helper instance.
* **Sidebar Component Nested Navigation Fix**:
  * **Issue**: Navigation to Level 3 (`Subscription Data` → `Assets` → `Services`) failed because `Assets` was treated as a top-level `li.item-nav` category.
  * **Fix**: Relaxed the `SidebarComponent` locator strategy to search for menu items (`a:has(...)`) *inside* the top-level category container, correctly supporting structures where Level 2 acts as an inline sub-category toggler.
* **Server Time Expiry Protection**:
  * **Issue**: In `TC-00`, a generated random year up to 3 years in the future triggers password expiry logic on the backend, locking the login flow.
  * **Fix (Temporary)**: Discovered that server time can be programmatically reset by calling the GraphQL API directly via PowerShell/curl.
* **Test Context Overwrite Bug (`saveTestContext` → `updateTestContext`)**:
  * **Issue**: `createAccountAndOrder()` called `saveTestContext()` (full overwrite) instead of `updateTestContext()` (merge), destroying `testingDateObj` written by TC-00.
  * **Fix**: Changed to `updateTestContext()` so all context fields are preserved across serial test cases. Never call `saveTestContext()` mid-suite.

---

## 4. Known Issues & Troubleshooting

* **Sandbox API Stability**: The CRM Gateway API (`/processAccountAndOrder`) and GraphQL backend occasionally go offline returning `502 Bad Gateway` errors.
* **Coope Work Order Error**: During the payment step in `TC-02`, the API returns a response containing:
  `there is error while calling create work order api in Coope - EnviarSMS: The input string 'OR-xxxxxx' was not in a correct format.`
  This error is suspected of causing backend provisioning failures later in `TC-03` where the final "Create" button fails to produce a success toast.

---

## 5. Next Steps for Next Session

1. **Complete TC-05**: Implement and verify assertions for Recurring Billing Month 01.
2. **Continue Regression Suite**: Continue implementing remaining test cases from the regression suite CSV.
3. **CI/CD Pipeline Update**: Add `DB_HOST`, `DB_USER`, `DB_PASSWORD` to GitLab CI variables.
