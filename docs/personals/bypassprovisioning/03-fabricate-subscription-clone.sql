-- ============================================================================
-- FABRICATE a subscription subtree on a target account by CLONING a working one.
--
-- Use when the target account's product is PROVISIONABLE (needs ALU/Coope) and
-- the sandbox can't run that, so the engine never created the subscription.
-- This copies a real, engine-built subscription subtree from a GOOD source
-- account onto the target account, so billing has something to bill.
--
-- It clones (INSERT...SELECT, all values copied from real rows - nothing guessed):
--   subscription  ->  service_unit  ->  price_unit  ->  price_unit_rating_attributes
-- IDs are remapped by appending a suffix (keeps FKs consistent + unique).
-- accountid is repointed to the target. status forced ACTIVE.
--
-- PICK A SOURCE ACCOUNT with a clean subtree (e.g. a PART2 account that already
-- has 1 ACTIVE subscription + price_unit). Target = the account you want to bill.
--
-- !!! SANDBOX-ONLY HACK. Not for prod. Review the read-back before COMMIT. !!!
-- Columns verified against V4_1__Create_CustomerHub_Tables.sql.
-- ============================================================================
BEGIN;

CREATE TEMP TABLE p ON COMMIT DROP AS
SELECT 'SOURCE_ACC'::varchar AS src,   -- <<< good account to copy FROM
       'TARGET_ACC'::varchar AS tgt,   -- <<< account to copy ONTO (e.g. AC-256465)
       '-SIM'::varchar       AS sfx;   -- id suffix (change if you re-run)

-- ---- PRE-CHECK: source must have a subtree; target should NOT already have one
SELECT 'SRC subscription' AS what, COUNT(*)::text AS cnt FROM core_engine.subscription s, p WHERE s.accountid=p.src AND s.status<>'CLOSED'
UNION ALL SELECT 'SRC price_unit', COUNT(*)::text FROM core_engine.price_unit pu, p WHERE pu.accountid=p.src AND pu.status<>'CLOSED'
UNION ALL SELECT 'TGT subscription (should be 0)', COUNT(*)::text FROM core_engine.subscription s, p WHERE s.accountid=p.tgt
UNION ALL SELECT 'TGT billing_profile (must be >=1)', COUNT(*)::text FROM core_engine.billing_profile bp, p WHERE bp.accountid=p.tgt;

-- ---- 1. subscription -------------------------------------------------------
INSERT INTO core_engine.subscription
  (uuid, id, name, accountid, status, initialterm, initialtermunit, renewalterm, renewaltermunit,
   trialterm, trialtermunit, createddate, effectivedate, startdate, enddate, reason, category,
   balanceunitid, creditprofilename)
SELECT s.id||p.sfx, s.id||p.sfx, s.name||p.sfx, p.tgt, 'ACTIVE', s.initialterm, s.initialtermunit,
   s.renewalterm, s.renewaltermunit, s.trialterm, s.trialtermunit, s.createddate, s.effectivedate,
   s.startdate, s.enddate, s.reason, s.category, s.balanceunitid, s.creditprofilename
FROM core_engine.subscription s, p
WHERE s.accountid = p.src AND s.status <> 'CLOSED';

-- ---- 2. service_unit -------------------------------------------------------
INSERT INTO core_engine.service_unit
  (uuid, id, type, accountid, status, reason, parentid, provisioningid, packageid, bundleid,
   createddate, effectivedate, subscriptionid, provisioneddate)
SELECT su.id||p.sfx, su.id||p.sfx, su.type, p.tgt, 'ACTIVE', su.reason, su.parentid,
   su.provisioningid||p.sfx, su.packageid, su.bundleid, su.createddate, su.effectivedate,
   su.subscriptionid||p.sfx, su.provisioneddate
FROM core_engine.service_unit su, p
WHERE su.accountid = p.src AND su.status <> 'CLOSED';

-- ---- 3. price_unit ---------------------------------------------------------
INSERT INTO core_engine.price_unit
  (uuid, id, priceofferid, serviceunitid, subscriptionid, accountid, bundleid, packageid,
   servicetype, status, cyclestart, cycleend, appliedstart, appliedend, createddate, startdate,
   enddate, priceoverride, priceoffset, discountpercent, quantity, reason, instanceid,
   omsinternalid, noofcyclesapplied, commitmentterm, commitmenttermunit)
SELECT pu.id||p.sfx, pu.id||p.sfx, pu.priceofferid, pu.serviceunitid||p.sfx, pu.subscriptionid||p.sfx,
   p.tgt, pu.bundleid, pu.packageid, pu.servicetype, 'ACTIVE', pu.cyclestart, pu.cycleend,
   pu.appliedstart, pu.appliedend, pu.createddate, pu.startdate, pu.enddate, pu.priceoverride,
   pu.priceoffset, pu.discountpercent, pu.quantity, pu.reason, pu.instanceid, pu.omsinternalid,
   pu.noofcyclesapplied, pu.commitmentterm, pu.commitmenttermunit
FROM core_engine.price_unit pu, p
WHERE pu.accountid = p.src AND pu.status <> 'CLOSED';

-- ---- 4. price_unit_rating_attributes (id must match the new price_unit id) --
INSERT INTO core_engine.price_unit_rating_attributes
  (id, currency, purchaseproration, cancelproration, upgradeproration, downgradeproration,
   recurringunit, recurringfrequency, priceofferid, instanceid, advanceflag,
   partmonthwaiveoffflag, calendarmonthflag, alignedtocycle, cutoffdate)
SELECT pra.id||p.sfx, pra.currency, pra.purchaseproration, pra.cancelproration, pra.upgradeproration,
   pra.downgradeproration, pra.recurringunit, pra.recurringfrequency, pra.priceofferid,
   pra.instanceid, pra.advanceflag, pra.partmonthwaiveoffflag, pra.calendarmonthflag,
   pra.alignedtocycle, pra.cutoffdate
FROM core_engine.price_unit_rating_attributes pra, p
WHERE pra.id IN (SELECT pu.id FROM core_engine.price_unit pu WHERE pu.accountid = p.src AND pu.status <> 'CLOSED');

-- ---- READ-BACK: target should now have ACTIVE subscription + price_unit -----
SELECT 'SUBSCRIPTION' AS entity, s.id AS ref, s.status AS status
FROM core_engine.subscription s, p WHERE s.accountid = p.tgt
UNION ALL
SELECT 'SERVICE_UNIT', su.id, su.status FROM core_engine.service_unit su, p WHERE su.accountid = p.tgt
UNION ALL
SELECT 'PRICE_UNIT', pu.id, pu.status FROM core_engine.price_unit pu, p WHERE pu.accountid = p.tgt
UNION ALL
SELECT 'RATING_ATTR', pra.id, COALESCE(pra.recurringunit,'?')
FROM core_engine.price_unit_rating_attributes pra
WHERE pra.id IN (SELECT pu.id FROM core_engine.price_unit pu, p WHERE pu.accountid = p.tgt)
ORDER BY 1, 2;

-- Read-back correct (target has ACTIVE subscription + price_unit + rating attrs)?
--   COMMIT;        wrong -> ROLLBACK;
COMMIT;
-- ROLLBACK;

-- AFTER COMMIT:
--   The cloned price_unit carries the SOURCE account's dates. To bill, set the
--   engine clock (setCcpTime) appropriately and run the billing job. If billing
--   complains about the cycle/dates, align the cloned price_unit dates to the
--   target's billing_profile (separate small step).
