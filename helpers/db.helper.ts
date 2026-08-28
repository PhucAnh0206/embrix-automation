import { Pool, PoolClient } from 'pg';
import { TestLogger } from './test-logger';

/**
 * DbHelper — direct Postgres client for the JASEC core database.
 *
 * Used by tests that need to seed or manipulate DB state that isn't
 * reachable via the UI or public APIs — e.g. simulating an account-in-debt
 * balance for TS-03 TC 3.2 (JASEC only produces positive CRC via kWh
 * consumption, which we don't automate).
 *
 * Connection is via env vars (see .env.example). Requires VPN + SSL.
 *
 * Usage:
 *   const bu = await db.getBalanceUnitIdForAccount('ACT-100171');
 *   await db.setBalanceAmount(bu, 500);   // put account into debt
 */
export class DbHelper {
  private pool: Pool | null = null;
  private logger?: TestLogger;

  constructor(logger?: TestLogger) {
    this.logger = logger;
  }

  private connectionConfig() {
    const host = process.env.DB_HOST;
    const port = Number(process.env.DB_PORT ?? '5432');
    const database = process.env.DB_NAME;
    const user = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;
    const sslMode = process.env.DB_SSL ?? 'require';

    if (!host || !database || !user || !password) {
      throw new Error(
        'DbHelper: missing DB_HOST / DB_NAME / DB_USER / DB_PASSWORD in env. ' +
        'Copy .env.example additions into .env and fill in the credentials.',
      );
    }

    return {
      host,
      port,
      database,
      user,
      password,
      ssl: sslMode === 'disable' ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      max: 5,
    };
  }

  /** Open the pool. Safe to call multiple times — no-op after first connect. */
  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = new Pool(this.connectionConfig());
    // Fail fast if creds are wrong / VPN is down.
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  /** Close the pool. Call in test teardown. */
  async disconnect(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error('DbHelper: pool not connected. Call connect() first.');
    }
    return this.pool;
  }

  /**
   * Run arbitrary parameterised SQL against the pool.
   *
   * Exposed so helpers that need queries beyond the balance operations above
   * (NotificationDbHelper) can reuse this connection handling instead of
   * opening a second pool. Prefer a named method here for anything reused.
   */
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const result = await this.requirePool().query(sql, params);
    return result.rows as T[];
  }

  /**
   * Look up the balance-unit UUID for the primary subscription of an account.
   * Throws if the account has no active subscription (i.e., no order yet).
   */
  async getBalanceUnitIdForAccount(accountId: string): Promise<string> {
    const pool = this.requirePool();
    const result = await pool.query<{ balanceunitid: string }>(
      `SELECT balanceunitid
         FROM core_engine.subscription
        WHERE accountid = $1
          AND status = 'ACTIVE'
        ORDER BY createddate DESC
        LIMIT 1`,
      [accountId],
    );

    if (result.rows.length === 0) {
      throw new Error(
        `DbHelper: no ACTIVE subscription found for account ${accountId}. ` +
        `Was the order created + submitted?`,
      );
    }

    const bu = result.rows[0].balanceunitid;
    this.logger?.data('Resolved balanceunitid', { accountId, balanceunitid: bu });
    return bu;
  }

  /**
   * Set the CRC amount on a balance unit. Positive = debt, negative = credit
   * (JASEC inverted sign convention).
   *
   * Returns the number of rows affected (should be 1). Throws if 0 or > 1.
   */
  async setBalanceAmount(balanceUnitId: string, amount: number): Promise<void> {
    const pool = this.requirePool();
    const result = await pool.query(
      `UPDATE core_engine.balance_unit_balances
          SET amount = $1
        WHERE id = $2
          AND currencyid = 'CRC'`,
      [amount, balanceUnitId],
    );

    if (result.rowCount !== 1) {
      throw new Error(
        `DbHelper: setBalanceAmount expected to update 1 row, got ${result.rowCount}. ` +
        `balanceUnitId=${balanceUnitId}`,
      );
    }

    this.logger?.data('Balance updated', { balanceUnitId, amount });
  }

  /**
   * Get the current CRC balance amount for a balance unit.
   * Returns null if no row (should never happen for a valid balance unit).
   */
  async getBalanceAmount(balanceUnitId: string): Promise<number | null> {
    const pool = this.requirePool();
    const result = await pool.query<{ amount: string }>(
      `SELECT amount
         FROM core_engine.balance_unit_balances
        WHERE id = $1
          AND currencyid = 'CRC'`,
      [balanceUnitId],
    );

    if (result.rows.length === 0) return null;
    return Number(result.rows[0].amount);
  }

  /** Convenience — one call to set an account's balance by accountId. */
  /**
   * How many saved cards the account has in core_engine.credit_card.
   *
   * The oracle for "no card was saved". The UI cannot answer that question: an
   * empty Credit Card Token field is identical whether nothing was ever saved or
   * the PlaceToPay callback simply has not landed yet, and waiting longer cannot
   * resolve an absence. Cases 1.2 (abandoned checkout) and 1.3 (declined card)
   * assert exactly that negative, so without this they can pass while proving
   * nothing -- they would keep passing even if the product started saving cards
   * from declined sessions.
   */
  async getSavedCardCount(accountId: string): Promise<number> {
    const rows = await this.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM core_engine.credit_card
        WHERE accountid = $1`,
      [accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * How many top-up records the account holds in core_engine.subscription_topup.
   *
   * This is the REGISTER side of the top-up flow. The flow makes two calls -- one
   * to PlaceToPay to charge the card, one to the CRM gateway to register the
   * top-up -- and only the second writes here. The charge itself leaves no row on
   * our side, so a rising count is the only evidence the money was actually
   * credited, and a flat count next to a completed charge means it was not.
   */
  async getTopUpCount(accountId: string): Promise<number> {
    const rows = await this.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM core_engine.subscription_topup
        WHERE accountid = $1`,
      [accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Accounts whose primary subscription is in `state`, newest first.
   *
   * Returns SEVERAL rather than one on purpose: not every account in a given
   * state is usable in Self Care. Smoke-test artefacts (AC-QCSMOKE-*) carry a
   * CLOSED subscription but cannot be attached to, and picking only the newest
   * hit exactly that on 2026-08-28. Callers should try candidates in order.
   *
   * Returns an empty array rather than throwing: an environment with no CLOSED or
   * SUSPENDED subscription is a data state, not a defect, and the caller should
   * skip that leg with the reason printed instead of failing.
   */
  async findAccountsBySubscriptionState(
    state: 'CLOSED' | 'ACTIVE' | 'SUSPENDED',
    limit = 5,
  ): Promise<string[]> {
    // ACTIVE/SUSPENDED must be EFFECTIVE at the current clock, not merely carry
    // that status. "Active" means the order was submitted AND the effective date
    // has been reached -- and because the CCP clock gets moved around freely, the
    // NEWEST subscription is often the one created under a later clock and now
    // sits months in the future. On 2026-08-28 this picked SUB-105744, status
    // ACTIVE with effectivedate 2027-01-09 against a clock of 2026-07-15, and its
    // top-up registration failed -- which is plausibly correct for a subscription
    // that has not started, and would have been filed as a product defect.
    //
    // CLOSED is exempt: a closed subscription has ended by definition, so the
    // window would exclude every candidate.
    const effectivityFilter =
      state === 'CLOSED'
        ? ''
        : `AND s.effectivedate <= (SELECT ccptime FROM core_config.ccp_time)
           AND (s.enddate IS NULL
                OR s.enddate > (SELECT ccptime FROM core_config.ccp_time))`;

    const rows = await this.query<{ accountid: string }>(
      `SELECT s.accountid
         FROM core_engine.subscription s
         JOIN core_engine.account a ON a.id = s.accountid
        WHERE s.status = $1
          AND a.status = 'ACTIVE'
          -- AC-QCSMOKE-* are smoke-test fixtures. They look complete in the DB
          -- (contact with e-mail, service rows, PREPAID, account ACTIVE) but Self
          -- Care will not open them: all four timed out at 180s each on
          -- 2026-08-28, burning the whole test budget before a real candidate was
          -- reached. Excluded so the caller finds a usable account or none at all.
          AND a.id NOT LIKE '%QCSMOKE%'
          ${effectivityFilter}
        -- Prefer an account that has ALREADY had a top-up registered: proof the
        -- whole path works for it, so a failure is about the state under test.
        ORDER BY (EXISTS (SELECT 1 FROM core_engine.subscription_topup t
                           WHERE t.accountid = a.id)) DESC,
                 s.id DESC
        LIMIT $2`,
      [state, limit],
    );
    return rows.map((r) => r.accountid);
  }

  /**
   * CRC balance regardless of subscription status.
   *
   * getAccountBalance resolves the balance unit through an ACTIVE subscription
   * and therefore throws for a SUSPENDED or CLOSED one -- which silently skipped
   * the balance assertion on exactly the leg where a top-up matters most, since
   * it is what restores service. This reads the balance unit directly off the
   * account, so state does not hide the number.
   */
  async getCrcBalanceAnyState(accountId: string): Promise<number | null> {
    const rows = await this.query<{ amount: string }>(
      `SELECT bub.amount
         FROM core_engine.balance_unit_balances bub
         JOIN core_engine.balance_unit bu ON bu.id = bub.id
        WHERE bu.accountid = $1
          AND bub.currencyid = 'CRC'
        LIMIT 1`,
      [accountId],
    );
    return rows.length ? Number(rows[0].amount) : null;
  }

  /** Current status of the account's primary subscription, or null if it has none. */
  async getSubscriptionStatus(accountId: string): Promise<string | null> {
    const rows = await this.query<{ status: string }>(
      `SELECT status FROM core_engine.subscription
        WHERE accountid = $1
        ORDER BY createddate DESC, id DESC
        LIMIT 1`,
      [accountId],
    );
    return rows.length ? rows[0].status : null;
  }

  /**
   * Force the account's primary subscription into `status`, returning its id.
   *
   * Used only as a FALLBACK when the environment holds no account in the state a
   * test needs -- creating a genuinely suspended account means driving it into
   * debt and waiting for CREDIT_LIMIT_ACTIONS, which is ts-04's whole job and
   * costs ~17 minutes. Direct state-setting has precedent here: ts-03 sets
   * balances the same way, for the same reason.
   *
   * It is a SYNTHETIC state and callers must say so in their log. It sets the
   * subscription row only, so anything downstream that reads service-unit or
   * provisioning state will not agree with it. That is fine for the top-up
   * registration path, which keys off the subscription, and is not safe to
   * assume beyond it.
   */
  async setSubscriptionStatus(
    accountId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED',
  ): Promise<string> {
    const rows = await this.query<{ id: string }>(
      `UPDATE core_engine.subscription
          SET status = $2
        WHERE id = (SELECT id FROM core_engine.subscription
                     WHERE accountid = $1
                     ORDER BY createddate DESC, id DESC
                     LIMIT 1)
      RETURNING id`,
      [accountId, status],
    );
    if (!rows.length) {
      throw new Error(`DbHelper: no subscription found for account ${accountId}`);
    }
    this.logger?.data('Subscription status forced', { accountId, status, id: rows[0].id });
    return rows[0].id;
  }

  async setAccountBalance(accountId: string, amount: number): Promise<void> {
    const bu = await this.getBalanceUnitIdForAccount(accountId);
    await this.setBalanceAmount(bu, amount);
  }

  /** Convenience — read an account's CRC balance directly. */
  async getAccountBalance(accountId: string): Promise<number> {
    const bu = await this.getBalanceUnitIdForAccount(accountId);
    const balance = await this.getBalanceAmount(bu);
    if (balance === null) {
      throw new Error(`DbHelper: no CRC balance row for account ${accountId}`);
    }
    return balance;
  }

  /**
   * Verify a top-up actually reached the backend. JASEC sign convention:
   * positive = debt, negative = credit, so a successful top-up of N moves
   * balance by −N (balanceAfter = balanceBefore − N).
   *
   * Guards against the "UI shows success but backend silently no-op'd" case
   * (e.g., subscription effective date not reached, orchestration failed).
   */
  async assertTopUpApplied(
    accountId: string,
    topUpAmount: number,
    balanceBefore: number,
  ): Promise<number> {
    const balanceAfter = await this.getAccountBalance(accountId);
    const expected = balanceBefore - topUpAmount;
    if (Math.abs(balanceAfter - expected) > 0.01) {
      throw new Error(
        `Top-up did not reach backend: expected balance ${expected} CRC, got ${balanceAfter} CRC ` +
        `(before=${balanceBefore}, topUp=${topUpAmount}, account=${accountId}). ` +
        `UI may have shown success but the balance did not move.`,
      );
    }
    this.logger?.data('Top-up verified via DB balance', {
      accountId, topUpAmount, balanceBefore, balanceAfter,
    });
    return balanceAfter;
  }
}
