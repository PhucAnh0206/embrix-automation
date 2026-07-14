---
aliases: [API Tests]
tags: [embrix/qa, embrix/testing]
type: knowledge
hub: QA
created: 2026-05-07
---
# 🧪 API Tests
> **Parent**: [[70-QA-Test-Suite-Overview]] | **Hub**: QA
## Test Cases
| ID | Test Case | Expected Result |
|----|-----------|----------------|
| API-01 | GraphQL: Query account details | Returns correct account data |
| API-02 | GraphQL: Create account mutation | Account created, returns ID |
| API-03 | REST: Get invoice PDF | Returns PDF file |
| API-04 | API Authentication with valid token | 200 OK |
| API-05 | API Authentication with invalid token | 401 Unauthorized |
| API-06 | Rate limiting check | 429 Too Many Requests after threshold |
| API-07 | GraphQL: Query with complex filters | Returns filtered results correctly |
---
*Back to [[70-QA-Test-Suite-Overview]]*
