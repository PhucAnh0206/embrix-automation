---
aliases: [Credit Note, Debit Note, Adjustments]
tags: [embrix/ar, embrix/credit-note, embrix/debit-note]
type: knowledge
hub: AR
created: 2026-05-07
sources: ["021 Credit Debit Note_pptx.md", "6 - Embrix User Guide - AR Hub_pdf.md"]
---

# 💳 Credit Note & Debit Note

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: AR
> **Related**: [[34-BILL-Invoice-Management]] | [[40-AR-Payment-Processing]] | [[50-REV-GL-Posting]]

---

## 1. Credit Note

| Aspect | Detail |
|--------|--------|
| **Purpose** | Reduce amount owed by customer |
| **Triggers** | Overcharge, service issue, goodwill, proration credit |
| **Effect** | Reduces AR balance, creates negative bill item |
| **Approval** | May require manager approval (configurable) |

## 2. Debit Note

| Aspect | Detail |
|--------|--------|
| **Purpose** | Increase amount owed by customer |
| **Triggers** | Undercharge correction, late fee, additional charges |
| **Effect** | Increases AR balance, creates positive bill item |
| **Approval** | May require manager approval |

## 3. Operations

```
AR Center → Adjustments → + NEW →
  Type: [Credit Note | Debit Note] →
  Select Account → Amount → Reason Code →
  Link to Invoice (optional) → SUBMIT
```

## 4. Reason Codes

| Code | Type | Description |
|------|------|-------------|
| `SVC_ISSUE` | Credit | Service quality issue |
| `OVERCHARGE` | Credit | Billing error correction |
| `GOODWILL` | Credit | Customer retention credit |
| `PRORATION` | Credit | Mid-cycle proration credit |
| `LATE_FEE` | Debit | Late payment penalty |
| `UNDERCHARGE` | Debit | Billing error correction |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
