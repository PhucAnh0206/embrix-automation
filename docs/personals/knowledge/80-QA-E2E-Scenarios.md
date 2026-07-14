---
aliases: [E2E Scenarios, End-to-End Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
---
# 🧪 E2E Scenarios
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Scenarios
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|----------------|
| E2E-01 | Full Customer Lifecycle | 1. Create account<br>2. Create order<br>3. Provision service<br>4. Generate usage<br>5. Bill & Invoice<br>6. Pay | Account closed with 0 balance |
| E2E-02 | Dunning to Disconnect | 1. Generate invoice<br>2. Ignore payment<br>3. Run Collections<br>4. Suspend<br>5. Disconnect | Service terminated, debt marked |
| E2E-03 | Plan Upgrade Mid-Cycle | 1. Activate Plan A<br>2. Upgrade to Plan B on day 15<br>3. Run billing | Prorated Plan A + prorated Plan B |
---
*Back to [[70-QA-Test-Suite-Overview]]*
