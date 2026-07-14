---
aliases: [Aging Report, AR Aging]
tags: [embrix/ar, embrix/aging]
type: knowledge
hub: AR
created: 2026-05-07
sources: ["022 Aging Report_pptx.md", "6 - Embrix User Guide - AR Hub_pdf.md"]
---

# 💳 Aging Report

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: AR
> **Related**: [[41-AR-Collections]] | [[40-AR-Payment-Processing]] | [[44-AR-Account-Balance]]

---

## 1. Aging Buckets

| Bucket | Days Overdue | Risk Level |
|--------|-------------|-----------|
| **Current** | 0 | ✅ Low |
| **1-30** | 1-30 | 🟡 Medium |
| **31-60** | 31-60 | 🟠 High |
| **61-90** | 61-90 | 🔴 Critical |
| **90+** | 91+ | ⛔ Write-off risk |

## 2. Report Contents

| Column | Description |
|--------|-------------|
| **Account** | Customer account name/ID |
| **Total Outstanding** | Total unpaid balance |
| **Current** | Amount not yet due |
| **1-30 Days** | Overdue 1-30 days |
| **31-60 Days** | Overdue 31-60 days |
| **61-90 Days** | Overdue 61-90 days |
| **90+ Days** | Overdue more than 90 days |

## 3. UI Path

```
AR Center → Reports → Aging Report →
  Filter: Date, Segment, Aging Bucket →
  Export: CSV, PDF
```

## 4. Automated Actions by Bucket

| Bucket | Automated Action |
|--------|-----------------|
| 1-30 | Send reminder email |
| 31-60 | Send warning + apply late fee |
| 61-90 | Suspend service |
| 90+ | Escalate for disconnection/write-off |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
