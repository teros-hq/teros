/**
 * Tests for FallbackBody — focused on the JSON-pretty-print logic
 * that lives in `formatOutput`. The status-branching skeleton (which
 * primitives are mounted per status) is trivially verifiable at the
 * source level (5 plain `&&` conditions), and a render-tree test was
 * tried and abandoned: react-native ships Flow-only source plus
 * react-native-svg pulls null-Mixin globals during init in bun:test,
 * neither resolvable without a heavy preload-mock setup that exceeds
 * the value of the assertion. The runtime behaviour is covered via
 * the smoke checklist documented in the assessment.
 *
 * What we DO test rigorously: `formatOutput`. It's the only branch
 * that has interesting logic (JSON detection + pretty-print + raw
 * fallback) and it's pure (string in, string out). Pinning it here
 * prevents silent regressions like switching to a non-pretty
 * serializer or accidentally calling `JsonPreview` underneath.
 */
import { describe, expect, it } from 'bun:test';

import { formatOutput } from '../../../../packages/app/src/components/mca/primitives/formatOutput';

describe('FallbackBody.formatOutput', () => {
  it('returns "—" for empty / whitespace-only input', () => {
    expect(formatOutput('')).toBe('—');
    expect(formatOutput('   ')).toBe('—');
    expect(formatOutput('\n\t\n')).toBe('—');
  });

  it('pretty-prints JSON objects (2-space indent)', () => {
    const out = formatOutput('{"a":1,"b":[2,3]}');
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b":');
    // Multi-line — pretty print broke object/array onto multiple lines
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('pretty-prints JSON arrays', () => {
    const out = formatOutput('[1,2,3]');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('falls back to raw text when content looks like JSON but is malformed', () => {
    const malformed = '{not actually json}';
    expect(formatOutput(malformed)).toBe(malformed);
  });

  it('returns raw text for plain strings (not JSON)', () => {
    expect(formatOutput('hello world')).toBe('hello world');
    expect(formatOutput('error: connection refused')).toBe('error: connection refused');
  });

  it('handles JSON-looking content that is not valid (unterminated)', () => {
    const broken = '{"a":1';
    expect(formatOutput(broken)).toBe(broken);
  });

  it('does not pretty-print primitives (only objects/arrays)', () => {
    // `42`, `true`, `"quoted"` are valid JSON but we treat them as
    // raw — pretty-printing a number is pointless.
    expect(formatOutput('42')).toBe('42');
    expect(formatOutput('true')).toBe('true');
    expect(formatOutput('"a string"')).toBe('"a string"');
  });

  it('preserves leading/trailing whitespace on raw text path', () => {
    // Trim is only applied to the JSON-detection guard, not to the
    // returned value when we fall through to raw.
    expect(formatOutput('  line1\nline2  ')).toBe('  line1\nline2  ');
  });

  it('handles deeply nested JSON without crashing', () => {
    const deep = JSON.stringify({ a: { b: { c: { d: { e: 1 } } } } });
    const out = formatOutput(deep);
    expect(out).toContain('"e": 1');
    expect(out.split('\n').length).toBeGreaterThan(5);
  });

  it('never throws on adversarial input', () => {
    // Defense against a tool returning something unexpected. Any of
    // these should produce a string, not crash the fallback body.
    expect(() => formatOutput('}{')).not.toThrow();
    expect(() => formatOutput('[}')).not.toThrow();
    expect(() => formatOutput('null')).not.toThrow();
    // `null` parses as valid JSON, but it's a primitive — falls to raw.
    expect(formatOutput('null')).toBe('null');
  });
});
