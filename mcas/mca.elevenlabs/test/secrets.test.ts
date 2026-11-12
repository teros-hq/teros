/**
 * Secret resolution — user-only model (product decision 2026-10-26).
 *
 * The user's own secret is the ONLY source: no system/shared fallback.
 * The manifest declares only userSecrets, so getAuthStatus requires the
 * user's key (needs_user_auth) until they configure it.
 */

import { describe, expect, it } from 'bun:test';
import { resolveAgentId, resolveApiKey, resolveApiKeyWithSource } from '../src/secrets';

function ctx(userSecrets: Record<string, string> | null, systemSecrets?: Record<string, string>) {
  return {
    getUserSecrets: async () => userSecrets,
    getSystemSecrets: async () => systemSecrets ?? { apiKey: 'sk_SYSTEM_KEY' },
  };
}

describe('resolveApiKey — user-only (no system fallback)', () => {
  it('user key (apiKey casing) is used', async () => {
    expect(await resolveApiKey(ctx({ apiKey: 'sk_USER' }))).toBe('sk_USER');
  });

  it('user key (API_KEY casing) is used', async () => {
    expect(await resolveApiKey(ctx({ API_KEY: 'sk_USER' }))).toBe('sk_USER');
  });

  it('NO system fallback: a system key present is ignored when the user has none', async () => {
    expect(await resolveApiKey(ctx(null))).toBe('');
  });

  it('empty string when the user has no key', async () => {
    expect(await resolveApiKey(ctx({}))).toBe('');
  });

  it('getUserSecrets rejection (no user secrets configured) → empty string (no throw)', async () => {
    const c = { getUserSecrets: async () => { throw new Error('no user secrets'); }, getSystemSecrets: async () => ({ apiKey: 'sk_SYSTEM' }) };
    expect(await resolveApiKey(c)).toBe('');
  });

  it('empty-string user key is treated as absent', async () => {
    expect(await resolveApiKey(ctx({ apiKey: '' }))).toBe('');
  });

  it('source attribution: user / none (system is never a source)', async () => {
    expect((await resolveApiKeyWithSource(ctx({ apiKey: 'sk_U' }))).source).toBe('user');
    expect((await resolveApiKeyWithSource(ctx(null))).source).toBe('none');
  });
});

describe('resolveAgentId — user-only (own account → own ConvAI agent)', () => {
  it('explicit agentId argument always wins', async () => {
    expect(await resolveAgentId(ctx({ AGENT_ID: 'agent_user' }), 'agent_explicit')).toBe('agent_explicit');
  });

  it('user AGENT_ID is used; no system fallback', async () => {
    expect(await resolveAgentId(ctx({ AGENT_ID: 'agent_user' }))).toBe('agent_user');
  });

  it('no user AGENT_ID → empty string (call sites surface the configure message)', async () => {
    expect(await resolveAgentId(ctx(null))).toBe('');
    expect(await resolveAgentId(ctx({}))).toBe('');
  });
});
