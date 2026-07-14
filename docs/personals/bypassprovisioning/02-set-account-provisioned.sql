-- ============================================================================
-- STEP 3 of the flow: fake the NOKIA "provisioned OK" callback.
-- Status-only. NO date manipulation. DBeaver-safe (one txn, no DO blocks).
--
-- Run this AFTER GraphQL mutation #1 has moved the order to PROVISIONING_INITIATED
-- and created the subscription/price_unit (see 00-README-run-flow.txt).
--
-- It flips (statuses only):
--   order_prov_sequence_list / order_provisioning_inputs -> COMPLETED
--   order_lines / order_services / order_billables        -> COMPLETED
--   order_oms_task_list                                   -> COMPLETED
--   order                                                 -> COMPLETED
--   subscription / service_unit / price_unit              -> ACTIVE
-- It does NOT touch any date.
--
-- Self-guard: only orders at PROVISIONING_INITIATED / PROVISIONING_ERROR are
-- touched, so running it on a CREATED order is a harmless no-op.
-- Columns verified against V4_1__Create_CustomerHub_Tables.sql.
-- ============================================================================
BEGIN;

-- PARAMETER: set the account id ONCE
CREATE TEMP TABLE sim ON COMMIT DROP AS
SELECT 'PUT_ACCOUNT_ID_HERE'::varchar AS account_id;   -- <<<<< only thing to edit

CREATE TEMP TABLE sim_orders ON COMMIT DROP AS
SELECT o.id AS order_id
FROM core_oms."order" o
WHERE o.accountid IN (SELECT account_id FROM sim)
  AND o.status IN ('PROVISIONING_INITIATED','PROVISIONING_ERROR');

-- ---- PRE-CHECK (grid #1) ---------------------------------------------------
-- Eligible = order PROVISIONING_INITIATED/PROVISIONING_ERROR + subscription/price_unit > 0
SELECT 'order'        AS what, o.status::text AS value, COUNT(*)::text AS cnt
FROM core_oms."order" o WHERE o.accountid IN (SELECT account_id FROM sim) GROUP BY o.status
UNION ALL
SELECT 'subscription', s.status, COUNT(*)::text
FROM core_engine.subscription s WHERE s.accountid IN (SELECT account_id FROM sim) GROUP BY s.status
UNION ALL
SELECT 'service_unit', su.status, COUNT(*)::text
FROM core_engine.service_unit su WHERE su.accountid IN (SELECT account_id FROM sim) GROUP BY su.status
UNION ALL
SELECT 'price_unit', pu.status, COUNT(*)::text
FROM core_engine.price_unit pu WHERE pu.accountid IN (SELECT account_id FROM sim) GROUP BY pu.status
ORDER BY 1, 2;

-- ---- FLIPS (status only) ---------------------------------------------------
UPDATE core_oms.order_prov_sequence_list ps SET status = 'COMPLETED'
WHERE ps.id IN (SELECT order_id FROM sim_orders) AND ps.status IN ('PENDING','PARTIAL','FAILED');

UPDATE core_oms.order_provisioning_inputs pin SET status = 'COMPLETED'
WHERE pin.id IN (SELECT order_id FROM sim_orders) AND pin.status IN ('PENDING','PARTIAL','FAILED');

UPDATE core_oms.order_lines ol SET status = 'COMPLETED'
WHERE ol.id IN (SELECT order_id FROM sim_orders) AND ol.status NOT IN ('COMPLETED','CANCELLED');

UPDATE core_oms.order_services os SET status = 'COMPLETED', reason = NULL
WHERE os.id IN (SELECT order_id FROM sim_orders) AND os.status NOT IN ('COMPLETED','CANCELLED');

UPDATE core_oms.order_billables ob SET status = 'COMPLETED'
WHERE ob.id IN (SELECT order_id FROM sim_orders) AND ob.status NOT IN ('COMPLETED','CANCELLED','BILLING_ERROR');

UPDATE core_oms.order_oms_task_list t SET status = 'COMPLETED'
WHERE t.id IN (SELECT order_id FROM sim_orders) AND t.status NOT IN ('COMPLETED','CANCELLED','NOT_REQUIRED');

UPDATE core_engine.subscription s SET status = 'ACTIVE'
WHERE s.accountid IN (SELECT account_id FROM sim) AND s.status <> 'CLOSED';

UPDATE core_engine.service_unit su SET status = 'ACTIVE'
WHERE su.accountid IN (SELECT account_id FROM sim) AND su.status <> 'CLOSED';

UPDATE core_engine.price_unit pu SET status = 'ACTIVE'
WHERE pu.accountid IN (SELECT account_id FROM sim) AND pu.status <> 'CLOSED';

UPDATE core_oms."order" o SET status = 'COMPLETED', reason = NULL
WHERE o.id IN (SELECT order_id FROM sim_orders);

-- ---- POST READ-BACK (grid #2) ----------------------------------------------
-- Expect ORDER=COMPLETED, SUBSCRIPTION/SERVICE_UNIT/PRICE_UNIT=ACTIVE
SELECT 'ORDER' AS entity, o.id AS ref, o.status AS status, COALESCE(o.reason,'') AS info
FROM core_oms."order" o WHERE o.accountid IN (SELECT account_id FROM sim)
UNION ALL
SELECT 'SUBSCRIPTION', s.id, s.status, ''
FROM core_engine.subscription s WHERE s.accountid IN (SELECT account_id FROM sim)
UNION ALL
SELECT 'SERVICE_UNIT', su.id, su.status, ''
FROM core_engine.service_unit su WHERE su.accountid IN (SELECT account_id FROM sim)
UNION ALL
SELECT 'PRICE_UNIT', pu.id, pu.status,
       'start='||COALESCE(pu.startdate::text,'NULL')||' end='||COALESCE(pu.enddate::text,'NULL')
FROM core_engine.price_unit pu WHERE pu.accountid IN (SELECT account_id FROM sim)
UNION ALL
SELECT 'PROV_SEQ', ps.id||':'||ps.index, ps.status, COALESCE(ps.apiname,'')
FROM core_oms.order_prov_sequence_list ps WHERE ps.id IN (SELECT order_id FROM sim_orders)
ORDER BY 1, 2;

-- Grid #2 correct ->  COMMIT;     Wrong / not eligible ->  ROLLBACK;
COMMIT;
-- ROLLBACK;
