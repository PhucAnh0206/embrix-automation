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
