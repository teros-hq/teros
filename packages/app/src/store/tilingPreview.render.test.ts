/**
 * Preview tabs in the tiling shell (docs/specs/ui/preview-tabs.md).
 *
 * GLOBAL per desktop (VS Code preview tabs, Pablo 2026-10-30): every NEW open
 * routes to the desktop's preview tab — reused when one exists anywhere in
 * the desktop, else created in the RIGHTMOST+TOPMOST panel. Pinning
 * (`pinWindow`, `pin: true`, double-click) turns it into a normal tab; the
 * next open then creates a fresh preview. ONLY the pin click pins (Pablo
 * 2026-11-01): acting from the preview reuses it. Opt-outs: `inNewTab`
 * (ctrl/cmd click), launcher, `noPreview` definitions. Draft chats are NOT
 * an opt-out: they are new content (configure agent → Chat, Pablo
 * 2026-11-01).
 *
 * Lives under `.render.test.ts` because importing the store pulls
 * react-native via services/storage, which the render harness shims.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type WindowTypeDefinition, windowRegistry } from '../services/windowRegistry'
import {
  type ContainerNode,
  type LayoutNode,
  findRightmostTopmostContainer,
  serializeWindowsForPersistence,
  useTilingStore,
} from './tilingStore'

const LIST = '__preview_list__'
const DETAIL = '__preview_detail__'
const LIVE = '__preview_live__'

function def(type: string, extra: Partial<WindowTypeDefinition> = {}): WindowTypeDefinition {
  return {
    type,
    audience: 'user',
    displayName: type,
    icon: (() => null) as unknown as WindowTypeDefinition['icon'],
    color: '#000000',
    getTitle: () => type,
    defaultSize: { width: 100, height: 100 },
    component: (() => null) as unknown as WindowTypeDefinition['component'],
    serialize: (props) => props,
    deserialize: (data) => data,
    ...extra,
  }
}

function containers(node: LayoutNode | null): ContainerNode[] {
  if (!node) return []
  if (node.type === 'container') return [node]
  return [...containers(node.first), ...containers(node.second)]
}

const s = () => useTilingStore.getState()
const layout = () => s().desktops[s().activeDesktopIndex].layout
const paneOf = (windowId: string) => containers(layout()).find((c) => c.windowIds.includes(windowId))!

beforeEach(() => {
  windowRegistry.register(def(LIST))
  windowRegistry.register(def(DETAIL))
  windowRegistry.register(def(LIVE, { noPreview: true }))
  useTilingStore.setState({ windows: {}, nextId: 1 })
  s().resetDesktops()
  s().setCompactShell(false)
})
afterEach(() => {
  windowRegistry.unregister(LIST)
  windowRegistry.unregister(DETAIL)
  windowRegistry.unregister(LIVE)
})

describe('findRightmostTopmostContainer (geometry)', () => {
  it('returns null for an empty desktop', () => {
    expect(findRightmostTopmostContainer(null)).toBeNull()
  })

  it('single pane: the pane itself', () => {
    const w = s().openWindow(LIST, {})!
    expect(findRightmostTopmostContainer(layout())).toBe(paneOf(w).id)
  })

  it('two side-by-side panes: the right one', () => {
    const a = s().openWindow(LIST, {})!
    s().splitContainer(paneOf(a).id, 'horizontal')
    const panes = containers(layout())
    // splitContainer puts the fresh pane as `second` (right of the source).
    expect(findRightmostTopmostContainer(layout())).toBe(panes[1].id)
  })

  it('nested splits: H(A, V(B, C)) picks B (right column, upper pane)', () => {
    const a = s().openWindow(LIST, {})!
    const left = paneOf(a)
    s().splitContainer(left.id, 'horizontal')
    const right = containers(layout()).find((c) => c.id !== left.id)!
    // Stack the right column: split the RIGHT pane vertically.
    s().splitContainer(right.id, 'vertical')
    const all = containers(layout())
    // all = [A, B, C] in tree order: A left, then right column top→bottom.
    expect(all).toHaveLength(3)
    const winner = findRightmostTopmostContainer(layout())
    // The right column's top pane (B) — same right edge as C, higher top.
    expect(winner).toBe(all[1].id)
    expect(winner).not.toBe(all[0].id)
    expect(winner).not.toBe(all[2].id)
  })

  it('V(A, H(B, C)): the top pane wins the right-edge tie', () => {
    const a = s().openWindow(LIST, {})!
    const top = paneOf(a)
    s().splitContainer(top.id, 'vertical')
    const bottom = containers(layout()).find((c) => c.id !== top.id)!
    s().splitContainer(bottom.id, 'horizontal')
    const all = containers(layout())
    const winner = findRightmostTopmostContainer(layout())
    // Top pane reaches the right edge with top=0; the bottom row starts at y=0.5.
    expect(winner).toBe(all[0].id)
  })
})

describe('global preview routing (default opens)', () => {
  it('first open on an empty desktop is a normal tab (not preview)', () => {
    const w = s().openWindow(LIST, {})!
    expect(s().windows[w].preview).toBeUndefined()
  })

  it('a NEW open lands as a preview tab in the rightmost+topmost pane', () => {
    const list = s().openWindow(LIST, {})!
    const p = s().openWindow(DETAIL, { n: 1 })!
    expect(s().windows[p]).toMatchObject({ preview: true })
    // No split was created — the preview went into an EXISTING pane.
    expect(containers(layout())).toHaveLength(1)
    expect(paneOf(p).id).toBe(paneOf(list).id)
    // Without a source window the preview is focused (VS Code click-browse).
    expect(paneOf(p).activeWindowId).toBe(p)
  })

  it('the second NEW open REUSES the preview tab — tabs do not pile up', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 })!
    const p2 = s().openWindow(DETAIL, { n: 2 })!
    expect(p2).toBe(p1)
    expect(paneOf(p1).windowIds).toEqual([list, p1])
    expect(s().windows[p1].props).toEqual({ n: 2 })
    expect(s().windows[p1].history.map((h) => h.props)).toEqual([{ n: 1 }, { n: 2 }])
    // Back walks the preview's selections.
    s().navigateBack(p1)
    expect(s().windows[p1].props).toEqual({ n: 1 })
    expect(s().windows[p1].preview).toBe(true)
  })

  it('with a source window the caller keeps the focus (keyboard lists)', () => {
    const list = s().openWindow(LIST, {})!
    const p = s().openWindow(DETAIL, { n: 1 }, { sourceWindowId: list })!
    expect(s().windows[p]).toMatchObject({ preview: true, openerId: list })
    // The preview is the visible tab of its pane…
    expect(paneOf(p).activeWindowId).toBe(p)
    // …but the pane focus stays with the caller.
    expect(s().desktops[0].activeContainerId).toBe(paneOf(list).id)
  })

  it('the preview lands in the RIGHTMOST pane when the desktop is split', () => {
    const a = s().openWindow(LIST, {})!
    s().splitContainer(paneOf(a).id, 'horizontal')
    const right = containers(layout()).find((c) => c.id !== paneOf(a).id)!
    const p = s().openWindow(DETAIL, { n: 1 })!
    expect(paneOf(p).id).toBe(right.id)
    expect(containers(layout())).toHaveLength(2)
  })

  it('pinWindow makes the tab permanent; the next open creates a NEW preview', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 })!
    s().pinWindow(p1)
    expect(s().windows[p1].preview).toBe(false)
    const p2 = s().openWindow(DETAIL, { n: 2 })!
    expect(p2).not.toBe(p1)
    expect(paneOf(p2).windowIds).toEqual([list, p1, p2])
    expect(s().windows[p2].preview).toBe(true)
    expect(s().windows[p1].props).toEqual({ n: 1 })
  })

  it('an existing identical window is FOCUSED, not duplicated (dedupe wins)', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 })!
    s().pinWindow(p1)
    const p2 = s().openWindow(DETAIL, { n: 2 })!
    const back = s().openWindow(DETAIL, { n: 1 })!
    expect(back).toBe(p1)
    expect(paneOf(p1).activeWindowId).toBe(p1)
    expect(paneOf(p1).windowIds).toEqual([list, p1, p2])
  })

  it('each desktop keeps its OWN preview tab', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 })!
    s().addDesktop()
    const list2 = s().openWindow(LIST, { k: 2 })!
    const p2 = s().openWindow(DETAIL, { n: 2 })!
    expect(p2).not.toBe(p1)
    expect(s().windows[p1].desktopIndex).toBe(0)
    expect(s().windows[p2].desktopIndex).toBe(1)
    // Reuse is per desktop: another open on desktop 1 reuses p2, not p1.
    const p2b = s().openWindow(DETAIL, { n: 3 })!
    expect(p2b).toBe(p2)
    s().switchToDesktop(0)
    const p1b = s().openWindow(DETAIL, { n: 4 })!
    expect(p1b).toBe(p1)
    expect(list && list2).toBeTruthy()
  })

  it('inNewTab bypasses preview routing — a normal new tab (ctrl/cmd-click)', () => {
    const list = s().openWindow(LIST, {})!
    const t1 = s().openWindow(DETAIL, { n: 1 }, true)!
    expect(s().windows[t1].preview).toBeUndefined()
    const t2 = s().openWindow(DETAIL, { n: 2 }, true)!
    expect(s().windows[t2].preview).toBeUndefined()
    expect(paneOf(t2).windowIds).toEqual([list, t1, t2])
  })

  it('noPreview definitions open as normal tabs', () => {
    const list = s().openWindow(LIST, {})!
    const live = s().openWindow(LIVE, { s: 1 })!
    expect(s().windows[live].preview).toBeUndefined()
    expect(paneOf(live).windowIds).toEqual([list, live])
  })

  it('draft chats follow preview routing (configure agent → Chat)', () => {
    // isDraftChat is keyed on the real "chat" type — register a fake def for it.
    windowRegistry.register(def('chat'))
    try {
      const list = s().openWindow(LIST, {})!
      // A chat WITHOUT channelId (a draft) is new content like any other:
      // it lands in the desktop's preview tab — NOT a separate tab.
      const draft = s().openWindow('chat', { agentId: 'agent_x' })!
      expect(s().windows[draft].preview).toBe(true)
      expect(paneOf(draft).windowIds).toEqual([list, draft])
      // A second draft REPLACES the preview's content — tabs do not pile up
      // (drafts skip dedup, so this exercises the preview reuse path).
      const draft2 = s().openWindow('chat', { agentId: 'agent_y' })!
      expect(draft2).toBe(draft)
      expect(s().windows[draft].props).toEqual({ agentId: 'agent_y' })
    } finally {
      windowRegistry.unregister('chat')
    }
  })

  it('acting FROM the preview reuses it — it does NOT pin (configure agent → Chat)', () => {
    windowRegistry.register(def('chat'))
    try {
      const list = s().openWindow(LIST, {})!
      // The configure-agent window IS the desktop's preview tab.
      const agentWin = s().openWindow(DETAIL, { n: 1 }, { sourceWindowId: list })!
      expect(s().windows[agentWin].preview).toBe(true)
      // Clicking "Chat" inside it: a draft chat whose source IS the preview.
      // The preview is REUSED (same tab, new content) — it is NOT pinned and
      // the chat does NOT open in a separate tab (Pablo 2026-11-01).
      const chat = s().openWindow('chat', { agentId: 'agent_x' }, { sourceWindowId: agentWin })!
      expect(chat).toBe(agentWin)
      expect(s().windows[agentWin]).toMatchObject({ preview: true, type: 'chat' })
      expect(s().windows[agentWin].props).toEqual({ agentId: 'agent_x' })
      expect(paneOf(agentWin).windowIds).toEqual([list, agentWin])
    } finally {
      windowRegistry.unregister('chat')
    }
  })

  it('ctrl/cmd-click on a draft chat still opens a separate normal tab', () => {
    windowRegistry.register(def('chat'))
    try {
      const list = s().openWindow(LIST, {})!
      const draft = s().openWindow('chat', { agentId: 'agent_x' })!
      const separate = s().openWindow('chat', { agentId: 'agent_y' }, true)!
      expect(separate).not.toBe(draft)
      expect(s().windows[separate].preview).toBeUndefined()
      expect(paneOf(separate).windowIds).toEqual([list, draft, separate])
    } finally {
      windowRegistry.unregister('chat')
    }
  })

  it('closing the preview: the next open creates a fresh one', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 })!
    s().closeWindow(p1)
    const p2 = s().openWindow(DETAIL, { n: 2 })!
    expect(p2).not.toBe(p1)
    expect(s().windows[p2].preview).toBe(true)
    expect(paneOf(p2).windowIds).toEqual([list, p2])
  })

  it('persists the preview flag and opener (reload keeps the preview tab)', () => {
    const list = s().openWindow(LIST, {})!
    const p = s().openWindow(DETAIL, { n: 1 }, { sourceWindowId: list })!
    const out = serializeWindowsForPersistence(s().windows) as Record<string, any>
    expect(out[p]).toMatchObject({ preview: true, openerId: list })
    expect(out[list].preview).toBeUndefined()
    s().restoreDesktops(s().desktops, 0, out)
    expect(s().windows[p]).toMatchObject({ preview: true, openerId: list })
  })
})

describe('explicit preview options (list windows)', () => {
  it('opens a preview in the rightmost+topmost pane and reuses it', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 }, { preview: true, sourceWindowId: list })!
    expect(s().windows[p1]).toMatchObject({ preview: true, openerId: list })
    const p2 = s().openWindow(DETAIL, { n: 2 }, { preview: true, sourceWindowId: list })!
    expect(p2).toBe(p1)
  })

  it('pin: true on the identical preview pins it (double-click)', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 }, { preview: true, sourceWindowId: list })!
    const again = s().openWindow(DETAIL, { n: 1 }, { preview: true, pin: true, sourceWindowId: list })!
    expect(again).toBe(p1)
    expect(s().windows[p1].preview).toBe(false)
  })

  it('pin: true on new content adds a PINNED tab beside the preview', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 }, { preview: true, sourceWindowId: list })!
    const pinned = s().openWindow(DETAIL, { n: 9 }, { preview: true, pin: true, sourceWindowId: list })!
    expect(pinned).not.toBe(p1)
    expect(s().windows[pinned].preview).toBe(false)
    expect(paneOf(pinned).windowIds).toEqual([list, p1, pinned])
  })

  it('an existing identical window is shown in place, not duplicated', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 }, { preview: true, sourceWindowId: list })!
    s().pinWindow(p1)
    const p2 = s().openWindow(DETAIL, { n: 2 }, { preview: true, sourceWindowId: list })!
    expect(paneOf(p2).activeWindowId).toBe(p2)
    const back = s().openWindow(DETAIL, { n: 1 }, { preview: true, sourceWindowId: list })!
    expect(back).toBe(p1)
    expect(paneOf(p1).activeWindowId).toBe(p1)
    expect(paneOf(p1).windowIds).toEqual([list, p1, p2])
  })

  it('on the compact shell the preview pushes in the source pane and focuses it', () => {
    s().setCompactShell(true)
    const list = s().openWindow(LIST, {})!
    const p = s().openWindow(DETAIL, { n: 1 }, { preview: true, sourceWindowId: list })!
    expect(containers(layout())).toHaveLength(1)
    expect(paneOf(p).windowIds).toEqual([list, p])
    expect(paneOf(p).activeWindowId).toBe(p)
    expect(s().windows[p].openerId).toBe(list)
    const p2 = s().openWindow(DETAIL, { n: 2 }, { preview: true, sourceWindowId: list })!
    expect(p2).toBe(p)
  })
})

describe('preview invariant (one preview per desktop)', () => {
  it('removeDesktop pins the extra preview of a merged desktop', () => {
    const a = s().openWindow(LIST, {})!
    const p0 = s().openWindow(DETAIL, { n: 0 })!
    s().addDesktop()
    const b = s().openWindow(LIST, { k: 2 })!
    const p1 = s().openWindow(DETAIL, { n: 1 })!
    expect(s().windows[p0].preview).toBe(true)
    expect(s().windows[p1].preview).toBe(true)

    s().removeDesktop(1)
    // Both previews survived the merge; only ONE stays preview.
    const previews = Object.values(s().windows).filter((w) => w.preview)
    expect(previews).toHaveLength(1)
    // The survivor is the one in the rightmost+topmost pane of the merged desktop.
    const keep = findRightmostTopmostContainer(s().desktops[0].layout)
    expect(previews[0].containerId).toBe(keep)
    expect(s().windows[p1].preview).toBe(false)
    expect(a && b).toBeTruthy()
  })

  it('restoreDesktops pins extras from an old persisted state', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 })!
    const p2 = s().openWindow(DETAIL, { n: 2 }, true)! // normal tab
    // Simulate an old state with two previews on one desktop.
    const out = serializeWindowsForPersistence(s().windows) as Record<string, any>
    out[p2].preview = true
    s().restoreDesktops(s().desktops, 0, out)
    const previews = Object.values(s().windows).filter((w) => w.preview)
    expect(previews).toHaveLength(1)
    expect(s().windows[p1].preview).toBe(true)
    expect(s().windows[p2].preview).toBe(false)
    expect(list).toBeTruthy()
  })
})

describe('openNewTab (+ button: pin the old preview, new tab becomes preview)', () => {
  beforeEach(() => {
    windowRegistry.register(def('launcher'))
  })

  const previews = () => Object.values(s().windows).filter((w) => w.preview)

  it('pins the current preview and the new launcher tab becomes the preview', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 }, { preview: true, sourceWindowId: list })!
    const fresh = s().openNewTab(list)!
    expect(s().windows[p1].preview).toBe(false)
    expect(s().windows[fresh].type).toBe('launcher')
    expect(s().windows[fresh].preview).toBe(true)
    expect(previews().map((w) => w.id)).toEqual([fresh])
  })

  it('without a previous preview nothing is pinned; the new tab is the preview', () => {
    const list = s().openWindow(LIST, {}, true)!
    expect(s().windows[list].preview).toBeFalsy()
    const fresh = s().openNewTab(list)!
    expect(s().windows[list].preview).toBeFalsy()
    expect(previews().map((w) => w.id)).toEqual([fresh])
  })

  it('a preview already pinned manually is not touched twice; still one preview', () => {
    const list = s().openWindow(LIST, {})!
    const p1 = s().openWindow(DETAIL, { n: 1 }, { preview: true, sourceWindowId: list })!
    s().pinWindow(p1)
    const a = s().openNewTab(list)!
    const b = s().openNewTab(a)!
    expect(s().windows[p1].preview).toBe(false)
    expect(s().windows[a].preview).toBe(false)
    expect(previews().map((w) => w.id)).toEqual([b])
  })
})
