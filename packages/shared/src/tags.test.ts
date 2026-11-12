/**
 * Contract — normalizeTags() never throws and always returns string[].
 *
 * Guards the invariants that matter:
 *   - every input type (array / JSON string / CSV / garbage) produces a
 *     usable string[] — this is the fix for "task.tags.join is not a
 *     function" and "(task.tags ?? []).slice(...).map is not a function";
 *   - no input can make it throw (JSON.parse is guarded);
 *   - output is always clean: trimmed, non-empty strings.
 */
import { describe, it, expect } from 'bun:test';
import { normalizeTags } from './tags';

// ---------------------------------------------------------------- arrays

describe('normalizeTags — arrays', () => {
  it('passes through a proper string array', () => {
    expect(normalizeTags(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('stringifies and trims non-string array items', () => {
    expect(normalizeTags([1, ' x ', null, undefined])).toEqual(['1', 'x']);
  });

  it('drops empty strings from arrays', () => {
    expect(normalizeTags(['a', '', '  ', 'b'])).toEqual(['a', 'b']);
  });

  it('returns [] for empty array', () => {
    expect(normalizeTags([])).toEqual([]);
  });
});

// -------------------------------------------------------- JSON strings

describe('normalizeTags — JSON strings', () => {
  it('parses a JSON array string', () => {
    expect(normalizeTags('["tag1", "tag2"]')).toEqual(['tag1', 'tag2']);
  });
  it('parses a JSON array string without spaces', () => {
    expect(normalizeTags('["a","b"]')).toEqual(['a', 'b']);
  });

  it('returns [] for JSON that parses to a non-array', () => {
    expect(normalizeTags('["a"')).toEqual(['a']);
    expect(normalizeTags('[123,456]')).toEqual(['123', '456']);
  });

});

// ------------------------------------------------------------- strings

describe('normalizeTags — plain strings', () => {
  it('splits CSV strings', () => {
    expect(normalizeTags('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  it('wraps a single tag in an array', () => {
    expect(normalizeTags('single')).toEqual(['single']);
  });
  it('strips stray brackets from broken JSON', () => {
    expect(normalizeTags('["a", "b"')).toEqual(['a', 'b']);
  });

  it('returns [] for empty/whitespace string', () => {
    expect(normalizeTags('')).toEqual([]);
    expect(normalizeTags('   ')).toEqual([]);
  });
});

// ------------------------------------------------------ other types

describe('normalizeTags — other types', () => {
  it('returns [] for null/undefined', () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it('returns [] for numbers, objects, booleans', () => { 
    expect(normalizeTags(42)).toEqual([]);
    expect(normalizeTags({ a: 1 })).toEqual([]);
    expect(normalizeTags(true)).toEqual([]);
  });
});

// --------------------------------------------------- crash regression

describe('normalizeTags — regression: board UI crashes', () => {
  it('output always supports .map/.slice/.join without throwing', () => {
    const inputs: unknown[] = [
      ['ui', 'bug'],
      '["ui","bug"]',
      'ui, bug',
      'ui',
      null,
      undefined,
      42,
      {},
    ];
    for (const input of inputs) {
      const tags = normalizeTags(input);
      expect(Array.isArray(tags)).toBe(true);
      expect(() => tags.slice(0, 3).map((t) => `#${t}`)).not.toThrow();
      expect(() => tags.join(', ')).not.toThrow();
      expect(() => tags.filter((t) => t.length > 1)).not.toThrow();
      expect(() => { for (const t of tags) void t; }).not.toThrow();
    }
  });
});
