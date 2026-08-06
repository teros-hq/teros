/**
 * MCA OAuth — persistencia de los scopes CONCEDIDos (handleCallback).
 *
 * Para apps multi-portal (HubSpot) los optional scopes que la cuenta no tiene se
 * descartan silenciosamente, así que el set concedido varía por portal. HubSpot
 * devuelve el `scope` realmente concedido en el token response; lo persistimos
 * como GRANTED_SCOPES para diagnóstico (qué autorizó cada portal) y para que la
 * UI pueda mostrarlo. Este test fija el contrato: el campo `scope` del token →
 * credentials.GRANTED_SCOPES, y se omite si el provider no lo devuelve.
 *
 * Mock fiel del boundary: globalThis.fetch (lo que oauthHttpClient.fetchRaw
 * acaba llamando) — mismo patrón que mca-oauth-exchange-contract.test.ts.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { McaOAuth } from '../../src/auth/mca-oauth';

const realFetch = globalThis.fetch;
const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

function mockTokenResponse(json: Record<string, unknown>) {
  globalThis.fetch = mock(async () => {
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
}

interface SetCall {
  userId: string;
  appId: string;
  mcaId: string;
  creds: Record<string, string | undefined>;
}

/**
 * McaOAuth wired for handleCallback: the states collection resolves the state
 * doc (consumeState), the catalog resolves an oauth2 MCA, and authManager.set
 * captures exactly what gets persisted.
 */
function makeOAuth(opts: { provider: string; catalogAuth: any }): {
  oauth: McaOAuth;
  setCalls: SetCall[];
} {
  const setCalls: SetCall[] = [];
  const statesCollection = {
    createIndex: async () => {},
    findOneAndDelete: async () => ({
      state: 's',
      appId: 'app_1',
      userId: 'user_1',
      mcaId: 'mca.hubspot',
      provider: opts.provider,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    }),
  };
  const db = { collection: () => statesCollection } as any;
  const authManager = {
    get: async () => ({}),
    merge: async () => {},
    set: async (userId: string, appId: string, mcaId: string, creds: any) => {
      setCalls.push({ userId, appId, mcaId, creds });
    },
  } as any;
  const secretsManager = { mca: () => ({ CLIENT_ID: 'cid', CLIENT_SECRET: 'csec' }) } as any;
  const catalogCollection = {
    findOne: async () => ({ mcaId: 'mca.hubspot', auth: opts.catalogAuth }),
  } as any;
  return { oauth: new McaOAuth(db, authManager, secretsManager, catalogCollection), setCalls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('handleCallback persists granted scopes', () => {
  it('persists GRANTED_SCOPES from HubSpot `scopes` ARRAY (joined to a string)', async () => {
    // HubSpot's REAL token response shape: `scopes` is an array, NOT `scope` string.
    const scopes = ['oauth', 'crm.objects.contacts.read', 'crm.objects.contacts.write', 'tickets'];
    mockTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 1800, scopes });
    const { oauth, setCalls } = makeOAuth({
      provider: 'hubspot',
      catalogAuth: { type: 'oauth2', provider: 'hubspot', tokenUrl: TOKEN_URL },
    });

    const res = await oauth.handleCallback('the_code', 's', 'https://app/cb');

    expect(res.success).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].creds.GRANTED_SCOPES).toBe(
      'oauth crm.objects.contacts.read crm.objects.contacts.write tickets',
    );
    expect(setCalls[0].creds.ACCESS_TOKEN).toBe('at');
    expect(setCalls[0].creds.REFRESH_TOKEN).toBe('rt');
  });

  it('persists GRANTED_SCOPES from a standard OAuth2 `scope` STRING (e.g. Google)', async () => {
    mockTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 1800, scope: 'a b c' });
    const { oauth, setCalls } = makeOAuth({
      provider: 'google',
      catalogAuth: { type: 'oauth2', provider: 'google', tokenUrl: TOKEN_URL },
    });

    await oauth.handleCallback('the_code', 's', 'https://app/cb');

    expect(setCalls[0].creds.GRANTED_SCOPES).toBe('a b c');
  });

  it('omits GRANTED_SCOPES when neither `scope` nor `scopes` is present', async () => {
    mockTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 1800 });
    const { oauth, setCalls } = makeOAuth({
      provider: 'hubspot',
      catalogAuth: { type: 'oauth2', provider: 'hubspot', tokenUrl: TOKEN_URL },
    });

    await oauth.handleCallback('the_code', 's', 'https://app/cb');

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].creds.GRANTED_SCOPES).toBeUndefined();
  });

  it('omits GRANTED_SCOPES when `scopes` is an empty array', async () => {
    mockTokenResponse({ access_token: 'at', expires_in: 1800, scopes: [] });
    const { oauth, setCalls } = makeOAuth({
      provider: 'hubspot',
      catalogAuth: { type: 'oauth2', provider: 'hubspot', tokenUrl: TOKEN_URL },
    });

    await oauth.handleCallback('the_code', 's', 'https://app/cb');

    expect(setCalls[0].creds.GRANTED_SCOPES).toBeUndefined();
  });

  it('omits GRANTED_SCOPES when `scope` is an empty string', async () => {
    mockTokenResponse({ access_token: 'at', expires_in: 1800, scope: '' });
    const { oauth, setCalls } = makeOAuth({
      provider: 'google',
      catalogAuth: { type: 'oauth2', provider: 'google', tokenUrl: TOKEN_URL },
    });

    await oauth.handleCallback('the_code', 's', 'https://app/cb');

    expect(setCalls[0].creds.GRANTED_SCOPES).toBeUndefined();
  });
});
