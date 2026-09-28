import { describe, it, expect } from 'vitest';
import { toCSV } from '../../src/utils/csv.js';
import { addDays, dateInTz, dayStartISO, rangeForPreset } from '../../src/utils/dates.js';
import { stockStatus } from '../../src/utils/stock.js';
import { loginIdToEmail } from '../../src/utils/login.js';
import { toAppError } from '../../src/utils/errors.js';

describe('csv', () => {
  it('quotes, escapes and blocks formula injection', () => {
    const csv = toCSV(
      [{ a: 'x,y', b: 'say "hi"', c: '=SUM(A1)', d: -5, e: '-12.5' }],
      [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'e', label: 'E' }],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const [, row] = csv.slice(1).split('\r\n');
    expect(row).toBe(`"x,y","say ""hi""",'=SUM(A1),-5,-12.5`);
  });
});

describe('dates', () => {
  it('computes business dates in the event timezone', () => {
    // 23:30 UTC on 1 Mar is already 2 Mar in Cairo (UTC+2)
    expect(dateInTz('Africa/Cairo', new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-02');
    expect(dateInTz('UTC', new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(dayStartISO('2026-03-02', 'Africa/Cairo')).toBe('2026-03-01T22:00:00.000Z');
    const r = rangeForPreset('today', 'Africa/Cairo');
    expect(r.from).toBe(r.to);
  });
});

describe('stock status', () => {
  it('classifies stock', () => {
    expect(stockStatus({ track_stock: true, stock: 0, min_stock: 5 })).toBe('out');
    expect(stockStatus({ track_stock: true, stock: 5, min_stock: 5 })).toBe('low');
    expect(stockStatus({ track_stock: true, stock: 6, min_stock: 5 })).toBe('ok');
    expect(stockStatus({ track_stock: false, stock: 0, min_stock: 0 })).toBe('service');
  });
});

describe('login', () => {
  it('maps usernames to internal emails and keeps real emails', () => {
    expect(loginIdToEmail(' Bazaar1 ', 'pos.example.org')).toBe('bazaar1@pos.example.org');
    expect(loginIdToEmail('Admin@School.org')).toBe('admin@school.org');
    expect(loginIdToEmail('')).toBe('');
  });
});

describe('errors', () => {
  it('distinguishes network failures from business errors', () => {
    expect(toAppError(new TypeError('Failed to fetch')).network).toBe(true);
    expect(toAppError({ message: 'TypeError: Failed to fetch', details: '', code: '' }).network).toBe(true);
    const e = toAppError({ message: 'Only 2 × Caps left in stock.', hint: 'INSUFFICIENT_STOCK', code: 'P0001' });
    expect(e.network).toBe(false);
    expect(e.code).toBe('INSUFFICIENT_STOCK');
    expect(e.message).toMatch(/Only 2/);
    expect(toAppError({ message: 'Only an admin can do this.', hint: 'FORBIDDEN', code: '42501' }).code).toBe('FORBIDDEN');
  });
});

import { attemptFor } from '../../src/utils/checkoutAttempt.js';
describe('checkout attempt (idempotency key reuse)', () => {
  it('reuses the key for the same sale and makes a new one for a different sale', () => {
    const a = attemptFor(null, 'sig1|CASH|100');
    expect(a.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(attemptFor(a, 'sig1|CASH|100').key).toBe(a.key);
    expect(attemptFor(a, 'sig1|CASH|200').key).not.toBe(a.key);
  });
});
