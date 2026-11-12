/**
 * Unit test — getAuthStatus alternative system-secret groups (systemSecretsAny)
 * + userSecretsOptional:false complementary semantics.
 *
 * Task tn_Qcpm5ajAOTRuuHlE (2026-11-01): mca.teros.email works 100% in Lab
 * proxy mode (STALWART_LAB_* complete) but check-app-auth reported
 * needs_system_setup demanding the direct-mode secrets
 * (STALWART_BASE_URL/STALWART_ADMIN_TOKEN) — misleading state for a fully
 * operational app. Root cause: 'configured' was evaluated as ALL declared
 * systemSecrets present, with no notion of alternative combinations.
 *
 *  NOTE (2026-11-01, tn_OdJGzu8TgIEgpvq1): mca.teros.email moved to a single
 *  direct transport (STALWART_BASE_URL + STALWART_ADMIN_TOKEN) and dropped
 *  STALWART_LAB_*. The emailMca() fixture below keeps the HISTORICAL dual
 *  shape on purpose - systemSecretsAny remains a general backend feature and
 *  this is the regression test for multi-group evaluation.
 *
 * Semantics under test:
 *
 *  systemSecretsAny (groups):
 *   - lab group complete + direct group missing + common secret present
 *     → system configured (no needs_system_setup)
 *   - direct group complete + lab group missing → system configured
 *   - BOTH groups incomplete → needs_system_setup, message names the
 *     closest group's gaps (not the union of every mode)
 *   - common (non-grouped) secret missing → needs_system_setup even with a
 *     complete group
 *
 *  userSecretsOptional:false (complementary user secrets):
 *   - system configured + user secrets missing → needs_user_auth (NOT the
 *     fake 'ready' of the hybrid fallback — MAIL_ACCOUNT is the mailbox
 *     identity, not an override of the transport)
 *   - system configured + user secrets complete → ready
 *
 *  Regression guards:
 *   - flat systemSecrets (no groups) keeps the historic all-required logic
 *   - hybrid apikey (groups absent, userSecretsOptional absent) keeps the
 *     2026-10-26 fallback semantics
 *
 * Same harness as mca-oauth-hybrid-apikey-status.test.ts: McaOAuth
 * instantiated directly with stubbed AuthManager/SecretsManager.
 */

import { describe, expect, it } from 'bun:test'
import { McaOAuth } from '../../src/auth/mca-oauth'
import type { McpCatalogEntry } from '../../src/types/database'

/**
 * Build an mca.teros.email-shaped catalog entry: alternative transport
 * groups (lab proxy vs direct admin token) + a common master secret +
 * complementary user secrets (mailbox identity).
 */
function emailMca(): McpCatalogEntry {
  return {
    mcaId: 'mca.teros.email',
    name: 'Email',
    description: '',
    execution: { command: 'bun', args: ['src/index.ts'] },
    availability: { enabled: true, multi: true, system: true, hidden: true, role: 'user' },
    systemSecrets: [
      'STALWART_LAB_URL',
      'STALWART_LAB_USER',
      'STALWART_LAB_PASS',
      'STALWART_MASTER_SECRET',
      'STALWART_BASE_URL',
      'STALWART_ADMIN_TOKEN',
    ],
    systemSecretsAny: [
      ['STALWART_LAB_URL', 'STALWART_LAB_USER', 'STALWART_LAB_PASS'],
      ['STALWART_BASE_URL', 'STALWART_ADMIN_TOKEN'],
    ],
    userSecrets: ['MAIL_ACCOUNT', 'MAIL_PASSWORD', 'MAIL_FROM_NAME'],
    userSecretsOptional: false,
    userSecretsRequired: ['MAIL_ACCOUNT'],
    auth: { type: 'api-key' },
  } as unknown as McpCatalogEntry
}

/** Flat api-key MCA (no groups) — historic all-required semantics. */
function flatMca(): McpCatalogEntry {
  return {
    mcaId: 'mca.flat.test',
    name: 'Flat Test',
    description: '',
    execution: { command: 'bun', args: ['src/index.ts'] },
    availability: { enabled: true, multi: false, system: false, hidden: false, role: 'user' },
    systemSecrets: ['API_KEY'],
    userSecrets: ['API_KEY'],
    auth: { type: 'api-key' },
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

const LAB_SECRETS = {
  STALWART_LAB_URL: 'https://lab.example',
  STALWART_LAB_USER: 'lab-user',
  STALWART_LAB_PASS: 'lab-pass',
  STALWART_MASTER_SECRET: 'master',
}

const DIRECT_SECRETS = {
  STALWART_BASE_URL: 'https://stalwart.example',
  STALWART_ADMIN_TOKEN: 'tok',
  STALWART_MASTER_SECRET: 'master',
}

const MAILBOX = { MAIL_ACCOUNT: 'nira@agents.teros.ai', MAIL_PASSWORD: 'pw' }

describe('getAuthStatus — systemSecretsAny (alternative transport groups)', () => {
  it('LAB group complete + direct missing + user mailbox → ready (the reported bug: was needs_system_setup)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: LAB_SECRETS, userAuth: MAILBOX })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('ready')
    expect(result.authType).toBe('apikey')
    expect(result.apikey?.configured).toBe(true)
  })

  it('DIRECT group complete + lab missing + user mailbox → ready (either mode is operational)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: DIRECT_SECRETS, userAuth: MAILBOX })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('ready')
  })

  it('LAB complete but COMMON secret (STALWART_MASTER_SECRET) missing → needs_system_setup', async () => {
    const oauth = makeOAuth({
      systemSecretsRecord: { ...LAB_SECRETS, STALWART_MASTER_SECRET: undefined },
      userAuth: MAILBOX,
    })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('needs_system_setup')
    expect(result.message).toContain('STALWART_MASTER_SECRET')
  })

  it('BOTH groups incomplete → needs_system_setup, message names the closest group gaps (not the union)', async () => {
    const oauth = makeOAuth({
      systemSecretsRecord: {
        STALWART_LAB_URL: 'https://lab.example',
        STALWART_MASTER_SECRET: 'master',
        STALWART_BASE_URL: 'https://stalwart.example',
      },
        userAuth: MAILBOX,
    })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('needs_system_setup')
    // Closest group is direct (1 missing: ADMIN_TOKEN) vs lab (2 missing)
    expect(result.message).toContain('STALWART_ADMIN_TOKEN')
    expect(result.message).not.toContain('STALWART_LAB_USER')
  })

  it('half a group is NOT operational: LAB_URL+LAB_USER only → needs_system_setup', async () => {
    const oauth = makeOAuth({
      systemSecretsRecord: {
        STALWART_LAB_URL: 'https://lab.example',
        STALWART_LAB_USER: 'lab-user',
        STALWART_MASTER_SECRET: 'master',
      },
      userAuth: MAILBOX,
    })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('needs_system_setup')
  })
})

describe('getAuthStatus — userSecretsOptional:false (complementary user secrets)', () => {
  it('system configured + NO user secrets → needs_user_auth (mailbox identity is mandatory, not a fallback)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: LAB_SECRETS, userAuth: null })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('needs_user_auth')
    expect(result.authType).toBe('apikey')
  })

  it('system configured + PARTIAL user secrets (no MAIL_ACCOUNT) → needs_user_auth', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: LAB_SECRETS, userAuth: { MAIL_FROM_NAME: 'Nira' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('needs_user_auth')
    expect(result.message).toContain('MAIL_ACCOUNT')
  })

  it('system configured + MAIL_ACCOUNT only (password derives from master secret) → ready — optional overrides absent is fine', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: LAB_SECRETS, userAuth: { MAIL_ACCOUNT: 'nira@agents.teros.ai' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('ready')
    expect(result.apikey?.configured).toBe(true)
  })

  it('system NOT configured + complete user secrets → still needs_system_setup (user secrets cannot replace the transport)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: MAILBOX })
    const result = await oauth.getAuthStatus('user_1', 'app_1', emailMca())
    expect(result.status).toBe('needs_system_setup')
  })
})

describe('getAuthStatus — regression guards (flat MCAs unchanged)', () => {
  it('flat api-key MCA: system key present + no user key → ready (hybrid fallback preserved)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: { API_KEY: 'shared' }, userAuth: null })
    const result = await oauth.getAuthStatus('user_1', 'app_1', flatMca())
    expect(result.status).toBe('ready')
    expect(result.apikey?.configured).toBe(false)
  })

  it('flat api-key MCA: system key missing + complete user key → ready (user replaces shared)', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: { API_KEY: 'own' } })
    const result = await oauth.getAuthStatus('user_1', 'app_1', flatMca())
    expect(result.status).toBe('ready')
    expect(result.apikey?.configured).toBe(true)
  })

  it('flat api-key MCA: nothing configured → needs_system_setup', async () => {
    const oauth = makeOAuth({ systemSecretsRecord: null, userAuth: null })
    const result = await oauth.getAuthStatus('user_1', 'app_1', flatMca())
    expect(result.status).toBe('needs_system_setup')
  })
})
