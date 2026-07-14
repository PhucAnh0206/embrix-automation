---
aliases: [Billing Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
sources: ["9 - Embrix QA Test Suite_pdf.md"]
---
# 🧪 Billing Tests
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Test Cases
| ID | Test Case | Expected Result |
|----|-----------|----------------|
| BL-01 | Run BillCheck for BDOM accounts | Charges calculated |
| BL-02 | Verify recurring charge amount | Matches price offer |
| BL-03 | Verify proration on mid-cycle activation | Correct prorated amount |
| BL-04 | Run InvoiceCheck after BillCheck | Invoices generated |
| BL-05 | Run InvoiceCheck before BillCheck | Error / no invoices |
| BL-06 | Verify tax calculation | Tax amount = base × rate |
| BL-07 | Verify discount application | Discount correctly applied |
| BL-08 | Billing with no active subscription | No charges generated |
---
*Back to [[70-QA-Test-Suite-Overview]]*
