/**
 * Tag normalization utilities
 *
 * Defense against legacy/corrupted data where `tags` reached MongoDB as a
 * JSON string ('["a","b"]'), a plain string, or another unexpected type
 * instead of a proper array. This broke the board UI with errors like
 * "task.tags.join is not a function" and
 * "(task.tags ?? []).slice(...).map is not a function".
 *
 * Use `normalizeTags()` before ANY array operation (.map / .slice / .join /
 * .filter / for...of) on a `tags` field coming from the database or from an
 * untrusted client payload.
 */

/**
 * Normalizes any `tags` value to a clean `string[]`. Never throws.
 *
 * Accepted inputs:
 * - `string[]`            → passed through (stringified, trimmed)
 * - `'"a","b"'` (JSON)    → parsed to array
 * - `'a, b'` (CSV)        → split on commas
 * - `'single'`            → `['single']`
 * - `null` / `undefined` / anything else → `[]`
 */
export function normalizeTags(tags: unknown): string[] {
  if (Array.isArray(tags)) {
    return tags
      .filter((t) => t !== null && t !== undefined)
      .map((t) => String(t).trim())
      .filter(Boolean);
  }

  if (typeof tags === 'string') {
    const trimmed = tags.trim();
    if (!trimmed) return [];

    // JSON array string: '["a","b"]'
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((t) => String(t).trim()).filter(Boolean);
        }
      } catch {
        // fall through to CSV fallback below
      }
    }

    // CSV fallback: 'a, b' or '"a","b"' (broken JSON)
    return trimmed
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => t.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }

  return [];
}
