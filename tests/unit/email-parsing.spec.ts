/**
 * Unit tests for the notification email parsing/formatting helpers.
 *
 * No browser, no VPN, no mailbox — runs in milliseconds:
 *   npx playwright test --project=unit
 *
 * Worth keeping: the Spanish templates are full of HTML entities, and an
 * entity the decoder doesn't know silently breaks every label lookup that
 * contains an accent. That failure mode is invisible in a live run (it just
 * looks like the field is missing from the email), so it is caught here.
 *
 * The fixture below mirrors the real JEPYP-49 email observed on ACT-100527,
 * using the worst-case layout: label and value in separate <td> cells, and
 * accented characters as named entities.
 *
 * Imports from page-factory, NOT jasec-fixtures: the latter carries the
 * `jasecCcpBaseline` auto-fixture, which calls the server before every test
 * and would make these require VPN. No fixtures are destructured below, so
 * nothing is instantiated.
 */

import { test, expect } from '../../fixtures/page-factory';
import {
  ParsedEmail,
  htmlToText,
  extractImageSrcs,
  decodeEntities,
  formatCRC,
  expectedKwh,
  normalizeValue,
} from '../../helpers/email.helper';

const SAMPLE_HTML = `
<div><img src="https://s3.amazonaws.com/jasec/logo.png" alt="JASEC"></div>
<p><b>Estimado(a) Tran Anh</b></p>
<p>Jasec le informa que su recarga se realiz&oacute; exitosamente.</p>
<table>
<tr><td><b>N&uacute;mero de Servicio:</b></td><td>ACT-100527</td></tr>
<tr><td><b>Fecha y Hora:</b></td><td>2026-08-06 00:00:00</td></tr>
<tr><td><b>Monto Recarga:</b></td><td>&#8353;5.000,00</td></tr>
<tr><td><b>Medio de Pago:</b></td><td>CREDIT_CARD</td></tr>
<tr><td><b>ID Referencia de Pago:</b></td><td>PLATAFORMA</td></tr>
<tr><td><b>ID Transacci&oacute;n:</b></td><td>TU-ACT-100527-8e3b3ee44040</td></tr>
<tr><td><b>Descripci&oacute;n:</b></td><td>Embrix Top Up 5000</td></tr>
<tr><td><b>Saldo Actual:</b></td><td>&#8353;5.085,00</td></tr>
<tr><td><b>Saldo kWh Aproximados:</b></td><td>41</td></tr>
</table>
<p>Muchas gracias por utilizar nuestros servicios.</p>
<p>Junta Administrativa del Servicio El&eacute;ctrico Municipal de Cartago (Jasec)</p>
<p>Mensaje generado autom&aacute;ticamente por el sistema</p>`;

function sampleEmail(html = SAMPLE_HTML): ParsedEmail {
  return new ParsedEmail(
    'Jasec - Servicio Eléctrico Prepago - Recarga',
    'notificaciones@example.com',
    'qa@example.com',
    new Date(),
    html,
    htmlToText(html),
    extractImageSrcs(html),
  );
}

test.describe('email helper — parsing', { tag: ['@unit'] }, () => {
  test('extracts every labelled field from a table-layout email', () => {
    const email = sampleEmail();
    expect(email.field('Número de Servicio')).toBe('ACT-100527');
    expect(email.field('Fecha y Hora')).toBe('2026-08-06 00:00:00');
    expect(normalizeValue(email.field('Monto Recarga'))).toBe('₡5.000,00');
    expect(email.field('Medio de Pago')).toBe('CREDIT_CARD');
    expect(email.field('ID Referencia de Pago')).toBe('PLATAFORMA');
    expect(email.field('ID Transacción')).toBe('TU-ACT-100527-8e3b3ee44040');
    expect(email.field('Descripción')).toBe('Embrix Top Up 5000');
    expect(normalizeValue(email.field('Saldo Actual'))).toBe('₡5.085,00');
    expect(email.field('Saldo kWh Aproximados')).toBe('41');
  });

  test('extracts labelled fields when label and value share a line', () => {
    const html = '<p>Número de Servicio: ACT-100999</p>';
    const email = sampleEmail(html);
    expect(email.field('Número de Servicio')).toBe('ACT-100999');
  });

  test('finds unlabelled lines and static copy', () => {
    const email = sampleEmail();
    expect(email.lineStartingWith('Estimado(a)')).toBe('Estimado(a) Tran Anh');
    expect(email.contains('Jasec le informa que su recarga se realizó exitosamente.')).toBe(true);
    expect(email.contains('Muchas gracias por utilizar nuestros servicios.')).toBe(true);
    expect(email.contains('Junta Administrativa del Servicio Eléctrico Municipal de Cartago (Jasec)')).toBe(true);
    expect(email.contains('Mensaje generado automáticamente por el sistema')).toBe(true);
  });

  test('collects image sources', () => {
    expect(sampleEmail().imageSrcs).toEqual(['https://s3.amazonaws.com/jasec/logo.png']);
  });

  test('detects unrendered Thymeleaf tokens', () => {
    expect(sampleEmail().hasUnresolvedTokens()).toBe(false);
    const broken = '<p>Saldo Actual: ${currentCRCBalance}</p>';
    expect(sampleEmail(broken).hasUnresolvedTokens()).toBe(true);
  });

  test('returns empty string for a field that is absent', () => {
    expect(sampleEmail().field('Campo Inexistente')).toBe('');
  });
});

test.describe('email helper — entity decoding', { tag: ['@unit'] }, () => {
  test('decodes the Spanish accented entities used in the templates', () => {
    expect(decodeEntities('realiz&oacute;')).toBe('realizó');
    expect(decodeEntities('N&uacute;mero')).toBe('Número');
    expect(decodeEntities('El&eacute;ctrico')).toBe('Eléctrico');
    expect(decodeEntities('autom&aacute;ticamente')).toBe('automáticamente');
    expect(decodeEntities('a&ntilde;o')).toBe('año');
    expect(decodeEntities('&Oacute;')).toBe('Ó');
  });

  test('decodes numeric entities including the colón sign', () => {
    expect(decodeEntities('&#8353;5.000,00')).toBe('₡5.000,00');
    expect(decodeEntities('&#x20A1;')).toBe('₡');
  });

  test('does not double-decode &amp;', () => {
    // Must yield the literal text "&lt;", not "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  test('leaves unknown entities untouched so they surface in a failure', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });
});

test.describe('email helper — formatting', { tag: ['@unit'] }, () => {
  test('formats CRC the way the template renders it', () => {
    expect(formatCRC(10)).toBe('₡10,00');
    expect(formatCRC(5000)).toBe('₡5.000,00');
    expect(formatCRC(100000)).toBe('₡100.000,00');
    expect(formatCRC(1000000)).toBe('₡1.000.000,00');
    // Credit is stored negative; the email renders it unsigned.
    expect(formatCRC(-5085)).toBe('₡5.085,00');
  });

  test('normalizes non-breaking spaces and the ¢ / ₡ variants', () => {
    expect(normalizeValue(' ₡5.000,00 ')).toBe('₡5.000,00');
    expect(normalizeValue('¢5.000,00')).toBe('₡5.000,00');
  });

  /**
   * The live template renders a space after the colón sign — "₡ 5.000,00" —
   * confirmed against the real JEPYP-49 emails on ACT-100525 / ACT-100527.
   * formatCRC emits no space, so normalizeValue has to reconcile them or
   * every amount check fails.
   */
  test('treats "₡ 5.000,00" and "₡5.000,00" as the same value', () => {
    expect(normalizeValue('₡ 5.000,00')).toBe(formatCRC(5000));
    expect(normalizeValue('₡ 10,00')).toBe(formatCRC(10));
    expect(normalizeValue('¢ 123.067,00')).toBe(formatCRC(123067));
  });

  /**
   * Reproduces the three balances observed on ACT-100527 plus the boundary
   * cases from the TC-TOPUPMAIL matrix. If dev changes the divisor, these are
   * the first assertions that should fail.
   */
  test('computes Saldo kWh Aproximados as floor(balance / 123.067)', () => {
    expect(expectedKwh(-85)).toBe(0);          // observed
    expect(expectedKwh(-5085)).toBe(41);       // observed
    expect(expectedKwh(-100000)).toBe(812);    // observed
    expect(expectedKwh(-123)).toBe(0);         // just below the 1 kWh boundary
    expect(expectedKwh(-124)).toBe(1);         // 1 kWh boundary
    expect(expectedKwh(-1230)).toBe(9);
    expect(expectedKwh(-1231)).toBe(10);
    expect(expectedKwh(-12306)).toBe(99);
    expect(expectedKwh(-12307)).toBe(100);     // pins the divisor to 123.067
    expect(expectedKwh(-1000000)).toBe(8125);
  });
});
