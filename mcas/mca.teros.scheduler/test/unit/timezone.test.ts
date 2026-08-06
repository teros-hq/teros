import { describe, expect, it } from 'bun:test';
import { SchedulerError } from '../../src/lib/errors';
import {
  assertValidTimezone,
  isValidIanaTimezone,
  resolveDefaultTimezone,
} from '../../src/lib/timezone';

describe('isValidIanaTimezone', () => {
  it.each([
    ['Europe/Madrid', true],
    ['America/New_York', true],
    ['UTC', true],
    ['Asia/Tokyo', true],
    ['Australia/Sydney', true],
    ['Not/AZone', false],
    ['', false],
  ])('%p → %p', (tz, expected) => {
    expect(isValidIanaTimezone(tz)).toBe(expected);
  });
});

describe('assertValidTimezone', () => {
  it('throws SchedulerError on invalid', () => {
    expect(() => assertValidTimezone('Not/AZone')).toThrow(SchedulerError);
  });

  it('passes on valid', () => {
    expect(() => assertValidTimezone('Europe/Madrid')).not.toThrow();
  });
});

describe('resolveDefaultTimezone', () => {
  it('returns Europe/Madrid by default', () => {
    delete process.env.MCA_DEFAULT_TIMEZONE;
    expect(resolveDefaultTimezone()).toBe('Europe/Madrid');
  });

  it('honours env var when valid', () => {
    process.env.MCA_DEFAULT_TIMEZONE = 'America/New_York';
    expect(resolveDefaultTimezone()).toBe('America/New_York');
    delete process.env.MCA_DEFAULT_TIMEZONE;
  });

  it('falls back when env var is invalid', () => {
    process.env.MCA_DEFAULT_TIMEZONE = 'Not/AZone';
    expect(resolveDefaultTimezone()).toBe('Europe/Madrid');
    delete process.env.MCA_DEFAULT_TIMEZONE;
  });
});
