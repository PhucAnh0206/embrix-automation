---
aliases: [4Cs Framework, Revenue Assurance]
tags: [embrix/revenue, embrix/4cs]
type: knowledge
hub: Revenue
created: 2026-05-07
sources: ["025 4Cs Framework_pptx.md", "7 - Embrix User Guide - Revenue Hub_pdf.md"]
---

# 📊 4Cs Framework

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Revenue
> **Related**: [[50-REV-GL-Posting]] | [[33-BILL-Tax-Configuration]] | [[25-PRICE-Currency-Resource]]

---

## 1. The 4Cs

| C | Name | Purpose |
|---|------|---------|
| **C1** | **Completeness** | Ensure all billable events are captured |
| **C2** | **Correctness** | Ensure charges are calculated accurately |
| **C3** | **Consistency** | Ensure data matches across systems |
| **C4** | **Compliance** | Ensure regulatory and tax compliance |

## 2. Completeness Checks

- All CDRs ingested vs CDRs generated at network
- All subscriptions have billing items
- No orphaned accounts without billing

## 3. Correctness Checks

- Rated amounts match price offer rules
- Tax calculations match tax rates
- Proration follows day-count rules

## 4. Consistency Checks

- GL postings balance (DR = CR)
- AR balance matches sum of open invoices
- Payment totals match bank reconciliation

## 5. Compliance Checks

- Tax rates match jurisdictional requirements
- Invoice format meets regulatory standards
- CFDI timbrado (Mexico) / electronic invoice requirements
- Data retention policies enforced

> ⚠️ **LATAM**: For Mexico operations, CFDI timbrado validation via PAC is mandatory for every invoice.

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
