/**
 * maskSecret — deterministic secret preview used by get-app-secret and the
 * agent-context redaction placeholder (docs/specs/20261031_agent-secret-tools.md).
 *
 * Rules:
 * - len >= 12 → `<first 6>…<last 4>` (e.g. `sk_live_…4f2a`)
 * - 4 <= len < 12 → `****<last 2>` (e.g. `****a7`)
 * - len < 4 → `****` (never reveal the whole value)
 * - The revealed portion is never >= 50% of the value.
 *
 * Pure function, no deps — lives in shared so backend (get-app-secret route)
 * and core (filterRedactedForViewer placeholder) produce the SAME mask for the
 * same secret, letting the agent correlate "the …4f2a key" across both.
 */
export function maskSecret(value: string): string {
  const v = String(value ?? '');
  const len = v.length;

  if (len === 0) return '****';
  if (len < 4) return '****';
  if (len < 12) return `****${v.slice(-2)}`;

  // len >= 12: prefix + ellipsis + last4. The prefix is capped at 8 chars so
  // the canonical shape `sk_live_…4f2a` (7-char prefix) is representable,
  // while prefixLen = max(1, len/2 - 4) keeps the revealed portion (prefix+4)
  // at or under half the value: len 12 → 2+4=6/12, len 16 → 4+4=8/16,
  // len 24+ → capped 8+4=12 ≤ 50%.
  const prefixLen = Math.max(1, Math.floor(len / 2) - 4);
  const prefix = v.slice(0, Math.min(8, prefixLen));
  return `${prefix}…${v.slice(-4)}`;
}

/**
 * Extract a displayable secret-ish string from arbitrary message content for
 * the redaction placeholder. Scans the FIRST occurrence of any string field
 * whose key looks secret-ish (token/key/secret/password/apikey) in a flat or
 * one-level-nested object, so the placeholder shows the mask of the actual
 * secret that caused the redaction rather than a generic marker.
 *
 * Two extra shapes the tool world produces constantly:
 * - `{ key: 'MAKE_API_TOKEN', value: <secret> }` — set-app-secret's own call
 *   args. The secret sits under the generic name `value`; the secret-ish name
 *   is a SIBLING. When a sibling key names a secret field, `value` is the
 *   secret payload.
 * - `'API_KEY=sk_live_…'` — key=value lines in tool outputs. The part after
 *   the `=` is the secret, not the whole line.
 *
 * Returns undefined when nothing secret-looking is found — callers then fall
 * back to a generic placeholder.
 */
export function extractSecretForMask(content: unknown): string | undefined {
  if (typeof content === 'string') {
    // KEY=VALUE line → the part after '='; any other string → as-is
    // (masking the whole string is the safe fallback — never leaks).
    return extractFromKeyValueLine(content) ?? content;
  }
  if (!content || typeof content !== 'object') return undefined;

  const SECRET_KEY_RE = /(token|key|secret|password|apikey|api_key|credential)/i;

  const scan = (obj: Record<string, unknown>): string | undefined => {
    for (const [k, v] of Object.entries(obj)) {
      // Call-args shape: a literal `key` field holds the secret's NAME
      // (e.g. 'region'), not a payload — never treat its content as secret.
      if (k === 'key' && 'value' in obj) continue;
      if (typeof v === 'string' && SECRET_KEY_RE.test(k) && v.length >= 4) return v;
    }
    return undefined;
  };

  // `{ key: '<SECRET_FIELD_NAME>', value: <secret> }` — set-app-secret shape.
  // Checked BEFORE the generic scan: the field literally named `key` holds the
  // secret's NAME (e.g. 'MAKE_API_TOKEN'), while the payload sits in the
  // sibling `value`. Masking the name instead of the payload is the trap.
  const rec = content as Record<string, unknown>;
  if (typeof rec.key === 'string' && SECRET_KEY_RE.test(rec.key) && typeof rec.value === 'string' && rec.value.length >= 4) {
    return rec.value;
  }

  const direct = scan(rec);
  if (direct) return direct;

  // One level deeper (tool input args, content objects…)
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = scan(v as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * `'API_KEY=sk_live_51AbCdEfGhIjKlMn4f2a'` → `'sk_live_51AbCdEfGhIjKlMn4f2a'`.
 * Only single KEY=VALUE lines where the KEY looks secret-ish and the value is
 * long enough to be a secret (>= 8) — never a whole prose line.
 */
function extractFromKeyValueLine(s: string): string | null {
  const idx = s.indexOf('=');
  if (idx <= 0 || idx === s.length - 1) return null;
  const keyPart = s.slice(0, idx);
  const valuePart = s.slice(idx + 1).trim();
  if (valuePart.includes(' ') || valuePart.length < 8) return null;
  if (!/(token|key|secret|password|apikey|api_key|credential)/i.test(keyPart)) return null;
  return valuePart;
}
