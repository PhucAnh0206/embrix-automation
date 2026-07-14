---
aliases: [Account Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
sources: ["9 - Embrix QA Test Suite_pdf.md"]
---
# 🧪 Account Tests
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Test Cases
| ID | Test Case | Expected Result |
|----|-----------|----------------|
| AC-01 | Create individual account | Account created, status Active |
| AC-02 | Create business account | Account created with business fields |
| AC-03 | Create child account under parent | Hierarchy established, BDOM inherited |
| AC-04 | Update account name | Name updated, audit log entry |
| AC-05 | Deactivate account with open balance | Blocked — must clear balance first |
| AC-06 | Set BDOM outside 1-28 | Validation error |
| AC-07 | Duplicate account ID | Validation error |
---
*Back to [[70-QA-Test-Suite-Overview]]*
