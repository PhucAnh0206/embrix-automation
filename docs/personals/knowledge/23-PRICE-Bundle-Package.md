---
aliases: [Bundle Package, Product Bundle]
tags: [embrix/pricing, embrix/bundle, embrix/package]
type: knowledge
hub: Pricing
created: 2026-05-07
sources: ["010 Bundle Package Configuration_pptx.md", "4 - Embrix User Guide - Pricing Hub_pdf.md"]
---

# 💰 Bundle & Package

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Pricing
> **Related**: [[20-PRICE-Item-Master]] | [[21-PRICE-Price-Offer-Models]] | [[12-CUST-Order-Management]]

---

## 1. Bundle vs Package

| Concept | Bundle | Package |
|---------|--------|---------|
| **Definition** | Single service-type grouping | Multi service-type grouping |
| **Example** | Internet bundle (100Mbps + ONT) | Triple Play (Internet + TV + Voice) |
| **Service Types** | One | Multiple |
| **Dependency** | Items depend on each other | Packages include multiple bundles |

## 2. Bundle Structure

```mermaid
graph TB
    B["Bundle: Internet Gold"]
    I1["Item: Internet 100Mbps (Recurring)"]
    I2["Item: Installation (One-Time)"]
    I3["Item: ONT Device (Equipment)"]
    
    B --> I1
    B --> I2
    B --> I3
```

## 3. Package Structure

```mermaid
graph TB
    P["Package: Triple Play Premium"]
    B1["Bundle: Internet Gold"]
    B2["Bundle: TV Premium"]
    B3["Bundle: Voice Basic"]
    
    P --> B1
    P --> B2
    P --> B3
```

## 4. Dependency Rules

| Rule | Description |
|------|-------------|
| **Mandatory** | Item must be included in the bundle |
| **Optional** | Item can be added/removed by customer |
| **Dependent** | Item requires another item to be selected |
| **Exclusive** | Item cannot exist with certain other items |

## 5. UI Path

```
Pricing Center → Bundle Management → + CREATE →
  Name, Description → Add Items → Set Dependencies →
  Configure Pricing → SAVE
```

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
