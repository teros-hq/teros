import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import {
  assertValidCron,
  describeCronExpression,
  getNextCronRun,
  isValidCronExpression,
  previewCronOccurrences,
} from '../../src/lib/cron';
import { SchedulerError } from '../../src/lib/errors';

const TZ = 'Europe/Madrid';

describe('isValidCronExpression', () => {
  it.each([
    ['0 9 * * *', true],
    ['*/15 * * * *', true],
    ['0 10-22 * * 1-5', true],
    ['0   9   *   *   *', true], // espacios extra colapsan a 5 campos
    ['', false],
    ['not-a-cron', false],
    ['60 25 32 13 8', false],
    // 6 campos = forma con SEGUNDOS de croner → sub-minuto, rechazada.
    ['*/30 * * * * *', false],
    ['0 0 12 * * 1', false],
    // Nicknames también rechazados (no son 5 campos).
    ['@daily', false],
    ['@hourly', false],
  ])('expression %p → %p', (expr, expected) => {
    expect(isValidCronExpression(expr)).toBe(expected);
  });
});

describe('assertValidCron', () => {
  it('throws SchedulerError on invalid', () => {
    expect(() => assertValidCron('not-a-cron')).toThrow(SchedulerError);
  });

  it('does not throw on valid', () => {
    expect(() => assertValidCron('0 9 * * *')).not.toThrow();
  });
});

describe('getNextCronRun', () => {
  beforeEach(() => {
    setSystemTime(new Date('2026-04-30T07:00:00.000Z'));
  });
  afterEach(() => {
    setSystemTime();
  });

  it('returns next 9am Madrid', () => {
    const ts = getNextCronRun('0 9 * * *', TZ);
    const d = new Date(ts);
    expect(d.getUTCHours()).toBe(7); // 9am Madrid CEST = 7 UTC
  });

  it('throws on invalid timezone', () => {
    expect(() => getNextCronRun('0 9 * * *', 'Not/AZone')).toThrow(SchedulerError);
  });

  it('throws on invalid cron', () => {
    expect(() => getNextCronRun('not-cron', TZ)).toThrow(SchedulerError);
  });
});

describe('previewCronOccurrences', () => {
  beforeEach(() => {
    setSystemTime(new Date('2026-04-30T07:00:00.000Z'));
  });
  afterEach(() => {
    setSystemTime();
  });

  it('returns N strictly increasing timestamps', () => {
    const occs = previewCronOccurrences('0 9 * * *', TZ, 5);
    expect(occs).toHaveLength(5);
    for (let i = 1; i < occs.length; i++) {
      expect(occs[i]).toBeGreaterThan(occs[i - 1]);
    }
  });

  it('caps at requested count', () => {
    expect(previewCronOccurrences('0 9 * * *', TZ, 2)).toHaveLength(2);
  });
});

describe('describeCronExpression', () => {
  it.each([
    ['0 9 * * *', 'Every day at 9:00'],
    ['0 9 * * 1-5', 'Every weekday at 9:00'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 0 * * *', 'Every day at midnight'],
  ])('common pattern %p → %p', (expr, expected) => {
    expect(describeCronExpression(expr)).toBe(expected);
  });

  it('returns expression unchanged for non-5-field', () => {
    expect(describeCronExpression('garbage')).toBe('garbage');
  });

  it('produces non-empty generic description', () => {
    const result = describeCronExpression('30 14 * * 0');
    expect(result).toContain('Sunday');
  });
});
