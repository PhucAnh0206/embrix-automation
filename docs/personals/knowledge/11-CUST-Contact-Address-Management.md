---
aliases:
  - Contact Management
  - Address Management
tags:
  - embrix/customer
  - embrix/contact
  - embrix/address
type: knowledge
hub: Customer
created: 2026-05-07
sources:
  - "003.c Contact and Address Management_pptx.md"
  - "3 - Embrix User Guide - Customer Hub_pdf.md"
---

# 👤 Contact & Address Management

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]]
> **Hub**: Customer
> **Related**: [[10-CUST-Account-Management]] | [[12-CUST-Order-Management]]

---

## 1. Contact Roles

| Role | Required | Description |
|------|----------|-------------|
| **Primary** | Yes | Main point of contact |
| **Billing** | Yes | Receives invoices, payment notices |
| **Shipping** | No | Receives physical deliveries |
| **Technical** | No | Technical support contact |
| **Administrative** | No | Contract and administrative contact |

## 2. Address Roles

| Role | Required | Description |
|------|----------|-------------|
| **Billing** | Yes | Address on invoices |
| **Service** | Yes | Where services are delivered |
| **Shipping** | No | Equipment delivery address |
| **Mailing** | No | General correspondence |

## 3. CRUD Operations

### Contact:
```
Account Data → Contacts → + ADD →
  First Name, Last Name, Email, Phone →
  Select Role(s) → SAVE
```

### Address:
```
Account Data → Addresses → + ADD →
  Street, City, State, ZIP, Country →
  Select Role(s) → SAVE
```

## 4. Validation Rules

| Rule | Description |
|------|-------------|
| At least 1 billing contact required | Cannot remove last billing contact |
| At least 1 billing address required | Cannot remove last billing address |
| Role uniqueness (configurable) | Some roles may allow only one contact/address |
| Address propagation | If enabled, parent address changes cascade to children |

## 5. Error Codes

| Error | Cause |
|-------|-------|
| `ACNT_CNT_ROLE_ALREADY_EXISTS` | Role already assigned to another contact |
| `ADDRESS_ROLE_ALREADY_PRESENT` | Role already assigned to another address |
| `CAN_NOT_REMOVE_CONTACT_ROLE` | Cannot remove mandatory billing contact |
| `CAN_NOT_REMOVE_ADDRESS_ROLE` | Cannot remove mandatory billing address |
| `MISSING_CONTACT_WITH_BILLING_ROLE` | No billing contact provided |
| `MISSING_ADDRESS_WITH_BILLING_ROLE` | No billing address provided |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
