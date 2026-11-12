/**
 * LeaderElectionService.listLiveOthers — the query the instance registry uses
 * to see other live backend instances (spec DEP-REQ-6).
 */
import { describe, expect, it } from 'bun:test'
import { LeaderElectionService, type LeaderLockDocument } from '../../src/services/leader-election'

function makeDb(docs: LeaderLockDocument[]) {
  const col = {
    find(filter: { expiresAt: { $gt: Date }; ownerId: { $ne: string } }) {
      const rows = docs.filter((d) => d.expiresAt > filter.expiresAt.$gt && d.ownerId !== filter.ownerId.$ne)
      return { toArray: async () => rows }
    },
  }
  return { collection: () => col } as any
}

describe('LeaderElectionService.listLiveOthers', () => {
  it('returns non-expired locks with the prefix that belong to other owners', async () => {
    const now = Date.now()
    const db = makeDb([
      { name: 'instance:blue-1', ownerId: 'blue-1', acquiredAt: new Date(), expiresAt: new Date(now + 10_000) },
      { name: 'instance:green-1', ownerId: 'green-1', acquiredAt: new Date(), expiresAt: new Date(now + 10_000) }, // ours
      { name: 'instance:dead-1', ownerId: 'dead-1', acquiredAt: new Date(), expiresAt: new Date(now - 10_000) }, // expired
      { name: 'scheduler-tick', ownerId: 'blue-1', acquiredAt: new Date(), expiresAt: new Date(now + 10_000) }, // other lock
    ])
    const svc = new LeaderElectionService(db, 'green-1', { ttlMs: 60_000 })
    const live = await svc.listLiveOthers('instance:')
    expect(live.map((d) => d.name)).toEqual(['instance:blue-1'])
  })
})
