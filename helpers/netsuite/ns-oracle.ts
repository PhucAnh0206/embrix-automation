/**
 * NetSuite regression — expected values (test-cases\netsuite\oracles.md, as code).
 *
 * Sources, so a failing check can be traced back to a requirement:
 *   - department / class / location / taxcode map: core_config tables, read 10-12 (ISP-215, ISP-217, ISP-231)
 *   - header shape and types: old-build SUCCESS payload A-1200192 (contract 208886, invoice 278465)
 *   - memo / mes / idProceso: ISP-202, ISP-215, ISP-245
 *   - due date = invoice date + 15: every Jira example (ISP-202/215)
 *   - entity / tipoFactura: ISP-223, ISP-292, handoff §2
 */

export type Lob = 'DEFAULT' | 'FONATEL' | 'PHC';

export const LOB_MAP: Record<Lob, { department: number; class: number }> = {
  DEFAULT: { department: 15, class: 104 },
  FONATEL: { department: 137, class: 9 },
  PHC: { department: 135, class: 10 },
};

/** Exemption % (2 dp) → taxCode. 6/12 are 100% with / without certificate. */
export const EXEMPT_TAXCODE: Record<string, number> = { '38.46': 8, '69.23': 9, '84.62': 10, '92.31': 11 };
export const LEVY_ITEMS = { I_IMP_CR: 0.01, I_IMP_911: 0.0075 } as const;
export const IVA = 0.13;

const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' */
export function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
export function addDays(iso: string, days: number): string {
  const t = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** Line of business the way the mapping reads it. [ASSUMPTION] FONATEL = custom attribute fonatelAccount TRUE; PHC = account type PHC. */
export function lobOf(account: any): Lob {
  const attrs: Record<string, string> = Object.fromEntries((account.customAttributes ?? []).map((a: any) => [a.name, String(a.value)]));
  if ((attrs.fonatelAccount ?? '').toUpperCase() === 'TRUE') return 'FONATEL';
  if (String(account.type).toUpperCase() === 'PHC' || /PHC/i.test(attrs.customAccountType ?? '')) return 'PHC';
  return 'DEFAULT';
}

/** taxCode an account's product line should carry. 'unmapped' = must never be sent (MAP-005). */
export function productTaxCode(account: any): number | 'unmapped' {
  const ex = (account.taxExemptions ?? [])[0];
  if (!ex || !ex.percent) return 7;
  const pct = Number(ex.percent);
  if (pct >= 100) return ex.taxCertificate?.id || ex.taxCertificate?.certificateNumber ? 6 : 12;
  return EXEMPT_TAXCODE[pct.toFixed(2)] ?? 'unmapped';
}

export interface Mismatch { field: string; expected: unknown; actual: unknown; }

function eq(out: Mismatch[], field: string, expected: unknown, actual: unknown) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) out.push({ field, expected, actual });
}

/** Full CREATE_INVOICE header check (oracle-04). invoice = getInvoiceUnitById row. */
export function checkInvoiceHeader(payload: any, account: any, invoice: any): Mismatch[] {
  const out: Mismatch[] = [];
  const h = payload?.invoice;
  if (!h) return [{ field: 'invoice', expected: 'object', actual: payload }];
  const lob = LOB_MAP[lobOf(account)];
  const date = String(invoice.invoiceDate).slice(0, 10);
  const [y, m] = date.split('-').map(Number);
  eq(out, 'canal', 'EMBRIX', payload.canal);
  if (account.partyId) eq(out, 'entity', String(account.partyId), h.entity);
  else if ('entity' in h) out.push({ field: 'entity', expected: '(omitted: no partyId)', actual: h.entity });
  eq(out, 'tipoFactura', 12, h.tipoFactura);
  eq(out, 'department', lob.department, h.department);
  eq(out, 'class', lob.class, h.class);
  eq(out, 'location', '131', h.location);
  eq(out, 'subsidiary', '2', h.subsidiary);
  eq(out, 'currency', 'CRC', h.currency);
  eq(out, 'mes', MESES[m - 1], h.mes);
  eq(out, 'annio', y, h.annio);
  eq(out, 'memo', `Telecomunicaciones ${MESES[m - 1]}-${y}`, h.memo);
  eq(out, 'idProceso', `${m}${y}`, h.idProceso);
  eq(out, 'tranDate', ddmmyyyy(date), h.tranDate);
  if (invoice.dueDate) eq(out, 'fechaVencimiento', ddmmyyyy(String(invoice.dueDate)), h.fechaVencimiento);
  eq(out, 'coopewebId', String(invoice.id), h.coopewebId);
  eq(out, 'idContrato', String(invoice.accountId), h.idContrato);
  return out;
}

/** Item checks (oracle-01/02/05). Works for invoice and credit-memo items. */
export function checkItems(items: any[], expectedProductCode: number | 'unmapped'): Mismatch[] {
  const out: Mismatch[] = [];
  if (!Array.isArray(items) || !items.length) return [{ field: 'items', expected: 'non-empty', actual: items }];
  const intBase = items.filter(i => i.item === 'I_INT').reduce((s, i) => s + Number(i.amount), 0);
  for (const it of items) {
    const tag = `items[${it.item}]`;
    if (Number(it.taxCode) === 0) out.push({ field: `${tag}.taxCode`, expected: '≠ 0', actual: it.taxCode });
    if (it.item === 'I_IMP_IVA') out.push({ field: tag, expected: 'no I_IMP_IVA item', actual: it });
    if (it.item in LEVY_ITEMS) {
      eq(out, `${tag}.taxCode`, 5, it.taxCode);
      eq(out, `${tag}.taxAmount`, round2(Number(it.amount)), round2(Number(it.taxAmount)));
      eq(out, `${tag}.grossAmount`, round2(Number(it.amount)), round2(Number(it.grossAmount)));
      if (intBase > 0) eq(out, `${tag}.amount (on I_INT base ${intBase})`, round2(intBase * LEVY_ITEMS[it.item as keyof typeof LEVY_ITEMS]), round2(Number(it.amount)));
    } else {
      eq(out, `${tag}.taxCode`, expectedProductCode, it.taxCode);
      if (expectedProductCode === 7) eq(out, `${tag}.taxAmount`, round2(Number(it.amount) * IVA), round2(Number(it.taxAmount)));
      eq(out, `${tag}.grossAmount`, round2(Number(it.amount) + Number(it.taxAmount)), round2(Number(it.grossAmount)));
    }
  }
  return out;
}

export function format(mm: Mismatch[]): string {
  return mm.map(m => `${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`).join('\n');
}
