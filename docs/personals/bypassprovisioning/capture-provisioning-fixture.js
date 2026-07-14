/**
 * capture-provisioning-fixture.js
 * --------------------------------
 * One-time script: dumps the ACTIVE subscription subtree of a source account
 * from the sandbox DB into test-data/provisioning-fixture.json.
 *
 * The resulting JSON is committed to the repo and used by fabricateSubscriptionClone
 * to INSERT rows into new test accounts — without querying the source account at
 * test-time.
 *
 * Usage (from project root):
 *   node -r dotenv/config scripts/capture-provisioning-fixture.js
 *
 * Re-run whenever the source account's data changes and commit the updated JSON.
 *
 * Environment variables required (loaded from .env via dotenv):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 *
 * Optional override:
 *   FIXTURE_SOURCE_ACCOUNT_ID=<accountId>  (default: 2118051)
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SOURCE_ACCOUNT_ID = process.env.FIXTURE_SOURCE_ACCOUNT_ID ?? '2118041';
const OUTPUT_PATH = path.join(process.cwd(), 'test-data', 'provisioning-fixture.json');

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30000,
});

async function main() {
    console.log(`\n📸 Capturing provisioning fixture for account: ${SOURCE_ACCOUNT_ID}`);
    console.log(`   Output: ${OUTPUT_PATH}\n`);

    const client = await pool.connect();
    try {
        // ── 1. subscription ───────────────────────────────────────────────────
        console.log('  → Querying core_engine.subscription (latest)...');
        const subRes = await client.query(`
            SELECT
                id, name, initialterm, initialtermunit, renewalterm, renewaltermunit,
                trialterm, trialtermunit, createddate, effectivedate,
                startdate, enddate, reason, category, balanceunitid, creditprofilename
            FROM core_engine.subscription
            WHERE accountid = '${SOURCE_ACCOUNT_ID}'::text
            ORDER BY id DESC
            LIMIT 1;
        `);

        if (subRes.rows.length === 0) {
            throw new Error(`No subscriptions found for account ${SOURCE_ACCOUNT_ID}. ` +
                'Ensure the account exists.');
        }
        const subscriptionId = subRes.rows[0].id;
        console.log(`     Found subscription: ${subscriptionId}`);

        // ── 2. service_unit ───────────────────────────────────────────────────
        console.log(`  → Querying core_engine.service_unit for subscription ${subscriptionId} ...`);
        const suRes = await client.query(`
            SELECT
                id, type, reason, parentid, provisioningid, packageid, bundleid,
                createddate, effectivedate, subscriptionid, provisioneddate
            FROM core_engine.service_unit
            WHERE subscriptionid = '${subscriptionId}'
            ORDER BY id;
        `);
        console.log(`     Found ${suRes.rows.length} service_unit(s).`);

        // ── 3. price_unit ─────────────────────────────────────────────────────
        console.log(`  → Querying core_engine.price_unit for subscription ${subscriptionId} ...`);
        const puRes = await client.query(`
            SELECT
                id, priceofferid, serviceunitid, subscriptionid,
                bundleid, packageid, servicetype,
                cyclestart, cycleend, appliedstart, appliedend,
                createddate, startdate, enddate,
                priceoverride, priceoffset, discountpercent, quantity, reason,
                instanceid, omsinternalid, noofcyclesapplied,
                commitmentterm, commitmenttermunit
            FROM core_engine.price_unit
            WHERE subscriptionid = '${subscriptionId}'
            ORDER BY id;
        `);

        if (puRes.rows.length === 0) {
            throw new Error(`No price_units found for subscription ${subscriptionId}.`);
        }
        console.log(`     Found ${puRes.rows.length} price_unit(s).`);

        // ── 4. price_unit_rating_attributes ───────────────────────────────────
        console.log('  → Querying core_engine.price_unit_rating_attributes ...');
        const praIds = puRes.rows.map(r => r.id);
        const praRes = await client.query(`
            SELECT
                id, currency, purchaseproration, cancelproration,
                upgradeproration, downgradeproration,
                recurringunit, recurringfrequency, priceofferid, instanceid,
                advanceflag, partmonthwaiveoffflag, calendarmonthflag,
                alignedtocycle, cutoffdate
            FROM core_engine.price_unit_rating_attributes
            WHERE id IN (${praIds.map(id => `'${id}'`).join(',')})
            ORDER BY id;
        `);
        console.log(`     Found ${praRes.rows.length} rating_attribute(s).`);

        // ── Serialize dates as YYYY-MM-DD strings ─────────────────────────────
        const serialize = (rows) => rows.map(row => {
            const out = {};
            for (const [k, v] of Object.entries(row)) {
                out[k] = (v instanceof Date) ? v.toISOString().split('T')[0] : v;
            }
            return out;
        });

        // ── Write JSON ────────────────────────────────────────────────────────
        const fixture = {
            capturedAt: new Date().toISOString(),
            sourceAccountId: SOURCE_ACCOUNT_ID,
            note: 'Snapshot of a successfully provisioned sandbox account. ' +
                'Used by fabricateSubscriptionClone to seed new test accounts. ' +
                'Sandbox-only. Re-run capture-provisioning-fixture.js to refresh.',
            subscriptions: serialize(subRes.rows),
            serviceUnits: serialize(suRes.rows),
            priceUnits: serialize(puRes.rows),
            priceUnitRatingAttributes: serialize(praRes.rows),
        };

        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fixture, null, 2), 'utf-8');

        console.log(`\n✅ Fixture written to: ${OUTPUT_PATH}`);
        console.log(`   subscriptions:             ${fixture.subscriptions.length}`);
        console.log(`   serviceUnits:              ${fixture.serviceUnits.length}`);
        console.log(`   priceUnits:                ${fixture.priceUnits.length}`);
        console.log(`   priceUnitRatingAttributes: ${fixture.priceUnitRatingAttributes.length}`);
        console.log('\n   Commit test-data/provisioning-fixture.json to the repo.\n');

    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(err => {
    console.error('\n❌ Capture failed:', err.message);
    process.exit(1);
});
