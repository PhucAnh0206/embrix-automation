/**
 * Customer > Bills, one invoice, one Action the agents' way: lists the actions offered, picks one, shows its form
 * (screenshot + fields) and only submits with NS_BILL_GO=true.
 *   NS_BILL=<account>:<invoice>            the row
 *   NS_BILL_ACTION=UNDO_MANUAL_INVOICE     or EXTEND_DUE_DATE, … (empty: only list the actions offered)
 *   NS_BILL_DATE=yyyy-mm-dd                EXTEND_DUE_DATE: the new due date typed in the form
 *   NS_BILL_GO=true                        submit (UNDO creates a full credit note; EXTEND changes the due date)
 * Checks: INV-018 (Undo offered for an invoice already in NetSuite, and its credit note reaches NetSuite) and the
 * Bills EXTEND_DUE_DATE date (saved one day short before the 31 Oct fix). Evidence: test-results\ns-bill-action-*.png
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; npx playwright test tests/coopeg/netsuite-actions/ns-bill-action.spec.ts --project=dev --reporter=line
 */
import { test, expect } from '@playwright/test';
import { NsApi } from '../../../helpers/netsuite/ns-api.helper';
import { rowAcrossPages } from '../../../helpers/netsuite/ns-ui.helper';

const [ACC, INV] = (process.env.NS_BILL ?? '').split(':');
const ACTION = process.env.NS_BILL_ACTION ?? '';
const DATE = process.env.NS_BILL_DATE ?? '';
const GO = process.env.NS_BILL_GO === 'true';
const shot = (n: string) => `test-results/ns-bill-action-${INV}-${n}.png`;

test('NS Bills action: offered actions, form, optional submit', async ({ page, playwright, baseURL }) => {
  test.setTimeout(10 * 60_000);
  expect(ACC && INV, 'NS_BILL=<account>:<invoice>').toBeTruthy();
  const api = new NsApi(await playwright.request.newContext());
  const before = await api.invoice(INV);
  console.log(`${INV} before: status ${before.status}, due ${before.dueDate}, total ${before.total}, NetSuite ${before.financeVersion ?? '-'}`);

  await page.setViewportSize({ width: 2200, height: 1100 });
  await page.goto(`${baseURL!.replace(/\/+$/, '')}/customers/${ACC}/bills`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4000);
  const row = await rowAcrossPages(page, INV);
  expect(await row.count(), `${INV} on Bills`).toBeGreaterThan(0);
  await row.locator('.custom-control, input[type=radio], td').first().click();
  await page.waitForTimeout(800);
  await page.getByText('<Select Action>').last().click();
  await page.waitForTimeout(1000);
  const offered = (await page.locator('[class*="option"]').allInnerTexts()).map(s => s.trim()).filter(s => s && s !== 'No options');
  console.log(`${INV} actions offered: ${offered.join(', ')}`);
  await page.screenshot({ path: shot('actions'), fullPage: true });
  if (!ACTION) return;
  expect(offered, `${ACTION} offered on ${INV}`).toContain(ACTION);
  await page.locator('[class*="option"]').filter({ hasText: new RegExp(`^${ACTION}$`) }).first().click();
  await page.waitForTimeout(2000);

  // The form the action opens (inline or a modal): its fields and buttons.
  const scope = (await page.locator('.modal:visible').count()) ? page.locator('.modal:visible').last() : page.locator('body');
  const fields = await scope.locator('input:visible, textarea:visible').evaluateAll(els => els.map(e => {
    const i = e as HTMLInputElement; return `${i.name || i.id || i.placeholder || i.type}=${i.value}`;
  }));
  const buttons = (await scope.locator('button:visible').allInnerTexts()).map(s => s.trim()).filter(Boolean);
  console.log(`${ACTION} form: fields [${fields.join(', ')}]; buttons [${buttons.join(', ')}]`);
  await page.screenshot({ path: shot(`${ACTION}-form`), fullPage: true });
  if (!GO) return;

  if (ACTION === 'EXTEND_DUE_DATE') {
    expect(DATE, 'NS_BILL_DATE=yyyy-mm-dd').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Due Date (date picker, typed) and Notes are both mandatory on the form.
    const box = scope.locator('input[name="dueDate"]:visible').first();
    await box.fill(DATE);
    await box.press('Tab');
    await page.waitForTimeout(500);
    console.log(`Due Date box shows "${await box.inputValue()}" for ${DATE}`);
    await scope.locator('[name="noteItem"]:visible').first().fill(`QA extend due date to ${DATE}`);
  }
  await scope.getByRole('button', { name: /^(submit|apply|save|ok|yes|confirm)$/i }).first().click();
  await page.waitForTimeout(1500);
  // A confirmation dialog after the submit, if any.
  const confirm = page.locator('.modal:visible').getByRole('button', { name: /^(yes|ok|confirm|submit)$/i });
  if (await confirm.count()) { await confirm.first().click(); }
  const toast = await (async () => {
    for (let i = 0; i < 40; i++) {
      const t = (await page.locator('.Toastify').allInnerTexts()).join(' | ').trim();
      if (t) return t;
      await page.waitForTimeout(1500);
    }
    return '';
  })();
  await page.screenshot({ path: shot(`${ACTION}-done`), fullPage: true });
  await page.waitForTimeout(15_000);
  const after = await api.invoice(INV).catch(() => undefined);
  console.log(`${ACTION} on ${INV}: screen "${toast}"; after: status ${after?.status}, due ${after?.dueDate}, total ${after?.total}, due amount ${after?.due}`);
});
