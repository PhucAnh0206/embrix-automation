/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX). JEPYP-316 charter 4.6 / N6 and 3.4 / 3.5 / N2 / N3.
 * API + DB only (no browser, no clock move, no billing).
 *
 * 1. PRIMARY order: createAccount with several contacts and no contact ids (what the form sends now the id is hidden).
 *    Expected (change-set page §2 row 5): the FIRST contact sent becomes PRIMARY, the rest CONTACT-n. 4 accounts:
 *    María→Jorge, Jorge→María, María→Jorge, Ana→María→Jorge.
 * 2. Address edits on one of OUR accounts (customerId QA316-*, full address, e.g. scenario E of explore-316-01):
 *    edit only Distrito -> saved; then edit only Otras señas (street) -> Distrito kept (change-set §6).
 *    The account is given by JEPYP316_EDIT_ACCOUNT; its address is restored at the end.
 *
 * MUTATING (own data): creates 4 accounts QA316-PRI-* (no order), edits one QA316 account. dev / preprod.
 *   $env:JEPYP316_EDIT_ACCOUNT='ACT-100462'; npx playwright test --project=jasec-customer-form-explore --grep "@316-contacts"
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const ENV = process.env.TEST_ENV ?? '';
const ALLOWED = ['jasec-dev', 'jasec-preprod'].includes(ENV);
const URL = process.env.EMBRIX_GRAPHQL_URL ?? process.env.GRAPH_URLS ?? '';
const EDIT_ACCOUNT = process.env.JEPYP316_EDIT_ACCOUNT ?? '';
const EVIDENCE = process.env.JEPYP316_EVIDENCE_DIR ?? path.resolve(__dirname,
  `../../../../../../Regression testing/EPDP-348_JASEC-Test/EXPLORE_JEPYP-316_customer-form/evidence/${ENV.replace('jasec-', '')}`);

async function gql(query: string, token?: string): Promise<any> {
  const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query }) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { httpStatus: res.status, raw: text.slice(0, 300) }; }
}

test('JEPYP-316 contacts (PRIMARY order) and address edits (exploratory) @316-contacts', async () => {
  if (blockedIf(!ALLOWED, `dev / preprod only (TEST_ENV=${ENV})`)) return;
  if (blockedIf(!hasDbConfig() || !URL, 'needs DB access and the GraphQL URL')) return;
  test.setTimeout(300_000);
  const db = new DbHelper();
  await db.connect();
  const report: Record<string, unknown> = { env: ENV, at: new Date().toISOString() };
  try {
    const login = await gql(`{ userLogin(input: {userName: ${JSON.stringify(process.env.EMBRIX_USER)}, password: ${JSON.stringify(process.env.EMBRIX_PASSWORD)}}) { token } }`);
    const token: string = login?.data?.userLogin?.token;
    if (blockedIf(!token, 'GraphQL login failed')) return;

    // 1. PRIMARY order.
    const contact = (f: string, l: string, role: string) =>
      `{roles:[${role}], firstName:"${f}", lastName:"${l}", identityDocument:"CÉDULA DE IDENTIDAD", email:"anh.tran@congerotechnology.com"}`;
    const runs: Array<[string, Array<[string, string, string]>]> = [
      ['María then Jorge', [['María', 'Rojas', 'BILLING'], ['Jorge', 'Mora', 'SERVICE']]],
      ['Jorge then María', [['Jorge', 'Mora', 'SERVICE'], ['María', 'Rojas', 'BILLING']]],
      ['María then Jorge (repeat)', [['María', 'Rojas', 'BILLING'], ['Jorge', 'Mora', 'SERVICE']]],
      ['Ana, María, Jorge', [['Ana', 'Solano', 'SOLD_TO'], ['María', 'Rojas', 'BILLING'], ['Jorge', 'Mora', 'SERVICE']]],
    ];
    const primary: unknown[] = [];
    for (const [name, cs] of runs) {
      const s = Date.now().toString(36).toUpperCase();
      const r = await gql(`mutation { createAccount(input:{
        currency:"CRC", type: RESIDENTIAL, accountCategory: PREPAID, customerSegment: B2C, salesChannel: NONE, marketSegment: NONE, subType: NONE,
        name:"QA316 PRIMARY ${s}", customerId:"QA316-PRI-${s}",
        contacts:[${cs.map(c => contact(...c)).join(', ')}],
        addresses:[{roles:[BILLING], street:"", city:"Cartago", state:"Cartago", country:"CRI", postalCode:""}],
        billingProfiles:[{billingDom:1, billingFrequency: MONTHLY, invoiceType: SUMMARY, invoiceDelivery: EMAIL, paymentProfileId:"PRIMARY"}],
        paymentProfiles:[{paymentMethod: CHECK, paymentTerm:"NET_30"}] }){ id } }`, token);
      const id = r?.data?.createAccount?.id;
      if (!id) { primary.push({ name, error: r.errors ?? r }); console.log(`  ${name}: ERROR ${JSON.stringify(r.errors ?? r).slice(0, 200)}`); continue; }
      const rows = await db.query<{ id: string; firstname: string }>(`SELECT id, firstname FROM core_engine.contact WHERE accountid = $1 ORDER BY id`, [id]);
      const p = rows.find(x => x.id === 'PRIMARY');
      const ok = p?.firstname === cs[0][0];
      console.log(`  ${name}: ${id} -> ${rows.map(x => `${x.id}=${x.firstname}`).join(', ')}  ${ok ? 'PRIMARY = first sent ✅' : `PRIMARY = ${p?.firstname} ❌`}`);
      primary.push({ name, accountId: id, sent: cs.map(c => c[0]), contacts: rows, ok });
      await new Promise(r2 => setTimeout(r2, 1200));
    }
    report.primaryOrder = primary;

    // 2. Address edits on our own account.
    if (EDIT_ACCOUNT) {
      const owner = (await db.query<{ customerid: string }>(`SELECT customerid FROM core_engine.account WHERE id = $1`, [EDIT_ACCOUNT]))[0];
      if (blockedIf(!owner || !owner.customerid.startsWith('QA316-'), `${EDIT_ACCOUNT} is not one of our QA316 accounts`)) return;
      const read = async () => (await db.query<{ street: string; city: string; state: string; district: string | null; postalcode: string }>(
        `SELECT street, city, state, district, postalcode FROM core_engine.address WHERE accountid = $1 AND id = 'PRIMARY'`, [EDIT_ACCOUNT]))[0];
      const before = await read();
      const newDistrict = before.district === 'Cachí' ? 'Orosi' : 'Cachí';
      await gql(`mutation { modifyAccount(input:{ id:"${EDIT_ACCOUNT}", addresses:[{ id:"PRIMARY", district:${JSON.stringify(newDistrict)} }] }){ id } }`, token);
      const afterDistrict = await read();
      await gql(`mutation { modifyAccount(input:{ id:"${EDIT_ACCOUNT}", addresses:[{ id:"PRIMARY", street:"300 m sur de la iglesia" }] }){ id } }`, token);
      const afterStreet = await read();
      // Restore what the account held before.
      await gql(`mutation { modifyAccount(input:{ id:"${EDIT_ACCOUNT}", addresses:[{ id:"PRIMARY", street:${JSON.stringify(before.street)}, district:${JSON.stringify(before.district ?? '')} }] }){ id } }`, token);
      const restored = await read();
      const districtOnly = afterDistrict.district === newDistrict ? 'SAVED ✅' : `IGNORED ❌ (still ${JSON.stringify(afterDistrict.district)})`;
      const streetOnly = afterStreet.street === '300 m sur de la iglesia' && afterStreet.district === afterDistrict.district
        ? 'street saved, Distrito KEPT ✅' : `Distrito now ${JSON.stringify(afterStreet.district)} ❌`;
      console.log(`\n  ${EDIT_ACCOUNT} before ${JSON.stringify(before)}`);
      console.log(`  edit only Distrito -> ${newDistrict}: ${districtOnly}`);
      console.log(`  edit only Otras señas: ${streetOnly}`);
      console.log(`  restored ${JSON.stringify(restored)}`);
      report.edits = { account: EDIT_ACCOUNT, before, afterDistrict, afterStreet, restored, districtOnly, streetOnly };
    } else console.log('  (no JEPYP316_EDIT_ACCOUNT - edit checks skipped)');
  } finally {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const file = path.join(EVIDENCE, `316-contacts-and-edits-${Date.now().toString(36)}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\n  report: ${file}`);
    await db.disconnect();
  }
  expect(report.primaryOrder, 'primary-order runs recorded').toBeTruthy();
});
