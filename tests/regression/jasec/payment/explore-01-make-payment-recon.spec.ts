/**
 * EXPLORATORY RECON — Self Care "Make Payment" and Core UI "Billing Data → Payments".
 *
 * NOT A TICKETED TEST CASE. No TC numbers: numbering is assigned from the
 * EPDP-348 sub-task list once a proposal is accepted. Named `explore-` so it can
 * never be mistaken for part of the official suite.
 *
 * WHY THIS EXISTS
 * The payment records that Self Care offers for payment were an unknown when this
 * suite was written — nobody could say what produced them. The DB answers it:
 *
 *   rated MDR usage  →  core_engine.transaction_unit (type USAGE, source MEDIATION)
 *     →  end-of-cycle billing job  →  core_engine.bill_unit
 *     →  core_engine.invoice_unit (status ACTIVE, due > 0)
 *     →  Self Care Activity → Make Payment lists exactly these
 *     →  paying one writes core_engine.payment + core_engine.arops_unit
 *        (type PAYMENT, netamount NEGATIVE = wallet credit) and flips the
 *        invoice to status CLOSED / due 0 / lastaraction PAYMENT.
 *
 * So "Make Payment" is an INVOICE-settlement screen, not a wallet screen. It has
 * nothing to do with Top Up, which credits the wallet with no invoice involved.
 * Both live one item apart in the same Activity dropdown.
 *
 * WHAT THIS SPEC DOES
 * Pure reconnaissance. It navigates, dumps what is actually on screen (headings,
 * buttons, table headers, rows, inputs), records every GraphQL operation the
 * screen fires, and writes it all to test-results/payment-recon/. It asserts
 * almost nothing — its output is the input for the real cases and for the page
 * objects. Nothing is paid, so it is safe to re-run at will.
 *
 * READ-ONLY: no payment submitted, no clock move, no billing run, no
 * job_schedule slot, no DB write.
 *
 * Requires: VPN (DB read), EMBRIX_USER / EMBRIX_PASSWORD via the `setup` project,
 * SELFCARE_BASE_URL for the Self Care host.
 *
 * Target account: PAYMENT_ACCOUNT_ID overrides; otherwise the most suitable
 * PREPAID account is chosen from the DB (saved card + smallest open invoice) and
 * logged, so a run stays reproducible.
 *
 * Owner: Anh Tran (QC)
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import type { Page } from '@playwright/test';
import { attachToAccountInSelfCare } from '../../../../fixtures/create-prepaid-account.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import { MEDIUM_WAIT, LONG_WAIT } from '../../../../helpers/timeouts.helper';

/**
 * Evidence lands OUTSIDE test-results/.
 *
 * Playwright owns test-results/ and clears it around a run — a recon JSON written
 * there disappeared between the run finishing and being read, taking the logs
 * folder with it. Evidence that vanishes is not evidence. Everything here is also
 * attached to the test, so it survives in the HTML report either way.
 */
const OUT_DIR = path.join(process.cwd(), 'artifacts', 'payment-recon');

/**
 * Leave the tenant CCP clock alone.
 *
 * The JASEC fixtures reset CCP to JASEC_CCP_BASELINE before every test. This spec
 * reads existing records and pays nothing, so there is no reason for it to move a
 * clock that other suites and other people share.
 */
test.use({ ccpBaseline: null });

interface TargetAccount {
  accountId: string;
  last4cc: string | null;
  openInvoices: { id: string; total: string; due: string; invoicedate: string; duedate: string }[];
  balance: number | null;
  subscriptionStatus: string | null;
}

let db: DbHelper;
let target: TargetAccount;

/** Dump a JSON artifact to disk AND attach it to the test. Returns the path. */
async function writeArtifact(
  testInfo: { attach: (name: string, opts: { body: string; contentType: string }) => Promise<void> },
  name: string,
  payload: unknown,
): Promise<string> {
  const json = JSON.stringify(payload, null, 2);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, json, 'utf-8');
  await testInfo.attach(`${name}.json`, { body: json, contentType: 'application/json' });
  return file;
}

/**
 * Everything visible on the current screen, in a shape that survives a diff.
 *
 * Deliberately generic — this runs BEFORE any page object exists, so it must not
 * depend on locators that are themselves the thing being discovered.
 */
async function dumpScreen(page: Page) {
  return page.evaluate(() => {
    const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const tables = Array.from(document.querySelectorAll('table')).map((t) => ({
      headers: Array.from(t.querySelectorAll('thead th')).map((th) => txt(th)),
      rowCount: t.querySelectorAll('tbody tr').length,
      rows: Array.from(t.querySelectorAll('tbody tr'))
        .slice(0, 10)
        .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => txt(td))),
    }));

    return {
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .map((h) => txt(h))
        .filter(Boolean),
      buttons: Array.from(document.querySelectorAll('button'))
        .map((b) => ({
          text: txt(b),
          disabled: (b as HTMLButtonElement).disabled,
          visible: !!(b as HTMLElement).offsetParent,
        }))
        .filter((b) => b.text),
      links: Array.from(document.querySelectorAll('a'))
        .map((a) => ({ text: txt(a), href: (a as HTMLAnchorElement).getAttribute('href') }))
        .filter((a) => a.text),
      inputs: Array.from(document.querySelectorAll('input,select,textarea')).map((i) => ({
        tag: i.tagName.toLowerCase(),
        name: i.getAttribute('name'),
        type: i.getAttribute('type'),
        placeholder: i.getAttribute('placeholder'),
        value: (i as HTMLInputElement).value,
        readOnly: (i as HTMLInputElement).readOnly,
        disabled: (i as HTMLInputElement).disabled,
      })),
      tables,
      radios: Array.from(document.querySelectorAll('input[type=radio],input[type=checkbox]')).map(
        (r) => ({
          name: r.getAttribute('name'),
          value: r.getAttribute('value'),
          checked: (r as HTMLInputElement).checked,
        }),
      ),
    };
  });
}

/**
 * Record every API call fired from now on — GraphQL *and* REST.
 *
 * The point is to learn WHICH call feeds the screen and what it returns, so the
 * real cases can assert against the same source the UI reads — and so a UI that
 * silently shows stale data can be told apart from a backend that returned it.
 *
 * Not GraphQL-only, deliberately. The first recon run filtered on /graphql and
 * concluded the Make Payment grid fires no invoice query at all, which would have
 * been a wrong finding if the grid is fed by a REST endpoint. Capture everything
 * that is not a static asset and let the artifact settle it.
 */
function recordApiCalls(page: Page) {
  const ops: any[] = [];

  page.on('request', (req) => {
    const url = req.url();
    if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|eot|ico|map)(\?|$)/i.test(url)) return;
    if (!/^https?:/i.test(url)) return;
    if (req.resourceType() === 'document' || req.resourceType() === 'stylesheet') return;
    let body: any = null;
    try {
      body = JSON.parse(req.postData() ?? 'null');
    } catch {
      body = req.postData();
    }
    const op = {
      url,
      method: req.method(),
      resourceType: req.resourceType(),
      operationName: body?.operationName ?? null,
      // Keep the whole query, whitespace-collapsed. The Self Care queries are
      // ANONYMOUS with the filters INLINED and no variables (`variables: {}`), so
      // the first line is just "{" and the variables tell you nothing — the query
      // body is the only thing that distinguishes two calls to the same resolver.
      query:
        typeof body?.query === 'string'
          ? body.query.replace(/\s+/g, ' ').trim().slice(0, 1200)
          : null,
      variables: body?.variables ?? null,
      response: null as any,
      status: null as number | null,
    };
    ops.push(op);

    req
      .response()
      .then(async (res) => {
        if (!res) return;
        op.status = res.status();
        try {
          const json = await res.json();
          // Keep the data shape but cap the size — a rows array of 200 is not evidence.
          op.response = JSON.parse(
            JSON.stringify(json, (_k, v) =>
              Array.isArray(v) && v.length > 10 ? [...v.slice(0, 10), `…+${v.length - 10} more`] : v,
            ),
          );
        } catch {
          op.response = '<non-json>';
        }
      })
      .catch(() => { });
  });

  return ops;
}

test.beforeAll(async () => {
  db = new DbHelper();
  await db.connect(); // fails fast if the VPN is down

  const explicit = process.env.PAYMENT_ACCOUNT_ID;

  // A usable recon target needs BOTH halves: an open invoice to look at, and a
  // saved card so the Pay Now path is reachable without tokenizing first.
  const picked = explicit
    ? [{ id: explicit }]
    : await db.query<{ id: string }>(`
        SELECT a.id
        FROM core_engine.account a
        JOIN core_engine.credit_card cc ON cc.accountid = a.id
        JOIN core_engine.invoice_unit iu
          ON iu.accountid = a.id AND iu.status = 'ACTIVE' AND iu.due > 0
        WHERE a.accountcategory = 'PREPAID'
          AND a.status = 'ACTIVE'
        GROUP BY a.id
        HAVING max(iu.due) < 50000
        ORDER BY min(iu.due) ASC, a.id DESC
        LIMIT 1
      `);

  if (!picked.length) {
    throw new Error(
      'No PREPAID account found with a saved card AND an open invoice under 50k CRC. ' +
      'Set PAYMENT_ACCOUNT_ID to pick one explicitly.',
    );
  }

  const accountId = picked[0].id;

  const invoices = await db.query<any>(
    `SELECT id, total::text, due::text,
            to_char(invoicedate,'YYYY-MM-DD') invoicedate,
            to_char(duedate,'YYYY-MM-DD')     duedate
     FROM core_engine.invoice_unit
     WHERE accountid = $1 AND status = 'ACTIVE' AND due > 0
     ORDER BY due ASC`,
    [accountId],
  );

  const card = await db.query<any>(
    `SELECT last4cc FROM core_engine.credit_card WHERE accountid = $1 LIMIT 1`,
    [accountId],
  );

  const bal = await db.query<any>(
    `SELECT s.status, b.amount::float8 AS amount
     FROM core_engine.subscription s
     LEFT JOIN core_engine.balance_unit_balances b ON b.id = s.balanceunitid
     WHERE s.accountid = $1
     LIMIT 1`,
    [accountId],
  );

  target = {
    accountId,
    last4cc: card[0]?.last4cc ?? null,
    openInvoices: invoices,
    balance: bal[0]?.amount ?? null,
    subscriptionStatus: bal[0]?.status ?? null,
  };

  console.log(`[recon] target account ${accountId} — ${invoices.length} open invoice(s), ` +
    `card ****${target.last4cc ?? 'none'}, balance ${target.balance}, ` +
    `subscription ${target.subscriptionStatus}`);
});

test.afterAll(async () => {
  await db?.disconnect();
});

test.describe(
  'EXPLORE — payment flow recon',
  { tag: ['@explore', '@jasec', '@payment'] },
  () => {
    // ── R1 — Self Care: what does Activity → Make Payment actually show? ──
    test(
      'R1: Self Care Activity → Make Payment — dump screen + GraphQL',
      { tag: ['@recon-1'] },
      async ({ page, testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage }, testInfo) => {
        const ops = recordApiCalls(page);

        await attachToAccountInSelfCare(
          { selfcareLoginPage, selfcareAccountSearchPage },
          target.accountId,
        );

        // Everything fired before this point is login/account-search noise.
        const opsBefore = ops.length;

        await selfcareActivityPage.navigateToMakePayment();
        await page.waitForTimeout(MEDIUM_WAIT); // let the grid settle before the dump

        const screen = await dumpScreen(page);
        await testInfo.attach('make-payment.png', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });

        const opsAfterFirstDump = ops.length;

        // The first arrival fired only getAccountById + getTenantSelfCareConfig and
        // left the grid on "No record has found!", so the invoice fetch is either
        // gated or it happens on a trigger the dropdown nav does not hit. Reload and
        // re-dump: the Top Up view needs exactly this (see SelfcareTopupPage.reload),
        // and if a reload populates the grid then the empty grid is a UI refresh bug,
        // not missing data.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
        await page.waitForLoadingToDisappear();
        await page.waitForTimeout(MEDIUM_WAIT);
        const screenAfterReload = await dumpScreen(page);

        // Tick the first invoice AFTER the reload — on arrival the grid is empty,
        // so probing the selection before reloading only ever measured the empty
        // state. Nothing is submitted; the pay buttons are left untouched.
        const selectionProbe = await openFirstRecord(page);
        await testInfo.attach('make-payment-after-tick.png', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });

        // The raw markup of the first invoice row. The Select checkbox is a
        // controlled React input that a plain .click() times out on, so the page
        // object needs to know what actually wraps it — attribute lists are not
        // enough to work that out.
        const firstRowHtml = await page
          .locator('table tbody tr')
          .first()
          .evaluate((el) => el.outerHTML)
          .catch(() => null);
        await testInfo.attach('make-payment-after-reload.png', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });

        const file = await writeArtifact(testInfo, 'r1-selfcare-make-payment', {
          target,
          screen,
          selectionProbe,
          screenAfterReload,
          firstRowHtml,
          apiCallsOnScreen: ops.slice(opsBefore, opsAfterFirstDump),
          apiCallsAfterReload: ops.slice(opsAfterFirstDump),
        });

        testLogger.log(`✓ R1 — recon written to ${file}`);
        testLogger.log(`  headings: ${screen.headings.join(' | ')}`);
        testLogger.log(`  buttons : ${screen.buttons.map((b) => b.text).join(' | ')}`);
        for (const t of screen.tables) {
          testLogger.log(`  table   : [${t.headers.join(' | ')}] rows=${t.rowCount}`);
        }

        const gridRows = (dump: typeof screen) =>
          dump.tables
            .flatMap((t) => t.rows)
            .filter((r) => !/No\s*record\s*has\s*found/i.test(r.join(' '))).length;

        testLogger.log(
          `  grid rows: first arrival=${gridRows(screen)} after reload=${gridRows(screenAfterReload)} ` +
          `| DB open invoices=${target.openInvoices.length}`,
        );

        // Recon asserts only that the screen RENDERED — an empty grid is a finding to
        // report, not a broken run. The real cases own the "grid must list the open
        // invoice" assertion; failing here would just hide the artifact.
        expect(
          screen.headings.length > 0 || screen.tables.length > 0,
          'Make Payment rendered nothing at all — navigation is wrong, not the data',
        ).toBeTruthy();
      },
    );

    // ── R2 — Core UI: the same payment, seen from the back office ─────────
    // The other half of the Selfcare-vs-CoreUI consistency question: the agent
    // view of the payment the customer just made. The Id link is probed here too,
    // but the link the customer actually clicks is the Self Care one — see R3.
    test(
      'R2: Core UI Billing Data → Payments — dump columns + probe the Id link',
      { tag: ['@recon-2'] },
      async ({ page, testLogger, searchAccountsPage, billsPage }, testInfo) => {
        const ops = recordApiCalls(page);

        await page.navigateToHome();
        await searchAccountsPage.navigateViaNav();
        await searchAccountsPage.searchByAccountId(target.accountId);
        // The column is "ACCT No", not "Account Id" — the search grid's own header,
        // used the same way by the CoopeG and JASEC account-creation specs.
        await searchAccountsPage.clickFirstRowLink('ACCT No');

        // Reuse the account-details sidebar the Bills page already owns — same
        // sidebar, different leaf.
        await billsPage.sidebar.navigateToSubScreen('Billing Data', 'Payments');
        await page.waitForLoadingToDisappear();
        await page.waitForTimeout(MEDIUM_WAIT);

        const screen = await dumpScreen(page);
        await testInfo.attach('coreui-payments.png', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });

        // ── The reported break: clicking the Id cell opens nothing ──────────
        // Probe it properly: a click can legitimately open a popup, start a
        // download, or fire a request. Watch for all three, and record which (if
        // any) happened. `filepath` is NULL on every core_engine.payment row on
        // this tenant, which is the likely reason there is nothing to open.
        const idProbe = await probeIdLink(page);

        const dbPayments = await db.query<any>(
          `SELECT id, invoiceunitid, amount::text, status, method,
                  filepath, folioid, foliostatus, externaltransid,
                  to_char(paymentdate,'YYYY-MM-DD') paymentdate,
                  to_char(createddate,'YYYY-MM-DD') createddate
           FROM core_engine.payment
           WHERE accountid = $1
           ORDER BY paymentdate DESC`,
          [target.accountId],
        );

        const file = await writeArtifact(testInfo, 'r2-coreui-payments', {
          target,
          screen,
          idLinkProbe: idProbe,
          dbPayments,
          apiCalls: ops,
        });

        testLogger.log(`✓ R2 — recon written to ${file}`);
        for (const t of screen.tables) {
          testLogger.log(`  table   : [${t.headers.join(' | ')}] rows=${t.rowCount}`);
        }
        testLogger.log(
          `  Id link → popup=${idProbe.popupUrl ?? 'none'} download=${idProbe.download ?? 'none'} ` +
          `requests=${idProbe.requests.length} newTab=${idProbe.newTabCount}`,
        );
        testLogger.log(`  DB payments: ${dbPayments.length}, filepath NULL on ` +
          `${dbPayments.filter((p: any) => !p.filepath).length}`);
      },
    );

    // ── R3 — Self Care: Billing Data → Payments, and the Id pill that opens ──
    // nothing. THIS is the screen in the reported break: the customer-facing one,
    // reached from the Self Care top nav, where the Id renders as a bordered pill.
    // Core UI (R2) is a different grid with different columns; testing it instead
    // of this one would report on the wrong screen.
    test(
      'R3: Self Care Billing Data → Payments — dump columns + probe the Id pill',
      { tag: ['@recon-3'] },
      async ({ page, testLogger, selfcareLoginPage, selfcareAccountSearchPage }, testInfo) => {
        const ops = recordApiCalls(page);

        await attachToAccountInSelfCare(
          { selfcareLoginPage, selfcareAccountSearchPage },
          target.accountId,
        );

        // Self Care top nav: Billing Data → the payments view. The label differs
        // between builds ("Payments" / "View Payment"), so match either.
        const billingTab = page
          .getByRole('link', { name: /^\s*Billing\s*Data\s*$/i })
          .or(page.getByRole('button', { name: /^\s*Billing\s*Data\s*$/i }))
          .first();
        await billingTab.waitFor({ state: 'visible', timeout: LONG_WAIT });
        await billingTab.click();
        await page.waitForTimeout(500);

        const paymentsItem = page
          .getByRole('link', { name: /(View\s*Payment|^\s*Payments?\s*$)/i })
          .or(page.getByText(/(View\s*Payment|^\s*Payments?\s*$)/i))
          .first();
        await paymentsItem.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
        await paymentsItem.click();
        await page.waitForLoadingToDisappear();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
        await page.waitForTimeout(MEDIUM_WAIT);

        // The Make Payment grid needs a reload before it renders its rows (see R1);
        // check whether this grid has the same defect before reading it.
        const screenOnArrival = await dumpScreen(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
        await page.waitForLoadingToDisappear();
        await page.waitForTimeout(MEDIUM_WAIT);
        const screen = await dumpScreen(page);

        await testInfo.attach('selfcare-payments.png', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });

        const idProbe = await probeIdLink(page);
        await testInfo.attach('selfcare-payments-after-id-click.png', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });

        const dbPayments = await db.query<any>(
          `SELECT id, invoiceunitid, amount::text, status, method, filepath,
                  folioid, foliostatus, externaltransid,
                  to_char(paymentdate,'YYYY-MM-DD') paymentdate
           FROM core_engine.payment
           WHERE accountid = $1
           ORDER BY paymentdate DESC`,
          [target.accountId],
        );

        const dataRows = (dump: typeof screen) =>
          dump.tables
            .flatMap((t) => t.rows)
            .filter((r) => !/No\s*record\s*has\s*found/i.test(r.join(' '))).length;

        const file = await writeArtifact(testInfo, 'r3-selfcare-payments', {
          target,
          rowsOnArrival: dataRows(screenOnArrival),
          rowsAfterReload: dataRows(screen),
          screen,
          idPillProbe: idProbe,
          dbPayments,
          apiCalls: ops,
        });

        testLogger.log(`✓ R3 — recon written to ${file}`);
        for (const t of screen.tables) {
          testLogger.log(`  table   : [${t.headers.join(' | ')}] rows=${t.rowCount}`);
          for (const r of t.rows) testLogger.log(`    row: ${r.join(' | ')}`);
        }
        testLogger.log(
          `  rows on arrival=${dataRows(screenOnArrival)} after reload=${dataRows(screen)}`,
        );
        testLogger.log(
          `  Id pill "${idProbe.clicked ?? 'not found'}" → popup=${idProbe.popupUrl ?? 'none'} ` +
          `download=${idProbe.download ?? 'none'} docRequests=${idProbe.requests.length} ` +
          `newTab=${idProbe.newTabCount} consoleErrors=${idProbe.consoleErrors.length}`,
        );
        for (const e of idProbe.consoleErrors) testLogger.log(`    console: ${e}`);
        testLogger.log(
          `  DB: ${dbPayments.length} payment(s), filepath NULL on ` +
          `${dbPayments.filter((p: any) => !p.filepath).length}`,
        );
      },
    );
  },
);

/**
 * Find out HOW the Select checkbox can be ticked, by trying each plausible way
 * and reporting which one actually moves the running total.
 *
 * Needed because the obvious two both fail silently. The row renders a Bootstrap
 * custom-checkbox:
 *
 *   <div class="check-item"><div class="custom-control custom-checkbox">
 *     <input readonly name="action" class="custom-control-input" type="checkbox" value="false">
 *     <label class="custom-control-label" for="checkbox-…"></label>
 *   </div></div>
 *
 * The input is opacity-0 / z-index--1, and the label is EMPTY so its box collapses
 * to nothing — a centre click on either lands on no pixels, reports success, and
 * leaves value="false". The running total is the only honest signal, so each
 * strategy is judged by whether the total moved off zero.
 *
 * Strategies are tried on the same row. A strategy that does nothing leaves the
 * state untouched, so trying the next one is safe; the loop stops at the first
 * that works and reports the winner for the page object to use.
 */
async function openFirstRecord(page: Page): Promise<unknown | null> {
  const readTotalText = async () =>
    (
      (await page
        .getByText(/Total\s*Selected\s*To\s*Pay/i)
        .first()
        .textContent()
        .catch(() => null)) ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim();

  const readTotalNumber = async () => {
    const m = (await readTotalText()).match(/:\s*([\d.,]+)/);
    return m ? Number(m[1].replace(/,/g, '')) : NaN;
  };

  const payButtons = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .map((b) => ({
          text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
          disabled: (b as HTMLButtonElement).disabled,
        }))
        .filter((b) => /pay/i.test(b.text)),
    );

  const checkboxValue = async () =>
    page
      .locator('table tbody tr input[type="checkbox"]')
      .first()
      .getAttribute('value')
      .catch(() => null);

  const firstRow = page.locator('table tbody tr').first();
  const input = firstRow.locator('input[type="checkbox"]').first();
  const label = firstRow.locator('label.custom-control-label').first();
  const wrapper = firstRow.locator('div.check-item').first();
  const firstCell = firstRow.locator('td').first();

  const strategies: { name: string; run: () => Promise<void> }[] = [
    { name: 'label.click(force)', run: () => label.click({ force: true, timeout: MEDIUM_WAIT }) },
    { name: 'input.dispatchEvent(click)', run: () => input.dispatchEvent('click') },
    { name: 'input.check(force)', run: () => input.check({ force: true, timeout: MEDIUM_WAIT }) },
    { name: 'wrapper.click(force)', run: () => wrapper.click({ force: true, timeout: MEDIUM_WAIT }) },
    { name: 'firstCell.click(force)', run: () => firstCell.click({ force: true, timeout: MEDIUM_WAIT }) },
  ];

  const before = {
    total: await readTotalText(),
    buttons: await payButtons(),
    checkboxValue: await checkboxValue(),
  };

  if (!(await input.count())) {
    return { before, note: 'no selectable row — grid is empty' };
  }

  const attempts: any[] = [];
  let winner: string | null = null;

  for (const s of strategies) {
    let error: string | null = null;
    await s.run().catch((e: Error) => { error = e.message.split(String.fromCharCode(10))[0]; });
    await page.waitForTimeout(1200);

    const total = await readTotalNumber();
    const value = await checkboxValue();
    attempts.push({ strategy: s.name, error, totalAfter: total, checkboxValue: value });

    if (Number.isFinite(total) && total > 0) {
      winner = s.name;
      break;
    }
  }

  return {
    before,
    attempts,
    winner,
    after: {
      total: await readTotalText(),
      buttons: await payButtons(),
      checkboxValue: await checkboxValue(),
    },
    rowHtmlAfterTick: await firstRow.evaluate((el) => el.outerHTML).catch(() => null),
  };
}

/**
 * Click the payment Id cell and report every way a document COULD have opened.
 *
 * Headless Chromium never populates a PDF tab's URL (the top-up receipt work hit
 * exactly this), so a bare `newPage.url()` check would report "nothing opened"
 * even on a working link. Watch popup, download, and network response together.
 */
async function probeIdLink(page: Page): Promise<{
  clicked: string | null;
  popupUrl: string | null;
  download: string | null;
  requests: string[];
  newTabCount: number;
  consoleErrors: string[];
}> {
  const requests: string[] = [];
  const consoleErrors: string[] = [];

  const ctx = page.context();
  const onRequest = (r: any) => {
    const u = r.url();
    if (/\.pdf|receipt|document|download|report|s3|amazonaws/i.test(u)) requests.push(u);
  };
  const onConsole = (m: any) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  };
  ctx.on('request', onRequest);
  page.on('console', onConsole);

  const tabsBefore = ctx.pages().length;

  // The Id cell renders as a bordered pill (see the reported screenshot); it can
  // be a button, a link, or a plain styled cell. Try each shape.
  const idCell = page
    .locator('table tbody tr')
    .first()
    .locator('td')
    .filter({ hasText: /^\s*P\d+\s*$/ })
    .first();

  const clickable = page
    .locator('table tbody tr')
    .first()
    .getByRole('button', { name: /^\s*P\d+\s*$/ })
    .or(page.locator('table tbody tr').first().getByRole('link', { name: /^\s*P\d+\s*$/ }))
    .or(idCell)
    .first();

  let clicked: string | null = null;
  let popupUrl: string | null = null;
  let download: string | null = null;

  if (await clickable.isVisible().catch(() => false)) {
    clicked = (await clickable.textContent().catch(() => ''))?.trim() ?? null;

    const popupPromise = ctx
      .waitForEvent('page', { timeout: MEDIUM_WAIT })
      .catch(() => null);
    const downloadPromise = page
      .waitForEvent('download', { timeout: MEDIUM_WAIT })
      .catch(() => null);

    await clickable.click({ timeout: MEDIUM_WAIT }).catch(() => { });

    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: MEDIUM_WAIT }).catch(() => { });
      popupUrl = popup.url();
    }
    const dl = await downloadPromise;
    if (dl) download = dl.suggestedFilename();

    await page.waitForTimeout(3000); // give a slow document call time to appear
  }

  ctx.off('request', onRequest);
  page.off('console', onConsole);

  return {
    clicked,
    popupUrl,
    download,
    requests,
    newTabCount: ctx.pages().length - tabsBefore,
    consoleErrors: consoleErrors.slice(0, 20),
  };
}
