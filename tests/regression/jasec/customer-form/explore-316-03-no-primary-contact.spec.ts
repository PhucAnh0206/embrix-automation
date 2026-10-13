/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX). JEPYP-316 finding F7.
 *
 * Question: what happens downstream for an account that has NO 'PRIMARY' contact? Since 316 hides the contact id, a
 * clerk can add a new billing contact and delete the primary one; it saves (ACT-101403: only CONTACT-111602 left).
 * The e-invoice receptor, the top-up receipt and the selfcare profile are said to read the PRIMARY contact.
 *
 * Two of OUR accounts (customerId QA316-*), same journey on each:
 *   X  ACT-101403  no PRIMARY contact (Phúc Trần Anh = CONTACT-111602, billing)
 *   K  ACT-101399  control: PRIMARY = María Rojas (billing), CONTACT-111596 = Jorge
 * 1. a NEW order with a QA meter (if the account has none), 2. a 5,000 top-up, 3. the BALANCE_TOPUP notification
 * (recipient, status, greeting), 4. selfcare as agent: the top-up receipt PDF "Nombre del Cliente" + screenshots.
 * Records the answer; asserts only the harness.
 *
 * MUTATING (own accounts only): orders + top-ups. No clock move, no billing. dev / preprod. Other accounts:
 * JEPYP316_NOPRI_ACCOUNT / JEPYP316_NOPRI_CONTROL (defaults are the dev ones).
 *   $env:JEPYP316_NOPRI_RUN='true'; npx playwright test --project=jasec-customer-form-explore --grep "@316-no-primary"
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter, attachToAccountInSelfCare } from '../../../../fixtures/create-prepaid-account.helper';
import { fetchAndExtractPdfText } from '../../../../helpers/pdf.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN = String(process.env.JEPYP316_NOPRI_RUN ?? '').trim().toLowerCase() === 'true';
const ENV = process.env.TEST_ENV ?? '';
const TOP_UP = 5000;
const EVIDENCE = process.env.JEPYP316_EVIDENCE_DIR ?? path.resolve(__dirname,
  `../../../../../../Regression testing/EPDP-348_JASEC-Test/EXPLORE_JEPYP-316_customer-form/evidence/${ENV.replace('jasec-', '')}`);
const SUBJECTS = [
  { key: 'X', accountId: process.env.JEPYP316_NOPRI_ACCOUNT ?? 'ACT-101403', title: 'no PRIMARY contact' },
  { key: 'K', accountId: process.env.JEPYP316_NOPRI_CONTROL ?? 'ACT-101399', title: 'control, PRIMARY = María' },
];

// This spec does not own the clock: never let the jasec fixture rewind it.
test.use({ ccpBaseline: null });

test('JEPYP-316 F7: account without a PRIMARY contact downstream (exploratory) @316-no-primary', async ({
  page, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage,
}) => {
  if (blockedIf(!RUN, 'JEPYP316_NOPRI_RUN is not "true" - this orders and tops up two accounts')) return;
  if (blockedIf(!['jasec-dev', 'jasec-preprod'].includes(ENV), `dev / preprod only (TEST_ENV=${ENV})`)) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
  test.setTimeout(900_000);

  const seed = new PrepaidSeedHelper();
  const db = new DbHelper();
  await db.connect();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const report: Record<string, unknown> = { env: ENV, at: new Date().toISOString(), subjects: [] as unknown[] };
  fs.mkdirSync(EVIDENCE, { recursive: true });
  try {
    for (const sub of SUBJECTS) {
      const r: Record<string, unknown> = { key: sub.key, title: sub.title, accountId: sub.accountId };
      const acct = (await db.query<{ customerid: string }>(`SELECT customerid FROM core_engine.account WHERE id = $1`, [sub.accountId]))[0];
      if (blockedIf(!acct || !/^QA316-/.test(acct.customerid), `${sub.accountId} is not one of our QA316 accounts`)) return;
      r.contacts = await db.query(`SELECT id, firstname, lastname, middlename, email FROM core_engine.contact WHERE accountid = $1 ORDER BY id`, [sub.accountId]);

      // 1. Order + meter, unless the account already has a subscription.
      const subs = await db.query<{ status: string }>(`SELECT status FROM core_engine.subscription WHERE accountid = $1`, [sub.accountId]);
      if (!subs.length) {
        const meter = assertQaMeter(`M-QANOPRI${sub.key}-${uniqueRunSuffix()}`);
        r.orderId = await seed.orderExisting(sub.accountId, meter);
        r.meter = meter;
        for (let i = 0; i < 40; i++) {
          const s = await db.query<{ status: string }>(`SELECT status FROM core_engine.subscription WHERE accountid = $1`, [sub.accountId]);
          if (s.some(x => x.status === 'ACTIVE')) break;
          await wait(3_000);
        }
      }
      r.subscription = await db.query(`SELECT id, status FROM core_engine.subscription WHERE accountid = $1`, [sub.accountId]);

      // 2. Top-up, 3. its notification.
      const water = Number((await db.query<{ n: string }>(
        `SELECT COALESCE(max((regexp_replace(id,'\\D','','g'))::bigint),0)::text n FROM core_engine.email_notification`))[0].n);
      const before = await db.getTopUpCount(sub.accountId);
      try { await seed.topUp(sub.accountId, TOP_UP); r.topUp = 'OK'; } catch (e) { r.topUp = `REFUSED: ${String(e).slice(0, 300)}`; }
      for (let i = 0; i < 20 && (await db.getTopUpCount(sub.accountId)) === before; i++) await wait(3_000);
      let notes: Array<{ id: string; type: string; status: string; email: string; description: string; content: string }> = [];
      for (let i = 0; i < 20; i++) {
        notes = await db.query(`SELECT id, type, status, COALESCE(email,'') email, COALESCE(description,'') description, COALESCE(content,'') content
                                  FROM core_engine.email_notification WHERE accountid = $1 AND (regexp_replace(id,'\\D','','g'))::bigint > $2 ORDER BY id`,
                                [sub.accountId, water]);
        if (notes.some(n => n.type === 'BALANCE_TOPUP')) break;
        await wait(3_000);
      }
      r.notifications = notes.map(n => ({
        id: n.id, type: n.type, status: n.status, email: n.email, description: n.description,
        greeting: (n.content.replace(/<[^>]+>/g, ' ').match(/Estimad[oa]\(?a?\)?[^.,<]{0,80}/i) ?? [''])[0].replace(/\s+/g, ' ').trim(),
      }));

      // 4. Selfcare as agent: receipt + screenshots.
      try {
        await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, sub.accountId);
        await page.screenshot({ path: path.join(EVIDENCE, `F7-${sub.key}-${sub.accountId}-selfcare-home.png`), fullPage: true });
        await selfcareActivityPage.navigateToTopUp();
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
        await page.screenshot({ path: path.join(EVIDENCE, `F7-${sub.key}-${sub.accountId}-selfcare-topup.png`), fullPage: true });
        const url = await selfcareTopupPage.clickReceiptButtonForRow(0);
        const text = await fetchAndExtractPdfText(url);
        r.receiptName = (text.match(/Nombre\s+del\s+Cliente[\s.:]*([^\n]{0,80})/i) ?? ['', '<label not found>'])[1].trim();
        r.receiptText = text.slice(0, 1500);
        // Profile: no page object - try the usual menu entries and record what shows.
        const profile = page.getByRole('link', { name: /perfil|profile/i }).or(page.getByText(/^\s*(Mi\s+)?Perfil\s*$|^\s*(My\s+)?Profile\s*$/i)).first();
        if (await profile.isVisible().catch(() => false)) {
          await profile.click();
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
          await page.screenshot({ path: path.join(EVIDENCE, `F7-${sub.key}-${sub.accountId}-selfcare-profile.png`), fullPage: true });
          r.profileShown = 'screenshot taken';
        } else r.profileShown = 'no profile link found - see home screenshot';
      } catch (e) { r.selfcareError = String(e).slice(0, 400); }

      console.log(`\n  ${sub.key} ${sub.title} ${sub.accountId}: top-up ${r.topUp}; receipt name "${r.receiptName ?? '-'}"`);
      for (const n of r.notifications as Array<Record<string, string>>) console.log(`    ${n.id} ${n.type} ${n.status} to=${n.email || '<blank>'} ${n.greeting ? `"${n.greeting}"` : ''} ${n.description}`);
      if (r.selfcareError) console.log(`    selfcare: ${r.selfcareError}`);
      (report.subjects as unknown[]).push(r);
    }
  } finally {
    const file = path.join(EVIDENCE, `F7-no-primary-contact-${Date.now().toString(36)}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\n  report: ${file}`);
    await db.disconnect();
  }
  expect((report.subjects as unknown[]).length, 'both subjects ran').toBe(SUBJECTS.length);
});
