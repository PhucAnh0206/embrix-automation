import { Pool } from 'pg';
import { EXTRA_LONG_WAIT } from './timeouts.helper';


export class DatabaseHelper {
    private pool: Pool;

    constructor() {
        this.pool = new Pool({
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT),
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            ssl: {
                rejectUnauthorized: false,
            },
            statement_timeout: EXTRA_LONG_WAIT,
            max: 10, // Max number of clients in the pool
        });
    }

    /** Execute a SQL query and return the result set. */
    async executeQuery(sql: string, params: any[] = []): Promise<any[]> {
        const res = await this.pool.query(sql, params);
        return res.rows;
    }

    /** Disconnect the pool. Usually called at the end of the test suite if needed. */
    async disconnect(): Promise<void> {
        await this.pool.end();
    }
}