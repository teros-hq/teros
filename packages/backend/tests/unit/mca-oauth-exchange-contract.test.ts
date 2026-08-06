/**
 * MCA OAuth — contract-boundary del token endpoint (TER-464, follow-up de TER-443/#154).
 *
 * #154 cubrió `shouldRefreshOAuthToken`/`parseExpiryToMs` (CUÁNDO refrescar).
 * Aquí va el POST EXACTO al token endpoint: `exchangeCode` (authorization_code,
 * PKCE, Basic auth Notion/Figma) y `refreshToken` (refresh_token grant) — con
 * el bug del refresh arreglado en este PR.
 *
 * Mock fiel del boundary: `globalThis.fetch` (que es lo que `oauthHttpClient.
 * fetchRaw` → `executeWithRetry` acaba llamando), capturando method/url/headers
 * (`new Headers()`) y body (`new URLSearchParams()`) — patrón del repo.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { buildTokenRequest, McaOAuth } from '../../src/auth/mca-oauth';

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  method?: string;
  headers: Headers;
  body: URLSearchParams;
}

function mockFetch(response?: { status?: number; json?: any }): { value: Captured | null } {
  const captured: { value: Captured | null } = { value: null };
  globalThis.fetch = mock(async (url: any, init: any) => {
    captured.value = {
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: new URLSearchParams(init?.body),
    };
    return new Response(
      JSON.stringify(response?.json ?? { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      { status: response?.status ?? 200, headers: { 'content-type': 'application/json' } },
    );
  }) as any;
  return captured;
}

/** Instancia con dependencias mock mínimas (exchangeCode no usa `this`). */
function makeOAuth(opts?: {
  refreshToken?: string;
  catalogAuth?: any;
  secrets?: Record<string, string>;
}): { oauth: McaOAuth; merged: any[] } {
  const merged: any[] = [];
  const db = { collection: () => ({ createIndex: async () => {} }) } as any;
  const authManager = {
    get: async () => (opts?.refreshToken ? { REFRESH_TOKEN: opts.refreshToken } : {}),
    merge: async (...args: any[]) => merged.push(args),
    set: async () => {},
  } as any;
  const secretsManager = {
    mca: () => opts?.secrets ?? { CLIENT_ID: 'cid', CLIENT_SECRET: 'csecret' },
  } as any;
  const catalogCollection = {
    findOne: async () => (opts?.catalogAuth ? { auth: opts.catalogAuth } : null),
  } as any;
  return { oauth: new McaOAuth(db, authManager, secretsManager, catalogCollection), merged };
}

const TOKEN_URL = 'https://example.com/oauth/token';

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// buildTokenRequest — el helper puro que evita la divergencia exchange↔refresh
// ─────────────────────────────────────────────────────────────────────────────

describe('buildTokenRequest', () => {
  it('standard: creds in body, NO Authorization header', () => {
    const { headers, body } = buildTokenRequest(
      { grant_type: 'refresh_token', refresh_token: 'rt' },
      { clientId: 'cid', clientSecret: 'csec', useBasicAuth: false },
    );
    expect(headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('csec');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
  });

  it('basicAuth: Authorization: Basic base64(id:secret), creds OUT of the body', () => {
    const { headers, body } = buildTokenRequest(
      { grant_type: 'authorization_code', code: 'c' },
      { clientId: 'cid', clientSecret: 'csec', useBasicAuth: true },
    );
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:csec').toString('base64')}`);
    expect(body.get('client_id')).toBeNull();
    expect(body.get('client_secret')).toBeNull();
    expect(body.get('code')).toBe('c');
  });

  it('basicAuth + codeVerifier (PKCE): adds code_verifier to body, still no body creds', () => {
    const { headers, body } = buildTokenRequest(
      { grant_type: 'authorization_code', code: 'c' },
      { clientId: 'cid', clientSecret: 'csec', useBasicAuth: true, codeVerifier: 'verif_123' },
    );
    expect(headers.Authorization).toContain('Basic ');
    expect(body.get('code_verifier')).toBe('verif_123');
    expect(body.get('client_id')).toBeNull();
  });

  it('attaches code_verifier whenever provided, independent of auth method (PKCE public clients send it in the body)', () => {
    // PKCE PUBLIC clients (Plaud, no basicAuth) must STILL send code_verifier in the
    // body — it's a PKCE concern, orthogonal to how the client authenticates. The
    // caller passes a verifier ONLY on PKCE flows, so standard grants never carry one.
    const { body } = buildTokenRequest(
      { grant_type: 'authorization_code', code: 'c' },
      { clientId: 'cid', clientSecret: 'csec', useBasicAuth: false, codeVerifier: 'verif_123' },
    );
    expect(body.get('code_verifier')).toBe('verif_123');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exchangeCode (privado, vía `as any`) — POST del authorization_code grant
// ─────────────────────────────────────────────────────────────────────────────

describe('exchangeCode — token endpoint POST', () => {
  it('standard provider: POST with grant_type/code/redirect_uri + creds in body', async () => {
    const captured = mockFetch();
    const { oauth } = makeOAuth();

    const result = await (oauth as any).exchangeCode('the_code', {
      tokenUrl: TOKEN_URL,
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://app/cb',
    });

    expect(result).toEqual({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const c = captured.value!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(TOKEN_URL);
    expect(c.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(c.headers.get('accept')).toBe('application/json');
    expect(c.headers.get('authorization')).toBeNull();
    expect(c.body.get('grant_type')).toBe('authorization_code');
    expect(c.body.get('code')).toBe('the_code');
    expect(c.body.get('redirect_uri')).toBe('https://app/cb');
    expect(c.body.get('client_id')).toBe('cid');
    expect(c.body.get('client_secret')).toBe('csecret');
    expect(c.body.get('code_verifier')).toBeNull();
  });

  it('Basic-auth provider (Notion/Figma): Authorization: Basic, NO creds in body', async () => {
    const captured = mockFetch();
    const { oauth } = makeOAuth();

    await (oauth as any).exchangeCode('the_code', {
      tokenUrl: TOKEN_URL,
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://app/cb',
      useBasicAuth: true,
    });

    const c = captured.value!;
    expect(c.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(c.body.get('client_id')).toBeNull();
    expect(c.body.get('client_secret')).toBeNull();
    expect(c.body.get('grant_type')).toBe('authorization_code');
  });

  it('PKCE: code_verifier in body + Basic header when usePkce and a verifier are present', async () => {
    const captured = mockFetch();
    const { oauth } = makeOAuth();

    await (oauth as any).exchangeCode('the_code', {
      tokenUrl: TOKEN_URL,
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://app/cb',
      usePkce: true,
      codeVerifier: 'pkce_verifier_xyz',
    });

    const c = captured.value!;
    expect(c.body.get('code_verifier')).toBe('pkce_verifier_xyz');
    expect(c.headers.get('authorization')).toContain('Basic ');
    expect(c.body.get('client_id')).toBeNull();
  });

  it('PKCE PUBLIC client (Plaud: usePkce, NO client_secret) → client_id + code_verifier in body, NO Basic', async () => {
    // Plaud has no client_secret (public client): authenticates with client_id in the
    // body + the PKCE verifier, NEVER Basic. (The verifier was previously only sent in
    // the basicAuth branch, so Plaud never sent it → "code_verifier required". Fixed.)
    const captured = mockFetch();
    const { oauth } = makeOAuth();

    await (oauth as any).exchangeCode('the_code', {
      tokenUrl: TOKEN_URL,
      clientId: 'cid',
      redirectUri: 'https://app/cb',
      usePkce: true,
      codeVerifier: 'plaud_verifier',
      // no clientSecret → public client
    });

    const c = captured.value!;
    expect(c.headers.get('authorization')).toBeNull(); // NOT Basic
    expect(c.body.get('client_id')).toBe('cid'); // client_id in the body
    expect(c.body.get('code_verifier')).toBe('plaud_verifier'); // verifier in the body
  });

  it('PKCE CONFIDENTIAL client (Canva: usePkce + client_secret) → Basic Auth + code_verifier, NO body creds (TER-464)', async () => {
    // Canva HAS a client_secret (confidential): MUST use Basic Auth (not body creds)
    // even though it's PKCE — TER-464. The verifier still rides in the body. Without
    // this, Canva's exchange/refresh regress to body creds → token endpoint rejects.
    const captured = mockFetch();
    const { oauth } = makeOAuth();

    await (oauth as any).exchangeCode('the_code', {
      tokenUrl: TOKEN_URL,
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://app/cb',
      usePkce: true,
      codeVerifier: 'canva_verifier',
    });

    const c = captured.value!;
    expect(c.headers.get('authorization')).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(c.body.get('client_id')).toBeNull(); // creds NOT in body
    expect(c.body.get('client_secret')).toBeNull();
    expect(c.body.get('code_verifier')).toBe('canva_verifier');
  });

  it('rejects when the endpoint returns !ok (HttpClient throws before exchangeCode sees the body)', async () => {
    // NOTA boundary: oauthHttpClient.fetchRaw LANZA HttpClientError en !ok, así
    // que el `if (!response.ok) throw "Token exchange failed"` de exchangeCode
    // es una rama MUERTA (inalcanzable). El error que sale es el del HttpClient
    // — incluye status y body upstream. Anotado en el PR.
    mockFetch({ status: 400, json: { error: 'invalid_grant' } });
    const { oauth } = makeOAuth();
    await expect(
      (oauth as any).exchangeCode('bad', {
        tokenUrl: TOKEN_URL,
        clientId: 'cid',
        clientSecret: 'csecret',
        redirectUri: 'https://app/cb',
      }),
    ).rejects.toThrow('400');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// refreshToken — regression del bug Basic-auth (TER-464)
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshToken — client auth method matches the provider', () => {
  it('standard provider: refresh_token grant with creds in body', async () => {
    const captured = mockFetch();
    const { oauth, merged } = makeOAuth({
      refreshToken: 'old_rt',
      catalogAuth: { provider: 'custom', tokenUrl: TOKEN_URL },
    });

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.x');

    expect(res).toEqual({ success: true });
    const c = captured.value!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(TOKEN_URL);
    expect(c.headers.get('authorization')).toBeNull();
    expect(c.body.get('grant_type')).toBe('refresh_token');
    expect(c.body.get('refresh_token')).toBe('old_rt');
    expect(c.body.get('client_id')).toBe('cid');
    expect(c.body.get('client_secret')).toBe('csecret');
    // El merge persiste los tokens nuevos.
    expect(merged.length).toBe(1);
  });

  it('REGRESSION (TER-464): Notion (basicAuth) refresh uses Basic header, NOT body creds', async () => {
    const captured = mockFetch();
    const { oauth } = makeOAuth({
      refreshToken: 'old_rt',
      catalogAuth: { provider: 'notion', tokenUrl: TOKEN_URL },
    });

    await oauth.refreshToken('user_1', 'app_1', 'mca.notion');

    const c = captured.value!;
    expect(c.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(c.body.get('client_id')).toBeNull();
    expect(c.body.get('client_secret')).toBeNull();
    expect(c.body.get('grant_type')).toBe('refresh_token');
    expect(c.body.get('refresh_token')).toBe('old_rt');
  });

  it('Figma (basicAuth) refresh also uses Basic header', async () => {
    const captured = mockFetch();
    const { oauth } = makeOAuth({
      refreshToken: 'old_rt',
      catalogAuth: { provider: 'figma', tokenUrl: TOKEN_URL },
    });

    await oauth.refreshToken('user_1', 'app_1', 'mca.figma');

    expect(captured.value!.headers.get('authorization')).toContain('Basic ');
    expect(captured.value!.body.get('client_secret')).toBeNull();
  });

  it('REGRESSION (TER-464 gemelo): Canva (pkce, NOT basicAuth) refresh uses Basic header, NOT body creds', async () => {
    // Canva es un confidential client PKCE: NO está marcado `basicAuth` en
    // OAUTH_PROVIDERS, pero su token endpoint exige Basic igual que el exchange
    // (que ya usa Basic por la rama pkce). Derivar useBasicAuth solo del flag
    // basicAuth dejaba el refresh mandando creds en el body → Canva lo rechaza
    // → status:"expired" → reconexión manual cada vez que expira el token.
    const captured = mockFetch();
    const { oauth } = makeOAuth({
      refreshToken: 'old_rt',
      catalogAuth: { provider: 'canva', tokenUrl: TOKEN_URL, pkce: true },
    });

    await oauth.refreshToken('user_1', 'app_1', 'mca.canva');

    const c = captured.value!;
    expect(c.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(c.body.get('client_id')).toBeNull();
    expect(c.body.get('client_secret')).toBeNull();
    expect(c.body.get('grant_type')).toBe('refresh_token');
    expect(c.body.get('refresh_token')).toBe('old_rt');
  });

  it('PKCE PUBLIC client refresh (Plaud: pkce, NO client_secret) → client_id in body, NO Basic', async () => {
    // Symmetric to Canva above: a public PKCE client (no secret) refreshes with
    // client_id in the body, NEVER Basic. Guards Plaud's refresh against the
    // confidential→Basic rule (the discriminator is the secret, not pkce alone).
    const captured = mockFetch();
    const { oauth } = makeOAuth({
      refreshToken: 'old_rt',
      catalogAuth: { provider: 'plaud', tokenUrl: TOKEN_URL, pkce: true },
      secrets: { CLIENT_ID: 'cid' }, // public client — no CLIENT_SECRET
    });

    await oauth.refreshToken('user_1', 'app_1', 'mca.plaud');

    const c = captured.value!;
    expect(c.headers.get('authorization')).toBeNull(); // NOT Basic
    expect(c.body.get('client_id')).toBe('cid');
    expect(c.body.get('grant_type')).toBe('refresh_token');
    expect(c.body.get('refresh_token')).toBe('old_rt');
  });

  it('no refresh token → fails without hitting the network', async () => {
    const captured = mockFetch();
    const { oauth } = makeOAuth({ catalogAuth: { provider: 'custom', tokenUrl: TOKEN_URL } });

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.x');

    expect(res.success).toBe(false);
    expect(res.error).toBe('No refresh token available');
    expect(captured.value).toBeNull();
  });

  it('endpoint !ok → success:false (HttpClientError propagated through the catch)', async () => {
    // Igual que arriba: fetchRaw lanza en !ok, así que el `if (!response.ok)
    // return "Refresh failed"` es rama muerta; el HttpClientError cae al catch
    // y su message (con status + body) sale como res.error.
    mockFetch({ status: 401, json: { error: 'invalid_grant' } });
    const { oauth } = makeOAuth({
      refreshToken: 'old_rt',
      catalogAuth: { provider: 'custom', tokenUrl: TOKEN_URL },
    });

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.x');

    expect(res.success).toBe(false);
    expect(res.error).toContain('401');
  });
});
