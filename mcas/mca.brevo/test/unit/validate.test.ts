import { describe, expect, it } from 'bun:test';
import {
  clampInt,
  isValidEmail,
  validateCreateContactArgs,
  validateEnum,
  validateSendEmailArgs,
} from '../../src/tools/_helpers';

const validSend = {
  sender: { email: 'ana@empresa.com', name: 'Ana' },
  to: [{ email: 'cliente@dominio.com' }],
  subject: 'Hola',
  textContent: 'Cuerpo',
};

describe('isValidEmail', () => {
  it('accepts well-formed addresses', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
    expect(isValidEmail('  a@b.com  ')).toBe(true);
  });
  it('rejects empty, whitespace and malformed', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('   ')).toBe(false);
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('foo@bar')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
    expect(isValidEmail(123)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});

describe('validateSendEmailArgs', () => {
  it('passes for valid args', () => {
    expect(() => validateSendEmailArgs(validSend)).not.toThrow();
  });

  it('accepts htmlContent alone (no textContent)', () => {
    expect(() =>
      validateSendEmailArgs({ ...validSend, textContent: undefined, htmlContent: '<p>Hi</p>' }),
    ).not.toThrow();
  });

  it('rejects missing / empty sender.email', () => {
    expect(() => validateSendEmailArgs({ ...validSend, sender: {} })).toThrow(/sender\.email/);
    expect(() => validateSendEmailArgs({ ...validSend, sender: { email: '  ' } })).toThrow(
      /sender\.email/,
    );
  });

  it('rejects malformed sender.email', () => {
    expect(() => validateSendEmailArgs({ ...validSend, sender: { email: 'nope' } })).toThrow(
      /not a valid email/,
    );
  });

  it('rejects empty to[]', () => {
    expect(() => validateSendEmailArgs({ ...validSend, to: [] })).toThrow(/to must be a non-empty/);
    expect(() => validateSendEmailArgs({ ...validSend, to: 'x' })).toThrow(/to must be a non-empty/);
  });

  it('reports the offending recipient index', () => {
    expect(() =>
      validateSendEmailArgs({
        ...validSend,
        to: [{ email: 'ok@x.com' }, { email: 'broken' }],
      }),
    ).toThrow(/to\[1\]/);
  });

  it('rejects missing subject', () => {
    expect(() => validateSendEmailArgs({ ...validSend, subject: '   ' })).toThrow(/subject/);
  });

  it('rejects when neither htmlContent nor textContent is present', () => {
    expect(() =>
      validateSendEmailArgs({ ...validSend, textContent: undefined, htmlContent: undefined }),
    ).toThrow(/At least one of htmlContent or textContent/);
  });

  it('validates optional cc / bcc / replyTo emails', () => {
    expect(() => validateSendEmailArgs({ ...validSend, cc: [{ email: 'bad' }] })).toThrow(
      /cc\[0\]/,
    );
    expect(() => validateSendEmailArgs({ ...validSend, bcc: 'x' })).toThrow(/bcc must be an array/);
    expect(() => validateSendEmailArgs({ ...validSend, replyTo: { email: 'bad' } })).toThrow(
      /replyTo\.email/,
    );
  });
});

describe('validateCreateContactArgs', () => {
  it('passes for a valid email', () => {
    expect(() => validateCreateContactArgs({ email: 'x@y.com' })).not.toThrow();
  });
  it('rejects missing / invalid email', () => {
    expect(() => validateCreateContactArgs({})).toThrow(/email is required/);
    expect(() => validateCreateContactArgs({ email: 'nope' })).toThrow(/not a valid email/);
  });
  it('rejects non-integer listIds', () => {
    expect(() => validateCreateContactArgs({ email: 'x@y.com', listIds: [1, 'a'] })).toThrow(
      /listIds/,
    );
    expect(() => validateCreateContactArgs({ email: 'x@y.com', listIds: 3 })).toThrow(/listIds/);
  });
  it('rejects non-object attributes', () => {
    expect(() => validateCreateContactArgs({ email: 'x@y.com', attributes: [1] })).toThrow(
      /attributes/,
    );
  });
});

describe('clampInt', () => {
  it('returns fallback for missing / non-numeric', () => {
    expect(clampInt(undefined, 1, 100, 50)).toBe(50);
    expect(clampInt(null, 1, 100, 50)).toBe(50);
    expect(clampInt('abc', 1, 100, 50)).toBe(50);
    expect(clampInt('', 1, 100, 50)).toBe(50);
  });
  it('returns fallback for NaN / Infinity (typeof number but not finite)', () => {
    expect(clampInt(Number.NaN, 1, 100, 50)).toBe(50);
    expect(clampInt(Number.POSITIVE_INFINITY, 1, 100, 50)).toBe(50);
    expect(clampInt(Number.NEGATIVE_INFINITY, 1, 100, 50)).toBe(50);
  });
  it('clamps to [min, max] and floors floats', () => {
    expect(clampInt(0, 1, 100, 50)).toBe(1);
    expect(clampInt(9999, 1, 100, 50)).toBe(100);
    expect(clampInt(12.9, 1, 100, 50)).toBe(12);
    expect(clampInt('30', 1, 100, 50)).toBe(30);
  });
});

describe('validateEnum', () => {
  const allowed = ['classic', 'trigger'] as const;
  it('returns undefined for missing / empty', () => {
    expect(validateEnum(undefined, allowed, 'type')).toBeUndefined();
    expect(validateEnum('', allowed, 'type')).toBeUndefined();
    expect(validateEnum(null, allowed, 'type')).toBeUndefined();
  });
  it('returns the value when allowed', () => {
    expect(validateEnum('classic', allowed, 'type')).toBe('classic');
  });
  it('throws listing allowed values when not allowed', () => {
    expect(() => validateEnum('bogus', allowed, 'type')).toThrow(/classic, trigger/);
  });
});
