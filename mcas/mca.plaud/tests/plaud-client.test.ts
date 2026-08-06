import { describe, expect, it } from 'bun:test'
import type { ToolContext } from '@teros/mca-sdk'
import {
  getPlaudClient,
  getPlaudSecrets,
  mapNoteDetail,
  mapRecording,
  mapSegments,
  mapTag,
  mapUser,
  PlaudClient,
} from '../src/lib'

// =============================================================================
// MOCK TOOL CONTEXT
// =============================================================================

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

// =============================================================================
// SECRET RESOLUTION
// =============================================================================

describe('getPlaudSecrets', () => {
  it('uses defaults when no secrets are provided', async () => {
    const context = createMockContext()
    const secrets = await getPlaudSecrets(context)
    expect(secrets.PLAUD_MCP_URL).toBe('https://mcp.plaud.ai/mcp')
    expect(secrets.ACCESS_TOKEN).toBeUndefined()
    expect(secrets.REFRESH_TOKEN).toBeUndefined()
  })

  it('strips trailing slash from PLAUD_MCP_URL', async () => {
    const context = createMockContext({ userSecrets: { PLAUD_MCP_URL: 'https://mcp.plaud.ai/mcp/' } })
    const secrets = await getPlaudSecrets(context)
    expect(secrets.PLAUD_MCP_URL).toBe('https://mcp.plaud.ai/mcp')
  })

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
})

// =============================================================================
// DATA MAPPERS
// =============================================================================

describe('mapRecording', () => {
  it('maps the official MCP file fields', () => {
    const raw = {
      id: 'abc123',
      name: 'Meeting',
      created_at: '2026-06-01T10:00:00Z',
      duration: 120_000,
      tag_name: 'Work',
    }
    expect(mapRecording(raw)).toEqual({
      id: 'abc123',
      title: 'Meeting',
      created_at: '2026-06-01T10:00:00Z',
      duration_seconds: 120,
      tag: 'Work',
    })
  })

  it('falls back to alternative field names', () => {
    const raw = {
      file_id: 'def456',
      file_name: 'Call',
      createTime: '2026-06-02T12:00:00Z',
      durationSeconds: 60,
      folder: 'Personal',
    }
    const rec = mapRecording(raw as unknown as Record<string, unknown>)
    expect(rec.id).toBe('def456')
    expect(rec.title).toBe('Call')
    expect(rec.created_at).toBe('2026-06-02T12:00:00Z')
    expect(rec.duration_seconds).toBe(60)
    expect(rec.tag).toBe('Personal')
  })

  it('converts duration from milliseconds to seconds', () => {
    const raw = {
      id: 'ghi789',
      name: 'Short call',
      created_at: '2026-06-03T10:00:00Z',
      duration: 30_000,
    }
    expect(mapRecording(raw).duration_seconds).toBe(30)
  })
})

describe('mapSegments', () => {
  it('maps segments with speaker labels', () => {
    const raw = [
      { text: 'Hello', start_time: 0, end_time: 1, speaker: 'A' },
      { content: 'Hi', start: 1, end: 2, speaker_label: 'B' },
    ]
    const segments = mapSegments(raw)
    expect(segments).toEqual([
      { text: 'Hello', start_time: 0, end_time: 1, speaker: 'A' },
      { text: 'Hi', start_time: 1, end_time: 2, speaker: 'B' },
    ])
  })

  it('returns an empty array for non-array input', () => {
    expect(mapSegments(null)).toEqual([])
    expect(mapSegments('text')).toEqual([])
  })
})

describe('mapNoteDetail', () => {
  it('concatenates transcript segments', () => {
    const raw = {
      id: 'abc',
      name: 'Note',
      created_at: '2026-06-01T10:00:00Z',
      duration: 30_000,
      source_list: [
        { text: 'One', start_time: 0, end_time: 1 },
        { text: 'two', start_time: 1, end_time: 2 },
      ],
      note_list: ['# Summary', 'Key points discussed.'],
    }
    const note = mapNoteDetail(raw)
    expect(note.transcript).toBe('One two')
    expect(note.segments).toHaveLength(2)
    expect(note.duration_seconds).toBe(30)
    expect(note.ai_content).toEqual(['# Summary', 'Key points discussed.'])
  })
})

describe('mapTag', () => {
  it('maps tag fields', () => {
    const raw = { tag_id: 't1', tag_name: 'Ideas', file_count: 5 }
    expect(mapTag(raw)).toEqual({ id: 't1', name: 'Ideas', count: 5 })
  })
})

describe('mapUser', () => {
  it('maps user fields', () => {
    const raw = { user_id: 'u1', email: 'u@example.com', name: 'User' }
    expect(mapUser(raw)).toEqual({ id: 'u1', email: 'u@example.com', name: 'User' })
  })
})

// =============================================================================
// MCP CLIENT MOCK
// =============================================================================

describe('PlaudClient with backend OAuth tokens', () => {
  it('reads OAuth tokens from user secrets', async () => {
    const context = createMockContext({
      userSecrets: {
        ACCESS_TOKEN: 'token_123',
        REFRESH_TOKEN: 'refresh_123',
        EXPIRY_DATE: '2026-06-25T12:00:00.000Z',
      },
    })

    const client = await getPlaudClient(context)
    expect(client).toBeInstanceOf(PlaudClient)
  })
})

// @todo nira - 2026-06-24: add full MCP server mock test once we can inspect the
// official Plaud tool list with a real token. This test currently validates the
// skeleton and mappers; the OAuth flow end-to-end test requires the Teros callback.
