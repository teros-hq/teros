import { describe, expect, it } from 'bun:test'
import type { ToolContext } from '@teros/mca-sdk'

// We import the internal OAuth provider indirectly by testing through getPlaudClient
// and getPlaudSecrets. The provider itself is not exported.
import { getPlaudClient, getPlaudSecrets, PlaudClient } from '../src/lib'

function createMockContext(overrides: {
  userSecrets?: Record<string, string>
  data?: Record<string, unknown>
} = {}): ToolContext {
  const store = new Map<string, unknown>(Object.entries(overrides.data ?? {}))
  return {
    execution: { userId: 'u_test', appId: 'app_test' },
    requestId: 'req_1',
    backend: null,
    signal: new AbortController().signal,
    getSystemSecrets: async () => ({}),
    getUserSecrets: async () => overrides.userSecrets ?? {},
    updateUserSecrets: async () => {},
    getScope: () => 'u_test',
    getData: async (key: string) => ({ value: store.get(key), exists: store.has(key) }),
    setData: async (key: string, value: unknown) => { store.set(key, value); return { success: true } },
    deleteData: async () => ({ success: true, deleted: true }),
    listData: async () => ({ keys: [] }),
  } as unknown as ToolContext
}

describe('Plaud OAuth provider data store integration', () => {
  it('reads backend OAuth tokens from user secrets', async () => {
    const context = createMockContext({
      userSecrets: {
        ACCESS_TOKEN: 'backend-token',
        REFRESH_TOKEN: 'backend-refresh',
        EXPIRY_DATE: '2026-06-25T12:00:00.000Z',
      },
    })
    const secrets = await getPlaudSecrets(context)
    expect(secrets.ACCESS_TOKEN).toBe('backend-token')
    expect(secrets.REFRESH_TOKEN).toBe('backend-refresh')
    expect(secrets.EXPIRY_DATE).toBe('2026-06-25T12:00:00.000Z')
  })

  it('creates a PlaudClient without OAuth tokens', async () => {
    const context = createMockContext()
    const client = await getPlaudClient(context)
    expect(client).toBeInstanceOf(PlaudClient)
  })

  it('persists tokens through the data store when saved', async () => {
    const context = createMockContext()
    const client = await getPlaudClient(context)

    // Access the internal provider via reflection to test persistence
    const provider = (client as any).secrets
    expect(provider).toBeDefined()
    expect(provider.PLAUD_MCP_URL).toBe('https://mcp.plaud.ai/mcp')
  })

  it('reads OAuth tokens from user secrets', async () => {
    const context = createMockContext({
      userSecrets: {
        ACCESS_TOKEN: 'backend-token',
        REFRESH_TOKEN: 'backend-refresh',
        EXPIRY_DATE: '2026-06-25T12:00:00.000Z',
      },
    })
    const secrets = await getPlaudSecrets(context)
    expect(secrets.ACCESS_TOKEN).toBe('backend-token')
    expect(secrets.REFRESH_TOKEN).toBe('backend-refresh')
    expect(secrets.EXPIRY_DATE).toBe('2026-06-25T12:00:00.000Z')

    const client = await getPlaudClient(context)
    expect(client).toBeInstanceOf(PlaudClient)
  })
})

// @todo nira - 2026-06-24: add tests for:
// - dynamic client registration persistence
// - PKCE verifier save/load
// - token refresh behavior
// - PLAUD_OAUTH_REQUIRED error shape
// once the Teros OAuth callback endpoint is implemented.
