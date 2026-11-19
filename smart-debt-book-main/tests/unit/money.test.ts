import { describe, expect, test } from 'vitest';
import { parseShekelsToAgorot, parseAgorot, formatAgorot, MoneyInputError } from '../../src/money.js';

describe('parseShekelsToAgorot', () => {
  test.each([
    ['100.70', 10070n], ['100.7', 10070n], ['100', 10000n], ['0.05', 5n], ['0', 0n],
    ['1.15', 115n], ['4.35', 435n], ['0.07', 7n],           // the cases floats get wrong
    ['١٠٠٫٧٠', 10070n], ['۱۰۰٫۷', 10070n], ['100,70', 10070n],
    ['₪ 100.70', 10070n], [' 1 000.50 ', 100050n], ['1٬000', 100000n],
    ['1000000.00', 100000000n],
  ])('%s → %s', (input, expected) => {
    expect(parseShekelsToAgorot(input)).toBe(expected);
  });

  test.each(['100.705', '-5', '+5', '', '.5', '5.', 'abc', '1e3', '0x10', '10.5.5', '١٠٠٫٧٠٥'])('rejects %j', (input) => {
    expect(() => parseShekelsToAgorot(input)).toThrow(MoneyInputError);
  });
});

describe('parseAgorot (JSON wire)', () => {
  test('accepts integer agorot strings', () => {
    expect(parseAgorot('10070')).toBe(10070n);
    expect(parseAgorot('0')).toBe(0n);
    expect(parseAgorot('9007199254740993')).toBe(9007199254740993n);   // beyond float precision, still exact
  });
  test.each(['100.70', '-1', '01', '', ' 1', '1e2'])('rejects %j', (wire) => {
    expect(() => parseAgorot(wire)).toThrow(MoneyInputError);
  });
  test('rejects a JSON number', () => {
    expect(() => parseAgorot(10070 as unknown as string)).toThrow(MoneyInputError);
  });
});

describe('formatAgorot', () => {
  test.each([[10070n, '100.70'], [5n, '0.05'], [0n, '0.00'], [100000000n, '1000000.00'], [-150n, '-1.50']])('%s → %s', (a, s) => {
    expect(formatAgorot(a)).toBe(s);
  });
  test('round trip', () => {
    for (const s of ['0.01', '1.15', '4.35', '99.99', '123456.78']) expect(formatAgorot(parseShekelsToAgorot(s))).toBe(s);
  });
});
