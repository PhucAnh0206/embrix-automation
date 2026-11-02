# Automation Effort Estimation Report

This report provides a detailed scan and effort estimation for the automation of test cases in the **COOPEGUANACASTE** and **EMBRIX** sheets from the regression suite.

## Executive Summary

| Sheet | Total Cases | Already Automated | Remaining Cases | Estimated Effort (Hours) | Estimated Effort (Days @ 8h/day) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **COOPEGUANACASTE** | 19 | 3 | 16 | 178.5 | 22.3 |
| **EMBRIX** | 48 | 0 | 48 | 453.5 | 56.7 |
| **TOTAL** | **67** | **3** | **64** | **632.0** | **79.0** |

> [!NOTE]
> - Estimates are calculated assuming **1 Playwright QA Engineer** working full-time (8 hours/day).
> - Already automated cases (TC-01, TC-02, and TC-03 in [ts-01.spec.ts](file:///d:/Works/EMBRIX/Automation/EmbrixAuto/tests/regression/coopeguanacaste/ts-01.spec.ts)) are counted as **0h** remaining effort.
> - Standard step implementation is estimated at **30 minutes/step**.
> - Creating a **new Page Object File** is estimated at **4 hours**.
> - Integration with external system mocks (GraphQL time shift, Nokia backend verification, email checking) includes a **+2.0h complexity buffer**.

## Naming Conventions

Page Object files follow a **hub → area → screen → tab → sub-tab** folder hierarchy using **kebab-case**, matching the Embrix navigation structure confirmed via the Screen-based sheet and live application double-check:

```
pages/
├── login.page.ts
├── base.page.ts
├── components/
│   ├── react-select.component.ts
│   ├── table.component.ts
│   └── toast.component.ts
├── customer-hub/
│   ├── customer-management/
│   │   ├── customer-management.page.ts          (Search Accounts, Create New, Quick Create)
│   │   └── account-details/
│   │       ├── account-details-sidebar.ts
│   │       ├── account-data/
│   │       │   ├── account-info.page.ts          (Account Info)
│   │       │   ├── contact.page.ts               [NEW] (Contact)
│   │       │   ├── addresses.page.ts             [NEW] (Addresses)
│   │       │   ├── payment-profile.page.ts       [NEW] (Payment Profile)
│   │       │   ├── billing-profile.page.ts       [NEW] (Billing Profile)
│   │       │   ├── custom-attributes.page.ts     [NEW] (Custom Attributes)
│   │       │   ├── tax-enterprises.page.ts       [NEW] (Tax Enterprises)
│   │       │   ├── hierarchy.page.ts             [NEW] (Hierachy)
│   │       │   ├── tasks.page.ts                 [NEW] (Tasks)
│   │       │   ├── payment-installment.page.ts   [NEW] (Payment Installment)
│   │       │   ├── xchange-rates.page.ts         [NEW] (Xchange Rates)
│   │       │   ├── external-po.page.ts           [NEW] (External PO)
│   │       │   └── customer-activity.page.ts     [NEW] (Customer Activity)
│   │       ├── subscription-data/
│   │       │   ├── services.page.ts              (Assets views, Provisioning, Others)
│   │       │   ├── subscription-view.page.ts     [NEW] (Assets - Subscription View)
│   │       │   ├── offers.page.ts                [NEW] (Assets - Offers)
│   │       │   ├── billable-services.page.ts     [NEW] (Assets - Billable Services)
│   │       │   └── provisioning.page.ts          [NEW] (Provisioning - Data/Attributes)
│   │       ├── billing-data/
│   │       │   ├── bills.page.ts                 (Bills)
│   │       │   ├── balances.page.ts              [NEW] (Balances)
│   │       │   ├── topup.page.ts                 [NEW] (Topup)
│   │       │   ├── lading-bill.page.ts           [NEW] (Lading Bill)
│   │       │   ├── transactions.page.ts          [NEW] (Transactions)
│   │       │   ├── rated-usage.page.ts           [NEW] (Rated Usage)
│   │       │   ├── usage-records.page.ts         [NEW] (Usage Records)
│   │       │   ├── ar-request-log.page.ts        [NEW] (AR Request Log)
│   │       │   ├── ar-ops-units.page.ts          [NEW] (AR Ops Units)
│   │       │   ├── payments.page.ts              [NEW] (Payments)
│   │       │   ├── invoice-payment-installment.page.ts [NEW]
│   │       │   ├── credit-debit-notes.page.ts    [NEW] (Credit/Debit Notes)
│   │       │   └── account-statement.page.ts     [NEW] (Account Statement)
│   │       └── sharing/
│   │           ├── charge-share.page.ts          [NEW] (Charge Share)
│   │           └── discount-share.page.ts        [NEW] (Discount Share)
│   ├── quote-management/
│   │   └── quote-management.page.ts              [NEW] (Search/New/Modify/Upgrade/Downgrade Quote)
│   └── order-management/
│       └── order-management.page.ts              (Search/New/Modify/etc. Order)
├── billing-hub/
│   ├── billing/
│   │   ├── config/
│   │   │   ├── delayed-billing.page.ts           [NEW]
│   │   │   ├── pending-bill-trigger.page.ts      [NEW]
│   │   │   └── in-advance-billing.page.ts        [NEW]
│   │   ├── te/
│   │   │   └── te.page.ts                        [NEW] (T&E screens)
│   │   └── bulk-operations/
│   │       └── bulk-operations.page.ts           [NEW] (Invoices, Saved Manual Bills)
│   ├── taxation/
│   │   ├── tax-type-config.page.ts               [NEW]
│   │   ├── tax-code-config.page.ts               [NEW]
│   │   └── third-party-tax-config.page.ts        [NEW]
│   └── usage/
│       ├── mediation-setup.page.ts               [NEW]
│       ├── usage-config.page.ts                  [NEW]
│       ├── operator-process.page.ts              [NEW]
│       └── usage-ops.page.ts                     [NEW]
├── pricing-hub/
│   ├── base-configurations/
│   │   ├── resources/
│   │   │   ├── currency.page.ts                  [NEW]
│   │   │   ├── grants.page.ts                    [NEW]
│   │   │   └── accumulators.page.ts              [NEW]
│   │   └── pricing-config/
│   │       ├── usage-type.page.ts                [NEW]
│   │       ├── unit-of-measure.page.ts           [NEW]
│   │       ├── rate-unit.page.ts                 [NEW]
│   │       └── zone-unit.page.ts                 [NEW]
│   ├── pricing-management/
│   │   ├── provisioning-config.page.ts           [NEW]
│   │   ├── pricing-catalog/
│   │   │   ├── product-family.page.ts            [NEW]
│   │   │   ├── item.page.ts                      [NEW]
│   │   │   ├── billable-services.page.ts         [NEW]
│   │   │   ├── price-offer.page.ts               [NEW]
│   │   │   ├── discount-trigger.page.ts          [NEW]
│   │   │   └── discount-offer.page.ts            [NEW]
│   │   └── prepaid-config/
│   │       └── topup-offers.page.ts              [NEW]
│   └── bundle-management/
│       ├── bundle.page.ts                        [NEW]
│       ├── package.page.ts                       [NEW]
│       └── dependency.page.ts                    [NEW]
├── ar-hub/
│   ├── payments/
│   │   ├── payment-admin/
│   │   │   ├── payment-config.page.ts            [NEW]
│   │   │   ├── batch-file.page.ts                [NEW]
│   │   │   ├── item-map.page.ts                  [NEW]
│   │   │   ├── payment-surcharge.page.ts         [NEW]
│   │   │   └── allocation-rules.page.ts          [NEW]
│   │   ├── payment-operations/
│   │   │   ├── payment-history.page.ts           [NEW]
│   │   │   ├── manual-payment.page.ts            [NEW]
│   │   │   └── payment-suspense.page.ts          [NEW]
│   │   └── batch-processing/
│   │       └── process-payment.page.ts           [NEW]
│   ├── collections/
│   │   ├── collection-config/
│   │   │   ├── profile.page.ts                   [NEW]
│   │   │   ├── actions.page.ts                   [NEW]
│   │   │   ├── schedule.page.ts                  [NEW]
│   │   │   └── agents.page.ts                    [NEW]
│   │   ├── collection-admin/
│   │   │   ├── actions.page.ts                   [NEW]
│   │   │   └── agent-activity.page.ts            [NEW]
│   │   └── collection-agents/
│   │       ├── accounts-in-collection.page.ts    [NEW]
│   │       └── collection-aging.page.ts          [NEW]
│   └── ar-operations/
│       ├── config/
│       │   ├── gl-setup.page.ts                  [NEW]
│       │   ├── item-map.page.ts                  [NEW]
│       │   ├── reason-code.page.ts               [NEW]
│       │   ├── group-reasons.page.ts             [NEW]
│       │   └── ar-thresholds.page.ts             [NEW]
│       ├── ar-operations/
│       │   ├── adjustment.page.ts                [NEW]
│       │   ├── disputes.page.ts                  [NEW]
│       │   └── write-offs.page.ts                [NEW]
│       └── bulk-operations/
│           ├── bulk-adjustments.page.ts          [NEW]
│           └── credit-notes.page.ts              [NEW]
├── revenue-hub/
│   ├── configuration/
│   │   ├── multi-org-setup/
│   │   │   ├── locations.page.ts                 [NEW]
│   │   │   ├── enterprise.page.ts                [NEW]
│   │   │   ├── divisions.page.ts                 [NEW]
│   │   │   ├── legal-entity.page.ts              [NEW]
│   │   │   ├── business-units.page.ts            [NEW]
│   │   │   ├── departments.page.ts               [NEW]
│   │   │   └── cost-center.page.ts               [NEW]
│   │   ├── base-configurations/
│   │   │   ├── gl-setup.page.ts                  [NEW]
│   │   │   ├── gl-accounts.page.ts               [NEW]
│   │   │   ├── cost-center-mapping.page.ts       [NEW]
│   │   │   ├── revenue-milestones.page.ts        [NEW]
│   │   │   └── erp-extract-batch.page.ts         [NEW]
│   │   ├── four-cs/
│   │   │   ├── chart-of-account.page.ts          [NEW]
│   │   │   ├── calendar.page.ts                  [NEW]
│   │   │   ├── currency-exchange.page.ts         [NEW]
│   │   │   └── accounting-convention.page.ts     [NEW]
│   │   └── ledger/
│   │       ├── primary.page.ts                   [NEW]
│   │       ├── secondary.page.ts                 [NEW]
│   │       └── reporting.page.ts                 [NEW]
│   └── revenue/
│       ├── journals.page.ts                      [NEW]
│       ├── accounting-log.page.ts                [NEW]
│       ├── erp-extracts.page.ts                  [NEW]
│       └── accounting-reconciliation.page.ts     [NEW]
├── operations-hub/
│   ├── user-management/
│   │   ├── roles.page.ts                         [NEW]
│   │   ├── role-groups.page.ts                   [NEW]
│   │   ├── users.page.ts                         [NEW]
│   │   ├── user-groups.page.ts                   [NEW]
│   │   └── approvals.page.ts                     [NEW]
│   ├── jobs-management/
│   │   ├── config/
│   │   │   └── job-schedule-config.page.ts       [NEW]
│   │   └── jobs-management.page.ts               [NEW]
│   ├── correspondence/
│   │   └── templates.page.ts                     [NEW]
│   ├── reports/
│   │   └── reports.page.ts                       [NEW]
│   ├── dashboard/
│   │   └── dashboard.page.ts                     [NEW]
│   ├── tenant-management/
│   │   ├── tenant-data.page.ts                   [NEW]
│   │   ├── tenant-config/
│   │   │   ├── id-sequence-config.page.ts        [NEW]
│   │   │   ├── schedule-pattern.page.ts          [NEW]
│   │   │   ├── selfcare-marketing.page.ts        [NEW]
│   │   │   ├── policy-enables.page.ts            [NEW]
│   │   │   ├── folio-response-file.page.ts       [NEW]
│   │   │   ├── templates.page.ts                 [NEW]
│   │   │   └── product-support-task.page.ts      [NEW]
│   │   ├── crm-gateway.page.ts                   [NEW]
│   │   ├── provisioning-gateway.page.ts          [NEW]
│   │   ├── tax-gateway.page.ts                   [NEW]
│   │   ├── payment-gateway.page.ts               [NEW]
│   │   ├── finance-gateway.page.ts               [NEW]
│   │   ├── document-gateway.page.ts              [NEW]
│   │   ├── customer-support-gateway.page.ts      [NEW]
│   │   ├── operation-gateway.page.ts             [NEW]
│   │   └── project-gateway.page.ts               [NEW]
│   └── task-management/
│       └── tasks.page.ts                         [NEW]
```

## Detailed Estimate: COOPEGUANACASTE Sheet

**Start Date:** `05/06/26` _(dd/mm/yy)_

| TC ID | Test Case Name | Priority | Steps | Page Objects Required | Status | Est. Effort (Hours) | Work-Days | Estimated Date |
| :--- | :--- | :---: | :---: | :--- | :---: | :---: | :---: | :---: |
| TC-01 | Residential Account Creation | P1 | 1 | None (use existing) | ✅ Automated | 0 | 0 | - |
| TC-02 | Installation Invoice Payment | P1 | 1 | None (use existing) | ✅ Automated | 0 | 0 | - |
| TC-03 | Successful Provisioning | P1 | 12 | `customer-hub/customer-management/customer-management.page.ts`, `customer-hub/order-management/order-management.page.ts`, `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ✅ Automated | 0 | 0 | - |
| TC-04 | Grace Period Billing | P1 | 3 | `operations-hub/jobs-management/jobs-management.page.ts` [NEW] | ⏳ Pending | 6 | 0.75 | 08/06/26 |
| TC-05 | Recurring Billing Month 01 | P1 | 3 | `operations-hub/jobs-management/jobs-management.page.ts` [NEW] | ⏳ Pending | 6 | 0.75 | 09/06/26 |
| TC-06 | Recurring Billing Month 02 | P1 | 3 | `operations-hub/jobs-management/jobs-management.page.ts` [NEW] | ⏳ Pending | 6 | 0.75 | 10/06/26 |
| TC-07 | Collection Notification Month 02 | P1 | 6 | `operations-hub/jobs-management/jobs-management.page.ts` [NEW], `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW] | ⏳ Pending | 13.5 | 1.69 | 11/06/26 |
| TC-08 | Full Billing, Collections, Notifications, Suspension and Reconnection Flow (Month 01 to Month 05) | P1 | 20 | `operations-hub/jobs-management/jobs-management.page.ts` [NEW], `ar-hub/ar-operations/ar-operations/adjustment.page.ts` [NEW], `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW], `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ⏳ Pending | 24.5 | 3.06 | 16/06/26 |
| TC-09 | Validate Full Collections Flow with Payments, Billing and Plan Change | P1 | 13 | `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW] | ⏳ Pending | 11 | 1.38 | 18/06/26 |
| TC-10 | Validate Full Residential Account Grace Period (Extension) Flow | P3 | 12 | `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW] | ⏳ Pending | 12.5 | 1.56 | 19/06/26 |
| TC-TEMP-11 | Validate Full Residential Account Grace Period (Extension) Flow | P2 | 6 | `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW], `customer-hub/customer-management/customer-management.page.ts`, `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/account-data/payment-installment.page.ts` [NEW] | ⏳ Pending | 13.5 | 1.69 | 23/06/26 |
| TC-11 | Validate Credit Note Flow | P2 | 9 | `ar-hub/ar-operations/ar-operations/adjustment.page.ts` [NEW], `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW] | ⏳ Pending | 15 | 1.88 | 25/06/26 |
| TC-12 | Validate Debit Note Flow | P3 | 9 | `ar-hub/ar-operations/ar-operations/adjustment.page.ts` [NEW], `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW] | ⏳ Pending | 15 | 1.88 | 29/06/26 |
| TC-13 | Validate Equipment Retrieval (Cancellation) Order Flow | P2 | 14 | `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW] | ⏳ Pending | 13.5 | 1.69 | 01/07/26 |
| TC-14 | Intercompany Residential Account End-to-End Flow | P2 | 15 | None (use existing) | ⏳ Pending | 10 | 1.25 | 02/07/26 |
| TC-15 | Residential Account with Tax Exemption Validation | P3 | 12 | `customer-hub/customer-management/customer-management.page.ts`, `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/account-data/payment-installment.page.ts` [NEW], `customer-hub/customer-management/account-details/account-data/custom-attributes.page.ts` [NEW] | ⏳ Pending | 16.5 | 2.06 | 06/07/26 |
| TC-16 | PHC Account Creation with Required Bundles | P3 | 11 | None (use existing) | ⏳ Pending | 8 | 1 | 07/07/26 |
| TC17 | Subscription Data / Offers – Filter Active Offers | P1 | 7 | `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ⏳ Pending | 4 | 0.5 | 07/07/26 |
| TC66 | Account Data / Tasks – Installment Payment Plan Creation | P1 | 6 | None (use existing) | ⏳ Pending | 3.5 | 0.44 | 08/07/26 |

## Detailed Estimate: EMBRIX Sheet

**Start Date:** `08/07/26` _(dd/mm/yy — continues from COOPEGUANACASTE end date)_

| TC ID | Test Case Name | Priority | Steps | Page Objects Required | Status | Est. Effort (Hours) | Work-Days | Estimated Date |
| :--- | :--- | :---: | :---: | :--- | :---: | :---: | :---: | :---: |
| TC-18 | Residential Account and Order Creation with Internet Bundle | P1 | 34 | `customer-hub/customer-management/customer-management.page.ts`, `customer-hub/order-management/order-management.page.ts` | ⏳ Pending | 17.5 | 2.19 | 13/07/26 |
| TC19 | Create Quotation in Embrix | P3 | 24 | `pricing-hub/pricing-management/pricing-catalog/product-family.page.ts` [NEW], `customer-hub/customer-management/customer-management.page.ts` | ⏳ Pending | 16.5 | 2.06 | 15/07/26 |
| TC20 | Send Existing Order from Order Management | P1 | 12 | `customer-hub/customer-management/customer-management.page.ts`, `customer-hub/order-management/order-management.page.ts` | ⏳ Pending | 6.5 | 0.81 | 16/07/26 |
| TC21 | Invoice Consultation and Validation in Billing Center | P2 | 18 | `billing-hub/billing/bulk-operations/bulk-operations.page.ts` [NEW], `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/account-data/payment-installment.page.ts` [NEW] | ⏳ Pending | 17.5 | 2.19 | 20/07/26 |
| TC22 | Billing Center / Taxes – Tax Code Configuration | P3 | 24 | `billing-hub/taxation/tax-code-config.page.ts` [NEW] | ⏳ Pending | 16.5 | 2.06 | 22/07/26 |
| TC23 | Billing Center – Usage | P3 | 19 | `billing-hub/usage/usage-config.page.ts` [NEW] | ⏳ Pending | 14 | 1.75 | 24/07/26 |
| TC24 | Pricing Center – Basic Configurations (Currency) | P1 | 12 | `pricing-hub/base-configurations/resources/currency.page.ts` [NEW] | ⏳ Pending | 10.5 | 1.31 | 27/07/26 |
| TC25 | Pricing Center – Price Management (Product Family) | P3 | 11 | `pricing-hub/pricing-management/pricing-catalog/product-family.page.ts` [NEW] | ⏳ Pending | 10 | 1.25 | 28/07/26 |
| TC26 | Pricing Center – Package Management | P1 | 4 | `pricing-hub/bundle-management/package.page.ts` [NEW] | ⏳ Pending | 6.5 | 0.81 | 29/07/26 |
| TC27 | Payment History Inquiry in A/R Center | P3 | 12 | `ar-hub/payments/payment-operations/payment-history.page.ts` [NEW] | ⏳ Pending | 10.5 | 1.31 | 30/07/26 |
| TC28 | View Invoice Units in Collections | P1 | 12 | `ar-hub/collections/collection-agents/accounts-in-collection.page.ts` [NEW] | ⏳ Pending | 10.5 | 1.31 | 03/08/26 |
| TC29 | A/R Center Flow Validation | P3 | 22 | `ar-hub/ar-operations/ar-operations/adjustment.page.ts` [NEW], `ar-hub/ar-operations/ar-operations/disputes.page.ts` [NEW], `ar-hub/ar-operations/ar-operations/write-offs.page.ts` [NEW] | ⏳ Pending | 15.5 | 1.94 | 04/08/26 |
| TC30 | Revenue Center / Configuration | P3 | 7 | `revenue-hub/configuration/multi-org-setup/locations.page.ts` [NEW], `revenue-hub/configuration/base-configurations/gl-setup.page.ts` [NEW] | ⏳ Pending | 8 | 1 | 05/08/26 |
| TC31 | Revenue Center / Revenues | P3 | 11 | `revenue-hub/revenue/journals.page.ts` [NEW], `revenue-hub/revenue/accounting-log.page.ts` [NEW] | ⏳ Pending | 10 | 1.25 | 07/08/26 |
| TC32 | Operations Center / User Management – Successful Creation and Modification | P1 | 13 | `operations-hub/user-management/users.page.ts` [NEW], `customer-hub/customer-management/account-details/account-data/contact.page.ts` [NEW], `customer-hub/customer-management/account-details/account-data/addresses.page.ts` [NEW] | ⏳ Pending | 19 | 2.38 | 11/08/26 |
| TC33 | Operations Center / Work Management – Work Calendar Information Validation | P1 | 4 | `operations-hub/jobs-management/jobs-management.page.ts` [NEW] | ⏳ Pending | 6.5 | 0.81 | 12/08/26 |
| TC34 | Operations Center / Correspondence – Template Configuration and Download Validation | P2 | 6 | `operations-hub/correspondence/templates.page.ts` [NEW] | ⏳ Pending | 7.5 | 0.94 | 13/08/26 |
| TC35 | Operations Center / Reports – Accounts Report Validation | P1 | 7 | `operations-hub/reports/reports.page.ts` [NEW] | ⏳ Pending | 8 | 1 | 14/08/26 |
| TC36 | Operations Center / Instance Management – Successful Modification | P3 | 11 | `operations-hub/tenant-management/tenant-data.page.ts` [NEW] | ⏳ Pending | 12 | 1.5 | 17/08/26 |
| TC37 | Operations Center / Task Administration – Successful Task Creation | P3 | 11 | `operations-hub/task-management/tasks.page.ts` [NEW] | ⏳ Pending | 10 | 1.25 | 19/08/26 |
| TC38 | Account Data / Account Information – Customer Segment Modification | P1 | 8 | `customer-hub/customer-management/account-details/account-data/account-info.page.ts` | ⏳ Pending | 4.5 | 0.56 | 19/08/26 |
| TC39 | Account Data / Contact – Contact Modification and Creation | P1 | 8 | `customer-hub/customer-management/account-details/account-data/contact.page.ts` [NEW] | ⏳ Pending | 8.5 | 1.06 | 20/08/26 |
| TC40 | Account Data / Addresses – Address Creation and Modification | P1 | 10 | `customer-hub/customer-management/account-details/account-data/addresses.page.ts` [NEW] | ⏳ Pending | 9.5 | 1.19 | 21/08/26 |
| TC41 | Account Data / Payment Profile – Payment Method Modification | P1 | 9 | `customer-hub/customer-management/account-details/account-data/payment-profile.page.ts` [NEW] | ⏳ Pending | 9 | 1.13 | 25/08/26 |
| TC42 | Account Data / Billing Profile – Annual Billing Modification | P1 | 8 | `customer-hub/customer-management/account-details/account-data/billing-profile.page.ts` [NEW] | ⏳ Pending | 8.5 | 1.06 | 26/08/26 |
| TC43 | Account Data / Custom Attributes & Tax Exemptions – Configuration and Modification | P2 | 18 | `customer-hub/customer-management/account-details/account-data/custom-attributes.page.ts` [NEW] | ⏳ Pending | 13.5 | 1.69 | 27/08/26 |
| TC44 | Account Data / Hierarchy – Move Account to Parent Hierarchy | P3 | 12 | `customer-hub/customer-management/account-details/account-data/payment-profile.page.ts` [NEW], `customer-hub/customer-management/account-details/account-data/hierarchy.page.ts` [NEW] | ⏳ Pending | 14.5 | 1.81 | 31/08/26 |
| TC45 | Account Data / Tasks – Installment Payment Plan Creation | P1 | 6 | None (use existing) | ⏳ Pending | 3.5 | 0.44 | 01/09/26 |
| TC46 | Account Data / Exchange Rates – External Purchase Order Configuration | P3 | 16 | `customer-hub/customer-management/account-details/account-data/xchange-rates.page.ts` [NEW] | ⏳ Pending | 12.5 | 1.56 | 02/09/26 |
| TC47 | Subscription Data / Subscription View – Active Subscription Detail | P2 | 7 | `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ⏳ Pending | 4 | 0.5 | 03/09/26 |
| TC48 | Subscription Data / Services – Service Creation and Order Approval | P2 | 10 | `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ⏳ Pending | 5.5 | 0.69 | 03/09/26 |
| TC49 | Subscription Data / Offers – Filter Active Offers | P1 | 7 | `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ⏳ Pending | 4 | 0.5 | 04/09/26 |
| TC50 | Subscription Data / Billable Services – Filter and Export | P3 | 6 | `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ⏳ Pending | 3.5 | 0.44 | 04/09/26 |
| TC51 | Subscription Data / Provisioning Inquiry – View Provisioning Data | P2 | 5 | None (use existing) | ⏳ Pending | 3 | 0.38 | 07/09/26 |
| TC52 | Subscription Data / Attributes – View Provisioned Asset Attributes | P2 | 4 | `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ⏳ Pending | 2.5 | 0.31 | 07/09/26 |
| TC53 | Billing Data / Subscription Balance Inquiry – View Subscription Balances | P2 | 5 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/balances.page.ts` [NEW] | ⏳ Pending | 7 | 0.88 | 08/09/26 |
| TC54 | Billing Data / Invoice Management – View and Manage Invoices | P2 | 11 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/invoice-payment-installment.page.ts` [NEW] | ⏳ Pending | 10 | 1.25 | 09/09/26 |
| TC55 | Billing Data / Waybill Management – Inquiry and Transfer | P2 | 8 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/lading-bill.page.ts` [NEW] | ⏳ Pending | 8.5 | 1.06 | 10/09/26 |
| TC56 | Billing Data / Transactions – View Transaction Detail and Recurring Data | P2 | 10 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/transactions.page.ts` [NEW] | ⏳ Pending | 9.5 | 1.19 | 11/09/26 |
| TC57 | Billing Data / Rated Usage Inquiry – Filter Rated Usage Transactions | P2 | 6 | `billing-hub/usage/usage-ops.page.ts` [NEW], `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/rated-usage.page.ts` [NEW] | ⏳ Pending | 11.5 | 1.44 | 15/09/26 |
| TC58 | Billing Data / Usage Records – Filter and Export Usage Data | P2 | 6 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/usage-records.page.ts` [NEW] | ⏳ Pending | 7.5 | 0.94 | 16/09/26 |
| TC59 | Subscription & Billing Data / AR Request Log – Filter AR Requests | P2 | 6 | `ar-hub/ar-operations/ar-operations/adjustment.page.ts` [NEW], `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/ar-request-log.page.ts` [NEW], `customer-hub/customer-management/account-details/subscription-data/services.page.ts` | ⏳ Pending | 11.5 | 1.44 | 17/09/26 |
| TC60 | Billing Data / AR Operation Units – Filter by Item ID | P2 | 5 | `ar-hub/ar-operations/ar-operations/adjustment.page.ts` [NEW], `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/ar-ops-units.page.ts` [NEW] | ⏳ Pending | 11 | 1.38 | 21/09/26 |
| TC61 | Billing Data / Payments – Filter Payments by Date, Status, Reference and Invoice | P2 | 8 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/payments.page.ts` [NEW] | ⏳ Pending | 8.5 | 1.06 | 22/09/26 |
| TC62 | Billing Data / Invoice Payment Due Dates – Filter Payments by Due Date and Invoice | P2 | 8 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/invoice-payment-installment.page.ts` [NEW] | ⏳ Pending | 8.5 | 1.06 | 23/09/26 |
| TC63 | Billing Data / Credit and Debit Notes – Filter by Date Range and Note Type | P2 | 7 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/credit-debit-notes.page.ts` [NEW] | ⏳ Pending | 8 | 1 | 24/09/26 |
| TC64 | Billing Data / Account Statement – Filter, Export and View Notes | P2 | 10 | `customer-hub/customer-management/account-details/billing-data/bills.page.ts`, `customer-hub/customer-management/account-details/billing-data/account-statement.page.ts` [NEW] | ⏳ Pending | 9.5 | 1.19 | 25/09/26 |
| TC65 | Billing Data / Shared Charge Configuration – Create New Shared Charge | P2 | 5 | None (use existing) | ⏳ Pending | 3 | 0.38 | 25/09/26 |

## Estimated Date Calculation Guide

> [!IMPORTANT]
> **How the "Estimated Date" column is computed:**
>
> - **Formula:** `Estimated Date(n) = addBusinessDays(Estimated Date(n-1), ceil(Work-Days(n)))`
> - The first pending row starts from the **Start Date** cell.
> - Saturdays and Sundays are skipped (only business days count).
> - Fractional Work-Days are accumulated and rounded up to whole business days.
> - Rows with 0 Work-Days (already automated) are skipped.
>
> **To recalculate with a different Start Date**, run:
> ```bash
> node docs/calculate-dates.js <dd/mm/yy>
> ```
> Example: `node docs/calculate-dates.js 05/06/26`
>
> Current dates above are calculated with **Start Date = 05/06/26**.
> **Projected end date: 25/09/26** (approximately 79 business days).
