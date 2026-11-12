/**
 * maskSecret / extractSecretForMask — agent secret tools
 * (docs/specs/20261031_agent-secret-tools.md, design C).
 */
import { describe, expect, it } from 'bun:test';
import { extractSecretForMask, maskSecret } from './mask-secret';

describe('maskSecret', () => {
  it('long value → prefix…last4 (the canonical sk_live_…4f2a shape)', () => {
    // 27 chars: prefixLen = max(1, 27/2-4) = 9 → capped at 6 → 'sk_live'
    expect(maskSecret('sk_live_51AbCdEfGhIjKlMn4f2a')).toBe('sk_live_…4f2a');
  });

  it('exactly 12 chars → clamps prefix so ≤50% is revealed', () => {
    // 12 chars: prefixLen = max(1, 12/2-4) = 2 → 'ab…wxyz' reveals 6/12 = 50%
    expect(maskSecret('abcdefghwxyz')).toBe('ab…wxyz');
  });

  it('4–11 chars → **** + last 2', () => {
    expect(maskSecret('token123')).toBe('****23');
    expect(maskSecret('abcd')).toBe('****cd');
  });

  it('under 4 chars → **** (never reveals the whole value)', () => {
    expect(maskSecret('ab')).toBe('****');
    expect(maskSecret('x')).toBe('****');
    expect(maskSecret('')).toBe('****');
  });

  it('never reveals ≥50% of the value', () => {
    for (const len of [12, 16, 24, 40, 64]) {
      const value = 'a'.repeat(len - 4) + 'wxyz';
      const masked = maskSecret(value);
      // Count revealed alphanumeric chars (everything except the ellipsis)
      const revealed = masked.replace('…', '').replace(/\*/g, '').length;
      expect(revealed).toBeLessThanOrEqual(Math.ceil(len / 2));
    }
  });

  it('is deterministic — same value, same mask, everywhere', () => {
    expect(maskSecret('sk_live_51AbCdEfGh4f2a')).toBe(maskSecret('sk_live_51AbCdEfGh4f2a'));
  });
});

describe('extractSecretForMask', () => {
  it('returns non-KEY=VALUE strings as-is (prose fallback)', () => {
    expect(extractSecretForMask('sk_live_xxx')).toBe('sk_live_xxx');
  });

  it('finds secret-ish keys in a flat object', () => {
    expect(extractSecretForMask({ MAKE_API_TOKEN: 'abc123def456', region: 'eu1' })).toBe(
      'abc123def456',
    );
  });

  it('finds secret-ish keys one level nested (tool input args)', () => {
    expect(
      extractSecretForMask({ input: { apiKey: 'sk_live_51xyz9f2a' }, name: 'deploy' }),
    ).toBe('sk_live_51xyz9f2a');
  });

  it('returns undefined when nothing looks secret-ish', () => {
    expect(extractSecretForMask({ name: 'deploy', region: 'eu1' })).toBeUndefined();
    expect(extractSecretForMask(undefined)).toBeUndefined();
    expect(extractSecretForMask(null)).toBeUndefined();
    expect(extractSecretForMask(42)).toBeUndefined();
  });

  it('matches the mca-oauth isSecretField vocabulary (token/key/secret/password)', () => {
    expect(extractSecretForMask({ API_TOKEN: 't' + 'ok'.repeat(4) })).toBeTruthy();
    expect(extractSecretForMask({ client_secret: 's' + 'ec'.repeat(4) })).toBeTruthy();
    expect(extractSecretForMask({ password: 'p' + 'w'.repeat(4) })).toBeTruthy();
    expect(extractSecretForMask({ APIKEY: 'k' + 'y'.repeat(4) })).toBeTruthy();
  });

  it('set-app-secret call shape {key, value} → masks the VALUE, not the key name', () => {
    // The trap: field 'key' = 'MAKE_API_TOKEN' matches the secret-ish regex,
    // but the payload is the sibling 'value'. Masking 'MAK…OKEN' would tell
    // the agent nothing about the secret it just stored.
    expect(
      extractSecretForMask({ appId: 'app_make', key: 'MAKE_API_TOKEN', value: 'sk_live_51AbCdEfGhIjKlMn4f2a' }),
    ).toBe('sk_live_51AbCdEfGhIjKlMn4f2a');
    // key naming a non-secret field → value is NOT treated as a secret
    expect(extractSecretForMask({ key: 'region', value: 'eu-central-1' })).toBeUndefined();
  });

  it('KEY=VALUE output lines → extracts the part after the =', () => {
    expect(extractSecretForMask('API_KEY=sk_live_51AbCdEfGhIjKlMn4f2a')).toBe('sk_live_51AbCdEfGhIjKlMn4f2a');
    // Too short / prose values → whole-string fallback (mask everything — safe)
    expect(extractSecretForMask('password=hunter2')).toBe('password=hunter2');
    expect(extractSecretForMask('command=cat /etc/provider/key')).toBe('command=cat /etc/provider/key');
    expect(extractSecretForMask('plain text without equals')).toBe('plain text without equals');
  });
});
