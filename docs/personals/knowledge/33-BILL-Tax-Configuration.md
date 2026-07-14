---
aliases: [Tax Configuration, Tax Rules, IVA]
tags: [embrix/billing, embrix/tax]
type: knowledge
hub: Billing
created: 2026-05-07
sources: ["016 Tax Configuration_pptx.md", "5 - Embrix User Guide - Billing Hub_pdf.md"]
---

# 📄 Tax Configuration

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Billing
> **Related**: [[31-BILL-Rating-Engine]] | [[34-BILL-Invoice-Management]] | [[55-REV-4Cs-Framework]]

---

## 1. Tax Model

| Concept | Description |
|---------|-------------|
| **Tax Category** | Classification of the item for tax purposes |
| **Tax Rate** | Percentage applied to taxable amount |
| **Tax Jurisdiction** | Geographic area where tax applies |
| **Tax Exemption** | Rules for tax-exempt accounts |

## 2. Tax Calculation

```
Taxable Amount = Base Charge - Discounts
Tax Amount = Taxable Amount × Tax Rate
Invoice Total = Taxable Amount + Tax Amount
```

## 3. Tax Configuration (Costa Rica)

| Tax | Rate | Applies To |
|-----|------|-----------|
| **IVA (VAT)** | 13% | All telecom services |
| **IVA Reducido** | 4% | Basic internet services (configurable) |
| **Exempt** | 0% | Government accounts (with exemption cert) |

## 4. Tax Rules

| Rule | Description |
|------|-------------|
| **Inclusive** | Tax included in displayed price |
| **Exclusive** | Tax added on top of displayed price |
| **Cascade** | Tax calculated on amount including other taxes |
| **Non-Cascade** | Tax calculated on base amount only |

## 5. UI Path

```
Billing Center → Tax Configuration →
  Tax Categories → + CREATE → Name, Rate, Jurisdiction → SAVE
  Tax Rules → Assign to Item Categories → SAVE
```

> ⚠️ **LATAM Note**: For Mexico, the system supports CFDI timbrado (digital tax stamp) via PAC integration. See [[55-REV-4Cs-Framework]].

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
