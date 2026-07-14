---
aliases: [Troubleshooting Guide, Common Issues]
tags: [embrix/operations, embrix/troubleshooting]
type: knowledge
hub: Operations
created: 2026-05-07
sources: ["8 - Embrix User Guide - Operations Hub_pdf.md"]
---

# ⚙️ Troubleshooting Guide

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Operations
> **Related**: [[61-OPS-Jobs-Management]] | [[63-OPS-Audit-Log]]

---

## 1. Common Issues

| Issue | Cause | Resolution |
|-------|-------|------------|
| **BillCheck not running** | BDOM mismatch, job disabled | Check job config, verify BDOM accounts |
| **Invoice amount = 0** | No active subscription, no price offer | Verify subscription + price offer linkage |
| **CDR not rated** | No matching price rule | Configure usage pricing, check stream config |
| **Payment not applied** | Account mismatch, wrong currency | Match payment to correct account/currency |
| **Provisioning failed** | Nokia adapter timeout | Check Nokia NetAct connectivity |
| **Login failure** | Account locked, wrong credentials | Reset password or unlock via Admin |

## 2. Diagnostic Commands

```
# Check job status
Operations → Jobs → Filter: Failed → View error details

# Check provisioning
Customer Center → Orders → View Order → Provisioning Status

# Check CDR errors
Billing → Usage → Error Queue → View unmatched CDRs
```

## 3. Escalation Path

| Level | Action |
|-------|--------|
| **L1 — CSR** | Basic troubleshooting, account checks |
| **L2 — Operations** | Job management, system config |
| **L3 — Engineering** | Code-level debugging, database fixes |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
