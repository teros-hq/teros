/**
 * Tests for ParamsTable.formatValue (Renderer UX Guide v2 §0).
 *
 * The Fallback Body renders input params via ParamsTable. Object/array
 * values must collapse to a compact placeholder — never expand to a JSON
 * tree. This test pins down the contract so future tweaks don't sneak
 * in the dreaded "raw JSON dump" the guide explicitly forbids.
 */
import { describe, expect, it } from 'bun:test';

import { formatValue } from '../../../../packages/app/src/components/mca/primitives/ParamsTable';

describe('formatValue', () => {
  it('returns "null" for null', () => {
    expect(formatValue(null)).toBe('null');
  });

  it('returns "—" for undefined', () => {
    expect(formatValue(undefined)).toBe('—');
  });

  it('returns the string for string values', () => {
    expect(formatValue('hello')).toBe('hello');
  });

  it('shows "" for empty strings', () => {
    expect(formatValue('')).toBe('""');
  });

  it('stringifies numbers', () => {
    expect(formatValue(42)).toBe('42');
    expect(formatValue(3.14)).toBe('3.14');
  });

  it('stringifies booleans', () => {
    expect(formatValue(true)).toBe('true');
    expect(formatValue(false)).toBe('false');
  });

  it('shows "[]" for empty arrays', () => {
    expect(formatValue([])).toBe('[]');
  });

  it('shows "[…N]" for non-empty arrays without exposing items', () => {
    expect(formatValue([1, 2, 3])).toBe('[…3]');
    expect(formatValue(['a', 'b'])).toBe('[…2]');
  });

  it('shows "{…}" for objects without exposing fields', () => {
    expect(formatValue({ secret: 'hunter2', any: 'thing' })).toBe('{…}');
  });

  it('does not expose nested object content', () => {
    const out = formatValue({ a: { b: { c: 'deep' } } });
    expect(out).toBe('{…}');
    expect(out).not.toContain('deep');
  });

  it('formats Date as ISO string', () => {
    const d = new Date('2026-05-07T12:00:00Z');
    expect(formatValue(d)).toBe('2026-05-07T12:00:00.000Z');
  });

  it('formats Invalid Date defensively', () => {
    expect(formatValue(new Date('not a date'))).toBe('[Invalid Date]');
  });

  it('formats BigInt with n suffix', () => {
    // biome-ignore lint/suspicious/noBigIntLiterals: testing BigInt literal handling
    expect(formatValue(123n)).toBe('123n');
  });

  it('formats Symbol', () => {
    expect(formatValue(Symbol('s'))).toBe('Symbol(s)');
  });

  it('formats functions as [Function]', () => {
    expect(formatValue(() => 1)).toBe('[Function]');
    expect(formatValue(function namedFn() {})).toBe('[Function]');
  });

  it('detects circular references without throwing', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(formatValue(obj)).toBe('{circular}');
  });
});
