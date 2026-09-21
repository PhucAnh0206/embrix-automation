/**
 * Guards for the billing helper's pure functions. NO NETWORK, NO LOGIN.
 *
 * These exist because two of them encode mistakes that reached a defect report.
 * They live in their own file so they cost milliseconds — putting them beside the
 * band spec made them wait ~45s for its `beforeAll` to page the tenant.
 *
 * If one of these fails, stop and fix the helper. Every band assertion downstream
 * is meaningless while consumption is being measured wrongly.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import { energiaKwh, lineName, summaryTotal } from '../../../../helpers/billing-gql.helper';

const fake = (lines: Array<[string, number]>) =>
  ({ invoiceSummaryList: lines.map(([name, quantity], index) => ({ index, name, quantity })) } as any);

test.describe('billing helper guards (no network)', { tag: ['@jasec', '@billing'] }, () => {

  test('energiaKwh SUMS the tariff blocks — regression guard for the max() bug', () => {
    /**
     * Invoice lines are split per tariff block and each carries only ITS OWN
     * slice. An earlier version of `energiaKwh` took max(), on the mistaken
     * reading that the top block held the whole cycle. It under-reported
     * consumption by the lower blocks — typically 200 kWh — which pushed
     * invoices a band too low and produced three false "tax applied below the
     * threshold" defects before it was caught.
     *
     * Shape below is TC-44's reference account, ACT-100599 at 1000 kWh.
     */
    const inv = fake([['ENERGIA|KWH|0|30', 30], ['ENERGIA|KWH|30|200', 170], ['ENERGIA|KWH|200|0', 800]]);
    expect(energiaKwh(inv), 'must be 30+170+800 = 1000; a result of 800 means max() is back').toBe(1000);
  });

  test('energiaKwh counts only ENERGIA, not the other charge lines', () => {
    const inv = fake([
      ['ENERGIA|KWH|0|30', 30],
      ['CVG ENERGIA|KWH|0|30', 30],
      ['ALUMBRADO PUBLICO|ALP|0|0', 999],
      ['CVG ALUMBRADO PUBLICO|ALP|0|0', 999],
    ]);
    expect(energiaKwh(inv)).toBe(30);
  });

  test('energiaKwh returns null when there is no ENERGIA line', () => {
    expect(energiaKwh(fake([['ALUMBRADO PUBLICO|ALP|0|0', 5]]))).toBeNull();
    expect(energiaKwh(fake([]))).toBeNull();
  });

  test('energiaKwh handles the plain (non-pipe) name format', () => {
    expect(energiaKwh(fake([['ENERGIA', 42]]))).toBe(42);
  });

  test('lineName takes the first pipe segment, in both name formats', () => {
    expect(lineName('ENERGIA|KWH|30|200')).toBe('ENERGIA');
    expect(lineName('ENERGIA')).toBe('ENERGIA');
    expect(lineName(' cvg energia |KWH|0|30')).toBe('CVG ENERGIA');
    expect(lineName(null)).toBe('');
  });

  test('summaryTotal unwraps the ARRAY form of invoiceSummaryTotal', () => {
    // The API returns an array. Treating it as an object yields undefined
    // silently, and every arithmetic assertion then compares against NaN.
    expect(summaryTotal({ invoiceSummaryTotal: [{ total: 5 }] } as any)?.total).toBe(5);
    expect(summaryTotal({ invoiceSummaryTotal: { total: 5 } } as any)?.total).toBe(5);
    expect(summaryTotal({} as any)).toBeNull();
  });
});
