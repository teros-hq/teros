/**
 * Google OAuth — contract-boundary (TER-464).
 *
 * exchangeCode (authorization_code grant, POST exacto a oauth2.googleapis.com)
 * y validateState (anti-replay: findOneAndDelete atómico + rechazo de states
 * expirados). El store fake modela el BORRADO real para ejercitar el replay.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { GoogleAuth } from '../../src/auth/google-auth';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CONFIG = {
  clientId: 'gcid.apps.googleusercontent.com',
  clientSecret: 'gsecret',
  redirectUri: 'https://app/google/cb',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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
    return new Response(JSON.stringify(response?.json ?? { access_token: 'at', expires_in: 3600 }), {
      status: response?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return captured;
}

/**
 * Store fake que modela findOneAndDelete: devuelve+borra atómicamente si el
 * state existe y no está expirado (`expiresAt > now`). Replays y expirados → null.
 */
function makeAuth(seedStates: Array<{ state: string; expiresAt: Date; userId?: string }> = []) {
  const states = new Map(seedStates.map((s) => [s.state, s]));
  const calls: any[] = [];
  const oauthStates = {
    createIndex: async () => {},
    insertOne: async (doc: any) => {
      states.set(doc.state, doc);
      return { insertedId: 'x' };
    },
    findOneAndDelete: async (filter: any) => {
      calls.push(filter);
      const found = states.get(filter.state);
      // Modela `expiresAt: { $gt: <date> }`: solo válido si no ha expirado.
      const gt = filter.expiresAt?.$gt as Date | undefined;
      if (!found) return null;
      if (gt && !(found.expiresAt > gt)) return null;
      states.delete(found.state); // atomic delete = anti-replay
      return found;
    },
  };
  const db = { collection: () => oauthStates } as any;
  return { auth: new GoogleAuth(db, CONFIG), calls, states };
}

// ─────────────────────────────────────────────────────────────────────────────
// exchangeCode
// ─────────────────────────────────────────────────────────────────────────────

describe('GoogleAuth.exchangeCode', () => {
  it('POST exacto: urlencoded con client creds + code + grant_type + redirect_uri', async () => {
    const captured = mockFetch({ json: { access_token: 'ya29.x', refresh_token: 'rt', expires_in: 3599 } });
    const { auth } = makeAuth();

    const res = await auth.exchangeCode('auth_code_xyz');

    expect(res).toEqual({ access_token: 'ya29.x', refresh_token: 'rt', expires_in: 3599 });
    const c = captured.value!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(GOOGLE_TOKEN_URL);
    expect(c.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(c.body.get('client_id')).toBe(CONFIG.clientId);
    expect(c.body.get('client_secret')).toBe(CONFIG.clientSecret);
    expect(c.body.get('code')).toBe('auth_code_xyz');
    expect(c.body.get('grant_type')).toBe('authorization_code');
    expect(c.body.get('redirect_uri')).toBe(CONFIG.redirectUri);
    // Google no usa Basic auth ni PKCE en este flujo.
    expect(c.headers.get('authorization')).toBeNull();
  });

  it('throws con el body upstream cuando el endpoint devuelve !ok', async () => {
    mockFetch({ status: 400, json: { error: 'invalid_grant' } });
    const { auth } = makeAuth();
    await expect(auth.exchangeCode('bad')).rejects.toThrow('Failed to exchange code');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateState — anti-replay
// ─────────────────────────────────────────────────────────────────────────────

describe('GoogleAuth.validateState — anti-replay', () => {
  it('devuelve el state válido y lo CONSUME (findOneAndDelete)', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const { auth, calls } = makeAuth([{ state: 'st_1', expiresAt: future, userId: 'u1' }]);

    const result = await auth.validateState('st_1');

    expect(result).not.toBeNull();
    expect((result as any).userId).toBe('u1');
    // La query exige no-expirado (expiresAt > now).
    expect(calls[0].state).toBe('st_1');
    expect(calls[0].expiresAt.$gt).toBeInstanceOf(Date);
  });

  it('REPLAY: un segundo validateState del mismo state → null (ya consumido)', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const { auth } = makeAuth([{ state: 'st_1', expiresAt: future }]);

    expect(await auth.validateState('st_1')).not.toBeNull();
    expect(await auth.validateState('st_1')).toBeNull(); // replay rechazado
  });

  it('state desconocido → null', async () => {
    const { auth } = makeAuth();
    expect(await auth.validateState('nope')).toBeNull();
  });

  it('state expirado → null (la condición expiresAt > now no se cumple)', async () => {
    const past = new Date(Date.now() - 1000);
    const { auth } = makeAuth([{ state: 'st_old', expiresAt: past }]);
    expect(await auth.validateState('st_old')).toBeNull();
  });
});
