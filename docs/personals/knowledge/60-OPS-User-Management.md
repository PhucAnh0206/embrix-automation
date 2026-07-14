---
aliases: [User Management, RBAC, Role-Based Access]
tags: [embrix/operations, embrix/user-mgmt]
type: knowledge
hub: Operations
created: 2026-05-07
sources: ["8 - Embrix User Guide - Operations Hub_pdf.md"]
---

# ⚙️ User Management

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Operations
> **Related**: [[06-ARCH-Multi-Tenancy]] | [[62-OPS-Notification-Engine]]

---

## 1. User Model

| Field | Description |
|-------|-------------|
| **Username** | Login identifier |
| **Email** | Contact email |
| **Role** | RBAC role assignment |
| **Tenant** | Which tenant(s) the user can access |
| **Status** | Active / Inactive / Locked |

## 2. RBAC Roles

| Role | Access Level |
|------|-------------|
| **Super Admin** | Full system access, all tenants |
| **Tenant Admin** | Full access within their tenant |
| **Billing Admin** | Billing & AR operations |
| **CSR** | Customer service — read + limited write |
| **Finance** | Revenue reports, GL, payments |
| **Read Only** | View-only access |

## 3. Permissions Matrix

| Module | Super Admin | Tenant Admin | CSR | Finance |
|--------|:-----------:|:------------:|:---:|:-------:|
| Accounts | CRUD | CRUD | RU | R |
| Orders | CRUD | CRUD | CR | R |
| Billing | CRUD | CRUD | R | R |
| Payments | CRUD | CRUD | R | CRUD |
| GL/Revenue | CRUD | R | - | R |
| System Config | CRUD | R | - | - |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
