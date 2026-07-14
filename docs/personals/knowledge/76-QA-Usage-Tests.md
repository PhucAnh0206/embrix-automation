---
aliases: [Usage Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
---
# 🧪 Usage Tests
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Test Cases
| ID | Test Case | Expected Result |
|----|-----------|----------------|
| US-01 | Import valid CDR file | CDRs loaded into staging |
| US-02 | Rate voice CDR | Charge calculated based on duration |
| US-03 | Rate data CDR | Charge calculated based on volume |
| US-04 | CDR with invalid account | Moved to error queue |
| US-05 | Duplicate CDR detection | Second CDR ignored |
| US-06 | Rating with volume discount | Discount applied correctly |
| US-07 | Peak vs Off-peak rating | Different rates applied correctly |
---
*Back to [[70-QA-Test-Suite-Overview]]*
