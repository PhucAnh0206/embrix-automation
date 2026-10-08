/**
 * TC-146, the AGENT's side: the Account Statement screen shows the same unbroken balance chain the
 * ledger holds.
 *
 * ts-03 @tc-146 proves the ledger itself is continuous across two billed cycles (each line's closing
 * balance = the next line's opening). That is the stored record. What a customer disputes is what the
 * agent reads to them: account > Billing Data > Account Statement. This case holds that screen to the
 * ledger, line for line - same document type, invoice, total, opening and closing balance, nothing
 * missing, nothing extra. With ts-03 green, equality here means the chain on screen is unbroken too.
 *
 * Its own spec and project (jasec-billing-statement) because ts-03 lives in jasec-billing-read, which
 * is documented "no browser, safe in CI"; this one needs the browser and the logged-in session.
 *
 * READ-ONLY. Subject: the same two-cycle account ts-03 uses - JASEC_TWO_CYCLE_ACCOUNT (run-suite
 * -Block billing sets it from the seeder handoff). None given = BLOCKED, never a guess.
 *
 *   $env:JASEC_TWO_CYCLE_ACCOUNT='<acct>'; npx playwright test --project=jasec-billing-statement
 *
 * Owner: Anh Tran (QC).
 */
import { test, expect } from '../../../../fixtures/page-factory';
import { BillingGqlHelper } from '../../../../helpers/billing-gql.helper';
import { AgentScreens, uiAmount } from '../../../../helpers/agent-screens.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const ACCOUNT = (process.env.JASEC_TWO_CYCLE_ACCOUNT ?? '').trim();
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 0.02;

test.describe('TC-146 on screen - the Account Statement shows the ledger chain @tc-146', () => {
  test('every ledger line appears on the Account Statement screen with the same balances @tc-146', async ({ page, billsPage }) => {
    blockedIf(!ACCOUNT, 'no JASEC_TWO_CYCLE_ACCOUNT given - seed one with _scripts/billing/seed-two-cycle-account.ps1');

    const ledger = await new BillingGqlHelper().getAccountStatement(ACCOUNT);
    blockedIf(!ledger.length, `${ACCOUNT} has no ledger lines`);
    console.log(`  ledger ${ACCOUNT}: ${ledger.map(l => `${l.lineType} ${l.invoiceId ?? l.lineReferenceId} ${l.openingBalance} -> ${l.amount} -> ${l.closingBalance}`).join(' | ')}`);

    await new AgentScreens(page).openAccount(ACCOUNT);
    await billsPage.navigateToAccountStatement();
    const rows = await billsPage.accountStatementRows();
    console.log(`  screen: ${rows.map(r => `${r['Document Type']} ${r['Invoice Id']} ${r['Opening Balance']} -> ${r['Total']} -> ${r['Closing Balance']}`).join(' | ')}`);

    // One-to-one: each ledger line consumes the first unused screen row that matches it exactly.
    const unused = [...rows];
    const missing: string[] = [];
    for (const l of ledger) {
      const i = unused.findIndex(r =>
        r['Document Type'] === String(l.lineType ?? '')
        && (!l.invoiceId || r['Invoice Id'] === String(l.invoiceId))
        && near(uiAmount(r['Total']), Number(l.amount))
        && near(uiAmount(r['Opening Balance']), Number(l.openingBalance))
        && near(uiAmount(r['Closing Balance']), Number(l.closingBalance)));
      if (i < 0) missing.push(`${l.lineType} ${l.invoiceId ?? l.lineReferenceId}: ${l.openingBalance} -> ${l.amount} -> ${l.closingBalance}`);
      else unused.splice(i, 1);
    }
    expect(missing, `ledger lines the Account Statement screen does not show (or shows with other figures)`).toEqual([]);
    expect(unused.map(r => `${r['Document Type']} ${r['Invoice Id']} ${r['Total']}`),
      'rows on the Account Statement screen that are not in the ledger').toEqual([]);
    console.log(`  PASS - ${ledger.length} ledger line(s) shown on screen with the same balances`);
  });
});
