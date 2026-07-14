---
aliases: [Payment Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
---
# 🧪 Payment Tests
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Test Cases
| ID | Test Case | Expected Result |
|----|-----------|----------------|
| PY-01 | Apply full payment to invoice | Invoice status → Closed |
| PY-02 | Apply partial payment | Invoice status → PartialPaid |
| PY-03 | Overpayment | Credit balance created |
| PY-04 | Payment reversal | Invoice reopened |
| PY-05 | Payment with wrong currency | Validation error |
| PY-06 | FIFO payment application | Oldest invoice paid first |
---
*Back to [[70-QA-Test-Suite-Overview]]*
