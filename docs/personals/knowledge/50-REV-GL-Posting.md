---
aliases: [GL Posting, General Ledger, Journal Entry]
tags: [embrix/revenue, embrix/gl]
type: knowledge
hub: Revenue
created: 2026-05-07
sources: ["023 GL Integration_pptx.md", "7 - Embrix User Guide - Revenue Hub_pdf.md"]
---

# 📊 GL Posting

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Revenue
> **Related**: [[51-REV-Revenue-Recognition]] | [[34-BILL-Invoice-Management]] | [[55-REV-4Cs-Framework]]

---

## 1. GL Integration Model

```mermaid
graph LR
    BI["Bill Items"] --> JE["Journal Entry Creation"] --> GL["General Ledger"] --> FS["Financial Statements"]
```

## 2. GL Accounts Used

| Account | Type | Purpose |
|---------|------|---------|
| **Revenue** | Credit | Service revenue recognized |
| **Accounts Receivable** | Debit | Customer owes payment |
| **Deferred Revenue** | Credit | Revenue not yet earned |
| **Cash/Bank** | Debit | Payment received |
| **Tax Payable** | Credit | Tax collected to be remitted |
| **Bad Debt Expense** | Debit | Uncollectible accounts |
| **Discount** | Debit | Discount given to customer |

## 3. Journal Entry Examples

### Invoice Generated:
```
DR: Accounts Receivable    $33.89
  CR: Revenue              $29.99
  CR: Tax Payable (IVA)     $3.90
```

### Payment Received:
```
DR: Cash/Bank              $33.89
  CR: Accounts Receivable  $33.89
```

## 4. GL Code Configuration

| Field | Description |
|-------|-------------|
| **GL Code** | Account code in external ERP |
| **Mapping** | Item → GL Code assignment |
| **Posting Schedule** | Real-time or batch |
| **Export Format** | CSV, XML for ERP integration |

## 5. UI Path

```
Revenue Center → GL Configuration →
  GL Accounts → Map Item to GL Code →
  Journal Entries → View / Export
```

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
