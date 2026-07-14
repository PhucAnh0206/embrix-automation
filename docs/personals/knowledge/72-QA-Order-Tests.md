---
aliases: [Order Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
sources: ["9 - Embrix QA Test Suite_pdf.md"]
---
# 🧪 Order Tests
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Test Cases
| ID | Test Case | Expected Result |
|----|-----------|----------------|
| OR-01 | Create new activation order | Order created, status Pending |
| OR-02 | Submit order for approval | Status changes to Approved |
| OR-03 | Cancel pending order | Status Cancelled, no billing |
| OR-04 | Modify active subscription via order | Change order created |
| OR-05 | Create suspend order | Service suspended |
| OR-06 | Create resume order | Service resumed |
| OR-07 | Order without subscription item | Validation error |
---
*Back to [[70-QA-Test-Suite-Overview]]*
