import { APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseHelper } from '../database.helper';
import { TestLogger } from '../test-logger';

/** Shape of test-data/provisioning-fixture.json */
interface ProvisioningFixture {
    capturedAt: string;
    sourceAccountId: string;
    note: string;
    subscriptions: Record<string, unknown>[];
    serviceUnits: Record<string, unknown>[];
    priceUnits: Record<string, unknown>[];
    priceUnitRatingAttributes: Record<string, unknown>[];
}

export class ProvisioningDbHelper {
    private db: DatabaseHelper;

    constructor() {
        this.db = new DatabaseHelper();
    }

    /**
     * Disable the provisioning process feature.
     */
    async disableProvisioning(logger?: TestLogger): Promise<void> {
        if (logger) logger.log("Starting disableProvisioning...");
        await this.db.executeQuery(`
            INSERT INTO core_config.ccp_properties (property, value)
            VALUES ('provisioningEnabled', 'false')
            ON CONFLICT (property) DO UPDATE SET value = 'false';
        `);
        if (logger) logger.log("Completed disableProvisioning.");
    }

    /**
     * Enable the provisioning process feature.
     */
    async enableProvisioning(logger?: TestLogger): Promise<void> {
        if (logger) logger.log("Starting enableProvisioning...");

        // Show current value first
        if (logger) logger.log("Executing SQL: SELECT property, value FROM core_config.ccp_properties WHERE property ILIKE '%provision%';");
        const beforeCheck = await this.db.executeQuery(`
            SELECT property, value FROM core_config.ccp_properties
            WHERE property ILIKE '%provision%';
        `);
        if (logger) logger.log(`Current provisioning properties: ${JSON.stringify(beforeCheck)}`);

        // Enable it (upsert)
        if (logger) logger.log("Executing SQL: INSERT INTO core_config.ccp_properties (property, value) VALUES ('provisioningEnabled', 'true') ON CONFLICT (property) DO UPDATE SET value = 'true';");
        await this.db.executeQuery(`
            BEGIN;
            INSERT INTO core_config.ccp_properties (property, value)
            VALUES ('provisioningEnabled', 'true')
            ON CONFLICT (property) DO UPDATE SET value = 'true';
            COMMIT;
        `);

        // Read-back
        if (logger) logger.log("Executing SQL: SELECT property, value FROM core_config.ccp_properties WHERE property = 'provisioningEnabled';");
        const afterCheck = await this.db.executeQuery(`
            SELECT property, value FROM core_config.ccp_properties
            WHERE property = 'provisioningEnabled';
        `);
        if (logger) logger.log(`Updated provisioning property: ${JSON.stringify(afterCheck)}`);

        if (logger) logger.log("Completed enableProvisioning.");
    }

    /**
     * Set dummy serial number and model in core_oms.order_services for the order
     * to bypass UI/backend validation during submission.
     */
    async setDummySerialAndModel(orderId: string): Promise<void> {
        const sanitizedOrderId = orderId.replace(/'/g, "''");
        await this.db.executeQuery(`
            UPDATE core_oms.order_services
            SET serialnumber = 'G-240W-G',
                model = 'G-240W-G'
            WHERE id = '${sanitizedOrderId}';
        `);
    }

    /**
     * Bypass provisioning by first driving the order through the engine via GraphQL
     * to create subscriptions and price units, and then simulating a successful
     * Nokia callback via status-only database updates.
     *
     * @param request - Playwright APIRequestContext for sending GraphQL requests
     * @param accountId - The account ID associated with the order (e.g. 'AC-241915')
     * @param orderId - The order ID to bypass provisioning for (e.g. 'OR-241915')
     * @param logger - Optional TestLogger instance
     * @throws Error if GraphQL mutation fails or database query fails.
     */
    async bypassProvisioning(request: APIRequestContext, accountId: string, orderId: string, logger?: TestLogger): Promise<void> {
        const graphqlUrl = process.env.GRAPH_URLS ?? 'https://transactional.coopeg.embrix.org/graphql';

        // ----------------------------------------------------------------
        // STEP 1 â€” Drive the order through the engine via GraphQL so the
        // engine creates subscription + service_unit + price_unit and moves
        // the order to PROVISIONING_INITIATED (no OMS broker, no real Nokia).
        // ----------------------------------------------------------------
        logger?.log(`[bypassProvisioning] STEP 1 â€” GraphQL updateOrderStatus â†’ SUBMITTED for order ${orderId}`);

        const gqlResponse = await request.post(graphqlUrl, {
            data: {
                query: `
                    mutation {
                        updateOrderStatus(input: {
                            id: "${orderId}",
                            status: SUBMITTED,
                            executeFutureOrderNow: true
                        }) {
                            id
                            status
                        }
                    }
                `
            }
        });

        const gqlBody = await gqlResponse.json();
        logger?.log(`[bypassProvisioning] GraphQL response status: ${gqlResponse.status()}`);

        if (!gqlBody?.data?.updateOrderStatus) {
            const errorMsg = JSON.stringify(gqlBody?.errors ?? gqlBody);
            logger?.log(`[bypassProvisioning] GraphQL mutation failed: ${errorMsg}`);
            throw new Error(`[bypassProvisioning] updateOrderStatus mutation returned null data: ${errorMsg}`);
        }

        const engineOrderStatus = gqlBody.data.updateOrderStatus.status;
        logger?.log(`[bypassProvisioning] Engine order status after mutation: ${engineOrderStatus}`);

        // ----------------------------------------------------------------
        // STEP 2 â€” Pre-check: verify order is at PROVISIONING_INITIATED or
        // PROVISIONING_ERROR and that subscription + price_unit were created.
        // ----------------------------------------------------------------
        logger?.log(`[bypassProvisioning] STEP 2 â€” Pre-check: verifying subscription/price_unit exist for account ${accountId}`);

        const preCheck = await this.db.executeQuery(`
            SELECT
                (SELECT COUNT(*)::int FROM core_oms."order"
                 WHERE id = $1
                   AND status IN ('PROVISIONING_INITIATED','PROVISIONING_ERROR')) AS order_ok,
                (SELECT COUNT(*)::int FROM core_engine.subscription
                 WHERE accountid = $2 AND status <> 'CLOSED') AS sub_count,
                (SELECT COUNT(*)::int FROM core_engine.price_unit
                 WHERE accountid = $2 AND status <> 'CLOSED') AS pu_count;
        `, [orderId, accountId]);

        const { order_ok, sub_count, pu_count } = preCheck[0];
        logger?.log(`[bypassProvisioning] Pre-check — order_ok: ${order_ok}, sub_count: ${sub_count}, pu_count: ${pu_count}`);

        if (order_ok === 0) {
            throw new Error(
                `[bypassProvisioning] Pre-check failed: order ${orderId} is NOT at PROVISIONING_INITIATED/PROVISIONING_ERROR. ` +
                `The engine may not have processed it (provisioning disabled or product not provisionable?).`
            );
        }
        if (sub_count === 0 || pu_count === 0) {
            logger?.log(`[bypassProvisioning] Pre-check: subscription (${sub_count}) or price_unit (${pu_count}) not created. Fabricating subscription clone from fixture...`);
            const idSuffix = `-SIM-${orderId}`;
            await this.fabricateSubscriptionClone(accountId, idSuffix, undefined, logger);

            // Fetch billing profile dates for alignment
            const bpRes = await this.db.executeQuery(`
                SELECT lastaccountingdate, nextaccountingdate, id
                FROM core_engine.billing_profile
                WHERE accountid = $1;
            `, [accountId]);

            if (bpRes.length > 0) {
                const { lastaccountingdate, nextaccountingdate, id: bpId } = bpRes[0];
                logger?.log(`[bypassProvisioning] Aligning dates for account ${accountId} with billing cycle: ${lastaccountingdate} to ${nextaccountingdate}`);

                // 1) Align price_unit to the open cycle
                await this.db.executeQuery(`
                    UPDATE core_engine.price_unit
                    SET status = 'ACTIVE', enddate = NULL,
                        startdate    = LEAST(startdate, $2::DATE),
                        cyclestart   = $2::DATE, cycleend = $3::DATE,
                        appliedstart = $2::DATE, appliedend = $2::DATE
                    WHERE accountid = $1 AND status <> 'CLOSED';
                `, [accountId, lastaccountingdate, nextaccountingdate]);

                // 2) Align subscription dates to start on/before the cycle
                await this.db.executeQuery(`
                    UPDATE core_engine.subscription
                    SET startdate     = LEAST(startdate, $2::DATE),
                        effectivedate = LEAST(effectivedate, $2::DATE)
                    WHERE accountid = $1 AND status = 'ACTIVE';
                `, [accountId, lastaccountingdate]);

                // 3) Create the open PENDING bill_unit for the cycle
                const buId = `BU-SIM-${accountId}`;
                await this.db.executeQuery(`
                    INSERT INTO core_engine.bill_unit
                        (id, type, accountid, billingprofileid, total, nonpayingtotal, billtotal, status, startdate, enddate, created_date)
                    VALUES ($1, 'REGULAR', $2, $3, 0, 0, 0, 'PENDING', $4::DATE, $5::DATE, $5::DATE)
                    ON CONFLICT (id) DO NOTHING;
                `, [buId, accountId, bpId, lastaccountingdate, nextaccountingdate]);

                // 4) Point the billing_profile at the new open bill_unit
                await this.db.executeQuery(`
                    UPDATE core_engine.billing_profile
                    SET nextbillunitid = $1
                    WHERE accountid = $2;
                `, [buId, accountId]);
            }
        }

        // ----------------------------------------------------------------
        // STEP 3 — Fake the Nokia "provisioned OK" callback via SQL.
        // Flip statuses only — no date manipulation.
        // Each statement is a separate executeQuery call because DatabaseHelper
        // uses pool.query (one connection per call); TEMP TABLEs would be lost
        // between calls, so we use parameterized $1/$2 instead.
        // Order follows 02-set-account-provisioned.sql exactly.
        // ----------------------------------------------------------------
        logger?.log(`[bypassProvisioning] STEP 3 — Faking Nokia callback: flipping statuses to COMPLETED / ACTIVE`);

        // 1. order_prov_sequence_list
        await this.db.executeQuery(`
            UPDATE core_oms.order_prov_sequence_list
            SET status = 'COMPLETED'
            WHERE id = $1
              AND status IN ('PENDING','PARTIAL','FAILED');
        `, [orderId]);

        // 2. order_provisioning_inputs
        await this.db.executeQuery(`
            UPDATE core_oms.order_provisioning_inputs
            SET status = 'COMPLETED'
            WHERE id = $1
              AND status IN ('PENDING','PARTIAL','FAILED');
        `, [orderId]);

        // 3. order_lines
        await this.db.executeQuery(`
            UPDATE core_oms.order_lines
            SET status = 'COMPLETED'
            WHERE id = $1
              AND status NOT IN ('COMPLETED','CANCELLED');
        `, [orderId]);

        // 4. order_services
        await this.db.executeQuery(`
            UPDATE core_oms.order_services
            SET status = 'COMPLETED', reason = NULL
            WHERE id = $1
              AND status NOT IN ('COMPLETED','CANCELLED');
        `, [orderId]);

        // 5. order_billables
        await this.db.executeQuery(`
            UPDATE core_oms.order_billables
            SET status = 'COMPLETED'
            WHERE id = $1
              AND status NOT IN ('COMPLETED','CANCELLED','BILLING_ERROR');
        `, [orderId]);

        // 6. order_oms_task_list
        await this.db.executeQuery(`
            UPDATE core_oms.order_oms_task_list
            SET status = 'COMPLETED'
            WHERE id = $1
              AND status NOT IN ('COMPLETED','CANCELLED','NOT_REQUIRED');
        `, [orderId]);

        // 7. subscription → ACTIVE
        await this.db.executeQuery(`
            UPDATE core_engine.subscription
            SET status = 'ACTIVE'
            WHERE accountid = $1 AND status <> 'CLOSED';
        `, [accountId]);

        // 8. service_unit → ACTIVE
        await this.db.executeQuery(`
            UPDATE core_engine.service_unit
            SET status = 'ACTIVE'
            WHERE accountid = $1 AND status <> 'CLOSED';
        `, [accountId]);

        // 9. price_unit → ACTIVE
        await this.db.executeQuery(`
            UPDATE core_engine.price_unit
            SET status = 'ACTIVE'
            WHERE accountid = $1 AND status <> 'CLOSED';
        `, [accountId]);

        // 10. order → COMPLETED (guard already applied by pre-check: only eligible orders get here)
        await this.db.executeQuery(`
            UPDATE core_oms."order"
            SET status = 'COMPLETED', reason = NULL
            WHERE id = $1;
        `, [orderId]);

        logger?.log(`[bypassProvisioning] STEP 3 — All status flips applied.`);

        // ----------------------------------------------------------------
        // STEP 4 — Post-check: verify order = COMPLETED and ACTIVE records exist.
        // ----------------------------------------------------------------
        logger?.log(`[bypassProvisioning] STEP 4 — Post-check: verifying final statuses`);

        const postCheck = await this.db.executeQuery(`
            SELECT
                (SELECT status FROM core_oms."order" WHERE id = $1) AS order_status,
                (SELECT COUNT(*)::int FROM core_engine.subscription
                 WHERE accountid = $2 AND status = 'ACTIVE') AS active_subs,
                (SELECT COUNT(*)::int FROM core_engine.price_unit
                 WHERE accountid = $2 AND status = 'ACTIVE') AS active_pus;
        `, [orderId, accountId]);

        const { order_status, active_subs, active_pus } = postCheck[0];
        logger?.log(`[bypassProvisioning] Post-check — order: ${order_status}, active subscriptions: ${active_subs}, active price_units: ${active_pus}`);

        if (order_status !== 'COMPLETED') {
            throw new Error(
                `[bypassProvisioning] Post-check failed: order ${orderId} status is '${order_status}', expected 'COMPLETED'.`
            );
        }

        logger?.log(`[bypassProvisioning] ✅ Bypass provisioning completed successfully for account ${accountId} / order ${orderId}.`);
    }

    /**
     * Fabricate a subscription subtree on a target account by applying a
     * pre-captured fixture snapshot (test-data/provisioning-fixture.json).
     *
     * Use when the target account's product is PROVISIONABLE (needs ALU/Nokia)
     * and the sandbox cannot run that, so the engine never created the
     * subscription. Reads a static JSON snapshot of a known-good account and
     * INSERTs those rows (with ID remapping) into the target account so billing
     * has something to bill — without querying any source account at test-time.
     *
     * Applies (INSERT...VALUES from fixture):
     *   subscription → service_unit → price_unit → price_unit_rating_attributes
     * IDs are remapped by appending idSuffix (keeps FKs consistent + unique).
     * accountid is set to targetAccountId. Status forced ACTIVE.
     *
     * To refresh the fixture: run scripts/capture-provisioning-fixture.js,
     * then commit the updated test-data/provisioning-fixture.json.
     *
     * !!! SANDBOX-ONLY HACK. Not for prod. !!!
     *
     * @param targetAccountId - The account to apply the subscription subtree onto.
     * @param idSuffix        - Suffix appended to all cloned IDs to ensure uniqueness. Defaults to '-SIM'.
     *                          Pass a dynamic value (e.g. `-SIM-${Date.now()}`) when re-running tests.
     * @param cycleStartDate  - Optional. If provided (format 'YYYY-MM-DD'), overrides the cloned price_unit's
     *                          cyclestart with this date and cycleend with the 1st of the following month.
     *                          Useful when the test generates its own startDate and needs dates to align.
     *                          If omitted, cyclestart/cycleend are copied as-is from the fixture.
     * @param logger          - Optional TestLogger instance.
     * @throws Error if the fixture is empty, or if pre-check or post-check fails.
     */
    async fabricateSubscriptionClone(
        targetAccountId: string,
        idSuffix = '-SIM',
        cycleStartDate?: string,
        logger?: TestLogger
    ): Promise<void> {
        logger?.log(`[fabricateSubscriptionClone] Target: ${targetAccountId} | suffix: '${idSuffix}' | cycleStartDate: ${cycleStartDate ?? 'use fixture dates'}`);

        // ----------------------------------------------------------------
        // LOAD FIXTURE — read static JSON snapshot from disk
        // ----------------------------------------------------------------
        const fixturePath = path.join(process.cwd(), 'test-data', 'provisioning-fixture.json');
        if (!fs.existsSync(fixturePath)) {
            throw new Error(
                `[fabricateSubscriptionClone] Fixture file not found: ${fixturePath}. ` +
                `Run: node -r dotenv/config scripts/capture-provisioning-fixture.js`
            );
        }
        const fixture: ProvisioningFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

        if (fixture.subscriptions.length === 0 || fixture.priceUnits.length === 0) {
            throw new Error(
                `[fabricateSubscriptionClone] Fixture is empty (subscriptions: ${fixture.subscriptions.length}, priceUnits: ${fixture.priceUnits.length}). ` +
                `Run: node -r dotenv/config scripts/capture-provisioning-fixture.js`
            );
        }
        logger?.log(`[fabricateSubscriptionClone] Fixture loaded (captured: ${fixture.capturedAt}) — ` +
            `${fixture.subscriptions.length} sub(s), ${fixture.serviceUnits.length} su(s), ` +
            `${fixture.priceUnits.length} pu(s), ${fixture.priceUnitRatingAttributes.length} pra(s)`);

        // ----------------------------------------------------------------
        // PRE-CHECK — target must have billing_profile and NOT yet have a
        // subscription (to avoid duplicates). No source account needed.
        // ----------------------------------------------------------------
        logger?.log(`[fabricateSubscriptionClone] PRE-CHECK — verifying target account state`);

        const preCheck = await this.db.executeQuery(`
            SELECT
                (SELECT COUNT(*)::int FROM core_engine.subscription
                 WHERE accountid = $1 AND status <> 'CLOSED') AS tgt_sub_count,
                (SELECT COUNT(*)::int FROM core_engine.billing_profile
                 WHERE accountid = $1) AS tgt_bp_count;
        `, [targetAccountId]);

        const { tgt_sub_count, tgt_bp_count } = preCheck[0];
        logger?.log(`[fabricateSubscriptionClone] Pre-check — tgt_sub: ${tgt_sub_count}, tgt_bp: ${tgt_bp_count}`);

        if (tgt_sub_count > 0) {
            throw new Error(
                `[fabricateSubscriptionClone] Pre-check failed: target account ${targetAccountId} already has ${tgt_sub_count} subscription(s). ` +
                `Aborted to avoid duplicates.`
            );
        }
        if (tgt_bp_count === 0) {
            throw new Error(
                `[fabricateSubscriptionClone] Pre-check failed: target account ${targetAccountId} has no billing_profile. ` +
                `Billing will fail after apply â€” ensure the account has a billing profile first.`
            );
        }

        // ----------------------------------------------------------------
        // APPLY STEP 1 â€” subscription
        // Each fixture row is inserted with id remapped (id + idSuffix),
        // accountid set to targetAccountId, status forced ACTIVE.
        // ----------------------------------------------------------------
        logger?.log(`[fabricateSubscriptionClone] Applying ${fixture.subscriptions.length} subscription(s)...`);

        for (const row of fixture.subscriptions) {
            const r = row as Record<string, unknown>;
            await this.db.executeQuery(`
                INSERT INTO core_engine.subscription
                    (uuid, id, name, accountid, status,
                     initialterm, initialtermunit, renewalterm, renewaltermunit,
                     trialterm, trialtermunit, createddate, effectivedate,
                     startdate, enddate, reason, category, balanceunitid, creditprofilename)
                VALUES ($1, $1, $2, $3, 'ACTIVE',
                        $4, $5, $6, $7,
                        $8, $9, $10, $11,
                        $12, $13, $14, $15, $16, $17)
                ON CONFLICT (id) DO NOTHING;
            `, [
                String(r.id) + idSuffix,
                String(r.name) + idSuffix,
                targetAccountId,
                r.initialterm ?? null, r.initialtermunit ?? null,
                r.renewalterm ?? null, r.renewaltermunit ?? null,
                r.trialterm ?? null, r.trialtermunit ?? null,
                r.createddate ?? null, r.effectivedate ?? null,
                r.startdate ?? null, r.enddate ?? null,
                r.reason ?? null, r.category ?? null,
                r.balanceunitid ?? null, r.creditprofilename ?? null,
            ]);
        }

        // ----------------------------------------------------------------
        // APPLY STEP 2 â€” service_unit
        // subscriptionid and provisioningid also remapped with suffix.
        // ----------------------------------------------------------------
        logger?.log(`[fabricateSubscriptionClone] Applying ${fixture.serviceUnits.length} service_unit(s)...`);

        for (const row of fixture.serviceUnits) {
            const r = row as Record<string, unknown>;
            await this.db.executeQuery(`
                INSERT INTO core_engine.service_unit
                    (uuid, id, type, accountid, status, reason, parentid,
                     provisioningid, packageid, bundleid,
                     createddate, effectivedate, subscriptionid, provisioneddate)
                VALUES ($1, $1, $2, $3, 'ACTIVE', $4, $5,
                        $6, $7, $8,
                        $9, $10, $11, $12)
                ON CONFLICT (id) DO NOTHING;
            `, [
                String(r.id) + idSuffix,
                r.type ?? null,
                targetAccountId,
                r.reason ?? null, r.parentid ?? null,
                r.provisioningid ? String(r.provisioningid) + idSuffix : null,
                r.packageid ?? null, r.bundleid ?? null,
                r.createddate ?? null, r.effectivedate ?? null,
                r.subscriptionid ? String(r.subscriptionid) + idSuffix : null,
                r.provisioneddate ?? null,
            ]);
        }

        // ----------------------------------------------------------------
        // APPLY STEP 3 â€” price_unit
        // serviceunitid and subscriptionid also remapped with suffix.
        // cyclestart/cycleend: overridden by cycleStartDate if provided.
        //   cyclestart = cycleStartDate
        //   cycleend   = first day of the following month
        // Otherwise fixture dates are used as-is.
        // ----------------------------------------------------------------
        logger?.log(`[fabricateSubscriptionClone] Applying ${fixture.priceUnits.length} price_unit(s)...`);

        for (const row of fixture.priceUnits) {
            const r = row as Record<string, unknown>;
            const cycleStart = cycleStartDate ?? (r.cyclestart as string | null) ?? null;
            const cycleEnd = cycleStartDate
                ? null   // computed by DB expression below
                : (r.cycleend as string | null) ?? null;

            await this.db.executeQuery(`
                INSERT INTO core_engine.price_unit
                    (uuid, id, priceofferid, serviceunitid, subscriptionid, accountid,
                     bundleid, packageid, servicetype, status,
                     cyclestart, cycleend, appliedstart, appliedend,
                     createddate, startdate, enddate,
                     priceoverride, priceoffset, discountpercent, quantity, reason,
                     instanceid, omsinternalid, noofcyclesapplied,
                     commitmentterm, commitmenttermunit)
                VALUES ($1, $1, $2, $3, $4, $5,
                        $6, $7, $8, 'ACTIVE',
                        $9::DATE,
                        CASE WHEN $10::text IS NULL
                             THEN (date_trunc('month', $9::DATE) + INTERVAL '1 month')::DATE
                             ELSE $10::DATE END,
                        $11, $12,
                        $13, $14, $15,
                        $16, $17, $18, $19, $20,
                        $21, $22, $23,
                        $24, $25)
                ON CONFLICT (id) DO NOTHING;
            `, [
                String(r.id) + idSuffix,
                r.priceofferid ?? null,
                r.serviceunitid ? String(r.serviceunitid) + idSuffix : null,
                r.subscriptionid ? String(r.subscriptionid) + idSuffix : null,
                targetAccountId,
                r.bundleid ?? null, r.packageid ?? null, r.servicetype ?? null,
                cycleStart,
                cycleEnd,
                r.appliedstart ?? null, r.appliedend ?? null,
                r.createddate ?? null, r.startdate ?? null, r.enddate ?? null,
                r.priceoverride ?? null, r.priceoffset ?? null,
                r.discountpercent ?? null, r.quantity ?? null, r.reason ?? null,
                r.instanceid ?? null, r.omsinternalid ?? null, r.noofcyclesapplied ?? null,
                r.commitmentterm ?? null, r.commitmenttermunit ?? null,
            ]);
        }

        // ----------------------------------------------------------------
        // APPLY STEP 4 â€” price_unit_rating_attributes
        // id must match the new price_unit id (fixture_id + idSuffix).
        // ----------------------------------------------------------------
        logger?.log(`[fabricateSubscriptionClone] Applying ${fixture.priceUnitRatingAttributes.length} price_unit_rating_attributes...`);

        for (const row of fixture.priceUnitRatingAttributes) {
            const r = row as Record<string, unknown>;
            await this.db.executeQuery(`
                INSERT INTO core_engine.price_unit_rating_attributes
                    (id, currency, purchaseproration, cancelproration,
                     upgradeproration, downgradeproration,
                     recurringunit, recurringfrequency, priceofferid, instanceid,
                     advanceflag, partmonthwaiveoffflag, calendarmonthflag,
                     alignedtocycle, cutoffdate)
                VALUES ($1, $2, $3, $4,
                        $5, $6,
                        $7, $8, $9, $10,
                        $11, $12, $13,
                        $14, $15)
                ON CONFLICT (id, priceofferid, instanceid) DO NOTHING;
            `, [
                String(r.id) + idSuffix,
                r.currency ?? null,
                r.purchaseproration ?? null, r.cancelproration ?? null,
                r.upgradeproration ?? null, r.downgradeproration ?? null,
                r.recurringunit ?? null, r.recurringfrequency ?? null,
                r.priceofferid ?? null, r.instanceid ?? null,
                r.advanceflag ?? null, r.partmonthwaiveoffflag ?? null,
                r.calendarmonthflag ?? null,
                r.alignedtocycle ?? null, r.cutoffdate ?? null,
            ]);
        }

        logger?.log(`[fabricateSubscriptionClone] All 4 tables applied.`);

        // ----------------------------------------------------------------
        // POST-CHECK â€” target should now have ACTIVE subscription, price_unit,
        // and matching rating_attributes.
        // ----------------------------------------------------------------
        logger?.log(`[fabricateSubscriptionClone] POST-CHECK â€” verifying target after apply`);

        const postCheck = await this.db.executeQuery(`
            SELECT
                (SELECT COUNT(*)::int FROM core_engine.subscription
                 WHERE accountid = $1 AND status = 'ACTIVE') AS active_subs,
                (SELECT COUNT(*)::int FROM core_engine.price_unit
                 WHERE accountid = $1 AND status = 'ACTIVE') AS active_pus,
                (SELECT COUNT(*)::int FROM core_engine.price_unit_rating_attributes
                 WHERE id IN (
                     SELECT pu.id FROM core_engine.price_unit pu WHERE pu.accountid = $1
                 )) AS rating_attrs;
        `, [targetAccountId]);

        const { active_subs, active_pus, rating_attrs } = postCheck[0];
        logger?.log(`[fabricateSubscriptionClone] Post-check â€” active_subs: ${active_subs}, active_pus: ${active_pus}, rating_attrs: ${rating_attrs}`);

        if (active_subs === 0 || active_pus === 0) {
            throw new Error(
                `[fabricateSubscriptionClone] Post-check failed: target ${targetAccountId} â€” ` +
                `active_subs=${active_subs}, active_pus=${active_pus}. Apply may have failed silently.`
            );
        }

        logger?.log(`[fabricateSubscriptionClone] âœ… Apply completed. Target ${targetAccountId} now has ${active_subs} sub(s), ${active_pus} pu(s), ${rating_attrs} pra(s).`);
    }
}
