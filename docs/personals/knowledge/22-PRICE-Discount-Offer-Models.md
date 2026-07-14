---
aliases: [Discount Offer Models, Discount Models]
tags: [embrix/pricing, embrix/discount]
type: knowledge
hub: Pricing
created: 2026-05-07
sources: ["009 Discount Offer Models_pptx.md", "4 - Embrix User Guide - Pricing Hub_pdf.md"]
---

# 💰 Discount Offer Models

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Pricing
> **Related**: [[21-PRICE-Price-Offer-Models]] | [[23-PRICE-Bundle-Package]]

---

## 1. Discount Types

| Type | Description | Example |
|------|-------------|---------|
| **Percentage** | % off the base price | 10% off monthly fee |
| **Fixed Amount** | Fixed deduction from price | $5 off per month |
| **Tiered** | Discount varies by quantity tier | 1-10: 5%, 11-50: 10%, 51+: 15% |
| **Volume** | Single discount rate for total volume | 25 units → 10% for all |
| **Loyalty** | Discount based on tenure/loyalty | After 12 months: 5% off |

## 2. Discount Configuration

| Field | Description |
|-------|-------------|
| **Discount Name** | Display name |
| **Discount Type** | Percentage, Fixed, Tiered, Volume, Loyalty |
| **Value** | Discount amount/percentage |
| **Applicable Items** | Which products this discount applies to |
| **Effective Date** | Start date |
| **End Date** | Expiry (optional) |
| **Eligibility Rules** | Conditions for auto-applying |

## 3. Discount Application

Discounts can be applied: **At order creation** (manual/auto), **At billing** (auto by rules), **Retroactively** (credit note).

## 4. UI Path

```
Pricing Center → Price Management → Discount Offers →
  + CREATE → Select Type → Configure Value/Tiers →
  Set Applicable Items → SAVE
```

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
