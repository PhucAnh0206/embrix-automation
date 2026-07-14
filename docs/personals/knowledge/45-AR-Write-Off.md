---
aliases: [Write-Off, Bad Debt]
tags: [embrix/ar, embrix/write-off]
type: knowledge
hub: AR
created: 2026-05-07
sources: ["6 - Embrix User Guide - AR Hub_pdf.md"]
---

# 💳 Write-Off

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: AR
> **Related**: [[41-AR-Collections]] | [[43-AR-Aging-Report]] | [[50-REV-GL-Posting]]

---

## 1. Write-Off Process

| Step | Action |
|------|--------|
| 1 | Account identified as uncollectible (90+ days overdue) |
| 2 | Collection team reviews and recommends write-off |
| 3 | Manager approval required |
| 4 | Write-off executed — invoice balance zeroed |
| 5 | GL entry created (Bad Debt Expense DR / AR CR) |

## 2. Write-Off Types

| Type | Description |
|------|-------------|
| **Full** | Entire outstanding balance written off |
| **Partial** | Portion of balance written off |

## 3. GL Impact

```
Debit:  Bad Debt Expense (P&L)
Credit: Accounts Receivable (Balance Sheet)
```

## 4. Recovery

If payment is received after write-off:
```
Debit:  Cash/Bank (Balance Sheet)
Credit: Bad Debt Recovery (P&L)
```

> ⚠️ Write-offs are **irreversible**. Recovery creates a new GL entry, not a reversal.

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
