---
aliases: [AR Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
---
# 🧪 AR Tests
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Test Cases
| ID | Test Case | Expected Result |
|----|-----------|----------------|
| AR-01 | Generate Aging Report | Report generated with correct buckets |
| AR-02 | Trigger Dunning Level 1 (Reminder) | Email sent to customer |
| AR-03 | Trigger Dunning Level 2 (Warning) | Email sent + late fee applied |
| AR-04 | Trigger Dunning Level 3 (Suspend) | Service suspended via provisioning |
| AR-05 | Write-off bad debt | Account balance zeroed, GL entry created |
| AR-06 | Create Credit Note | Balance reduced, linked to invoice |
| AR-07 | Create Debit Note | Balance increased |
---
*Back to [[70-QA-Test-Suite-Overview]]*
