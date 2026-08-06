import { describe, expect, it } from 'bun:test'
import type { ToolContext } from '@teros/mca-sdk'
import { getPlaudClient } from '../src/lib'
import { listNotes, getNote, getTranscript, getCurrentUser } from '../src/tools'
import { createMockPlaudServer } from './mock-plaud-server'

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

async function createClientWithMockServer(options: Parameters<typeof createMockPlaudServer>[0]) {
  const { clientTransport } = await createMockPlaudServer(options)
  const context = createMockContext({
    userSecrets: {
      ACCESS_TOKEN: 'backend-token',
      REFRESH_TOKEN: 'backend-refresh',
      EXPIRY_DATE: '2026-06-25T12:00:00.000Z',
    },
  })
  // Inject the mock transport at construction time so the client never builds
  // the real StreamableHTTPClientTransport or triggers the OAuth flow.
  const client = await getPlaudClient(context, clientTransport)
  await client.connect()
  return { client, context }
}

describe('Plaud MCP integration with mock server', () => {
  it('lists recordings via list_files', async () => {
    const { context } = await createClientWithMockServer({
      recordings: [
        { id: 'a1', name: 'Meeting 1', created_at: '2026-06-01T10:00:00Z', duration: 120_000 },
        { id: 'a2', name: 'Meeting 2', created_at: '2026-06-02T10:00:00Z', duration: 60_000 },
      ],
    })

    const result = await listNotes.handler({ limit: 10 }, context)
    expect(result).toEqual({
      recordings: [
        { id: 'a2', title: 'Meeting 2', created_at: '2026-06-02T10:00:00Z', duration_seconds: 60, tag: undefined },
        { id: 'a1', title: 'Meeting 1', created_at: '2026-06-01T10:00:00Z', duration_seconds: 120, tag: undefined },
      ],
      total: 2,
    })
  })

  it('gets a note via get_file + get_note mapping', async () => {
    const { context } = await createClientWithMockServer({
      note: {
        id: 'abc',
        name: 'Important call',
        created_at: '2026-06-03T10:00:00Z',
        duration: 300_000,
        source_list: [
          { text: 'Hello', start_time: 0, end_time: 1, speaker: 'A' },
          { text: 'world', start_time: 1, end_time: 2, speaker: 'B' },
        ],
        note_list: ['# Summary', 'A great call'],
      },
    })

    const result = await getNote.handler({ id: 'abc' }, context)
    expect(result).toMatchObject({
      id: 'abc',
      title: 'Important call',
      duration_seconds: 300,
      transcript: 'Hello world',
      ai_content: ['# Summary', 'A great call'],
    })
  })

  it('gets transcript segments', async () => {
    const { context } = await createClientWithMockServer({
      transcript: {
        id: 'abc',
        source_list: [
          { text: 'First', start_time: 0, end_time: 1, speaker: 'A' },
          { text: 'Second', start_time: 1, end_time: 2, speaker: 'B' },
        ],
      },
    })

    const result = await getTranscript.handler({ id: 'abc' }, context)
    expect(result).toEqual({
      id: 'abc',
      title: '',
      duration_seconds: 0,
      segments: [
        { text: 'First', start_time: 0, end_time: 1, speaker: 'A' },
        { text: 'Second', start_time: 1, end_time: 2, speaker: 'B' },
      ],
    })
  })

  it('gets current user', async () => {
    const { context } = await createClientWithMockServer({
      user: { user_id: 'u123', email: 'user@example.com', name: 'Test User' },
    })

    const result = await getCurrentUser.handler({}, context)
    expect(result).toEqual({
      user: { id: 'u123', email: 'user@example.com', name: 'Test User' },
    })
  })
})
