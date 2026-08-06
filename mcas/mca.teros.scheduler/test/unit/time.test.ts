import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import {
  formatNextRun,
  parseDelayExpression,
  parseTimeExpression,
  previewOccurrences,
} from '../../src/lib/time';
import { SchedulerError } from '../../src/lib/errors';

const TZ_MADRID = 'Europe/Madrid';

describe('parseTimeExpression', () => {
  beforeEach(() => {
    // Anchor: 2026-04-30 10:00:00 UTC
    setSystemTime(new Date('2026-04-30T10:00:00.000Z'));
  });
  afterEach(() => {
    setSystemTime();
  });

  it('parses ISO 8601 future', () => {
    const r = parseTimeExpression('2026-05-01T10:00:00Z', { timezone: TZ_MADRID });
    expect(r.confidence).toBe('high');
    expect(r.timestamp).toBe(new Date('2026-05-01T10:00:00Z').getTime());
    expect(r.detectedText).toBe('2026-05-01T10:00:00Z');
  });

  it('rejects ISO in the past without allowPast', () => {
    expect(() =>
      parseTimeExpression('2020-01-01T00:00:00Z', { timezone: TZ_MADRID }),
    ).toThrow(SchedulerError);
  });

  it('accepts past with allowPast:true', () => {
    const r = parseTimeExpression('2020-01-01T00:00:00Z', {
      timezone: TZ_MADRID,
      allowPast: true,
    });
    expect(r.timestamp).toBe(new Date('2020-01-01T00:00:00Z').getTime());
  });

  it('parses natural English "in 2 hours"', () => {
    const r = parseTimeExpression('in 2 hours', { timezone: TZ_MADRID, locale: 'en' });
    expect(r.locale).toBe('en');
    expect(r.timestamp).toBeGreaterThan(Date.now());
    expect(r.timestamp - Date.now()).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1000);
    expect(r.timestamp - Date.now()).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 1000);
  });

  it('parses natural English "tomorrow at 9am" with forwardDate', () => {
    const r = parseTimeExpression('tomorrow at 9am', { timezone: TZ_MADRID, locale: 'en' });
    expect(r.timestamp).toBeGreaterThan(Date.now());
    const day = new Date(r.timestamp);
    expect(day.getUTCDate()).toBe(1); // next day (May 1)
    expect(day.getUTCMonth()).toBe(4); // May (0-indexed)
  });

  // P1-1 regression: literal hour MUST be reinterpreted in the target TZ.
  // "tomorrow at 9am" with timezone Madrid → 09:00 Madrid (= 07:00 UTC in CEST).
  // "tomorrow at 9am" with timezone New_York → 09:00 NY (= 13:00 UTC in EDT).
  // The two MUST produce different epochs; previously they were identical.
  it('P1-1: literal hour respects opts.timezone (Madrid vs NY)', () => {
    const madrid = parseTimeExpression('tomorrow at 9am', { timezone: TZ_MADRID, locale: 'en' });
    const ny = parseTimeExpression('tomorrow at 9am', { timezone: 'America/New_York', locale: 'en' });
    expect(ny.timestamp).not.toBe(madrid.timestamp);
    // NY is 6h behind Madrid (in spring): so NY's 9am = Madrid's 15:00 = 6h later in UTC.
    expect(ny.timestamp - madrid.timestamp).toBe(6 * 3_600_000);
  });

  // P1-1 regression: relative expressions ("in 2 hours") MUST NOT be reinterpreted —
  // they're computed from the reference instant, not from a literal token.
  it('P1-1: relative "in 2 hours" same epoch regardless of timezone', () => {
    const madrid = parseTimeExpression('in 2 hours', { timezone: TZ_MADRID, locale: 'en' });
    const ny = parseTimeExpression('in 2 hours', { timezone: 'America/New_York', locale: 'en' });
    expect(madrid.timestamp).toBe(ny.timestamp);
  });

  it('throws on empty input', () => {
    expect(() => parseTimeExpression('', { timezone: TZ_MADRID })).toThrow(SchedulerError);
  });

  it('throws on garbage input', () => {
    expect(() =>
      parseTimeExpression('xyzqwerty', { timezone: TZ_MADRID, locale: 'en' }),
    ).toThrow(SchedulerError);
  });
});

describe('parseDelayExpression', () => {
  it('parses minutes', () => {
    expect(parseDelayExpression('30m')).toBe(30 * 60_000);
    expect(parseDelayExpression('30 mins')).toBe(30 * 60_000);
    expect(parseDelayExpression('5 minutes')).toBe(5 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDelayExpression('2h')).toBe(2 * 3_600_000);
    expect(parseDelayExpression('1 hour')).toBe(3_600_000);
  });

  it('parses days', () => {
    expect(parseDelayExpression('1d')).toBe(86_400_000);
    expect(parseDelayExpression('3 days')).toBe(3 * 86_400_000);
  });

  it('parses seconds', () => {
    expect(parseDelayExpression('45s')).toBe(45 * 1000);
  });

  it('rejects invalid', () => {
    expect(() => parseDelayExpression('xyz')).toThrow(SchedulerError);
    expect(() => parseDelayExpression('30 lightyears')).toThrow(SchedulerError);
  });
});

describe('formatNextRun', () => {
  beforeEach(() => {
    setSystemTime(new Date('2026-04-30T10:00:00.000Z'));
  });
  afterEach(() => {
    setSystemTime();
  });

  it('< 1 minute', () => {
    expect(formatNextRun(Date.now() + 30_000, TZ_MADRID)).toBe('in <1 minute');
  });

  it('minutes', () => {
    expect(formatNextRun(Date.now() + 5 * 60_000, TZ_MADRID)).toBe('in 5 minutes');
    expect(formatNextRun(Date.now() + 60_000, TZ_MADRID)).toBe('in 1 minute');
  });

  it('hours', () => {
    expect(formatNextRun(Date.now() + 2 * 3_600_000, TZ_MADRID)).toBe('in 2 hours');
  });

  it('past', () => {
    expect(formatNextRun(Date.now() - 5 * 60_000, TZ_MADRID)).toBe('5 minutes ago');
  });

  it('tomorrow (>= 24h)', () => {
    // formatNextRun's "tomorrow at HH:MM" branch fires when delta rounds to
    // exactly 1 day. Use 26h to round to 1 day.
    const tomorrow = Date.now() + 26 * 3_600_000;
    expect(formatNextRun(tomorrow, TZ_MADRID)).toContain('tomorrow at');
  });

  it('< 24h falls into hours branch', () => {
    expect(formatNextRun(Date.now() + 21 * 3_600_000, TZ_MADRID)).toBe('in 21 hours');
  });
});

describe('previewOccurrences', () => {
  beforeEach(() => {
    setSystemTime(new Date('2026-04-30T10:00:00.000Z'));
  });
  afterEach(() => {
    setSystemTime();
  });

  it('returns 1 occurrence for non-recurring', () => {
    const occs = previewOccurrences('in 2 hours', { timezone: TZ_MADRID }, 5);
    // Non-recurring expressions produce 1 result (subsequent parse with later
    // reference may yield same or no result depending on chrono behavior).
    expect(occs.length).toBeGreaterThanOrEqual(1);
  });

  it('returns [] when count is 0', () => {
    expect(previewOccurrences('in 2 hours', { timezone: TZ_MADRID }, 0)).toEqual([]);
  });
});
