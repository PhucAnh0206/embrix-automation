/**
 * NetSuite R2 — INV-002 / CRN-003: bill new contracts the way 9000207 / 9000209 were billed
 * (Daily Schedule in the Core UI, same route as JASEC TC-61 and CoopeG ts-01).
 *
 *   1. Clock to the cycle start (NS_RUN_START, default 2027-10-01); create a RESIDENTIAL contract (INV-002)
 *      and an INTERCOMPANY contract (CRN-003) through crm-gateway processAccountAndOrder (copy of the
 *      QA-ANH-NS-R2-10160723-P1 request).
 *   2. Clock to the bill date (NS_RUN_DATE, default 2027-11-01); Daily Schedule > date > Create > Process.
 *   3. Clock back to what it was, always.
 *
 * Bills EVERY account due on the bill date (2027-11-01 on 10-21: ~11 team / QA accounts) - run only with
 * the team's OK. Refuses to run if a schedule already exists on the bill date.
 * Run: $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; npx playwright test tests/coopeg/netsuite-actions/ns-billing-run.spec.ts --project=dev
 * Results: output/test-results/ns-billing-run.json (read with the GraphQL checks in notes).
 */
import * as fs from 'fs';
import { test, expect } from '../../../fixtures/page-factory';

const GQL = 'https://service-transactional.coopegsbx2.embrix.org/graphql';
const CRM = 'https://crm-gateway.coopegsbx2.embrix.org';
const START = process.env.NS_RUN_START ?? '2027-10-01';
const BILL = process.env.NS_RUN_DATE ?? '2027-11-01';
const SOURCE = 'QA-ANH-NS-R2-10160723-P1';

const gql = async (query: string) => (await (await fetch(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })).json()) as any;
const clock = async (): Promise<string> => (await gql('{ getCcpDateTime(dummy:"x") { ccpTime } }')).data.getCcpDateTime.ccpTime;
const setClock = async (d: string) => { await gql(`mutation { setCcpTime(input:{ccpTime:"${d}"}) { ccpTime } }`); return clock(); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('NS billing run: new contracts billed by the Daily Schedule', async ({ page, dailySchedulePage, testLogger }) => {
  test.setTimeout(60 * 60_000);
  expect(process.env.TEST_ENV, 'coopegsbx2 only').toBe('coopegsbx2');
  // NS_RUN_EXISTING=true: a schedule already created for the date but never processed (status PENDING) is processed
  // as it is. Any other existing schedule stops the run.
  const existing = (await gql(`{ getJobScheduleByDate(input:{scheduleDate:"${BILL}"}) { id status } }`)).data?.getJobScheduleByDate;
  const processExisting = process.env.NS_RUN_EXISTING === 'true' && existing?.status === 'PENDING';
  if (!processExisting) expect(existing, `a schedule already exists on ${BILL}`).toBeNull();

  const base = await clock();
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(4, 12);
  // NS_RUN_NO_CONTRACTS=true: bill only what is already due (on the develop build new contracts stay CREATED and
  // are never billed, Bug_032).
  const newContracts = process.env.NS_RUN_NO_CONTRACTS !== 'true';
  const src = newContracts ? JSON.parse((await gql(`{ searchActivities(page:1,size:5,filter:{accountId:"${SOURCE}",apiName:"PROCESS_ACCOUNT_AND_ORDER"}) { request } }`)).data.searchActivities[0].request) : {};
  const out: any = { base, start: START, bill: BILL, contracts: {} as Record<string, any> };
  try {
    if (newContracts) testLogger.log(`clock ${base} -> ${await setClock(START)}`);
    for (const [tag, type] of newContracts ? [['N', 'RESIDENTIAL'], ['I', 'INTERCOMPANY']] as const : []) {
      const acc = `QA-ANH-NS-R2-${stamp}-${tag}`;
      const body = { ...src, accountId: acc, orderId: `${acc}-O`, accounttype: type, lastName: `R2 ${tag}` };
      const r = await fetch(`${CRM}/processAccountAndOrder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      testLogger.log(`${tag} ${type} ${acc}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      out.contracts[tag] = { acc, type, http: r.status };
    }
    // Both contracts must start on START (first cycle START -> BILL) or the run would not bill them.
    for (const c of Object.values<any>(out.contracts)) {
      let a: any, bu: any[] = [];
      for (let i = 0; i < 18; i++) {
        await sleep(10_000);
        a = (await gql(`{ getAccountById(input:{id:"${c.acc}"}) { status type effectiveDate } }`)).data?.getAccountById;
        bu = (await gql(`{ searchBillUnits(page:1,size:10,filter:{accountId:"${c.acc}"}) { id status startDate endDate } }`)).data?.searchBillUnits ?? [];
        if (a && bu.some(b => b.endDate === BILL)) break;
      }
      c.account = a; c.billUnits = bu;
      testLogger.log(`${c.acc}: ${JSON.stringify(a)} bill units ${JSON.stringify(bu)}`);
      expect(a?.effectiveDate, `${c.acc} effective date`).toBe(START);
      expect(bu.some(b => b.endDate === BILL), `${c.acc} has a cycle ending ${BILL}`).toBeTruthy();
    }

    testLogger.log(`clock -> ${await setClock(BILL)}`);
    if (processExisting) {
      testLogger.log(`processing the existing schedule ${existing.id}`);
      await (page as any).navigateToHome();
      await dailySchedulePage.navigateViaNav();
      await dailySchedulePage.inputJobCalendar(BILL);
      const processBtn = page.getByRole('button', { name: 'Process', exact: true });
      await processBtn.waitFor({ state: 'visible', timeout: 60_000 });
      for (let i = 0; i < 60 && !(await processBtn.isEnabled()); i++) await page.waitForTimeout(1_000);
      await dailySchedulePage.clickProcess();
      await dailySchedulePage.confirmProcess();
      await dailySchedulePage.waitForAllJobsCompleted(testLogger, 40);
      out.cards = await dailySchedulePage.jobStatuses();
    } else {
      out.cards = await dailySchedulePage.createAndProcess(BILL, () => setClock(BILL).then(() => undefined), testLogger);
    }
    testLogger.log(`job cards: ${JSON.stringify(out.cards)}`);
    await page.screenshot({ path: 'output/test-results/ns-billing-run-cards.png', fullPage: true }).catch(() => {});
  } finally {
    out.restored = await setClock(base);
    testLogger.log(`clock restored: ${out.restored}`);
    fs.mkdirSync('output/test-results', { recursive: true });
    fs.writeFileSync('output/test-results/ns-billing-run.json', JSON.stringify(out, null, 2));
  }
  expect(out.restored.slice(0, 10)).toBe(base.slice(0, 10));
});
