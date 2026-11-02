-- NetSuite regression — READ-ONLY checks (rebuilt 2026-10-12; names verified on coopegsbx3-dev-db the same day)
-- Run with the helper (refuses anything but SELECT/WITH/SHOW, session is read-only):
--   node tools/ro-query.js --file readonly-checks.sql --q Q5
-- !! Bug_006: coopegsbx3-dev-db/coredb is a production-derived snapshot, NOT the DB the coopegsbx2 app uses
--    (here 279497 = acct 223180 CLOSED and A-1209153 = CALCULATE_TAX; in the app 0279497 = 208886 ACTIVE ERROR).
--    Config checks (Q1-Q4) are meaningful only if the app DB carries the same config; ask Jeremy.
-- Never INSERT/UPDATE jobs, schedules or invoices (handoff §6).
-- Ids (invoice_unit.id, activity.id) are TEXT: quote them.

-- Q0  Find the NetSuite-related tables
SELECT table_schema, table_name FROM information_schema.tables
WHERE table_name ILIKE ANY (ARRAY['%department_map%','%class_map%','%taxcode_map%','%gateway_api%','%gateway_attribute%','invoice_unit','activity'])
ORDER BY 1, 2;

-- Q1  ENV-001  Migrations 10.2 / 10.3   (10-12 on coopegsbx3: both success, installed 2026-10-05 05:39 UTC)
SELECT installed_rank, version, description, success, installed_on
FROM public.flyway_schema_history ORDER BY installed_rank DESC LIMIT 10;

-- Q2  ENV-002  Department / class / taxcode maps   (10-12: all match oracle-01)
SELECT accounttype, departmentint FROM core_config.account_type_department_map ORDER BY 1;  -- DEFAULT 15, FONATEL 137, PHC 135
SELECT accounttype, classint      FROM core_config.account_type_class_map ORDER BY 1;       -- DEFAULT 104, FONATEL 9, PHC 10
SELECT taxcodeint, exemptpercent, exemptrate, hascertificate
FROM core_config.tax_exempt_taxcode_map ORDER BY taxcodeint;   -- 5..12, no 0 (see oracle-01)

-- Q3  ENV-002  Finance gateway endpoints (NetSuite sandbox 8754760-sb1 restlets)
SELECT index, type, url, apitype FROM core_config.finance_gateway_attributes ORDER BY index, type;

-- Q4  ENV-002 / RET-003  NetSuite request maps: CREATE_INVOICE GID-100077, CREATE_CREDIT_NOTES GID-100081
--     (sourcename = NetSuite field, canonicalname = Embrix field)
SELECT id, gatewayname, providername, apiname FROM core_config.gateway_api_map
WHERE providername = 'NETSUITE' ORDER BY apiname;
SELECT id, index, sourcename, canonicalname FROM core_config.gateway_api_requestmap
WHERE id IN ('GID-100077', 'GID-100081') ORDER BY id, index;
-- expect: invoice.entity <- account.partyId; invoice.tipoFactura <- invoice.typeInt; creditMemo.entity <- account.partyId;
--         creditMemo.applys[].refNum <- creditNote.invoices[].financeRefId

-- Q5  ENG-007 / INV-*  Sync fields of the QA invoices (oracle-03). Add the round-2 ids.
SELECT id, accountid, type, status, invoicedate, total, foliostatus,
       financesyncstatus, financerefid, financeversion, LEFT(financeerrormessage, 120) AS financeerrormessage
FROM core_engine.invoice_unit
WHERE id IN ('279497', '279498', '279499', '279507', '279508')
ORDER BY id;

-- Q6  ENG-007 / INV-005 / INV-016  Exact NetSuite-bound payload of one invoice's CREATE_INVOICE
SELECT id, accountid, entityid, apiname, action, createddate, request, response
FROM core_engine.activity
WHERE apiname IN ('CREATE_INVOICE', 'CREATE_CREDIT_NOTES') AND entityid = '279497'      -- [ASSUMPTION] entityid = invoice id
ORDER BY createddate;

-- Q7  Duplicate guard: one NetSuite id per invoice
SELECT financerefid, COUNT(*) FROM core_engine.invoice_unit
WHERE financerefid IS NOT NULL GROUP BY financerefid HAVING COUNT(*) > 1;

-- Q8  RPT-001 / Bug_012  Which statuses exist (10-12 on coopegsbx3: ERROR, SUCCESS, NULL; no PENDING at all)
SELECT financesyncstatus, COUNT(*) FROM core_engine.invoice_unit GROUP BY 1 ORDER BY 2 DESC;

-- Q9  Bug_006  Which DB is this? The app shows 0279497 on account 208886, ACTIVE, ERROR
SELECT id, accountid, status, financesyncstatus FROM core_engine.invoice_unit WHERE id IN ('279497', '0279497');
