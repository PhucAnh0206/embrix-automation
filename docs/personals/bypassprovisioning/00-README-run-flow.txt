==============================================================================
 SIMULATE PROVISIONING -> BILLING ON SANDBOX/DEMO (no real NOKIA, no broker)
==============================================================================

WHAT THIS DOES
  Take an order that is stuck in CREATED (future-dated, and/or the OMS broker
  isn't consuming on the sandbox) and carry it all the way to a recurring
  invoice, using only:
    - GraphQL  (drive the order through the engine, in-process)
    - SQL      (fake the NOKIA "provisioned OK" callback)
    - the UI / GraphQL clock + billing job

FILES IN THIS FOLDER
  00-README-run-flow.txt        <- you are here
  01-graphql-commands.txt       <- the GraphQL mutations to run
  02-set-account-provisioned.sql<- the SQL that fakes "provisioned OK"

KEY IDEA (why nothing worked before)
  - SQL alone CANNOT create the subscription/price_unit - that is engine logic.
  - The UI "Submit Order" goes through the OMS broker queue (async, flaky on
    sandbox) and a future-dated order won't execute now anyway.
  - So we let the ENGINE process the order synchronously via a GraphQL mutation
    (updateOrderStatus). That creates the subscription + price_unit and moves the
    order to PROVISIONING_INITIATED, WITHOUT the broker and WITHOUT NOKIA.
  - Then SQL fakes the NOKIA success callback. Then we bill via the clock + job.

------------------------------------------------------------------------------
 STEPS
------------------------------------------------------------------------------

STEP 0 - Enable provisioning  (so the order routes through provisioning)
  coreui -> Config -> CCP Properties -> provisioningEnabled = true
  (Use the UI: it refreshes the Redis cache so pods see it immediately. A raw
   SQL update does NOT take effect until the cache is refreshed.)
  The product / price offer must be provisionable (isprovisionable = true).

STEP 1 - Process the order through the engine  (GraphQL, file 01, mutation #1)
  Run updateOrderStatus with status SUBMITTED and executeFutureOrderNow:true.
  Result: engine creates subscription + service_unit + price_unit and moves the
  order to PROVISIONING_INITIATED. It tries to reach NOKIA, gets no answer, so
  the order just sits at PROVISIONING_INITIATED (or PROVISIONING_ERROR). Good -
  the subscription/price_unit already exist.

STEP 2 - Verify  (SQL, the check block at the top of file 02 / quick query)
  order = PROVISIONING_INITIATED (or PROVISIONING_ERROR)
  subscription >= 1, price_unit >= 1
  If order is still CREATED or subscription = 0 -> Step 0/1 didn't take (provisioning
  off, product not provisionable, or the mutation errored). Fix that first.

STEP 3 - Fake the NOKIA "provisioned OK" callback  (SQL, file 02)
  Open 02-set-account-provisioned.sql, set the account id, run the whole script.
    Grid #1 (pre-check): order = PROVISIONING_INITIATED, subscription/price_unit > 0
    Grid #2 (post):      ORDER = COMPLETED, SUB/SERVICE_UNIT/PRICE_UNIT = ACTIVE
  Grid #2 correct -> type COMMIT;   wrong/not eligible -> type ROLLBACK;

STEP 4 - Bill it  (GraphQL file 01 mutations #2 and #3, or the UI)
  a) Set the system clock to a date on/after the account's nextbilldate so the
     cycle is due:  setCcpTime (mutation #2).
  b) Run the billing job (Jobs Management -> Job Schedule), or runBilling
     (mutation #3). The recurring invoice is generated.
  If billing complains PENDING_DEFERRED_PURCHASE_JOB, run the deferred-purchase
  job first, then billing.

------------------------------------------------------------------------------
 TRAPS - DO NOT REPEAT
------------------------------------------------------------------------------
  1. Do NOT disable provisioning to avoid NOKIA - it also stops the subscription
     from being created, leaving the order stuck at CREATED.
  2. Do NOT hand-edit dates on the account. The sandbox runs a fake clock
     (ccp_time, ~2024); real-world 2026 dates look like the future and billing
     skips them. Control time ONLY through ccp_time (setCcpTime).
  3. provisioningEnabled via raw SQL won't take effect until the Redis cache is
     refreshed - set it from the UI Config screen.
==============================================================================
