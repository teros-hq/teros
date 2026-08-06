import { describe, expect, test } from 'bun:test';
import { optionalInt, requireDomain, requireEmail, requireNonEmpty } from '../../src/lib/validation';

describe('requireDomain', () => {
  test('accepts a bare company domain', () => {
    expect(requireDomain('stripe.com')).toBe('stripe.com');
  });

  test('strips scheme + path and lowercases', () => {
    expect(requireDomain('HTTPS://Stripe.com/pricing')).toBe('stripe.com');
  });

  test('accepts multi-label domains', () => {
    expect(requireDomain('mail.google.co.uk')).toBe('mail.google.co.uk');
  });

  test('rejects a bare IPv4 address (no alphabetic TLD)', () => {
    expect(() => requireDomain('192.168.0.1')).toThrow(/\[BAD_REQUEST\]/);
  });

  test('rejects a numeric TLD', () => {
    expect(() => requireDomain('foo.123')).toThrow(/\[BAD_REQUEST\]/);
  });

  test('rejects empty / whitespace', () => {
    expect(() => requireDomain('   ')).toThrow(/\[BAD_REQUEST\].*domain/);
  });
});

describe('optionalInt boundaries', () => {
  test('undefined / null → undefined (absent)', () => {
    expect(optionalInt(undefined, 'limit', 1, 100)).toBeUndefined();
    expect(optionalInt(null, 'limit', 1, 100)).toBeUndefined();
  });

  test('accepts the inclusive min and max', () => {
    expect(optionalInt(1, 'limit', 1, 100)).toBe(1);
    expect(optionalInt(100, 'limit', 1, 100)).toBe(100);
  });

  test('accepts 0 when min is 0 (offset)', () => {
    expect(optionalInt(0, 'offset', 0, 100_000)).toBe(0);
  });

  test('rejects 0 when min is 1', () => {
    expect(() => optionalInt(0, 'limit', 1, 100)).toThrow(/limit must be an integer in \[1, 100\]/);
  });

  test('rejects a negative value', () => {
    expect(() => optionalInt(-1, 'limit', 1, 100)).toThrow(/\[BAD_REQUEST\]/);
  });

  test('rejects a non-integer', () => {
    expect(() => optionalInt(1.5, 'limit', 1, 100)).toThrow(/\[BAD_REQUEST\]/);
  });

  test('rejects above max', () => {
    expect(() => optionalInt(101, 'limit', 1, 100)).toThrow(/\[BAD_REQUEST\]/);
  });
});

describe('requireEmail / requireNonEmpty', () => {
  test('accepts a valid email, rejects garbage', () => {
    expect(requireEmail('a@b.com')).toBe('a@b.com');
    expect(() => requireEmail('nope')).toThrow(/\[BAD_REQUEST\].*email/);
  });

  test('requireNonEmpty trims and rejects whitespace', () => {
    expect(requireNonEmpty('  x  ', 'f')).toBe('x');
    expect(() => requireNonEmpty('   ', 'f')).toThrow(/f is required/);
  });
});
