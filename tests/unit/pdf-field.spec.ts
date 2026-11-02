// Unit tests for pdfField (helpers/pdf.helper.ts) on the two JASEC invoice text layouts (offline, no tenant).
import { test, expect } from '@playwright/test';
import { pdfField } from '../../helpers/pdf.helper';

// Text as extracted from the v6 layout (one label per line) and the v7 layout (2026-10-18: labels share lines).
const V6 = [
  'Cliente: Ana Rojas Mora',
  'Cuenta: ACT-100570',
  'Ubicacion: Avenida 2 Occidental, Cartago, Cartago, Costa Rica',
  'Fecha emision: 20-11-2026',
  'Dias facturados: 17',
  'Consumo (kWh): 30.00 Tipo de consumo: Leido',
  'Consumo (kWh)',
].join('\n');
const V7 = [
  'Cliente: Ana Rojas Mora Cuenta: ACT-100571',
  'Ubicacion: Avenida 2 Occidental, Cartago, Cartago, Costa Rica',
  'Fecha emision: 20-11-2026 Periodo: 02-11-2026 al 19-11-2026 Tarifa aplicada: PRE Tipo de venta: CONTADO',
  'Dias facturados: 1',
  'Lectura anterior (kWh): 0.00',
  'Consumo (kWh): 10.00',
  'Consumo (kWh)',
].join('\n');

test('pdfField reads the v6 layout (one label per line) @unit', () => {
  expect(pdfField(V6, 'Cliente')).toBe('Ana Rojas Mora');
  expect(pdfField(V6, 'Cuenta')).toBe('ACT-100570');
  expect(pdfField(V6, 'Ubicacion')).toBe('Avenida 2 Occidental, Cartago, Cartago, Costa Rica');
  expect(pdfField(V6, 'Dias facturados')).toBe('17');
  expect(pdfField(V6, 'Consumo (kWh)')).toBe('30.00');
});

test('pdfField reads the v7 layout (several labels on one line) @unit', () => {
  expect(pdfField(V7, 'Cliente')).toBe('Ana Rojas Mora');
  expect(pdfField(V7, 'Cuenta')).toBe('ACT-100571');
  expect(pdfField(V7, 'Periodo')).toBe('02-11-2026 al 19-11-2026');
  expect(pdfField(V7, 'Tarifa aplicada')).toBe('PRE');
  expect(pdfField(V7, 'Tipo de venta')).toBe('CONTADO');
  expect(pdfField(V7, 'Lectura anterior (kWh)')).toBe('0.00');
  expect(pdfField(V7, 'Consumo (kWh)')).toBe('10.00');
});

test('pdfField returns empty for an empty field, never the next label @unit', () => {
  expect(pdfField('Dias facturados:\nLectura anterior (kWh): 5', 'Dias facturados')).toBe('');
  expect(pdfField('Dias facturados: Lectura anterior (kWh): 5', 'Dias facturados')).toBe('');
  expect(pdfField('Identificacion:', 'Identificacion')).toBe('');
  expect(pdfField(V7, 'Identificacion')).toBe('');
});
