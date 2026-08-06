/**
 * JSON-aware formatter for the FallbackBody output block.
 *
 * Lives in its own file (no React, no react-native, no tamagui) so
 * it's testable in pure bun:test without bringing the RN bundler
 * runtime into the test environment.
 *
 * Behaviour:
 *   - Empty / whitespace-only → `'—'` (em-dash placeholder).
 *   - JSON object/array (and parses cleanly) → pretty-printed with
 *     2-space indent so users can scan the structure.
 *   - JSON primitive (number/string/null/bool) → raw (pretty-printing
 *     a single value is noise).
 *   - Anything else → raw, untouched. Preserves whitespace because the
 *     trim is only used as a JSON-detection heuristic.
 */
export function formatOutput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '—';
  // Try compact-pretty for JSON objects/arrays only; primitives and
  // non-JSON strings fall through to raw.
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      /* malformed JSON — fall through to raw */
    }
  }
  return raw;
}
