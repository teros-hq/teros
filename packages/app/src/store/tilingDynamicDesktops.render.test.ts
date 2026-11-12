/**
 * Dynamic desktops (task tn_pA4USvSgNqk9NLS3).
 *
 * `addDesktop` / `removeDesktop` on the tiling store: creation up to the hard
 * cap MAX_DESKTOPS (10), removal that never takes the last desktop and never
 * closes windows silently (they merge into the PREVIOUS desktop), window
 * desktopIndex reindexing after a removal, and the persistence roundtrip —
 * the whole desktops array (layouts + windows + active index) survives
 * serialize → restoreDesktops, which is the same path persistToStorage →
 * restoreFromStorage takes.
 *
 * Lives under `.render.test.ts` because importing the store pulls
 * react-native via services/storage, which the render harness shims.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type WindowTypeDefinition, windowRegistry } from '../services/windowRegistry'
import {
  MAX_DESKTOPS,
  serializeWindowsForPersistence,
  useTilingStore,
} from './tilingStore'

const FAKE_TYPE = '__dynamic_desktops_test__'

const fakeDefinition: WindowTypeDefinition = {
  type: FAKE_TYPE,
  audience: 'user',
  displayName: 'Fake',
  icon: (() => null) as unknown as WindowTypeDefinition['icon'],
  color: '#000000',
  getTitle: () => 'Fake',
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition['component'],
  serialize: (props) => props,
  deserialize: (data) => data,
}

const s = () => useTilingStore.getState()

/** Open a window on the ACTIVE desktop and return its id. */
function openFake(n: number): string {
  return s().openWindow(FAKE_TYPE, { n })!
}

beforeEach(() => {
  windowRegistry.register(fakeDefinition)
  useTilingStore.setState({ windows: {}, nextId: 1 })
  s().resetDesktops()
  s().setCompactShell(false)
})
afterEach(() => {
  windowRegistry.unregister(FAKE_TYPE)
})

describe('addDesktop', () => {
  it('starts from the single default desktop', () => {
    expect(s().desktops).toHaveLength(1)
    expect(s().activeDesktopIndex).toBe(0)
  })

  it('creates a new empty desktop and switches to it', () => {
    const idx = s().addDesktop()
    expect(idx).toBe(1)
    expect(s().desktops).toHaveLength(2)
    expect(s().activeDesktopIndex).toBe(1)
    expect(s().desktops[1].layout).toBeNull()
    expect(s().desktops[1].name).toBe('Desktop 2')
    // Derived state follows the new active desktop.
    expect(s().layout).toBeNull()
    expect(s().activeContainerId).toBeNull()
  })

  it('hard-caps at MAX_DESKTOPS (10) — no 11th desktop', () => {
    // Start at 1, add until 10.
    for (let i = 1; i < MAX_DESKTOPS; i++) {
      expect(s().addDesktop()).not.toBeNull()
    }
    expect(s().desktops).toHaveLength(MAX_DESKTOPS)
    // The 11th is refused.
    expect(s().addDesktop()).toBeNull()
    expect(s().desktops).toHaveLength(MAX_DESKTOPS)
    expect(s().activeDesktopIndex).toBe(MAX_DESKTOPS - 1)
  })
})

describe('removeDesktop', () => {
  it('never removes the last remaining desktop', () => {
    expect(s().desktops).toHaveLength(1)
    expect(s().removeDesktop(0)).toBe(false)
    expect(s().desktops).toHaveLength(1)
  })

  it('moves the removed desktop windows into the PREVIOUS desktop — nothing is lost', () => {
    // Desktop 0: one window. Desktop 1: two windows.
    const a = openFake(1)
    s().addDesktop()
    const b = openFake(2)
    const c = s().openWindow(FAKE_TYPE, { n: 3 }, true, b)!
    expect(s().desktops).toHaveLength(2)

    const ok = s().removeDesktop(1)
    expect(ok).toBe(true)
    expect(s().desktops).toHaveLength(1)

    // All three windows survive, now on desktop 0.
    expect(Object.keys(s().windows)).toHaveLength(3)
    for (const w of Object.values(s().windows)) {
      expect(w.desktopIndex).toBe(0)
    }
    // a keeps its own container; b and c merged into desktop 0's active container.
    const layout = s().desktops[0].layout!
    const allIds: string[] = []
    const walk = (node: any) => {
      if (!node) return
      if (node.type === 'container') allIds.push(...node.windowIds)
      else {
        walk(node.first)
        walk(node.second)
      }
    }
    walk(layout)
    expect(allIds.sort()).toEqual([a, b, c].sort())
    // Active desktop follows the merge target.
    expect(s().activeDesktopIndex).toBe(0)
  })

  it('reindexes windows on desktops after the removed one', () => {
    // Three desktops: w0 on 0, w1 on 1, w2 on 2.
    const w0 = openFake(0)
    s().addDesktop()
    const w1 = openFake(1)
    s().addDesktop()
    const w2 = openFake(2)
    expect(s().desktops).toHaveLength(3)

    // Remove the MIDDLE one (index 1): w1 merges into 0, w2 shifts 2 → 1.
    expect(s().removeDesktop(1)).toBe(true)
    expect(s().desktops).toHaveLength(2)
    expect(s().windows[w0].desktopIndex).toBe(0)
    expect(s().windows[w1].desktopIndex).toBe(0)
    expect(s().windows[w2].desktopIndex).toBe(1)
  })

  it('merges into the first desktop when removing desktop 0', () => {
    const a = openFake(1)
    s().addDesktop()
    const b = openFake(2)

    expect(s().removeDesktop(0)).toBe(true)
    expect(s().desktops).toHaveLength(1)
    // Both windows land on the (new) desktop 0 — the previous desktop 1.
    expect(s().windows[a].desktopIndex).toBe(0)
    expect(s().windows[b].desktopIndex).toBe(0)
    expect(Object.keys(s().windows)).toHaveLength(2)
  })
})

describe('persistence roundtrip (dynamic desktops)', () => {
  it('keeps every desktop layout, window and the active index across serialize → restore', () => {
    // Desktop 0 with one window, desktop 1 with another.
    const a = openFake(1)
    s().addDesktop()
    const b = openFake(2)
    expect(s().activeDesktopIndex).toBe(1)

    // The exact shape persistToStorage writes.
    const serialized = {
      version: 2 as const,
      desktops: s().desktops,
      windows: serializeWindowsForPersistence(s().windows) as any,
      activeDesktopIndex: s().activeDesktopIndex,
      maxDesktops: s().maxDesktops,
      nextId: s().nextId,
    }

    // Simulate a reload: empty store, then restore.
    s().resetDesktops()
    useTilingStore.setState({ windows: {} })
    expect(s().desktops).toHaveLength(1)
    expect(Object.keys(s().windows)).toHaveLength(0)

    s().restoreDesktops(serialized.desktops, serialized.activeDesktopIndex, serialized.windows)

    expect(s().desktops).toHaveLength(2)
    expect(s().activeDesktopIndex).toBe(1)
    expect(Object.keys(s().windows)).toHaveLength(2)
    expect(s().windows[a].desktopIndex).toBe(0)
    expect(s().windows[b].desktopIndex).toBe(1)
    // Each desktop kept its layout with its own window.
    const idsOn = (i: number) => {
      const out: string[] = []
      const walk = (node: any) => {
        if (!node) return
        if (node.type === 'container') out.push(...node.windowIds)
        else {
          walk(node.first)
          walk(node.second)
        }
      }
      walk(s().desktops[i].layout)
      return out
    }
    expect(idsOn(0)).toEqual([a])
    expect(idsOn(1)).toEqual([b])
    // Derived state points at the restored active desktop.
    expect(s().layout).toBe(s().desktops[1].layout)
  })

  it('restore clamps a stale activeDesktopIndex beyond the restored range', () => {
    s().addDesktop()
    s().addDesktop()
    s().restoreDesktops(s().desktops, 5, {})
    expect(s().activeDesktopIndex).toBe(2)
  })
})
