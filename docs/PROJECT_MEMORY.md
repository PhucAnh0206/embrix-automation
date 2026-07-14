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
* **Conventions Documentation**: Created unified guideline files at `PROJECT_CONVENTIONS.md` (English) and `docs/personals/PROJECT_CONVENTIONS.md` (Vietnamese).
* **Reusable Components**: `ToastComponent`, `ReactSelectComponent`, `TableComponent`, `SidebarComponent` — all in `pages/components/`.
* **Database Integration**: Generic `DatabaseHelper` using `pg.Pool` (SSL, statement timeout, retry/poll) + domain-specific helpers in `helpers/db/` (e.g. `JobScheduleDbHelper`, `ProvisioningDbHelper`).
* **Active Regression Test Suite (`ts-01.spec.ts`)**: Runs sequentially under `test.describe.serial`. It applies database-level provisioning bypass (`bypassProvisioning`) via `ProvisioningDbHelper`:
  * **TC-00**: Sets system date on the server via GraphQL (generates random future dates to simulate billing periods).
  * **TC-01**: Creates residential account and order via REST API, verifies customer details on UI.
  * **TC-02**: Bypasses provisioning process via database updates and GraphQL, and verifies that the order is completed.
  * **TC-03**: Processes monthly billing jobs for Month 01 and verifies recurring invoice generation.
  * **TC-04**: Processes monthly billing jobs for Month 02 and verifies recurring invoice generation.
* **Legacy Normal Provisioning Suite (`leagcy.spec.ts`)**: A backup/reference E2E test file representing the flow testing with the normal UI/Nokia-based provisioning process, preserved before the decision to implement database-bypass provisioning:
  * **TC-00**: Suite Setup — Set CCP Time.
  * **TC-01**: Residential Account Creation.
  * **TC-03**: Successfully Provisioning An Order (UI order submission + Nokia `FINALIZADO` status verification via Customer Activity).
  * **TC-05**: Recurring Billing Month 01.
  * **TC-06**: Recurring Billing Month 02.
  * **TC-07**: Collection Notification Month 02 (suspension logic verification).
* **Context Reference (`read-context.spec.ts`)**: Created a dedicated guide/spec showcasing how to correctly interact with and update the shared E2E `SavedContext` via helper functions or the `testContext` fixture.

---

## 3. Critical Technical Decisions & Fixes

* **Fixture Centralization & Code Cleanup**:
  * **Decision**: Deleted 10 obsolete individual fixture files (previously under `api-fixtures/` and `pages-fixtures/`) and component/logger fixture files. Centralized all fixture definitions, page/helper instantiations, and page/context extensions in the single [page-factory.ts](file:///d:/Works/EMBRIX/Automation/EmbrixAuto/fixtures/page-factory.ts). This removed ~30% of redundant files from the fixtures directory, improved imports, and eliminated dead code.
* **TestLogger Dual-Write/Write Conflict Fix**:
  * **Issue**: `TestLogger` buffered logs and performed a `flush()` at the end of execution while also synchronously appending each entry to the file via `appendFileSync` on each call. This resulted in duplicate logs in the file.
  * **Fix**: Removed the buffer and simplified `flush()`, letting `TestLogger` write log categories in real-time without conflicts.
* **TypeScript Type Safety**:
  * **Fix**: Replaced broad `any` types in `daily-schedule-flow.helper.ts` and page objects with proper explicit types (e.g. `ServerHelper`, `ToastComponent`, `TestLogger`).
* **Monkey Patching Playwright Page Interface**:
  * **Decision**: To avoid tight coupling and violating the "components do not inherit BasePage" rule, the `waitForLoadingToDisappear()` method was removed from `BasePage` and added directly to Playwright's native `Page` interface via `fixtures/page-factory.ts`. This allows `await this.page.waitForLoadingToDisappear()` to be used safely everywhere. Added error handling (`.catch(() => {})`) to avoid test failure if the loader does not appear.
* **Database Helper Pool (`pg.Pool`)**:
  * **Issue**: `DatabaseHelper` initially used `pg.Client` and called `.end()` after the first query, throwing `Client has already been connected. You cannot reuse a client` on subsequent calls.
  * **Fix**: Switched to `pg.Pool`, which handles checkout, connection, execution, and release automatically, allowing multiple queries to be safely executed by the same helper instance.
* **Sidebar Component Simplification & Stability Fix**:
  * **Issue**: Navigation to Level 3 (`Subscription Data` → `Assets` → `Services`) failed due to incorrect locator nesting. Furthermore, the component was overly complex (224 lines of code, polling bounding boxes, checking `display-none` classes, and using `aria-expanded` attributes which were frequently stale or incorrect in SPA routing, causing flaky tests).
  * **Fix**: Relaxed the `SidebarComponent` locator strategy to search for menu items (`a:has(...)`) *inside* the top-level category container. Then, completely simplified and rewrote the navigation logic down to 120 lines, using actual element visibility (`isVisible()`) as the sole source of truth to decide when to click headers. Added retry logic for SPA-specific toggle issues and wrapped network idle/loader waits in safe `.catch(() => {})` handlers to prevent spurious test failures.
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

## 5. Handover Status & Next Steps

1. **Bypass Provisioning Implementation**: Work is currently in progress for database-bypass provisioning. The helper method `bypassProvisioning()` in `helpers/db/provisioning.db.ts` integrates direct DB status updates with GraphQL calls. This flow is actively tested in `ts-01.spec.ts`. The next developer should refine and finalize the DB bypass model.
2. **Legacy Flow Verification**: For reference, `leagcy.spec.ts` preserves the original, UI-based, normal Nokia provisioning flow (which includes submitting provisioning via the wizard and waiting for Nokia's SMS/Callback activity status `FINALIZADO` inside Customer Activity).
3. **CI/CD Configuration**: Ensure `DB_HOST`, `DB_USER`, and `DB_PASSWORD` variables are added to the GitLab CI environment settings when ready.
4. **Complete Remaining Regression Cases**: Once `bypassProvisioning` is fully stabilized, continue implementing the remaining billing and suspension cases from the regression CSV document.
