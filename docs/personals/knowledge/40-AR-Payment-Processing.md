---
aliases: [Payment Processing, Payment Methods]
tags: [embrix/ar, embrix/payment]
type: knowledge
hub: AR
created: 2026-05-07
sources: ["019 Payment Processing_pptx.md", "6 - Embrix User Guide - AR Hub_pdf.md"]
---

# 💳 Payment Processing

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: AR
> **Related**: [[34-BILL-Invoice-Management]] | [[41-AR-Collections]] | [[43-AR-Aging-Report]]

---

## 1. Payment Methods

| Method | Type | Description |
|--------|------|-------------|
| **Cash** | Manual | In-person cash payment |
| **Check** | Manual | Physical check |
| **Bank Transfer** | Manual/Auto | Wire transfer, ACH |
| **Credit Card** | Auto | Card payment via gateway |
| **Direct Debit** | Auto | Automatic bank deduction |
| **Online Payment** | Auto | Payment portal |

## 2. Payment Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Pending: Payment initiated
    Pending --> Applied: Payment posted to invoice
    Pending --> Failed: Payment rejected
    Applied --> Reversed: Payment reversal
    Reversed --> [*]
    Applied --> [*]
```

## 3. Payment Application Rules

| Rule | Description |
|------|-------------|
| **FIFO** | Apply payment to oldest invoice first |
| **Specific Invoice** | Apply to a designated invoice |
| **Proportional** | Split across all open invoices |
| **Overpayment** | Creates credit balance on account |
| **Underpayment** | Invoice remains partially paid |

## 4. Payment Operations

```
AR Center → Payments → + NEW PAYMENT →
  Select Account → Amount → Payment Method →
  Select Invoice(s) → Apply → SAVE
```

## 5. Payment Reversal

| Reason | Effect |
|--------|--------|
| **Bounced Check** | Reverses payment, reopens invoice |
| **Chargeback** | Reverses card payment |
| **Error Correction** | Administrative reversal |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
