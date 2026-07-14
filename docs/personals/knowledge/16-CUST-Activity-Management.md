---
aliases:
  - Activity Management
  - Activity Log
  - Audit Trail
tags:
  - embrix/customer
  - embrix/activity
type: knowledge
hub: Customer
created: 2026-05-07
sources:
  - "3 - Embrix User Guide - Customer Hub_pdf.md"
---

# 👤 Activity Management

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]]
> **Hub**: Customer
> **Related**: [[10-CUST-Account-Management]] | [[12-CUST-Order-Management]]

---

## 1. Overview

Activity Management provides a **complete audit trail** of all actions performed on a customer account. Every significant event is recorded as an activity entry.

## 2. Activity Triggers

| Trigger | Activity Type | Details Captured |
|---------|--------------|-----------------|
| Account created | `ACCOUNT_CREATE` | Account ID, type, segment |
| Order submitted | `ORDER_SUBMIT` | Order ID, type, items |
| Payment received | `PAYMENT_RECEIVE` | Amount, method, reference |
| Invoice generated | `INVOICE_GENERATE` | Invoice ID, amount, period |
| Service suspended | `SERVICE_SUSPEND` | Reason (manual/collection) |
| Service resumed | `SERVICE_RESUME` | Trigger (payment/manual) |
| Contact updated | `CONTACT_UPDATE` | Changed fields |
| Note added | `NOTE_ADD` | User, note content |

## 3. Viewing Activities

```
Customer Center → Select Account → Activities Tab →
  Filter by: Date Range, Activity Type, User →
  View chronological activity log
```

## 4. Activity Record Fields

| Field | Description |
|-------|-------------|
| **Timestamp** | When the activity occurred |
| **User** | Who performed the action |
| **Activity Type** | Category of the activity |
| **Description** | Detailed description of what happened |
| **Reference** | Related entity ID (order, invoice, payment) |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
