---
aliases: [Account Balance, Balance Inquiry]
tags: [embrix/ar, embrix/balance]
type: knowledge
hub: AR
created: 2026-05-07
sources: ["6 - Embrix User Guide - AR Hub_pdf.md"]
---

# 💳 Account Balance

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: AR
> **Related**: [[40-AR-Payment-Processing]] | [[43-AR-Aging-Report]] | [[34-BILL-Invoice-Management]]

---

## 1. Balance Components

| Component | Description |
|-----------|-------------|
| **Total Billed** | Sum of all invoice amounts |
| **Total Paid** | Sum of all payments applied |
| **Credits** | Sum of credit notes |
| **Debits** | Sum of debit notes |
| **Outstanding Balance** | Total Billed - Total Paid - Credits + Debits |
| **Overdue Balance** | Balance past due date |

## 2. Balance Calculation

```
Outstanding = Σ(Invoices) - Σ(Payments) - Σ(Credits) + Σ(Debits)
Overdue = Outstanding WHERE invoice.dueDate < today
```

## 3. Balance Inquiry (UI)

```
AR Center → Account Balance →
  Search Account → View Balance Summary →
  Drill down: Invoices, Payments, Adjustments
```

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
