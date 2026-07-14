---
aliases: [Proration Logic, Proration Rules]
tags: [embrix/billing, embrix/proration]
type: knowledge
hub: Billing
created: 2026-05-07
sources: ["018 Proration_pptx.md", "5 - Embrix User Guide - Billing Hub_pdf.md"]
---

# 📄 Proration Logic

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Billing
> **Related**: [[31-BILL-Rating-Engine]] | [[30-BILL-Billing-Cycle]] | [[12-CUST-Order-Management]]

---

## 1. Proration Formula

```
Prorated Amount = (Number of Days / Total Days in Cycle) × Full Monthly Rate
```

## 2. Proration Scenarios

| Scenario | Proration Type | Calculation |
|----------|---------------|-------------|
| **New activation mid-cycle** | Credit proration | Remaining days × daily rate |
| **Cancellation mid-cycle** | Debit proration | Used days × daily rate |
| **Plan upgrade mid-cycle** | Dual proration | Credit old + charge new (remaining) |
| **Plan downgrade mid-cycle** | Dual proration | Credit old + charge new (remaining) |
| **Suspension mid-cycle** | Credit proration | Suspended days credited |
| **Resume mid-cycle** | Debit proration | Active days charged |

## 3. Example — Mid-Cycle Activation

```
BDOM: 1 (cycle = Jan 1 – Jan 31)
Activation Date: Jan 15
Monthly Rate: $30.00
Days Remaining: 17 (Jan 15-31)
Total Days: 31

Proration = 17/31 × $30.00 = $16.45
```

## 4. Example — Mid-Cycle Plan Change

```
BDOM: 1 (cycle = Jan 1 – Jan 31)
Change Date: Jan 20
Old Plan: $30.00/mo | New Plan: $50.00/mo

Credit Old: 12/31 × $30.00 = -$11.61 (Jan 20-31 unused)
Charge New: 12/31 × $50.00 = +$19.35 (Jan 20-31 new)
Net Impact: +$7.74
```

## 5. Configuration

| Setting | Options |
|---------|---------|
| **Proration Enabled** | Yes (default) / No |
| **Day Count Method** | Calendar days (default) / 30-day month |
| **Rounding** | Uses currency rounding rules |
| **First Cycle** | Always prorated / Full charge |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
