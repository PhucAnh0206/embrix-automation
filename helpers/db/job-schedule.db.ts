// helpers/db/job-schedule.db.ts
import { DatabaseHelper } from '../database.helper';

export class JobScheduleDbHelper {
    private db: DatabaseHelper;

    constructor() {
        this.db = new DatabaseHelper();
    }

    /**
     * Get Job Schedule from Database by date
     */
    async getJobSchedule(date: string): Promise<any[]> {
        const sqlQuery = `SELECT * FROM core_engine.job_schedule js WHERE scheduledate = $1::DATE;`;
        return this.db.executeQuery(sqlQuery, [date]);
    }

    /**
     * Delete Job Schedule from Database by id
     */
    async deleteJobScheduleById(id: string): Promise<void> {
        const sqlQuery1 = `DELETE FROM core_engine.job_schedule_list WHERE id = $1;`;
        const sqlQuery2 = `DELETE FROM core_engine.job_schedule WHERE id = $1;`;
        
        await this.db.executeQuery(sqlQuery1, [id]);
        await this.db.executeQuery(sqlQuery2, [id]);
    }
}
