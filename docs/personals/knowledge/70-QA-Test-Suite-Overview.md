---
aliases: [QA Test Suite Overview, Test Strategy]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
sources: ["9 - Embrix QA Test Suite_pdf.md"]
---

# 🧪 QA Test Suite Overview

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: QA

---

## 1. Test Categories

| Category | Scope | Nodes |
|----------|-------|-------|
| **Account Tests** | Account CRUD, hierarchy | [[71-QA-Account-Tests]] |
| **Order Tests** | Order lifecycle, validation | [[72-QA-Order-Tests]] |
| **Billing Tests** | BillCheck, rating, proration | [[73-QA-Billing-Tests]] |
| **Payment Tests** | Payment application, reversal | [[74-QA-Payment-Tests]] |
| **Provisioning Tests** | Network activation | [[75-QA-Provisioning-Tests]] |
| **Usage Tests** | CDR processing, mediation | [[76-QA-Usage-Tests]] |
| **AR Tests** | Collections, aging, write-off | [[77-QA-AR-Tests]] |
| **Revenue Tests** | GL posting, reconciliation | [[78-QA-Revenue-Tests]] |
| **API Tests** | GraphQL/REST endpoints | [[79-QA-API-Tests]] |
| **E2E Tests** | Full lifecycle scenarios | [[80-QA-E2E-Scenarios]] |

## 2. Test Environment

| Environment | Purpose |
|-------------|---------|
| **DEV** | Developer unit testing |
| **QA** | Formal QA testing |
| **UAT** | User acceptance testing |
| **STAGING** | Pre-production validation |
| **PROD** | Production (smoke tests only) |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
