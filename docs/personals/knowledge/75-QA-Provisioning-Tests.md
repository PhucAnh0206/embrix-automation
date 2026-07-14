---
aliases: [Provisioning Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
---
# 🧪 Provisioning Tests
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Test Cases
| ID | Test Case | Expected Result |
|----|-----------|----------------|
| PR-01 | Activate mobile line via order | Command sent to HLR/Nokia NetAct |
| PR-02 | Deactivate mobile line | Suspend command sent |
| PR-03 | Change plan (Plan A → Plan B) | Profile updated in network |
| PR-04 | Network adapter timeout | Order marked as failed, retry option |
| PR-05 | Bulk activation | All lines activated, status updated |
| PR-06 | Verify SIM status sync | Embrix SIM status matches network |
---
*Back to [[70-QA-Test-Suite-Overview]]*
