-- ============================================================================
-- MAKE A CLONED ACCOUNT BILLABLE (fix the 2 things the clone left wrong)
-- For AC-889530: (1) price_unit dates were in the future vs ccp_time, and
--                (2) no open bill_unit + billing_profile.nextBillUnitId was NULL.
--
-- Engine clock (ccp_time) = 2028-04-01. Offer = ARREARS_RECURRING.
-- Open cycle = [lastAcct, nextAcct] = [2028-03-16 .. 2028-04-01].
-- This: aligns subscription+price_unit dates to that cycle (so they are in the
-- past vs the clock and unbilled), creates the open PENDING bill_unit, and links it.
-- The account currently has ZERO bill_units, so there is no duplicate risk.
-- DBeaver-safe, read-back before COMMIT. SANDBOX-ONLY.
-- ============================================================================
BEGIN;

CREATE TEMP TABLE f ON COMMIT DROP AS
SELECT 'AC-889530'::varchar AS acct,
       DATE '2028-03-16' AS cyc_start,   -- = billing_profile.lastAccountingDate
       DATE '2028-04-01' AS cyc_end;     -- = billing_profile.nextAccountingDate (= clock)

-- 1) Align price_unit to the open cycle; startdate in the past; current cycle unbilled
UPDATE core_engine.price_unit pu
SET status='ACTIVE', enddate=NULL,
    startdate    = LEAST(pu.startdate, f.cyc_start),
    cyclestart   = f.cyc_start, cycleend = f.cyc_end,
    appliedstart = f.cyc_start, appliedend = f.cyc_start
FROM f WHERE pu.accountid = f.acct AND pu.status <> 'CLOSED';

-- 2) Align subscription dates to start on/before the cycle
UPDATE core_engine.subscription s
SET startdate     = LEAST(s.startdate, f.cyc_start),
    effectivedate = LEAST(s.effectivedate, f.cyc_start)
FROM f WHERE s.accountid = f.acct AND s.status = 'ACTIVE';

-- 3) Create the open PENDING bill_unit for the cycle (account has none today)
INSERT INTO core_engine.bill_unit
   (id, type, accountid, billingprofileid, total, nonpayingtotal, billtotal, status, startdate, enddate, created_date)
SELECT 'BU-SIM-'||f.acct, 'REGULAR', f.acct, bp.id, 0, 0, 0, 'PENDING', f.cyc_start, f.cyc_end, f.cyc_end
FROM f JOIN core_engine.billing_profile bp ON bp.accountid = f.acct;

-- 4) Point the billing_profile at the new open bill_unit
UPDATE core_engine.billing_profile bp
SET nextbillunitid = 'BU-SIM-'||bp.accountid
FROM f WHERE bp.accountid = f.acct;

-- ---- READ-BACK -------------------------------------------------------------
SELECT 'PRICE_UNIT' AS k, pu.id AS id, pu.status AS status,
       'start='||pu.startdate||' cyc='||pu.cyclestart||'..'||pu.cycleend||' appE='||pu.appliedend AS info
FROM core_engine.price_unit pu, f WHERE pu.accountid=f.acct AND pu.status<>'CLOSED'
UNION ALL
SELECT 'BILL_UNIT', bu.id, bu.status, bu.startdate::text||'..'||bu.enddate::text
FROM core_engine.bill_unit bu, f WHERE bu.accountid=f.acct
UNION ALL
SELECT 'PROFILE', bp.id, bp.status, 'nextBU='||COALESCE(bp.nextbillunitid,'-')||' nextBill='||bp.nextbilldate::text
FROM core_engine.billing_profile bp, f WHERE bp.accountid=f.acct
ORDER BY 1;

-- Expect: PRICE_UNIT cyc 2028-03-16..2028-04-01 start<=2028-03-16; BILL_UNIT PENDING;
--         PROFILE nextBU=BU-SIM-AC-889530. If correct:
COMMIT;
-- ROLLBACK;
