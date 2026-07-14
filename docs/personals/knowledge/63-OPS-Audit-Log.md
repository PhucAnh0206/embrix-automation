---
aliases: [Audit Log, Activity Tracking, System Audit]
tags: [embrix/operations, embrix/audit]
type: knowledge
hub: Operations
created: 2026-05-07
sources: ["8 - Embrix User Guide - Operations Hub_pdf.md"]
---

# ⚙️ Audit Log

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Operations
> **Related**: [[16-CUST-Activity-Management]] | [[60-OPS-User-Management]]

---

## 1. Logged Events

| Category | Events |
|----------|--------|
| **Authentication** | Login, logout, failed login, password change |
| **Data Changes** | Create, update, delete on any entity |
| **Billing Operations** | BillCheck, InvoiceCheck, payment processing |
| **System Config** | Role changes, parameter updates |
| **API Calls** | GraphQL/REST requests (configurable) |

## 2. Audit Record Fields

| Field | Description |
|-------|-------------|
| **Timestamp** | When the event occurred |
| **User** | Who performed the action |
| **Action** | CREATE / UPDATE / DELETE / LOGIN / etc. |
| **Entity** | What was affected |
| **Before** | Previous value (for updates) |
| **After** | New value (for updates) |
| **IP Address** | Client IP |

## 3. Retention and Search

```
Operations → Audit Log →
  Filter: Date range, User, Action, Entity →
  Export: CSV
```

> Retention period: configurable, default 365 days.

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
