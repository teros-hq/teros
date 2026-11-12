/**
 * Unit test — getAuthStatus hybrid apikey model (user-first + system fallback).
 *
 * Post-demo user-secrets migration (2026-10-26): an MCA that declares BOTH
 * systemSecrets and userSecrets with auth.type 'api-key' (e.g. mca.elevenlabs,
 * mca.twilio) must treat the system key as a VALID shared fallback:
 *
 *  - user without own key + system key present   → 'ready' (not needs_user_auth)
 *  - user with own key + system key missing      → 'ready' (user key replaces shared)
 *  - user without own key + system key missing   → 'needs_system_setup'
 *  - user with own key + system key present      → 'ready' (user key wins)
 *
 * The test instantiates McaOAuth directly with stubbed AuthManager and
 * SecretsManager — getAuthStatus touches no other collaborator. The Mongo
 * collection is a no-op stub (getAuthStatus never queries it).
 */

import { describe, expect, it } from 'bun:test'
import { McaOAuth } from '../../src/auth/mca-oauth'
import type { McpCatalogEntry } from '../../src/types/database'

/** Build a hybrid apikey catalog entry (system + user secrets), e.g. elevenlabs/twilio. */
function hybridMca(mcaId = 'mca.elevenlabs.test'): McpCatalogEntry {
  return {
    mcaId,
    name: 'Hybrid Test',
    description: '',
    execution: { command: 'bun', args: ['src/index.ts'] },
    availability: { enabled: true, multi: false, system: false, hidden: false, role: 'user' },
    systemSecrets: ['API_KEY'],
    userSecrets: ['API_KEY'],
    auth: { type: 'api-key', provider: 'elevenlabs' },
  } as unknown as McpCatalogEntry
}

/** User-only apikey MCA (e.g. hunter) — must keep the legacy behavior. */
function userOnlyMca(): McpCatalogEntry {
  return {
    mcaId: 'mca.hunter.test',
    name: 'User Only Test',
    description: '',
    execution: { command: 'bun', args: ['src/index.ts'] },
    availability: { enabled: true, multi: false, system: false, hidden: false, role: 'user' },
    systemSecrets: [],
    userSecrets: ['HUNTER_API_KEY'],
    auth: { type: 'api-key', provider: 'hunter' },
  } as unknown as McpCatalogEntry
}

/** OAuth2 MCA (system = client credentials, NOT a usable fallback). */
function oauth2Mca(): McpCatalogEntry {
  return {
    mcaId: 'mca.oauth2.test',
    name: 'OAuth2 Test',
    description: '',
    execution: { command: 'bun', args: ['src/index.ts'] },
    availability: { enabled: true, multi: false, system: false, hidden: false, role: 'user' },
    systemSecrets: ['CLIENT_ID', 'CLIENT_SECRET'],
    userSecrets: ['ACCESS_TOKEN', 'REFRESH_TOKEN'],
    auth: { type: 'oauth2', provider: 'google', authorizeUrl: 'https://example.com', tokenUrl: 'https://example.com', scopes: [] },
  } as unknown as McpCatalogEntry
}

function makeOAuth(opts: {
  systemSecretsRecord?: Record<string, string> | null
  userAuth?: Record<string, any> | null
}): McaOAuth {
  const authManager = {
    get: async (_userId: string, _appId: string) => opts.userAuth ?? null,
    set: async () => {},
    merge: async () => {},
    revoke: async () => {},
  }
  const secretsManager = {
    mca: (_mcaId: string) => opts.systemSecretsRecord ?? undefined,
  }
  const db = { collection: () => ({ findOne: async () => null, findOneAndDelete: async () => null, insertOne: async () => null }) }
  return new McaOAuth(db as any, authManager as any, secretsManager as any, db.collection() as any)
}

describe('getAuthStatus — hybrid apikey MCA (system + user secrets)', () => {
  it('user WITHOUT own key + system key PRESENT → ready (shared fallback works, not needs_user_auth)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: { API_KEY: 'shared-key' }, userAuth: null })
    const result = await oauth.getAuthStatus('user_1', 'app_1', hybridMca())
    expect(result.status).toBe('ready')
    expect(result.authType).toBe('apikey')
    // The optional-key form must still render in the UI
    expect(result.apikey?.configured).toBe(false)
    expect(result.apikey?.fields?.length).toBe(1)
    expect(result.apikey?.fields?.[0]?.name).toBe('API_KEY')
  })

  it('user WITH own key + system key PRESENT → ready, apikey.configured=true (user key wins)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: { API_KEY: 'shared-key' }, userAuth: { API_KEY: 'user-key' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', hybridMca())
    expect(result.status).toBe('ready')
    expect(result.authType).toBe('apikey')
    expect(result.apikey?.configured).toBe(true)
  })

  it('user WITH own key + system key MISSING → ready (user key fully replaces the shared key)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: { API_KEY: 'user-key' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', hybridMca())
    expect(result.status).toBe('ready')
    expect(result.authType).toBe('apikey')
    expect(result.apikey?.configured).toBe(true)
  })

  it('user WITHOUT own key + system key MISSING → needs_system_setup (nothing works)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: null })
    const result = await oauth.getAuthStatus('user_1', 'app_1', hybridMca())
    expect(result.status).toBe('needs_system_setup')
    // The self-serve form is still offered alongside the admin message
    expect(result.apikey?.fields?.length).toBe(1)
  })

  it('user with PARTIAL own key + system key MISSING → needs_system_setup (half a key set is not usable)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: { OTHER: 'x' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', hybridMca())
    expect(result.status).toBe('needs_system_setup')
  })

  it('multi-secret hybrid (twilio ACCOUNT_SID+AUTH_TOKEN): full user pair + missing system pair → ready', async () => {
    const mca = {
      ...hybridMca('mca.twilio.test'),
      systemSecrets: ['ACCOUNT_SID', 'AUTH_TOKEN'],
      userSecrets: ['ACCOUNT_SID', 'AUTH_TOKEN'],
    } as McpCatalogEntry
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: { ACCOUNT_SID: 'sid', AUTH_TOKEN: 'tok' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', mca)
    expect(result.status).toBe('ready')
    expect(result.apikey?.configured).toBe(true)
  })

  it('multi-secret hybrid: HALF user pair + system pair missing → needs_system_setup (never mix halves)', async () => {
    const mca = {
      ...hybridMca('mca.twilio.test'),
      systemSecrets: ['ACCOUNT_SID', 'AUTH_TOKEN'],
      userSecrets: ['ACCOUNT_SID', 'AUTH_TOKEN'],
    } as McpCatalogEntry
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: { ACCOUNT_SID: 'sid' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', mca)
    expect(result.status).toBe('needs_system_setup')
  })
})

describe('getAuthStatus — regression guards (existing MCA shapes unchanged)', () => {
  it('user-only apikey MCA (hunter) without user key → needs_user_auth (legacy behavior preserved)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: null })
    const result = await oauth.getAuthStatus('user_1', 'app_1', userOnlyMca())
    expect(result.status).toBe('needs_user_auth')
    expect(result.authType).toBe('apikey')
    expect(result.apikey?.configured).toBe(false)
  })

  it('user-only apikey MCA (hunter) with user key → ready', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: { HUNTER_API_KEY: 'k' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', userOnlyMca())
    expect(result.status).toBe('ready')
    expect(result.apikey?.configured).toBe(true)
  })

  it('oauth2 MCA with system client creds present + no user token → needs_user_auth (system creds are NOT a fallback)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: { CLIENT_ID: 'id', CLIENT_SECRET: 's' }, userAuth: null })
    const result = await oauth.getAuthStatus('user_1', 'app_1', oauth2Mca())
    expect(result.status).toBe('needs_user_auth')
    expect(result.authType).toBe('oauth2')
  })

  it('oauth2 MCA with system client creds MISSING → needs_system_setup', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: null })
    const result = await oauth.getAuthStatus('user_1', 'app_1', oauth2Mca())
    expect(result.status).toBe('needs_system_setup')
  })
})
