// helpers/db/job-schedule.db.ts
import { DbHelper } from '../db.helper';

export class JobScheduleDbHelper {
    private readonly db = new DbHelper();

    /** Connects on first use, so a test that never queries never needs the DB. */
    private async conn(): Promise<DbHelper> {
        await this.db.connect();
        return this.db;
    }

    /**
     * Get Job Schedule from Database by date
     */
    async getJobSchedule(date: string): Promise<any[]> {
        const sqlQuery = `SELECT * FROM core_engine.job_schedule js WHERE scheduledate = $1::DATE;`;
        return (await this.conn()).query(sqlQuery, [date]);
    }

    /**
     * Delete Job Schedule from Database by id
     */
    async deleteJobScheduleById(id: string): Promise<void> {
        const sqlQuery1 = `DELETE FROM core_engine.job_schedule_list WHERE id = $1;`;
        const sqlQuery2 = `DELETE FROM core_engine.job_schedule WHERE id = $1;`;

        const db = await this.conn();
        await db.query(sqlQuery1, [id]);
        await db.query(sqlQuery2, [id]);
    }

    async disconnect(): Promise<void> {
        await this.db.disconnect();
    }
}
