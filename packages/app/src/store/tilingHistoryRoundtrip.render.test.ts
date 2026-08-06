/**
 * Window history persistence roundtrip (TER-516).
 *
 * The tiling layout persists/restores not just each window's ACTIVE props but also
 * its navigation `history` (back/forward). `serializeWindowsForPersistence` and
 * `restoreDesktops` must run every history entry through the registry's
 * serialize/deserialize by ITS OWN type — otherwise the history keeps raw props and
 * diverges from the active props the day a window's serialize/deserialize stops being
 * identity (drops a heavy field, applies a default, migrates a shape). These tests use
 * a fake window type whose serialize is NON-identity, so raw vs serialized is
 * observable and a history entry that skips the cycle is caught.
 *
 * Lives under `.render.test.ts` because importing the store pulls react-native via
 * services/storage, which the render harness shims. Nothing is rendered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type WindowTypeDefinition, windowRegistry } from '../services/windowRegistry'
import { serializeWindowsForPersistence, useTilingStore } from './tilingStore'

const FAKE_TYPE = '__history_roundtrip_test__'

// serialize DROPS `ephemeral`; deserialize ADDS `hydrated`. So raw ≠ serialized ≠
// restored, making a history entry that skipped the cycle observable.
const fakeDefinition: WindowTypeDefinition = {
  type: FAKE_TYPE,
  displayName: 'Fake',
  icon: (() => null) as unknown as WindowTypeDefinition['icon'],
  color: '#000000',
  getTitle: () => 'Fake',
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition['component'],
  serialize: (props) => ({ kept: props.kept }),
  deserialize: (data) => ({ kept: data.kept, hydrated: true }),
}

beforeEach(() => {
  windowRegistry.register(fakeDefinition)
})
afterEach(() => {
  windowRegistry.unregister(FAKE_TYPE)
})

function makeWindow(overrides: Record<string, any> = {}) {
  return {
    id: 'w1',
    type: FAKE_TYPE,
    props: { kept: 'active', ephemeral: 'E' },
    containerId: 'c1',
    desktopIndex: 0,
    hasNotification: false,
    notificationCount: undefined,
    history: [
      { type: FAKE_TYPE, props: { kept: 'h0', ephemeral: 'E0' } },
      { type: FAKE_TYPE, props: { kept: 'h1', ephemeral: 'E1' } },
    ],
    historyIndex: 1,
    ...overrides,
  }
}

describe('window history persistence roundtrip (TER-516)', () => {
  it('serializes every history entry prop, not just the active props', () => {
    const out = serializeWindowsForPersistence({ w1: makeWindow() } as any)
    const w = out.w1 as any
    // Active props serialized (ephemeral dropped).
    expect(w.props).toEqual({ kept: 'active' })
    // History entries ALSO serialized by their own type — the fix.
    expect(w.history).toEqual([
      { type: FAKE_TYPE, props: { kept: 'h0' } },
      { type: FAKE_TYPE, props: { kept: 'h1' } },
    ])
  })

  it('deserializes every history entry prop on restore', () => {
    const store = useTilingStore.getState()
    store.resetDesktops()
    const desktops = useTilingStore.getState().desktops
    store.restoreDesktops(desktops, 0, {
      w1: {
        id: 'w1',
        type: FAKE_TYPE,
        props: { kept: 'active' },
        containerId: 'c1',
        desktopIndex: 0,
        history: [{ type: FAKE_TYPE, props: { kept: 'h0' } }],
        historyIndex: 0,
      },
    })
    const restored = useTilingStore.getState().windows.w1
    // Active props deserialized (hydrated marker).
    expect(restored.props).toEqual({ kept: 'active', hydrated: true })
    // History entries ALSO deserialized by their own type — the fix.
    expect(restored.history).toEqual([{ type: FAKE_TYPE, props: { kept: 'h0', hydrated: true } }])
  })

  it('falls back to raw history props for an unknown type (never throws)', () => {
    const out = serializeWindowsForPersistence({
      w1: makeWindow({
        type: 'totally-unknown',
        history: [{ type: 'totally-unknown', props: { a: 1 } }],
      }),
    } as any)
    const w = out.w1 as any
    expect(w.history).toEqual([{ type: 'totally-unknown', props: { a: 1 } }])
  })
})
