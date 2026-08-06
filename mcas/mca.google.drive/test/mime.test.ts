import { describe, expect, it } from 'bun:test';
import { isTextualMimeType } from '../src/tools/_mime';

describe('isTextualMimeType', () => {
  it('accepts text/* types', () => {
    expect(isTextualMimeType('text/plain')).toBe(true);
    expect(isTextualMimeType('text/html')).toBe(true);
    expect(isTextualMimeType('text/csv')).toBe(true);
    expect(isTextualMimeType('text/markdown')).toBe(true);
  });

  it('accepts structured text types', () => {
    expect(isTextualMimeType('application/json')).toBe(true);
    expect(isTextualMimeType('application/xml')).toBe(true);
    expect(isTextualMimeType('application/javascript')).toBe(true);
    expect(isTextualMimeType('application/xhtml+xml')).toBe(true);
    expect(isTextualMimeType('application/ld+json')).toBe(true);
  });

  it('rejects PDF and Office binary types (the bug)', () => {
    expect(isTextualMimeType('application/pdf')).toBe(false);
    expect(
      isTextualMimeType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(false);
    expect(isTextualMimeType('application/msword')).toBe(false);
  });

  it('rejects images, archives and octet-stream', () => {
    expect(isTextualMimeType('image/png')).toBe(false);
    expect(isTextualMimeType('application/zip')).toBe(false);
    expect(isTextualMimeType('application/octet-stream')).toBe(false);
  });

  it('rejects missing/empty mime types', () => {
    expect(isTextualMimeType(undefined)).toBe(false);
    expect(isTextualMimeType(null)).toBe(false);
    expect(isTextualMimeType('')).toBe(false);
  });
});
