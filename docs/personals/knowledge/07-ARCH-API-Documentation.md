---
aliases:
  - API Documentation
  - GraphQL API
  - REST API
tags:
  - embrix/architecture
  - embrix/api
type: knowledge
hub: Architecture
created: 2026-05-07
sources:
  - "Embrix_API_Documentation.md"
  - "Embrix KT -- UI Access _ Local Endpoints (transcribed).md"
---

# 🏗️ API Documentation

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]]
> **Hub**: Architecture
> **Related**: [[02-ARCH-Microservices-Stack]] | [[92-REF-API-Endpoints]]

---

## 1. API Architecture

| Aspect | Detail |
|--------|--------|
| **Primary Protocol** | GraphQL |
| **Secondary Protocol** | REST (file operations, health checks) |
| **Endpoint** | `{base_url}/graphql` |
| **Documentation** | GraphiQL explorer + Postman collections |
| **Authentication** | Bearer token + x-tenant-id + x-broker-id |

## 2. Environment Configuration

| Environment | Core UI | API Base |
|-------------|---------|----------|
| **Develop** | `coreui.dev.embrix.org` | `api.dev.embrix.org/graphql` |
| **Sandbox** | `coreui.sandbox.embrix.org` | `api.sandbox.embrix.org/graphql` |
| **Production** | `coreui.{tenant}.embrix.org` | `api.{tenant}.embrix.org/graphql` |

## 3. Request Headers

```
Authorization: Bearer {token}
Content-Type: application/json
x-tenant-id: {tenantId}
x-broker-id: {brokerId}
```

> ⚠️ `x-broker-id` is **mandatory** for all API calls. It determines which tenant database to use.

## 4. Postman Collections

Available collections for testing:
- Account Management, Order Management, Billing Operations
- Payment Processing, AR Operations, Collections
- System Administration (date change, job execution)

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
