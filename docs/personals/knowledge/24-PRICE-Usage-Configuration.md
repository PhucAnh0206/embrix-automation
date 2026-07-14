---
aliases: [Usage Configuration, Mediation, CDR Processing]
tags: [embrix/pricing, embrix/usage, embrix/mediation]
type: knowledge
hub: Pricing
created: 2026-05-07
sources: ["011 Usage Configuration_pptx.md", "4 - Embrix User Guide - Pricing Hub_pdf.md"]
---

# 💰 Usage Configuration

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Pricing
> **Related**: [[32-BILL-Usage-Processing]] | [[24-PRICE-Usage-Configuration]] | [[31-BILL-Rating-Engine]]

---

## 1. Usage Flow

```mermaid
graph LR
    N["Network/CDR Source"] --> M["Mediation"] --> S["Stream Config"] --> R["Rating Engine"] --> I["Invoice"]
```

## 2. Stream Configuration

| Field | Description |
|-------|-------------|
| **Stream Name** | Identifier for the usage stream |
| **Source** | Where CDR data comes from |
| **Format** | CDR file format (CSV, XML, custom) |
| **Rating Rule** | How to rate the usage (per-unit, tiered) |
| **UOM** | Unit of measure (MB, minutes, events) |

## 3. CDR Fields

| Field | Description |
|-------|-------------|
| **Account ID** | Customer identifier |
| **Timestamp** | When the usage occurred |
| **Quantity** | Amount consumed |
| **UOM** | Unit of measure |
| **Service Type** | Which service generated the usage |

## 4. Mediation Process

1. **Ingest** — CDR files uploaded (batch or real-time)
2. **Parse** — Extract fields from CDR format
3. **Validate** — Check for duplicates, missing fields
4. **Enrich** — Match account, apply rating rules
5. **Output** — Send to Rating Engine for billing

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
