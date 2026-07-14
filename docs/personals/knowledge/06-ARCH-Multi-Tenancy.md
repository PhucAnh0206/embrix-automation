---
aliases:
  - Multi-Tenancy
  - Tenant Isolation
tags:
  - embrix/architecture
  - embrix/multi-tenant
type: knowledge
hub: Architecture
created: 2026-05-07
sources:
  - "000.b Embrix Solution Architecture - Technical_pptx.md"
  - "BRM Technical Training - video 2 (transcribed).md"
---

# 🏗️ Multi-Tenancy

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]]
> **Hub**: Architecture
> **Related**: [[02-ARCH-Microservices-Stack]] | [[64-OPS-Instance-Management]]

---

## 1. Tenant Isolation Strategy

Embrix uses **schema-per-tenant** isolation in PostgreSQL:

| Aspect | Implementation |
|--------|---------------|
| **Isolation Level** | Separate database schema per tenant |
| **Schema Naming** | `{tenant_id}_schema` |
| **Tenant Selection** | `x-broker-id` HTTP header in API calls |
| **Data Access** | jOOQ dynamically selects schema based on tenant context |

## 2. Multi-Tenant Data Model

```
PostgreSQL Instance
├── Tenant: coopeguanacaste (broker-id: COOPEG)
│   └── Schema: coopeg_schema
│       ├── account, contact, address, order, subscription
│       ├── invoice, bill_item, payment
│       └── gl_entry, journal
├── Tenant: embrix-demo (broker-id: EMBRIX)
│   └── Schema: embrix_schema
│       └── (same tables, different data)
└── Shared Schema: public
    └── tenant_config, system_settings
```

## 3. Schema Migrations

| Tool | Purpose |
|------|---------|
| **Flyway** | Version-controlled SQL migrations |
| **Migration Naming** | `V{version}__{description}.sql` |
| **Execution** | Applied per-tenant on deployment |
| **Rollback** | Manual — no auto-rollback |

## 4. Request Routing

```
API Request → API Gateway →
  Extract x-broker-id header →
  Resolve tenant schema →
  Set jOOQ schema context →
  Execute business logic →
  Return response
```

> ⚠️ **Critical**: Missing or invalid `x-broker-id` causes `TENANT_NOT_FOUND` error.

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
