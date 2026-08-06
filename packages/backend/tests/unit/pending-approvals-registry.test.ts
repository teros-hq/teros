/**
 * Direct unit tests for `PendingApprovalsRegistry` — TER-351.
 *
 * Tests the class in isolation, without mocking any backend infrastructure
 * (channels, broadcasts, etc.). The class only manages in-memory state +
 * invariants between the 3 internal Maps.
 */

import { describe, expect, it } from 'bun:test'
import {
  PendingApprovalsRegistry,
  type PendingPermission,
} from '../../src/handlers/message/pending-approvals-registry'

function makePerm(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    resolve: () => {},
    reject: () => {},
    toolName: 'write-file',
    appId: 'app_fs',
    input: { path: '/tmp/x' },
    channelId: 'ch_test',
    messageId: 'msg_test',
    toolCallId: 'tc_test',
    userId: 'user_a',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('PendingApprovalsRegistry — pending CRUD', () => {
  it('register + get + has + size', () => {
    const r = new PendingApprovalsRegistry()
    expect(r.has('rid1')).toBe(false)
    expect(r.size()).toBe(0)

    r.register('rid1', makePerm())
    expect(r.has('rid1')).toBe(true)
    expect(r.get('rid1')?.toolName).toBe('write-file')
    expect(r.size()).toBe(1)
  })

  it('delete returns false for unknown requestId, true after register', () => {
    const r = new PendingApprovalsRegistry()
    expect(r.delete('unknown')).toBe(false)
    r.register('rid1', makePerm())
    expect(r.delete('rid1')).toBe(true)
    expect(r.size()).toBe(0)
  })

  it('register auto-indexes by userId; delete cleans userIndex', () => {
    const r = new PendingApprovalsRegistry()
    r.register('rid1', makePerm({ userId: 'user_a' }))
    r.register('rid2', makePerm({ userId: 'user_a' }))
    r.register('rid3', makePerm({ userId: 'user_b' }))

    expect(r.getUserPendingCount('user_a')).toBe(2)
    expect(r.getUserPendingCount('user_b')).toBe(1)

    r.delete('rid1')
    expect(r.getUserPendingCount('user_a')).toBe(1)
  })

  it('register without userId does not affect userIndex', () => {
    const r = new PendingApprovalsRegistry()
    r.register('rid1', makePerm({ userId: undefined }))
    expect(r.getUserPendingCount('user_a')).toBe(0)
  })
})

describe('PendingApprovalsRegistry — idempotency / resolved TTL', () => {
  it('recordResolved + isResolved + getResolved', () => {
    const r = new PendingApprovalsRegistry()
    expect(r.isResolved('rid1')).toBe(false)

    r.recordResolved('rid1', 'granted')
    expect(r.isResolved('rid1')).toBe(true)
    expect(r.getResolved('rid1')?.resolution).toBe('granted')
  })

  it('pruneResolved removes entries older than TTL', () => {
    const r = new PendingApprovalsRegistry({ resolvedTtlMs: 1000 })
    r.recordResolved('old', 'denied')
    r.recordResolved('new', 'granted')

    // Mock-shift the entry's timestamp by accessing the internal Map
    const internalResolved: any = (r as any).resolved
    internalResolved.get('old').at = Date.now() - 2000

    const pruned = r.pruneResolved()
    expect(pruned).toBe(1)
    expect(r.isResolved('old')).toBe(false)
    expect(r.isResolved('new')).toBe(true)
  })

  it('auto-prune triggers when size > threshold', () => {
    const r = new PendingApprovalsRegistry({
      resolvedTtlMs: 1000,
      resolvedPruneThreshold: 2,
    })
    r.recordResolved('a', 'granted')
    r.recordResolved('b', 'granted')
    // Both entries should still exist after these 2 inserts (size == threshold).
    expect(r.isResolved('a')).toBe(true)

    // Shift 'a' to expired, then insert 'c' (size becomes 3, triggers prune).
    const internalResolved: any = (r as any).resolved
    internalResolved.get('a').at = Date.now() - 2000
    r.recordResolved('c', 'denied')
    expect(r.isResolved('a')).toBe(false)
  })
})

describe('PendingApprovalsRegistry — query helpers', () => {
  it('hasOtherPendingInChannel detects siblings', () => {
    const r = new PendingApprovalsRegistry()
    r.register('rid1', makePerm({ channelId: 'ch_a' }))
    r.register('rid2', makePerm({ channelId: 'ch_a' }))
    r.register('rid3', makePerm({ channelId: 'ch_b' }))

    expect(r.hasOtherPendingInChannel('ch_a', 'rid1')).toBe(true)
    expect(r.hasOtherPendingInChannel('ch_a', 'rid2')).toBe(true)
    expect(r.hasOtherPendingInChannel('ch_b', 'rid3')).toBe(false)
  })

  it('getUserPendingSummaries returns projection of pending entries', () => {
    const r = new PendingApprovalsRegistry()
    r.register('rid1', makePerm({ userId: 'user_a', irreversible: true }))
    r.register('rid2', makePerm({ userId: 'user_a', toolName: 'delete' }))

    const summaries = r.getUserPendingSummaries('user_a')
    expect(summaries).toHaveLength(2)
    expect(summaries.find((s) => s.requestId === 'rid1')?.irreversible).toBe(true)
    expect(summaries.find((s) => s.requestId === 'rid2')?.toolName).toBe('delete')
  })

  it('getUserPendingSummaries returns empty array for unknown user', () => {
    const r = new PendingApprovalsRegistry()
    expect(r.getUserPendingSummaries('user_unknown')).toEqual([])
  })

  it('entries iterates all pending', () => {
    const r = new PendingApprovalsRegistry()
    r.register('rid1', makePerm())
    r.register('rid2', makePerm({ channelId: 'ch_other' }))

    const ids = [...r.entries()].map(([rid]) => rid).sort()
    expect(ids).toEqual(['rid1', 'rid2'])
  })
})

describe('PendingApprovalsRegistry — lifecycle', () => {
  it('clear resets all state', () => {
    const r = new PendingApprovalsRegistry()
    r.register('rid1', makePerm({ userId: 'user_a' }))
    r.recordResolved('rid_old', 'denied')

    r.clear()

    expect(r.size()).toBe(0)
    expect(r.isResolved('rid_old')).toBe(false)
    expect(r.getUserPendingCount('user_a')).toBe(0)
  })

  it('two instances do NOT share state (isolation)', () => {
    const a = new PendingApprovalsRegistry()
    const b = new PendingApprovalsRegistry()

    a.register('rid1', makePerm({ userId: 'user_a' }))
    expect(a.size()).toBe(1)
    expect(b.size()).toBe(0)
    expect(b.has('rid1')).toBe(false)
  })
})
