import { describe, it, expect } from 'vitest';
import { toCents, centsToAmount, centsToString, parseAmountInput, calcChange, createMoneyFormatter } from '../../src/utils/money.js';

describe('money', () => {
  it('converts amounts to integer cents without float drift', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents('12.35')).toBe(1235);
    expect(toCents('1,234.5')).toBe(123450);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents('12.345')).toBe(1235);
    expect(toCents('-4.50')).toBe(-450);
    expect(toCents('abc')).toBeNaN();
    expect(toCents(null)).toBeNaN();
  });

  it('adds many prices exactly', () => {
    const total = Array.from({ length: 1000 }, () => toCents(0.1)).reduce((a, b) => a + b, 0);
    expect(total).toBe(10000);
    expect(centsToAmount(total)).toBe(100);
    expect(centsToString(1205)).toBe('12.05');
    expect(centsToString(-5)).toBe('-0.05');
  });

  it('parses what a cashier types', () => {
    expect(parseAmountInput('200')).toBe(20000);
    expect(parseAmountInput(' 1,000.5 ')).toBe(100050);
    expect(parseAmountInput('10.123')).toBeNaN();
    expect(parseAmountInput('-5')).toBeNaN();
    expect(parseAmountInput('')).toBeNaN();
    expect(parseAmountInput('1e3')).toBeNaN();
  });

  it('calculates change = received - total and refuses short payments', () => {
    expect(calcChange(8000, 10000)).toEqual({ valid: true, change: 2000, short: 0 });
    expect(calcChange(3705, 5000)).toEqual({ valid: true, change: 1295, short: 0 });
    expect(calcChange(8000, 8000)).toEqual({ valid: true, change: 0, short: 0 });
    expect(calcChange(8000, 7999)).toEqual({ valid: false, change: 0, short: 1 });
    expect(calcChange(8000, NaN).valid).toBe(false);
  });

  it('formats with the configured currency (not hard-coded)', () => {
    const egp = createMoneyFormatter({ currency_code: 'EGP', locale: 'en-US' });
    expect(egp(25)).toMatch(/EGP\s?25$/);
    expect(egp(12.5)).toMatch(/EGP\s?12\.50$/);
    const usd = createMoneyFormatter({ currency_code: 'USD', locale: 'en-US' });
    expect(usd(1234.5)).toMatch(/USD\s?1,234\.50/);
    expect(egp(null)).toBe('—');
    const bad = createMoneyFormatter({ currency_code: 'EGP', locale: 'xx-!!' });
    expect(bad(5)).toContain('5');
  });
});
