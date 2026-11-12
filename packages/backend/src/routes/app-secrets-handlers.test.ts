/**
 * app-secrets-handlers test — set/get user secrets via the MCA resource route
 * (docs/specs/20261031_agent-secret-tools.md, designs B + C).
 *
 * Real MongoDB (pattern of redaction-integration.test.ts — unique db, dropped,
 * skips if Mongo down). McaOAuth is faked: its AuthManager write path is the
 * panel's own and is covered elsewhere; what matters HERE is the route
 * contract — validation, scope rejection, mask-only reads, audit without the
 * value, and the post-write sweep riding on the same confirmation.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import type { ServerResponse } from 'node:http'
import { handleAppCopyAuth, handleAppGetSecret, handleAppSetSecret } from './mca-resources-handlers'
import type { ResourceContext } from './mca-resources-handlers'
import type { McaOAuth } from '../services/mca-oauth'
import type { AuthManager } from '../auth/auth-manager'
import { ChannelManager } from '../services/channel-manager'
import { RandomIdGenerator } from '@teros/core'
import type { ProviderService } from '../services/provider-service'

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017'
const DB_NAME = `teros_test_appsecrets_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const SECRET = 'sk_live_51AbCdEfGhIjKlMn4f2a'
const SECRET_MASK = 'sk_live_…4f2a'

// Minimal ServerResponse capture — sendJson writes status + JSON body.
function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0
  let json: any = undefined
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: string) => {
      if (chunk) {
        try { json = JSON.parse(chunk) } catch { json = chunk }
      }
    },
    write: () => {},
    writeHead: (code: number) => { statusCode = code },
  } as unknown as ServerResponse
  // sendJson uses res.statusCode assignment + end(JSON.stringify(...))
  const proxy = new Proxy(res, {
    set(target, prop, value) {
      if (prop === 'statusCode') statusCode = value
      ;(target as any)[prop] = value
      return true
    },
    get(target, prop) {
      if (prop === 'statusCode') return statusCode
      return (target as any)[prop]
    },
  }) as ServerResponse
  return { res: proxy, status: () => statusCode, body: () => json }
}

describe('app-secrets-handlers: set/get user secrets', () => {
  let mongoClient: MongoClient
  let db: Db
  let available = false

  const workspaceId = 'work_test_secrets'
  const workspaceId2 = 'work_test_secrets_2'
  const ownerUserId = 'user_owner_secrets'
  const strangerUserId = 'user_stranger_secrets'
  const appId = 'app_make_test'
  const targetAppId = 'app_make_target'
  const crossMcaAppId = 'app_holded_target'
  const channelId = 'ch_test_secrets_' + Date.now()

  // In-memory credential store standing in for AuthManager
  const credStore = new Map<string, Record<string, string>>()
  const fakeMcaOAuth = {
    saveApiKeyCredentials: async (userId: string, _appId: string, _mcaId: string, creds: Record<string, string>) => {
      credStore.set(userId, { ...(credStore.get(userId) ?? {}), ...creds })
    },
    getCredentials: async (userId: string, _appId: string) => credStore.get(userId),
    getAuthStatus: async () => ({ status: 'connected', authType: 'api-key', message: 'ok' }),
  } as unknown as McaOAuth

  const ctx = (userId: string): ResourceContext => ({
    userId,
    channelId,
    appId,
    mcaManager: null,
  })

  beforeAll(async () => {
    try {
      mongoClient = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
      db = mongoClient.db(DB_NAME)
      available = true
    } catch {
      console.warn('[app-secrets test] Mongo unreachable — skipping')
      return
    }

    // Workspace + owner membership (canAccessApp → canAccessWorkspace)
    await db.collection('workspaces').insertOne({ workspaceId, ownerId: ownerUserId, status: 'active' })
    await db.collection('workspace_members').insertOne({ workspaceId, userId: ownerUserId, status: 'active' })

    // Workspace-owned app backed by an api-key MCA (mca.make shape)
    await db.collection('apps').insertOne({
      appId,
      workspaceId,
      ownerType: 'workspace',
      ownerId: workspaceId,
      mcaId: 'mca.make',
      name: 'Make (test)',
    })
    await db.collection('mca_catalog').insertOne({
      mcaId: 'mca.make',
      auth: { type: 'api-key', userSecrets: ['MAKE_API_TOKEN', 'MAKE_REGION'] },
    })

    // ── copy-app-auth fixtures (tn_aGVdSrVwIJi9mfvc) ────────────────────────
    // Second workspace, same owner — the cross-workspace target lives there.
    await db.collection('workspaces').insertOne({ workspaceId: workspaceId2, ownerId: ownerUserId, status: 'active' })
    await db.collection('workspace_members').insertOne({ workspaceId: workspaceId2, userId: ownerUserId, status: 'active' })
    // Same-MCA target instance in the second workspace
    await db.collection('apps').insertOne({
      appId: targetAppId,
      workspaceId: workspaceId2,
      ownerType: 'workspace',
      ownerId: workspaceId2,
      mcaId: 'mca.make',
      name: 'Make (other workspace)',
    })
    // Cross-MCA instance (mca.holded shape) — must be blocked
    await db.collection('apps').insertOne({
      appId: crossMcaAppId,
      workspaceId: workspaceId2,
      ownerType: 'workspace',
      ownerId: workspaceId2,
      mcaId: 'mca.teros.holded',
      name: 'Holded (other workspace)',
    })
    await db.collection('mca_catalog').insertOne({
      mcaId: 'mca.teros.holded',
      auth: { type: 'api-key', userSecrets: ['HOLDED_API_KEY'] },
    })

    // A channel with one message carrying the secret (for the post-write sweep)
    await db.collection('sessions').insertOne({
      id: channelId,
      userId: ownerUserId,
      time: { created: Date.now(), updated: Date.now() },
    })
    await db.collection('channel_messages').insertOne({
      messageId: 'msg_secret_' + Date.now(),
      channelId,
      role: 'user',
      content: { type: 'text', text: `mi token de Make es ${SECRET}` },
      timestamp: new Date().toISOString(),
    })
  })

  afterAll(async () => {
    if (available) {
      await db.dropDatabase().catch(() => {})
      await mongoClient.close().catch(() => {})
    }
  })

  test('set: happy path — writes via panel path, returns mask + auth + sweep, never the value', async () => {
    if (!available) return
    const { res, status, body } = makeRes()
    const channelManager = new ChannelManager(db, {} as ProviderService, new RandomIdGenerator())

    await handleAppSetSecret(
      res, ctx(ownerUserId), db, appId,
      { key: 'MAKE_API_TOKEN', value: SECRET },
      fakeMcaOAuth, channelManager, 'agent_nira',
    )

    expect(status()).toBe(200)
    const b = body()
    expect(b.success).toBe(true)
    expect(b.key).toBe('MAKE_API_TOKEN')
    expect(b.maskedValue).toBe(SECRET_MASK)
    expect(b.scope).toBe('user')
    // Auth read-back so the agent can verify the connection (AC 1)
    expect(b.auth.status).toBe('connected')
    // Post-write sweep redacted the message that contained the value
    expect(b.redaction.swept).toBe(true)
    expect(b.redaction.redactedCount).toBeGreaterThanOrEqual(1)
    // The response NEVER carries the plaintext (AC 6)
    expect(JSON.stringify(b)).not.toContain(SECRET)

    // Credential actually written through the fake AuthManager path
    expect(credStore.get(ownerUserId)?.MAKE_API_TOKEN).toBe(SECRET)

    // The message got redacted in channel_messages
    const swept = await db.collection('channel_messages').findOne({ channelId })
    expect(swept?.redacted).toBe(true)
  })

  test('set: rejects scope app — agents never write MCA system secrets', async () => {
    if (!available) return
    const { res, status, body } = makeRes()

    await handleAppSetSecret(
      res, ctx(ownerUserId), db, appId,
      { key: 'MAKE_API_TOKEN', value: SECRET, scope: 'app' },
      fakeMcaOAuth, undefined, 'agent_nira',
    )

    expect(status()).toBe(403)
    expect(body().error).toMatch(/admin-only/i)
  })

  test('set: rejects undeclared keys and lists allowedKeys', async () => {
    if (!available) return
    const { res, status, body } = makeRes()

    await handleAppSetSecret(
      res, ctx(ownerUserId), db, appId,
      { key: 'EVIL_KEY', value: SECRET },
      fakeMcaOAuth, undefined, 'agent_nira',
    )

    expect(status()).toBe(400)
    expect(body().error).toMatch(/not a declared secret/i)
    expect(body().allowedKeys).toContain('MAKE_API_TOKEN')
    expect(body().allowedKeys).toContain('MAKE_REGION')
  })

  test('set: rejects missing key/value and bad scope', async () => {
    if (!available) return

    const r1 = makeRes()
    await handleAppSetSecret(r1.res, ctx(ownerUserId), db, appId, {}, fakeMcaOAuth, undefined)
    expect(r1.status()).toBe(400)

    const r2 = makeRes()
    await handleAppSetSecret(
      r2.res, ctx(ownerUserId), db, appId,
      { key: 'MAKE_API_TOKEN' }, // no value
      fakeMcaOAuth, undefined,
    )
    expect(r2.status()).toBe(400)

    const r3 = makeRes()
    await handleAppSetSecret(
      r3.res, ctx(ownerUserId), db, appId,
      { key: 'MAKE_API_TOKEN', value: SECRET, scope: 'bogus' as any },
      fakeMcaOAuth, undefined,
    )
    expect(r3.status()).toBe(400)
  })

  test('set: 403 for a user outside the workspace', async () => {
    if (!available) return
    const { res, status } = makeRes()

    await handleAppSetSecret(
      res, ctx(strangerUserId), db, appId,
      { key: 'MAKE_API_TOKEN', value: SECRET },
      fakeMcaOAuth, undefined,
    )

    expect(status()).toBe(403)
  })

  test('get: returns configured + maskedValue only — never the stored value', async () => {
    if (!available) return
    const { res, status, body } = makeRes()

    await handleAppGetSecret(res, ctx(ownerUserId), db, appId, { key: 'MAKE_API_TOKEN' }, fakeMcaOAuth)

    expect(status()).toBe(200)
    const b = body()
    expect(b.configured).toBe(true)
    expect(b.maskedValue).toBe(SECRET_MASK)
    expect(JSON.stringify(b)).not.toContain(SECRET)
    expect(b.note).toMatch(/masked preview/i)
  })

  test('get: configured=false for a key with no stored value', async () => {
    if (!available) return
    const { res, status, body } = makeRes()

    await handleAppGetSecret(res, ctx(ownerUserId), db, appId, { key: 'MAKE_REGION' }, fakeMcaOAuth)

    expect(status()).toBe(200)
    expect(body().configured).toBe(false)
  })

  test('get: rejects undeclared key and missing key', async () => {
    if (!available) return

    const r1 = makeRes()
    await handleAppGetSecret(r1.res, ctx(ownerUserId), db, appId, { key: 'NOPE' }, fakeMcaOAuth)
    expect(r1.status()).toBe(400)
    expect(r1.body().allowedKeys).toContain('MAKE_API_TOKEN')

    const r2 = makeRes()
    await handleAppGetSecret(r2.res, ctx(ownerUserId), db, appId, {}, fakeMcaOAuth)
    expect(r2.status()).toBe(400)
  })

  test('get: 403 for a user outside the workspace', async () => {
    if (!available) return
    const { res, status } = makeRes()

    await handleAppGetSecret(res, ctx(strangerUserId), db, appId, { key: 'MAKE_API_TOKEN' }, fakeMcaOAuth)

    expect(status()).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// copy-app-auth (tn_aGVdSrVwIJi9mfvc) — the 5th credential tool.
// Same real-Mongo pattern as above; AuthManager is faked with the REAL method
// shapes (get/set/getCredentialDoc) so the route contract is exercised:
// cross-workspace copy OK, cross-MCA blocked, no-source blocked, revoked
// blocked, cross-user blocked, masked-only response, full-replace semantics.
// ─────────────────────────────────────────────────────────────────────────────
describe('app-secrets-handlers: copy-app-auth', () => {
  let mongoClient: MongoClient
  let db: Db
  let available = false

  const workspaceId = 'work_copyauth'
  const workspaceId2 = 'work_copyauth_2'
  const ownerUserId = 'user_owner_copyauth'
  const strangerUserId = 'user_stranger_copyauth'
  const sourceAppId = 'app_make_src'
  const targetAppId = 'app_make_dst'
  const crossMcaAppId = 'app_holded_dst'
  const unconnectedAppId = 'app_make_unconnected'
  const channelId = 'ch_test_copyauth_' + Date.now()

  const SECRET = 'sk_live_CopyAuth_77aabbccddee'
  const SECRET_MASK = 'sk_live_…ddee'

  // Fake AuthManager with the real method shapes. Records the (userId, appId)
  // scope each write used, so the test proves the re-encryption path: the
  // source blob is READ under the source appId and WRITTEN under the target.
  const credDocs = new Map<string, { data: Record<string, string>; revokedAt?: Date }>()
  const writeScopes: Array<{ userId: string; appId: string; mcaId: string }> = []
  const fakeAuthManager = {
    async get(userId: string, appId: string) {
      const doc = credDocs.get(`${userId}:${appId}`)
      if (!doc || doc.revokedAt) return undefined
      return { ...doc.data }
    },
    async set(userId: string, appId: string, mcaId: string, data: any) {
      writeScopes.push({ userId, appId, mcaId })
      credDocs.set(`${userId}:${appId}`, { data: { ...(data as Record<string, string>) } })
    },
    async getCredentialDoc(userId: string, appId: string) {
      const doc = credDocs.get(`${userId}:${appId}`)
      if (!doc) return null
      return { userId, appId, mcaId: 'mca.make', revokedAt: doc.revokedAt, data: doc.data }
    },
    async merge(userId: string, appId: string, mcaId: string, patch: Record<string, any>) {
      const existing = (await fakeAuthManager.get(userId, appId)) ?? {}
      await fakeAuthManager.set(userId, appId, mcaId, { ...existing, ...patch })
    },
    async revoke(userId: string, appId: string) {
      const doc = credDocs.get(`${userId}:${appId}`)
      if (doc) doc.revokedAt = new Date()
    },
  } as unknown as AuthManager

  const fakeMcaOAuth = {
    getAuthStatus: async () => ({ status: 'ready', authType: 'api-key', message: 'ok' }),
  } as unknown as McaOAuth

  const ctx = (userId: string): ResourceContext => ({
    userId,
    channelId,
    appId: sourceAppId,
    mcaManager: null,
  })

  beforeAll(async () => {
    try {
      mongoClient = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
      db = mongoClient.db(DB_NAME)
      available = true
    } catch {
      console.warn('[copy-auth test] Mongo unreachable — skipping')
      return
    }

    // Two workspaces owned by the same user; the stranger has access to NEITHER.
    for (const ws of [workspaceId, workspaceId2]) {
      await db.collection('workspaces').insertOne({ workspaceId: ws, ownerId: ownerUserId, status: 'active' })
      await db.collection('workspace_members').insertOne({ workspaceId: ws, userId: ownerUserId, status: 'active' })
    }

    // Source instance (workspace 1) and same-MCA target (workspace 2) — the
    // cross-workspace pair. Plus a cross-MCA instance that must be rejected.
    await db.collection('apps').insertOne({
      appId: sourceAppId, workspaceId, ownerType: 'workspace', ownerId: workspaceId, mcaId: 'mca.make', name: 'Make (src)',
    })
    await db.collection('apps').insertOne({
      appId: targetAppId, workspaceId: workspaceId2, ownerType: 'workspace', ownerId: workspaceId2, mcaId: 'mca.make', name: 'Make (dst)',
    })
    await db.collection('apps').insertOne({
      appId: crossMcaAppId, workspaceId: workspaceId2, ownerType: 'workspace', ownerId: workspaceId2, mcaId: 'mca.teros.holded', name: 'Holded (dst)',
    })
    // Same-MCA instance that EXISTS but has NO stored credential — the route's
    // access gate passes, the service must reject with NO_SOURCE_CREDENTIAL.
    await db.collection('apps').insertOne({
      appId: unconnectedAppId, workspaceId, ownerType: 'workspace', ownerId: workspaceId, mcaId: 'mca.make', name: 'Make (never connected)',
    })
    await db.collection('mca_catalog').insertOne({
      mcaId: 'mca.make', auth: { type: 'api-key', userSecrets: ['MAKE_API_TOKEN', 'MAKE_REGION'] },
    })
    await db.collection('mca_catalog').insertOne({
      mcaId: 'mca.teros.holded', auth: { type: 'api-key', userSecrets: ['HOLDED_API_KEY'] },
    })

    // The owner's credential on the SOURCE app — the blob to be copied.
    credDocs.set(`${ownerUserId}:${sourceAppId}`, {
      data: { MAKE_API_TOKEN: SECRET, MAKE_REGION: 'eu1.make.com' },
    })
  })

  afterAll(async () => {
    if (available) {
      await db.dropDatabase().catch(() => {})
      await mongoClient.close().catch(() => {})
    }
  })

  test('copy: happy path — cross-workspace, full replace, masked only, correct scopes', async () => {
    if (!available) return
    const { res, status, body } = makeRes()

    await handleAppCopyAuth(
      res, ctx(ownerUserId), db, targetAppId,
      { sourceAppId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId2, agentId: 'agent_nira' },
      fakeAuthManager, fakeMcaOAuth,
    )

    expect(status()).toBe(200)
    const b = body()
    expect(b.success).toBe(true)
    expect(b.sourceAppId).toBe(sourceAppId)
    expect(b.targetAppId).toBe(targetAppId)
    expect(b.mcaId).toBe('mca.make')
    expect(b.fieldCount).toBe(2)
    expect(b.copiedFields).toContainEqual({ key: 'MAKE_API_TOKEN', maskedValue: SECRET_MASK })
    // 'eu1.make.com' is 12 chars → prefix…last4 mask ('eu….com'), not ****
    expect(b.copiedFields).toContainEqual({ key: 'MAKE_REGION', maskedValue: 'eu….com' })
    // Live status read-back so the agent can verify without a restart
    expect(b.auth.status).toBe('ready')
    // The response NEVER carries the plaintext
    expect(JSON.stringify(b)).not.toContain(SECRET)
    expect(b.note).toMatch(/full replace/i)

    // The write used the TARGET's (userId, appId) — re-encrypted scope, and the
    // credential actually landed on the target instance.
    expect(writeScopes.at(-1)).toEqual({ userId: ownerUserId, appId: targetAppId, mcaId: 'mca.make' })
    const copied = credDocs.get(`${ownerUserId}:${targetAppId}`)
    expect(copied?.data.MAKE_API_TOKEN).toBe(SECRET)
    expect(copied?.data.MAKE_REGION).toBe('eu1.make.com')
  })

  test('copy: full replace — a pre-existing target secret NOT in the source is gone', async () => {
    if (!available) return
    // Plant an extra field on the target that the source does NOT have
    credDocs.set(`${ownerUserId}:${targetAppId}`, {
      data: { MAKE_API_TOKEN: 'sk_live_OLD_value_000011', STALE_EXTRA: 'must-not-survive' },
    })

    const { res, status, body } = makeRes()
    await handleAppCopyAuth(
      res, ctx(ownerUserId), db, targetAppId,
      { sourceAppId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId2 },
      fakeAuthManager, fakeMcaOAuth,
    )

    expect(status()).toBe(200)
    const copied = credDocs.get(`${ownerUserId}:${targetAppId}`)
    // Set semantics: the target is now EXACTLY the source blob
    expect(copied?.data).toEqual({ MAKE_API_TOKEN: SECRET, MAKE_REGION: 'eu1.make.com' })
    expect(copied?.data.STALE_EXTRA).toBeUndefined()
    expect(JSON.stringify(body())).not.toContain('must-not-survive')
  })

  test('copy: blocks cross-MCA (Make → Holded) with a clear error', async () => {
    if (!available) return
    const { res, status, body } = makeRes()

    await handleAppCopyAuth(
      res, ctx(ownerUserId), db, crossMcaAppId,
      { sourceAppId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId2 },
      fakeAuthManager, fakeMcaOAuth,
    )

    expect(status()).toBe(400)
    expect(body().code).toBe('CROSS_MCA_BLOCKED')
    expect(body().error).toMatch(/mca\.make.*mca\.teros\.holded|across app types/i)
    // Nothing was written to the cross-MCA target
    expect(writeScopes.find((w) => w.appId === crossMcaAppId)).toBeUndefined()
  })

  test('copy: blocks a source with no stored credential', async () => {
    if (!available) return
    const { res, status, body } = makeRes()

    await handleAppCopyAuth(
      res, ctx(ownerUserId), db, targetAppId,
      { sourceAppId: unconnectedAppId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId2 },
      fakeAuthManager, fakeMcaOAuth,
    )

    // The source app EXISTS (access gate passes) but has no credential →
    // the service rejects with NO_SOURCE_CREDENTIAL, actionably.
    expect(status()).toBe(404)
    expect(body().code).toBe('NO_SOURCE_CREDENTIAL')
    expect(body().error).toMatch(/no credential stored/i)
  })

  test('copy: blocks a revoked source credential', async () => {
    if (!available) return
    // Revoke the owner's source credential (disconnect semantics)
    await fakeAuthManager.revoke(ownerUserId, sourceAppId)

    const { res, status, body } = makeRes()
    await handleAppCopyAuth(
      res, ctx(ownerUserId), db, targetAppId,
      { sourceAppId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId2 },
      fakeAuthManager, fakeMcaOAuth,
    )

    expect(status()).toBe(409)
    expect(body().code).toBe('SOURCE_REVOKED')
    expect(body().error).toMatch(/revoked/i)

    // Restore for any later runs
    credDocs.set(`${ownerUserId}:${sourceAppId}`, {
      data: { MAKE_API_TOKEN: SECRET, MAKE_REGION: 'eu1.make.com' },
    })
  })

  test('copy: cross-user blocked — a stranger cannot copy the owner\'s credentials', async () => {
    if (!available) return
    const { res, status } = makeRes()

    await handleAppCopyAuth(
      res, ctx(strangerUserId), db, targetAppId,
      { sourceAppId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId2 },
      fakeAuthManager, fakeMcaOAuth,
    )

    // The stranger has access to neither app → 403 at the route gate. Even
    // with access, ctx.userId (their own) has no credential to copy — copying
    // ANOTHER user's credential is impossible by construction.
    expect(status()).toBe(403)
  })

  test('copy: 403 for a caller without access to the target app', async () => {
    if (!available) return
    const { res, status } = makeRes()

    await handleAppCopyAuth(
      res, ctx(strangerUserId), db, targetAppId,
      { sourceAppId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId2 },
      fakeAuthManager, undefined,
    )

    expect(status()).toBe(403)
  })

  // tn_hj1s2cs1t93g91xq — cross-workspace tools ALWAYS name their workspaces
  // (infra sharded by workspaceId). Missing either ID → VALIDATION_ERROR before
  // anything is written.
  test('copy: missing sourceWorkspaceId → 400 VALIDATION_ERROR, nothing written', async () => {
    if (!available) return
    const { res, status, body } = makeRes()
    const writesBefore = writeScopes.length

    await handleAppCopyAuth(
      res, ctx(ownerUserId), db, targetAppId,
      { sourceAppId, targetWorkspaceId: workspaceId2 },
      fakeAuthManager, fakeMcaOAuth,
    )

    expect(status()).toBe(400)
    expect(body().error).toMatch(/sourceWorkspaceId is required/i)
    expect(writeScopes.length).toBe(writesBefore)
  })

  test('copy: missing targetWorkspaceId → 400 VALIDATION_ERROR, nothing written', async () => {
    if (!available) return
    const { res, status, body } = makeRes()
    const writesBefore = writeScopes.length

    await handleAppCopyAuth(
      res, ctx(ownerUserId), db, targetAppId,
      { sourceAppId, sourceWorkspaceId: workspaceId },
      fakeAuthManager, fakeMcaOAuth,
    )

    expect(status()).toBe(400)
    expect(body().error).toMatch(/targetWorkspaceId is required/i)
    expect(writeScopes.length).toBe(writesBefore)
  })

  test('copy: WORKSPACE_MISMATCH intact — wrong sourceWorkspaceId rejected before any write', async () => {
    if (!available) return
    const { res, status, body } = makeRes()
    const writesBefore = writeScopes.length

    // Source actually lives in workspaceId, but we claim workspaceId2 → the
    // mismatch check must fire before any credential is read or written.
    await handleAppCopyAuth(
      res, ctx(ownerUserId), db, targetAppId,
      { sourceAppId, sourceWorkspaceId: workspaceId2, targetWorkspaceId: workspaceId2 },
      fakeAuthManager, fakeMcaOAuth,
    )

    expect(status()).toBe(400)
    expect(body().error).toMatch(/not in workspace/i)
    expect(writeScopes.length).toBe(writesBefore)
  })
})
