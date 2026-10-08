/**
 * Guards for the accounting helper's pure functions. NO NETWORK, NO LOGIN.
 *
 * Every case here encodes a mistake this feature actively invites. The extract
 * is a one-day date offset feeding a double-entry ledger, so an off-by-one or a
 * silently-empty result is not a flaky test — it is a wrong number sent to
 * JASEC's ERP. If one of these fails, stop: every assertion in ts-02, ts-03 and
 * ts-06 is built on these functions.
 *
 * Runs in milliseconds and is safe anywhere, including CI.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import {
  NO_DATA_FOUND,
  isNoDataFound,
  shiftDate,
  endOfMonth,
  extractInvariants,
  type EbsHeader,
  type EbsDetail,
} from '../../../../helpers/accounting-gql.helper';

/** A clean header/detail pair shaped like real batch 10018 on jasec-dev. */
const header = (over: Partial<EbsHeader> = {}): EbsHeader => ({
  id: '2030',
  batchId: '10018',
  batchName: '10018_EMB Sep2026 EMBRIX IMPORTED  15-SEP-2026 07:12:15AM',
  type: 'INVOICE',
  extractStatus: 'PENDING',
  period: 'Sep-2026',
  accountingDate: '2026-09-30',
  inputDate: '2026-09-14',
  createdDate: '2026-09-15',
  totalCreditAmount: 17678.14,
  totalDebitAmount: 17678.14,
  count: 3,
  filePath: null,
  externalRefId: null,
  currencyCode: 'CRC',
  category: 'Sales Invoice',
  ...over,
});

const detail = (index: number, amount: number, over: Partial<EbsDetail> = {}): EbsDetail => ({
  index,
  credit: amount,
  debit: amount,
  glAccount: `401-001-001-001-0${index}0-000-000-000-000-000`,
  glOffset: '100-020-050-001-000-000-000-000-000-000',
  accountingCode: '10-02-05-00-00',
  offsetAccountingCode: '10-02-05-00-00',
  period: 'Sep-26',
  glDate: '2026-09-15',
  batchId: '10018',
  batchName: '10018_EMB Sep2026 EMBRIX IMPORTED  15-SEP-2026 07:12:15AM',
  type: 'INVOICE',
  ...over,
});

/** Real batch 10018: 221.44 + 16749.15 + 707.55 = 17678.14. */
const cleanDetails = () => [detail(1, 221.44), detail(2, 16749.15), detail(3, 707.55)];

test.describe('accounting helper guards (no network)', { tag: ['@jasec', '@accounting', '@tc-147'] }, () => {

  // ── the silent no-op ────────────────────────────────────────────────────

  test('isNoDataFound catches the empty extract, which returns HTTP 200', () => {
    /**
     * `PGEbsExtractService.ebsExtract` returns `{id:"0", batchId:"No data found"}`
     * when the target date held no journals — no error, no warning. A test that
     * checks only "the mutation came back" passes against an extract that did
     * nothing, which is the single easiest way to ship false green here.
     */
    expect(isNoDataFound({ id: '0', batchId: NO_DATA_FOUND, batchName: NO_DATA_FOUND })).toBe(true);
    expect(isNoDataFound({ id: '0', batchId: null, batchName: null })).toBe(true);
    expect(isNoDataFound(null)).toBe(true);
    expect(isNoDataFound(undefined)).toBe(true);
  });

  test('isNoDataFound passes a real batch through', () => {
    expect(isNoDataFound({ id: '2030', batchId: '10018', batchName: 'x' })).toBe(false);
  });

  // ── the date arithmetic the whole feature turns on ──────────────────────

  test('shiftDate is UTC-based, so no local timezone can move the day', () => {
    /**
     * The machine running this sits at UTC-7. A `new Date('2026-09-14')` built
     * and read locally lands on the 13th, which is exactly the off-by-one this
     * feature is about. shiftDate does the arithmetic in UTC for that reason.
     */
    expect(shiftDate('2026-09-14', 1)).toBe('2026-09-15');
    expect(shiftDate('2026-09-14', 0)).toBe('2026-09-14');
    expect(shiftDate('2026-09-14', -1)).toBe('2026-09-13');
  });

  test('shiftDate crosses month, year and leap-day boundaries', () => {
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
    // 2028 is a leap year — the extract runs daily and will meet this date.
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDate('2028-02-29', 1)).toBe('2028-03-01');
  });

  test('endOfMonth matches the accountingDate the extract stamps', () => {
    // Real header 2030 carries inputDate 2026-09-14 and accountingDate 2026-09-30.
    expect(endOfMonth('2026-09-14')).toBe('2026-09-30');
    expect(endOfMonth('2026-02-01')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-01')).toBe('2028-02-29');
    expect(endOfMonth('2026-12-25')).toBe('2026-12-31');
  });

  // ── the ledger invariants ───────────────────────────────────────────────

  test('a clean batch passes every invariant', () => {
    expect(extractInvariants(header(), cleanDetails())).toEqual([]);
  });

  test('an unbalanced header is caught', () => {
    const bad = extractInvariants(header({ totalCreditAmount: 17678.13 }), cleanDetails());
    expect(bad.join(' | ')).toMatch(/does not balance/);
  });

  test('an unbalanced detail line is caught', () => {
    const details = cleanDetails();
    details[1] = detail(2, 16749.15, { credit: 16749.15, debit: 16700.00 });
    expect(extractInvariants(header(), details).join(' | ')).toMatch(/line 2: credit .* != debit/);
  });

  test('a line posting to and from the same account is caught', () => {
    /**
     * glAccount === glOffset is a posting that moves nothing. It balances, so
     * every totals check passes — only an explicit rule catches it. 0 of the 71
     * rows on jasec-dev do this today and none ever should.
     */
    const details = cleanDetails();
    details[0] = detail(1, 221.44, { glOffset: details[0].glAccount });
    expect(extractInvariants(header(), details).join(' | ')).toMatch(/glAccount === glOffset/);
  });

  test('a line with no GL account is caught', () => {
    const details = cleanDetails();
    details[2] = detail(3, 707.55, { glAccount: '' });
    expect(extractInvariants(header(), details).join(' | ')).toMatch(/missing glAccount\/glOffset/);
  });

  test('header totals that do not sum from the lines are caught', () => {
    // Drop a line but keep the header total — the shape a partially written
    // batch would take.
    expect(extractInvariants(header(), cleanDetails().slice(0, 2)).join(' | '))
      .toMatch(/!= sum of its 2 lines/);
  });

  test('a header with no detail rows is caught, not silently passed', () => {
    const bad = extractInvariants(header(), []);
    expect(bad.join(' | ')).toMatch(/has no detail rows/);
  });

  test('a detail row belonging to another batch is caught', () => {
    const details = cleanDetails();
    details[1] = detail(2, 16749.15, { batchId: '10017' });
    expect(extractInvariants(header(), details).join(' | ')).toMatch(/detail carries batchId 10017/);
  });

  test('invariants tolerate float noise at the cent, not above it', () => {
    /**
     * Money arrives as GraphQL Float. 0.1 + 0.2 style drift must not fail a
     * batch, but a real one-cent break must.
     */
    const ok = extractInvariants(
      header({ totalDebitAmount: 17678.140000000001, totalCreditAmount: 17678.14 }),
      cleanDetails(),
    );
    expect(ok).toEqual([]);

    const broken = extractInvariants(header({ totalDebitAmount: 17678.15 }), cleanDetails());
    expect(broken.length).toBeGreaterThan(0);
  });
});
