/**
 * Unit tests for channel permission functions (REQ-10).
 *
 * Each can* function is tested with three cases:
 *   1. Creator → true
 *   2. Non-creator → false
 *   3. Non-existent channel → false
 *
 * canUsePersonalApp has additional scope-based cases.
 */

import { describe, expect, test, mock } from 'bun:test'
import type { Db } from 'mongodb'
import {
  canArchiveChannel,
  canRedact,
  canToggleScope,
  canUsePersonalApp,
  canWriteInChannel,
} from './channel-permissions'

// ─── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Create a mock Db whose `channels.findOne` returns a pre-configured channel
 * document (or null). This lets us test every can* function without a real
 * MongoDB connection.
 */
function createMockDb(channel: Record<string, unknown> | null): Db {
  const findOne = mock(() => Promise.resolve(channel))
  const collection = mock(() => ({ findOne }))
  // Db is a large interface; we only need .collection('channels').findOne
  return { collection } as unknown as Db
}

const CREATOR_ID = 'user_creator'
const OTHER_ID = 'user_other'
const CHANNEL_ID = 'ch_test123'

function makeChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channelId: CHANNEL_ID,
    userId: CREATOR_ID,
    agentId: 'agent_test',
    status: 'active',
    workspaceId: 'ws_test',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    ...overrides,
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('channel-permissions', () => {
  describe('canRedact', () => {
    test('creator → true', async () => {
      const db = createMockDb(makeChannel())
      expect(await canRedact(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('non-creator → false', async () => {
      const db = createMockDb(makeChannel())
      expect(await canRedact(db, OTHER_ID, CHANNEL_ID)).toBe(false)
    })

    test('non-existent channel → false', async () => {
      const db = createMockDb(null)
      expect(await canRedact(db, CREATOR_ID, CHANNEL_ID)).toBe(false)
    })
  })

  describe('canToggleScope', () => {
    test('creator → true', async () => {
      const db = createMockDb(makeChannel())
      expect(await canToggleScope(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('non-creator → false', async () => {
      const db = createMockDb(makeChannel())
      expect(await canToggleScope(db, OTHER_ID, CHANNEL_ID)).toBe(false)
    })

    test('non-existent channel → false', async () => {
      const db = createMockDb(null)
      expect(await canToggleScope(db, CREATOR_ID, CHANNEL_ID)).toBe(false)
    })
  })

  describe('canWriteInChannel', () => {
    test('creator → true', async () => {
      const db = createMockDb(makeChannel())
      expect(await canWriteInChannel(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('non-creator → false', async () => {
      const db = createMockDb(makeChannel())
      expect(await canWriteInChannel(db, OTHER_ID, CHANNEL_ID)).toBe(false)
    })

    test('non-existent channel → false', async () => {
      const db = createMockDb(null)
      expect(await canWriteInChannel(db, CREATOR_ID, CHANNEL_ID)).toBe(false)
    })
  })

  describe('canArchiveChannel', () => {
    test('creator → true', async () => {
      const db = createMockDb(makeChannel())
      expect(await canArchiveChannel(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('non-creator → false', async () => {
      const db = createMockDb(makeChannel())
      expect(await canArchiveChannel(db, OTHER_ID, CHANNEL_ID)).toBe(false)
    })

    test('non-existent channel → false', async () => {
      const db = createMockDb(null)
      expect(await canArchiveChannel(db, CREATOR_ID, CHANNEL_ID)).toBe(false)
    })
  })

  describe('canUsePersonalApp', () => {
    test('private channel → true (creator)', async () => {
      const db = createMockDb(makeChannel({ scope: 'personal' }))
      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('private channel → true (non-creator, scope-based)', async () => {
      const db = createMockDb(makeChannel({ scope: 'personal' }))
      expect(await canUsePersonalApp(db, OTHER_ID, CHANNEL_ID)).toBe(true)
    })

    test('public channel → false', async () => {
      const db = createMockDb(makeChannel({ scope: 'shared' }))
      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(false)
    })

    test('channel without scope field → true (treated as private, NFR-3 rev2)', async () => {
      const db = createMockDb(makeChannel({ scope: undefined }))
      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('non-existent channel → false', async () => {
      const db = createMockDb(null)
      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(false)
    })
  })
})
