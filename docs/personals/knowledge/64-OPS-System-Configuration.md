---
aliases: [System Configuration, System Parameters]
tags: [embrix/operations, embrix/config]
type: knowledge
hub: Operations
created: 2026-05-07
sources: ["8 - Embrix User Guide - Operations Hub_pdf.md"]
---

# ⚙️ System Configuration

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Operations
> **Related**: [[06-ARCH-Multi-Tenancy]] | [[08-ARCH-DevOps-Deployment]]

---

## 1. Configuration Categories

| Category | Examples |
|----------|---------|
| **Billing** | BDOM range, proration method, payment terms |
| **Tax** | Tax rates, jurisdictions |
| **Notification** | Email server, templates |
| **Security** | Password policy, session timeout |
| **Integration** | API keys, external system URLs |
| **UI** | Theme, logo, language |

## 2. Configuration Levels

| Level | Scope |
|-------|-------|
| **System** | All tenants (Super Admin only) |
| **Tenant** | Specific tenant (overrides system) |
| **User** | User-specific preferences |

## 3. Hot vs Cold Configuration

| Type | Description | Restart Required |
|------|-------------|:----------------:|
| **Hot** | Takes effect immediately | No |
| **Cold** | Requires service restart | Yes |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
