---
aliases: [Currency Resource, Multi-Currency]
tags: [embrix/pricing, embrix/currency]
type: knowledge
hub: Pricing
created: 2026-05-07
sources: ["012 Currency Resource_pptx.md", "4 - Embrix User Guide - Pricing Hub_pdf.md"]
---

# 💰 Currency Resource

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Pricing
> **Related**: [[25-PRICE-Currency-Resource]] | [[55-REV-4Cs-Framework]]

---

## 1. Currency Configuration

| Field | Description | Example |
|-------|-------------|---------|
| **Currency Code** | ISO 4217 code | CRC, USD, MXN |
| **Currency Name** | Display name | Costa Rican Colón |
| **Symbol** | Currency symbol | ₡ |
| **Decimal Precision** | Rounding decimal places | 2 |
| **Rounding Mode** | How to round | HALF_UP |

## 2. Multi-Currency Support

| Aspect | Detail |
|--------|--------|
| **Account Currency** | Set at account creation, cannot be changed |
| **Pricing Currency** | Can differ from account currency |
| **Exchange Rates** | Maintained in Currency Resource |
| **Invoice Currency** | Always matches account currency |

## 3. Rounding Policies

| Mode | Description | Example (2.555) |
|------|-------------|----------------|
| **HALF_UP** | Round up at .5 | 2.56 |
| **HALF_DOWN** | Round down at .5 | 2.55 |
| **CEILING** | Always round up | 2.56 |
| **FLOOR** | Always round down | 2.55 |

## 4. UI Path

```
Pricing Center → Basic Config → Currency →
  + CREATE → Code, Name, Symbol, Precision, Rounding → SAVE
```

> ⚠️ **Rule**: Changing precision on an active currency affects ALL future calculations. Historical data remains unchanged.

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
