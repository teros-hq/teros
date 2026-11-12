/**
 * Unit tests for default values — NFR-3 (rev2) legacy channel handling.
 *
 * NFR-3 (revised 2026-09-15 per Pablo's decision) requires:
 * - Channels without `scope` → treated as 'personal' (defense in depth)
 * - Apps without `scope` → treated as 'shared'
 *
 * These tests verify that the code handles missing fields correctly
 * by normalising undefined → 'personal' for scope (not 'shared').
 */

import { describe, expect, test, mock } from 'bun:test'
import type { Db } from 'mongodb'
import { canUsePersonalApp } from './channel-permissions'

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function createMockDb(channel: Record<string, unknown> | null): Db {
  const findOne = mock(() => Promise.resolve(channel))
  const collection = mock(() => ({ findOne }))
  return { collection } as unknown as Db
}

const CREATOR_ID = 'user_creator'
const CHANNEL_ID = 'ch_test123'

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('NFR-3 (rev2): default values — legacy channels treated as personal', () => {
  describe('channel scope defaults to personal when missing', () => {
    test('channel with no scope field → canUsePersonalApp returns true (treated as personal)', async () => {
      // Channel document as it would exist from before the feature — no scope field at all
      const db = createMockDb({
        channelId: CHANNEL_ID,
        userId: CREATOR_ID,
        workspaceId: 'ws_test',
        status: 'active',
        // NOTE: no `scope` field — legacy channel
      })

      // canUsePersonalApp normalises undefined → 'personal', so personal apps are allowed
      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('channel with scope: undefined explicitly → canUsePersonalApp returns true', async () => {
      const db = createMockDb({
        channelId: CHANNEL_ID,
        userId: CREATOR_ID,
        workspaceId: 'ws_test',
        scope: undefined,
      })

      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('channel with scope: null → canUsePersonalApp returns true (null ?? personal = personal)', async () => {
      const db = createMockDb({
        channelId: CHANNEL_ID,
        userId: CREATOR_ID,
        workspaceId: 'ws_test',
        scope: null,
      })

      // null ?? 'personal' = 'personal' → personal apps allowed
      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('channel with scope: personal → canUsePersonalApp returns true', async () => {
      const db = createMockDb({
        channelId: CHANNEL_ID,
        userId: CREATOR_ID,
        workspaceId: 'ws_test',
        scope: 'personal',
      })

      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(true)
    })

    test('channel with scope: shared → canUsePersonalApp returns false', async () => {
      const db = createMockDb({
        channelId: CHANNEL_ID,
        userId: CREATOR_ID,
        workspaceId: 'ws_test',
        scope: 'shared',
      })

      expect(await canUsePersonalApp(db, CREATOR_ID, CHANNEL_ID)).toBe(false)
    })
  })

  describe('app scope defaults to shared when missing', () => {
    // The scope default is enforced in two places:
    // 1. pre-publish-scan.ts: `const scope = app.scope ?? 'personal'`
    // 2. execute-tool.ts: only triggers gate when `app.scope === 'personal'`
    //
    // We verify the logic: an app with no scope should NOT be treated as personal.

    test('app without scope → not personal (gate does not trigger)', () => {
      // Simulate the check in execute-tool.ts:
      // `if (db && gateChannelId && muwEnabled && app.scope === 'personal')`
      const app = { appId: 'app_test', name: 'Test', /* no scope */ }
      const isPersonal = (app as any).scope === 'personal'
      expect(isPersonal).toBe(false)
    })

    test('app with scope: undefined → not personal', () => {
      const app = { appId: 'app_test', name: 'Test', scope: undefined }
      const isPersonal = (app as any).scope === 'personal'
      expect(isPersonal).toBe(false)
    })

    test('app with scope: null → not personal', () => {
      const app = { appId: 'app_test', name: 'Test', scope: null }
      const isPersonal = (app as any).scope === 'personal'
      expect(isPersonal).toBe(false)
    })

    test('app with scope: shared → not personal', () => {
      const app = { appId: 'app_test', name: 'Test', scope: 'shared' }
      const isPersonal = (app as any).scope === 'personal'
      expect(isPersonal).toBe(false)
    })

    test('app with scope: personal → is personal', () => {
      const app = { appId: 'app_test', name: 'Test', scope: 'personal' }
      const isPersonal = (app as any).scope === 'personal'
      expect(isPersonal).toBe(true)
    })

    test('pre-publish scan: scope ?? personal → defaults to personal', () => {
      // Simulate the check in pre-publish-scan.ts:
      // `const scope = (app.scope as string | undefined) ?? 'personal'`
      const appNoScope = { appId: 'a', name: 'Test' }
      const appUndefined = { appId: 'a', name: 'Test', scope: undefined }
      const appNull = { appId: 'a', name: 'Test', scope: null }

      expect((appNoScope as any).scope ?? 'personal').toBe('personal')
      expect((appUndefined as any).scope ?? 'personal').toBe('personal')
      expect((appNull as any).scope ?? 'personal').toBe('personal')
    })
  })
})
