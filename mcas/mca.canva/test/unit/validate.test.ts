import { describe, expect, it } from 'bun:test';
import { validateExternalUrl, validateNonEmpty, validatePages } from '../../src/tools/_validate';

describe('validateExternalUrl', () => {
  it('accepts https URLs', () => {
    expect(() => validateExternalUrl('https://example.com/image.png', 'url')).not.toThrow();
  });

  it('accepts http URLs', () => {
    expect(() => validateExternalUrl('http://example.com', 'url')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateExternalUrl('', 'url')).toThrow(/non-empty/);
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateExternalUrl('   ', 'url')).toThrow(/non-empty/);
  });

  it('rejects javascript: protocol (XSS vector)', () => {
    expect(() => validateExternalUrl('javascript:alert(1)', 'url')).toThrow(/http:|https:/);
  });

  it('rejects file: protocol (local file access)', () => {
    expect(() => validateExternalUrl('file:///etc/passwd', 'url')).toThrow(/http:|https:/);
  });

  it('rejects ftp:// protocol', () => {
    expect(() => validateExternalUrl('ftp://example.com', 'url')).toThrow(/http:|https:/);
  });

  it('rejects garbage strings', () => {
    expect(() => validateExternalUrl('not a url', 'url')).toThrow(/valid URL/);
  });

  it('error message includes the parameter name', () => {
    let captured: Error | null = null;
    try {
      validateExternalUrl('javascript:bad', 'attachmentUrl');
    } catch (e) {
      captured = e as Error;
    }
    expect(captured?.message).toContain('attachmentUrl');
  });
});

describe('validateNonEmpty', () => {
  it('accepts non-empty strings', () => {
    expect(() => validateNonEmpty('a', 'x')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateNonEmpty('', 'x')).toThrow(/non-empty/);
  });

  it('rejects whitespace-only', () => {
    expect(() => validateNonEmpty('   \t\n', 'x')).toThrow(/non-empty/);
  });

  it('rejects undefined / null / number', () => {
    expect(() => validateNonEmpty(undefined, 'x')).toThrow();
    expect(() => validateNonEmpty(null, 'x')).toThrow();
    expect(() => validateNonEmpty(42, 'x')).toThrow();
  });
});

describe('validatePages', () => {
  it('accepts arrays of positive integers', () => {
    expect(() => validatePages([1, 2, 3])).not.toThrow();
  });

  it('accepts a single page', () => {
    expect(() => validatePages([1])).not.toThrow();
  });

  it('rejects non-arrays', () => {
    expect(() => validatePages('1,2,3')).toThrow(/array/);
    expect(() => validatePages(undefined)).toThrow(/array/);
  });

  it('rejects 0 (Canva pages are 1-indexed)', () => {
    expect(() => validatePages([0])).toThrow(/positive integer/);
  });

  it('rejects negative numbers', () => {
    expect(() => validatePages([-1, 2])).toThrow(/positive integer/);
  });

  it('rejects non-integers', () => {
    expect(() => validatePages([1.5])).toThrow(/positive integer/);
  });

  it('error message includes the offending index', () => {
    let captured: Error | null = null;
    try {
      validatePages([1, 2, 0]);
    } catch (e) {
      captured = e as Error;
    }
    expect(captured?.message).toContain('[2]');
  });
});
