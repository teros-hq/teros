/**
 * Unit tests for LeaderElectionService.
 *
 * The MongoDB Db is mocked with a minimal in-memory implementation that
 * preserves the contract used by the service: `findOneAndUpdate` with
 * `upsert: true` returns the document AFTER the update, and unique index
 * conflicts surface as `{ code: 11000 }` errors.
 */

import { describe, expect, it } from 'bun:test'
import { MongoServerError } from 'mongodb'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  LEADER_LOCKS,
  LeaderElectionService,
  type LeaderLockDocument,
} from '../../src/services/leader-election'

class MockCollection {
  private store = new Map<string, LeaderLockDocument>()

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, any>,
    options?: { upsert?: boolean; returnDocument?: 'before' | 'after' },
  ): Promise<LeaderLockDocument | null> {
    const name = (filter.name as string) || ''
    const existing = this.store.get(name)
    const now = new Date()

    const matchesFilter = (doc: LeaderLockDocument | undefined): boolean => {
      if (!doc) return false
      const or = filter.$or as Array<{ expiresAt?: { $lt?: Date }; ownerId?: string }> | undefined
      if (!or) return true
      return or.some((cond) => {
        if (cond.expiresAt?.$lt) return doc.expiresAt < cond.expiresAt.$lt
        if (cond.ownerId) return doc.ownerId === cond.ownerId
        return false
      })
    }

    if (existing && matchesFilter(existing)) {
      const next: LeaderLockDocument = {
        ...existing,
        ...(update.$set ?? {}),
      }
      this.store.set(name, next)
      return options?.returnDocument === 'after' ? next : existing
    }
    if (!existing && options?.upsert) {
      const fresh: LeaderLockDocument = {
        name,
        ownerId: '',
        acquiredAt: now,
        expiresAt: now,
        ...(update.$setOnInsert ?? {}),
        ...(update.$set ?? {}),
      }
      this.store.set(name, fresh)
      return options.returnDocument === 'after' ? fresh : null
    }
    if (existing && !matchesFilter(existing) && options?.upsert) {
      // The driver wraps duplicate-key errors in MongoServerError; our helper
      // `isMongoDuplicateKey` only matches instances of this class (canonical
      // pattern per the official driver docs).
      const err = new MongoServerError({ message: 'duplicate key', code: 11000 } as any)
      throw err
    }
    return null
  }

  async findOne(filter: { name: string }): Promise<LeaderLockDocument | null> {
    return this.store.get(filter.name) ?? null
  }

  async updateOne(
    filter: { name: string; ownerId: string },
    update: { $set: Record<string, unknown> },
  ): Promise<{ matchedCount: number }> {
    const doc = this.store.get(filter.name)
    if (doc && doc.ownerId === filter.ownerId) {
      this.store.set(filter.name, { ...doc, ...update.$set })
      return { matchedCount: 1 }
    }
    return { matchedCount: 0 }
  }

  async deleteOne(filter: { name: string; ownerId: string }): Promise<void> {
    const doc = this.store.get(filter.name)
    if (doc && doc.ownerId === filter.ownerId) this.store.delete(filter.name)
  }
}

function makeService(ownerId: string, ttlMs = 60_000): LeaderElectionService {
  const col = new MockCollection()
  const db = { collection: () => col }
  return new LeaderElectionService(db as any, ownerId, { ttlMs })
}

function shareDb() {
  const col = new MockCollection()
  const db = { collection: () => col }
  return {
    leaderA: new LeaderElectionService(db as any, 'instance-A', { ttlMs: 60_000 }),
    leaderB: new LeaderElectionService(db as any, 'instance-B', { ttlMs: 60_000 }),
  }
}

describe('LeaderElectionService', () => {
  it('first instance to call tryAcquire wins; second loses', async () => {
    const { leaderA, leaderB } = shareDb()
    expect(await leaderA.tryAcquire(LEADER_LOCKS.ReconcileAgentUsage)).toBe(true)
    expect(await leaderB.tryAcquire(LEADER_LOCKS.ReconcileAgentUsage)).toBe(false)
  })

  it('the same instance can re-acquire its own lock (renewal)', async () => {
    const svc = makeService('instance-A')
    expect(await svc.tryAcquire(LEADER_LOCKS.RollupAgentUsage)).toBe(true)
    expect(await svc.tryAcquire(LEADER_LOCKS.RollupAgentUsage)).toBe(true)
  })

  it('another instance can acquire after the lock expires', async () => {
    const { leaderA, leaderB } = shareDb()
    // Tiny TTL so the lock expires within a sleep.
    expect(await leaderA.tryAcquire(LEADER_LOCKS.SentryAgentUsageAlerts, 30)).toBe(true)
    await sleep(60)
    expect(await leaderB.tryAcquire(LEADER_LOCKS.SentryAgentUsageAlerts, 1000)).toBe(true)
    expect(await leaderA.isLeader(LEADER_LOCKS.SentryAgentUsageAlerts)).toBe(false)
    expect(await leaderB.isLeader(LEADER_LOCKS.SentryAgentUsageAlerts)).toBe(true)
  })

  it('heartbeat extends the lease only for the current owner', async () => {
    const { leaderA, leaderB } = shareDb()
    await leaderA.tryAcquire(LEADER_LOCKS.ReconcileAgentUsage, 1000)
    expect(await leaderA.heartbeat(LEADER_LOCKS.ReconcileAgentUsage, 2000)).toBe(true)
    // B never owned the lock: heartbeat must be a no-op
    expect(await leaderB.heartbeat(LEADER_LOCKS.ReconcileAgentUsage)).toBe(false)
  })

  it('release removes the lock so anyone can take it', async () => {
    const { leaderA, leaderB } = shareDb()
    await leaderA.tryAcquire(LEADER_LOCKS.ReconcileAgentUsage)
    await leaderA.release(LEADER_LOCKS.ReconcileAgentUsage)
    expect(await leaderB.tryAcquire(LEADER_LOCKS.ReconcileAgentUsage)).toBe(true)
  })

  it('isLeader returns false for non-owners and after expiry', async () => {
    const { leaderA, leaderB } = shareDb()
    await leaderA.tryAcquire(LEADER_LOCKS.RollupAgentUsage, 30)
    expect(await leaderA.isLeader(LEADER_LOCKS.RollupAgentUsage)).toBe(true)
    expect(await leaderB.isLeader(LEADER_LOCKS.RollupAgentUsage)).toBe(false)
    await sleep(60)
    expect(await leaderA.isLeader(LEADER_LOCKS.RollupAgentUsage)).toBe(false)
  })

  it('exposes ownerId', () => {
    const svc = makeService('instance-X')
    expect(svc.getOwnerId()).toBe('instance-X')
  })
})
