/**
 * Core OAuth token refresh — contract-boundary (TER-464).
 *
 * Refresh de los adapters OAuth core: ClaudeOAuth (Anthropic Max) y CodexOAuth
 * (ChatGPT). Cubre: buffer de 5 min (tokensNeedRefresh / codexTokensNeedRefresh),
 * el POST EXACTO del refresh_token grant, y el contrato de fallo "4xx/5xx/
 * excepción → null" (NO throw — el adapter cae al token stale).
 *
 * Mock fiel: globalThis.fetch (ambos usan `await fetch` directo) capturando
 * method/url/headers/body. ClaudeOAuth.refreshOAuthTokens persiste con
 * saveOAuthTokens(getTokenPath()) → SECRETS_PATH apuntado a un tmpdir para no
 * tocar credenciales reales.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  type ClaudeOAuthTokens,
  refreshOAuthTokens,
  tokensNeedRefresh,
} from './ClaudeOAuth';
import { codexTokensNeedRefresh, refreshCodexTokens } from './CodexOAuth';

const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const realFetch = globalThis.fetch;
const origSecretsPath = process.env.SECRETS_PATH;
let secretsDir: string;

beforeAll(() => {
  secretsDir = mkdtempSync(join(tmpdir(), 'ter464-secrets-'));
  process.env.SECRETS_PATH = secretsDir;
});
afterAll(() => {
  if (origSecretsPath === undefined) delete process.env.SECRETS_PATH;
  else process.env.SECRETS_PATH = origSecretsPath;
  rmSync(secretsDir, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  method?: string;
  headers: Headers;
  rawBody: string;
}

function mockFetch(response: { status?: number; json?: any } | (() => never)): { value: Captured | null } {
  const captured: { value: Captured | null } = { value: null };
  globalThis.fetch = mock(async (url: any, init: any) => {
    captured.value = {
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers),
      rawBody: typeof init?.body === 'string' ? init.body : '',
    };
    if (typeof response === 'function') response();
    return new Response(JSON.stringify(response.json ?? {}), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return captured;
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffer de 5 minutos
// ─────────────────────────────────────────────────────────────────────────────

describe('tokensNeedRefresh (Claude) — 5 min buffer', () => {
  const mk = (expiresAt: number): ClaudeOAuthTokens => ({
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt,
    tokenType: 'Bearer',
    createdAt: 0,
  });

  it('refresca si expira dentro del buffer de 5 min', () => {
    expect(tokensNeedRefresh(mk(Date.now() + 4 * 60 * 1000))).toBe(true);
  });
  it('NO refresca si expira más allá del buffer', () => {
    expect(tokensNeedRefresh(mk(Date.now() + 10 * 60 * 1000))).toBe(false);
  });
  it('refresca si ya expiró', () => {
    expect(tokensNeedRefresh(mk(Date.now() - 1000))).toBe(true);
  });
});

describe('codexTokensNeedRefresh — 5 min buffer', () => {
  it('refresca dentro del buffer / no refresca fuera / refresca si expiró', () => {
    expect(codexTokensNeedRefresh({ expiresAt: Date.now() + 4 * 60 * 1000 })).toBe(true);
    expect(codexTokensNeedRefresh({ expiresAt: Date.now() + 10 * 60 * 1000 })).toBe(false);
    expect(codexTokensNeedRefresh({ expiresAt: Date.now() - 1000 })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ClaudeOAuth.refreshOAuthTokens
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshOAuthTokens (Claude)', () => {
  it('POST exacto: JSON body con grant_type/refresh_token/client_id al token endpoint', async () => {
    const captured = mockFetch({ json: { access_token: 'new_at', refresh_token: 'new_rt', expires_in: 3600, token_type: 'Bearer' } });

    await refreshOAuthTokens('old_rt');

    const c = captured.value!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(CLAUDE_TOKEN_URL);
    expect(c.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(c.rawBody)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old_rt',
      client_id: CLAUDE_CLIENT_ID,
    });
  });

  it('success: devuelve tokens con expiresAt = now + expires_in*1000 y el nuevo refresh', async () => {
    mockFetch({ json: { access_token: 'new_at', refresh_token: 'new_rt', expires_in: 3600, token_type: 'Bearer' } });
    const before = Date.now();
    const tokens = await refreshOAuthTokens('old_rt');

    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe('new_at');
    expect(tokens!.refreshToken).toBe('new_rt');
    expect(tokens!.tokenType).toBe('Bearer');
    expect(tokens!.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens!.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it('preserva el refresh token viejo cuando la respuesta no trae uno nuevo', async () => {
    mockFetch({ json: { access_token: 'new_at', expires_in: 3600 } });
    const tokens = await refreshOAuthTokens('old_rt');
    expect(tokens!.refreshToken).toBe('old_rt');
    expect(tokens!.tokenType).toBe('Bearer'); // default cuando upstream no manda token_type
  });

  it('4xx → null (no throw)', async () => {
    mockFetch({ status: 400, json: { error: 'invalid_grant' } });
    expect(await refreshOAuthTokens('old_rt')).toBeNull();
  });

  it('5xx → null', async () => {
    mockFetch({ status: 503, json: { error: 'unavailable' } });
    expect(await refreshOAuthTokens('old_rt')).toBeNull();
  });

  it('excepción de red → null', async () => {
    mockFetch(() => {
      throw new Error('ECONNRESET');
    });
    expect(await refreshOAuthTokens('old_rt')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CodexOAuth.refreshCodexTokens
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshCodexTokens', () => {
  it('POST exacto: urlencoded con grant_type/refresh_token/client_id al issuer/oauth/token', async () => {
    const captured = mockFetch({ json: { access_token: 'new_at', refresh_token: 'new_rt', expires_in: 3600 } });

    await refreshCodexTokens('old_rt');

    const c = captured.value!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(CODEX_TOKEN_URL);
    expect(c.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(c.rawBody);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old_rt');
    expect(body.get('client_id')).toBe(CODEX_CLIENT_ID);
  });

  it('preserva el accountId actual cuando la respuesta no trae id_token', async () => {
    mockFetch({ json: { access_token: 'new_at', expires_in: 3600 } });
    const tokens = await refreshCodexTokens('old_rt', 'acct_existing');
    expect(tokens).not.toBeNull();
    expect(tokens!.accountId).toBe('acct_existing');
    expect(tokens!.refreshToken).toBe('old_rt'); // preservado
  });

  it('default de expires_in a 3600 cuando falta', async () => {
    const before = Date.now();
    mockFetch({ json: { access_token: 'new_at' } });
    const tokens = await refreshCodexTokens('old_rt');
    expect(tokens!.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens!.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it('4xx → null', async () => {
    mockFetch({ status: 401, json: { error: 'invalid_grant' } });
    expect(await refreshCodexTokens('old_rt')).toBeNull();
  });

  it('5xx → null', async () => {
    mockFetch({ status: 500 });
    expect(await refreshCodexTokens('old_rt')).toBeNull();
  });

  it('excepción de red → null', async () => {
    mockFetch(() => {
      throw new Error('ETIMEDOUT');
    });
    expect(await refreshCodexTokens('old_rt')).toBeNull();
  });
});
