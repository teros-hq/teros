/**
 * Window serialize/deserialize roundtrip invariant (TER-516, TER-399 Fase B / B5).
 *
 * The tiling layout persists each open window via `definition.serialize(props)`
 * (store/tilingStore.ts:1815) and restores it after reload via
 * `definition.deserialize(persisted)` (store/tilingStore.ts:606), with a JSON hop
 * in between. If serialize emits a key that deserialize does not read back, that
 * piece of window state is silently lost on reload — the whole class of "my tab
 * came back without its search / filter / path / project" bugs. This test makes
 * that asymmetry impossible to introduce unnoticed across every registered window
 * type.
 *
 * It lives under `.render.test.ts` because importing the registry transitively
 * loads every window definition; the render harness (vitest.config plugin
 * `stub-window-content`) stubs their heavy content components so the graph stays
 * cheap. The assertions themselves are pure — nothing is rendered.
 */
import { describe, expect, it } from 'vitest'
import { windowRegistry } from '../services/windowRegistry'
import { registerAllWindowTypes } from './index'

registerAllWindowTypes()

/**
 * Window types intentionally without serialize/deserialize. The store tolerates
 * this (`definition?.serialize` optional chaining → raw-props fallback), which is
 * only safe because they carry no persistable props. A NEW type missing serialize
 * must be added here deliberately — otherwise the structural test below bites,
 * forcing a conscious choice instead of a silent raw-fallback.
 */
// billing-requests (FASE 6) and billing-teams (T1) carry no persistable props
// (they open on a list and drill in via internal state), same as
// pending-approvals — a deliberate no-serialize choice, not an oversight.
const NO_SERIALIZE_ALLOWLIST = new Set(['pending-approvals', 'billing-requests', 'billing-teams'])

/** Types registered by registerAllWindowTypes() — bites if the registry shrinks. */
const EXPECTED_TYPE_COUNT = 36

const sentinel = (key: string) => `__rt:${key}__`

/**
 * Discover the prop keys a serialize() reads, by probing it with a Proxy that
 * records every string access and returns a unique truthy sentinel (so even
 * presence-conditional spreads like `props.x && { x: props.x }` include the key).
 * Every window serializer does shallow `props.<key>` reads, so the probe is faithful.
 */
function discoverPersistedKeys(serialize: (props: any) => Record<string, any>): string[] {
  const keys = new Set<string>()
  const probe = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') {
          keys.add(prop)
          return sentinel(prop)
        }
        return undefined
      },
    },
  )
  serialize(probe)
  return [...keys]
}

interface RoundtripResult {
  persisted: Record<string, any>
  restored: Record<string, any>
  repersisted: Record<string, any>
}

/**
 * Drive props with distinctive values through the REAL persistence path:
 * serialize → JSON (the wire) → deserialize → serialize again.
 */
function roundtrip(def: {
  serialize: (props: any) => Record<string, any>
  deserialize: (data: Record<string, any>) => any
}): RoundtripResult {
  const keys = discoverPersistedKeys(def.serialize)
  const sample = Object.fromEntries(keys.map((k) => [k, sentinel(k)]))
  const persisted = def.serialize(sample)
  const overWire = JSON.parse(JSON.stringify(persisted)) as Record<string, any>
  const restored = def.deserialize(overWire)
  const repersisted = def.serialize(restored)
  return { persisted, restored, repersisted }
}

describe('window serialize/deserialize roundtrip (TER-516)', () => {
  const defs = windowRegistry.getAll()

  it('registers every window type exactly once', () => {
    expect(defs).toHaveLength(EXPECTED_TYPE_COUNT)
    const types = defs.map((d) => d.type)
    expect(new Set(types).size).toBe(types.length)
  })

  it('every persistable window type has both serialize and deserialize', () => {
    const missing = defs
      .filter((d) => typeof d.serialize !== 'function' || typeof d.deserialize !== 'function')
      .map((d) => d.type)
      .filter((type) => !NO_SERIALIZE_ALLOWLIST.has(type))
    expect(missing).toHaveLength(0)
  })

  const roundtrippable = defs.filter((d) => !NO_SERIALIZE_ALLOWLIST.has(d.type))

  it.each(roundtrippable.map((d) => [d.type, d] as const))(
    "'%s' preserves every persisted prop through serialize→JSON→deserialize",
    (_type, def) => {
      const { persisted, restored, repersisted } = roundtrip(def)
      // No key emitted by serialize is dropped on the restore→persist cycle.
      expect(repersisted).toEqual(persisted)
      // Every persisted key is read back with the exact same value — no default
      // silently overwriting real data, no key read under a different name.
      for (const key of Object.keys(persisted)) {
        expect(restored[key]).toBe(persisted[key])
      }
    },
  )

  it('the roundtrip oracle catches an asymmetric definition', () => {
    // §5: prove the invariant can fail by feeding it a serialize/deserialize pair
    // that loses a key. If this passed, the oracle above would be decorative.
    const broken = {
      serialize: (p: any) => ({ a: p.a, b: p.b }),
      deserialize: (d: Record<string, any>) => ({ a: d.a }), // drops `b`
    }
    const { persisted, repersisted } = roundtrip(broken)
    expect(persisted).toEqual({ a: sentinel('a'), b: sentinel('b') })
    expect(repersisted).not.toEqual(persisted)
  })
})
