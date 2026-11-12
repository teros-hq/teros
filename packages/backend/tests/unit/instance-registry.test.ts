/**
 * InstanceRegistry — liveness of backend instances during a blue/green
 * handoff (spec DEP-REQ-6).
 *
 * The LeaderElectionService is faked at its boundary: tryAcquire / release /
 * listLiveOthers against an in-memory map, so the test controls which other
 * instances "exist" and when they disappear.
 */
import { describe, expect, it } from 'bun:test'
import { INSTANCE_LOCK_PREFIX, InstanceRegistry } from '../../src/services/instance-registry'

function makeLeader(ownerId = 'me-1') {
  const live = new Map<string, { ownerId: string; expiresAt: Date }>()
  const calls: string[] = []
  const leader = {
    getOwnerId: () => ownerId,
    async tryAcquire(name: string, ttlMs: number) {
      calls.push(`acquire ${name} ${ttlMs}`)
      live.set(name, { ownerId, expiresAt: new Date(Date.now() + ttlMs) })
      return true
    },
    async release(name: string) {
      calls.push(`release ${name}`)
      live.delete(name)
    },
    async listLiveOthers(prefix: string) {
      const now = new Date()
      return [...live.entries()]
        .filter(([name, d]) => name.startsWith(prefix) && d.ownerId !== ownerId && d.expiresAt > now)
        .map(([name, d]) => ({ name, ownerId: d.ownerId, acquiredAt: now, expiresAt: d.expiresAt }))
    },
  }
  return { leader: leader as any, live, calls }
}

const quiet = { warn: () => {}, info: () => {} }

describe('InstanceRegistry', () => {
  it('registers under instance:<ownerId> with the TTL on start and releases it on stop', async () => {
    const { leader, calls, live } = makeLeader('core-42')
    const reg = new InstanceRegistry(leader, { ttlMs: 15_000, heartbeatMs: 60_000, log: quiet })
    await reg.start()
    expect(reg.lockName).toBe(`${INSTANCE_LOCK_PREFIX}core-42`)
    expect(calls).toEqual(['acquire instance:core-42 15000'])
    expect(live.has('instance:core-42')).toBe(true)
    await reg.stop()
    expect(calls.at(-1)).toBe('release instance:core-42')
    expect(live.has('instance:core-42')).toBe(false)
  })

  it('[DEP-AC-8] waitUntilSoleInstance resolves immediately when nobody else is registered', async () => {
    const { leader } = makeLeader()
    const reg = new InstanceRegistry(leader, { log: quiet })
    const sleeps: number[] = []
    const r = new InstanceRegistry(leader, { log: quiet, sleep: async (ms) => { sleeps.push(ms) } })
    expect(await r.waitUntilSoleInstance({ pollMs: 2000, timeoutMs: 10_000 })).toBe(true)
    expect(sleeps).toEqual([])
    void reg
  })

  it('[DEP-AC-8] waits while another instance is live and resolves as soon as its lock disappears', async () => {
    const { leader, live } = makeLeader('green-1')
    live.set('instance:blue-1', { ownerId: 'blue-1', expiresAt: new Date(Date.now() + 60_000) })
    const sleeps: number[] = []
    const reg = new InstanceRegistry(leader, {
      log: quiet,
      sleep: async (ms) => {
        sleeps.push(ms)
        if (sleeps.length === 3) live.delete('instance:blue-1') // the previous color exits
      },
    })
    expect(await reg.waitUntilSoleInstance({ pollMs: 2000, timeoutMs: 60_000 })).toBe(true)
    expect(sleeps).toEqual([2000, 2000, 2000])
    expect(await reg.othersAlive()).toEqual([])
  })

  it('[DEP-AC-8] ignores expired locks of dead instances and our own lock', async () => {
    const { leader, live } = makeLeader('green-1')
    live.set('instance:crashed', { ownerId: 'crashed', expiresAt: new Date(Date.now() - 1) })
    live.set('instance:green-1', { ownerId: 'green-1', expiresAt: new Date(Date.now() + 60_000) })
    live.set('other-lock', { ownerId: 'blue-1', expiresAt: new Date(Date.now() + 60_000) }) // not an instance lock
    const reg = new InstanceRegistry(leader, { log: quiet })
    expect(await reg.othersAlive()).toEqual([])
    expect(await reg.waitUntilSoleInstance({ pollMs: 1, timeoutMs: 10 })).toBe(true)
  })

  it('[DEP-AC-8] gives up after timeoutMs with a warning and returns false', async () => {
    const { leader, live } = makeLeader('green-1')
    live.set('instance:blue-1', { ownerId: 'blue-1', expiresAt: new Date(Date.now() + 600_000) })
    const warnings: string[] = []
    const reg = new InstanceRegistry(leader, {
      log: { info: () => {}, warn: (m: string) => { warnings.push(String(m)) } },
      sleep: async () => {},
    })
    const ok = await reg.waitUntilSoleInstance({ pollMs: 1, timeoutMs: 0 })
    expect(ok).toBe(false)
    expect(warnings.some((w) => w.includes('blue-1') && w.includes('proceeding anyway'))).toBe(true)
  })
})
