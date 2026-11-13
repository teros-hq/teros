import { Platform } from "react-native"
import {
  clampRect,
  type FloatRect,
  type Floats,
  MAX_OPEN_FLOATS,
  frontId,
  overflowToDock,
  overflowToMinimize,
  placeNew,
  topZ,
  type Viewport,
} from "./floatGeometry"
import type { ContainerNode, Desktop, LayoutNode, TilingWindow } from "./tilingStore"

export interface FloatSlice {
  desktops: Desktop[]
  windows: Record<string, TilingWindow>
  floats: Floats
  activeDesktopIndex: number
  nextId: number
}

export interface FloatPlacement {
  at?: { x: number; y: number } | null
  rect?: FloatRect
}

const NOMINAL_VIEWPORT: Viewport = { w: 1280, h: 800 }
const Z_CEILING = 200

export function floatsSupported(): boolean {
  return Platform.OS === "web"
}

export function viewport(): Viewport {
  if (typeof window === "undefined") return NOMINAL_VIEWPORT
  const w = Number(window.innerWidth)
  const h = Number(window.innerHeight)
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : NOMINAL_VIEWPORT
}

function containersOf(node: LayoutNode | null): ContainerNode[] {
  if (!node) return []
  if (node.type === "container") return [node]
  return [...containersOf(node.first), ...containersOf(node.second)]
}

function containerById(node: LayoutNode | null, id: string): ContainerNode | null {
  return containersOf(node).find((c) => c.id === id) ?? null
}

function withContainer(node: LayoutNode, next: ContainerNode): LayoutNode {
  if (node.type === "container") return node.id === next.id ? next : node
  return { ...node, first: withContainer(node.first, next), second: withContainer(node.second, next) }
}

function withoutContainer(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === "container") return node.id === id ? null : node
  const first = withoutContainer(node.first, id)
  const second = withoutContainer(node.second, id)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1))
}

export function dockedWindowIds(desktops: Desktop[]): Set<string> {
  const ids = new Set<string>()
  for (const desktop of desktops)
    for (const container of containersOf(desktop.layout))
      for (const id of container.windowIds) ids.add(id)
  return ids
}

function detach(desktops: Desktop[], window: TilingWindow): Desktop[] {
  const desktop = desktops[window.desktopIndex]
  const container = desktop ? containerById(desktop.layout, window.containerId) : null
  if (!desktop?.layout || !container || !container.windowIds.includes(window.id)) return desktops
  const windowIds = container.windowIds.filter((id) => id !== window.id)
  const next = [...desktops]
  if (windowIds.length === 0) {
    const layout = withoutContainer(desktop.layout, container.id)
    const activeContainerId =
      desktop.activeContainerId === container.id
        ? (containersOf(layout)[0]?.id ?? null)
        : desktop.activeContainerId
    next[window.desktopIndex] = { ...desktop, layout, activeContainerId }
    return next
  }
  const activeWindowId =
    container.activeWindowId === window.id
      ? windowIds[windowIds.length - 1]
      : container.activeWindowId
  next[window.desktopIndex] = {
    ...desktop,
    layout: withContainer(desktop.layout, { ...container, windowIds, activeWindowId }),
  }
  return next
}

function attach(state: FloatSlice, windowId: string, activate: boolean): FloatSlice | null {
  const window = state.windows[windowId]
  if (!window || state.desktops.length === 0) return null
  const activeIndex = clampIndex(state.activeDesktopIndex, state.desktops.length)
  const found = state.desktops.findIndex((d) => !!containerById(d.layout, window.containerId))
  const homeIndex = found >= 0 ? found : activeIndex
  const home = containerById(state.desktops[homeIndex]?.layout ?? null, window.containerId)
  const useHome = !!home && (!activate || homeIndex === activeIndex)
  const desktopIndex = useHome ? homeIndex : activeIndex
  const desktop = state.desktops[desktopIndex]
  let nextId = state.nextId
  let container =
    (useHome ? home : null) ??
    (desktop.activeContainerId ? containerById(desktop.layout, desktop.activeContainerId) : null) ??
    containersOf(desktop.layout)[0] ??
    null
  let layout = desktop.layout
  if (!container || !layout) {
    container = {
      type: "container",
      id: `container_${nextId}_${Math.random().toString(36).slice(2, 6)}`,
      windowIds: [],
      activeWindowId: null,
    }
    layout = container
    nextId += 1
  }
  const docked: ContainerNode = {
    ...container,
    windowIds: [...container.windowIds.filter((id) => id !== windowId), windowId],
    activeWindowId: activate ? windowId : (container.activeWindowId ?? windowId),
  }
  const desktops = [...state.desktops]
  desktops[desktopIndex] = {
    ...desktop,
    layout: withContainer(layout, docked),
    activeContainerId: activate ? docked.id : (desktop.activeContainerId ?? docked.id),
  }
  const floats = { ...state.floats }
  delete floats[windowId]
  return {
    ...state,
    desktops,
    floats,
    nextId,
    windows: {
      ...state.windows,
      [windowId]: { ...window, containerId: docked.id, desktopIndex },
    },
  }
}

function makeRoom(state: FloatSlice, maxOpen: number): FloatSlice {
  let next = state
  for (const id of overflowToDock(next.floats)) next = attach(next, id, false) ?? next
  const toMinimize = overflowToMinimize(next.floats, maxOpen)
  if (toMinimize.length === 0) return next
  const floats = { ...next.floats }
  for (const id of toMinimize) floats[id] = { ...floats[id], minimized: true }
  return { ...next, floats }
}

function place(floats: Floats, placement: FloatPlacement | undefined, vp: Viewport): FloatRect {
  if (placement?.rect) return clampRect(placement.rect, vp)
  return placeNew(vp, Object.values(floats), placement?.at ?? null)
}

export function floatOut(
  state: FloatSlice,
  windowId: string,
  placement: FloatPlacement | undefined,
  vp: Viewport,
  maxOpen: number = MAX_OPEN_FLOATS,
): FloatSlice | null {
  const window = state.windows[windowId]
  if (!window || state.floats[windowId]) return null
  const detached: FloatSlice = {
    ...state,
    desktops: detach(state.desktops, window),
    windows: { ...state.windows, [windowId]: { ...window, preview: false, openerId: undefined } },
  }
  const roomy = makeRoom(detached, maxOpen)
  return {
    ...roomy,
    floats: {
      ...roomy.floats,
      [windowId]: {
        ...place(roomy.floats, placement, vp),
        minimized: false,
        z: topZ(roomy.floats) + 1,
      },
    },
  }
}

export function openFloating(
  state: FloatSlice,
  window: TilingWindow,
  placement: FloatPlacement | undefined,
  vp: Viewport,
  maxOpen: number = MAX_OPEN_FLOATS,
): FloatSlice {
  const roomy = makeRoom({ ...state, windows: { ...state.windows, [window.id]: window } }, maxOpen)
  return {
    ...roomy,
    nextId: roomy.nextId + 1,
    floats: {
      ...roomy.floats,
      [window.id]: {
        ...place(roomy.floats, placement, vp),
        minimized: false,
        z: topZ(roomy.floats) + 1,
      },
    },
  }
}

export function dockIn(state: FloatSlice, windowId: string, activate: boolean): FloatSlice | null {
  if (!state.floats[windowId]) return null
  return attach(state, windowId, activate)
}

export function raiseFloat(
  floats: Floats,
  windowId: string,
  maxOpen: number = MAX_OPEN_FLOATS,
): Floats {
  const entry = floats[windowId]
  if (!entry) return floats
  if (!entry.minimized && frontId(floats) === windowId) return floats
  const others = { ...floats }
  delete others[windowId]
  const roomy = { ...others }
  for (const id of overflowToMinimize(others, maxOpen))
    roomy[id] = { ...roomy[id], minimized: true }
  return renumber({ ...roomy, [windowId]: { ...entry, minimized: false, z: topZ(floats) + 1 } })
}

function renumber(floats: Floats): Floats {
  if (topZ(floats) <= Z_CEILING) return floats
  const next: Floats = {}
  Object.keys(floats)
    .sort((a, b) => floats[a].z - floats[b].z)
    .forEach((id, index) => {
      next[id] = { ...floats[id], z: index + 1 }
    })
  return next
}

export function adoptOrphans(state: FloatSlice): FloatSlice {
  const docked = dockedWindowIds(state.desktops)
  let next = state
  for (const id of Object.keys(state.windows)) {
    if (docked.has(id) || next.floats[id]) continue
    next = attach(next, id, false) ?? next
  }
  return next
}

export function followDesktop(
  windows: Record<string, TilingWindow>,
  floats: Floats,
  desktopIndex: number,
): Record<string, TilingWindow> {
  let next = windows
  for (const id of Object.keys(floats)) {
    const window = next[id]
    if (!window || window.desktopIndex === desktopIndex) continue
    if (next === windows) next = { ...windows }
    next[id] = { ...window, desktopIndex }
  }
  return next
}

export function minimizeIn(
  floats: Floats,
  windowId: string,
  minimized: boolean,
  maxOpen: number = MAX_OPEN_FLOATS,
): Floats {
  const entry = floats[windowId]
  if (!entry || entry.minimized === minimized) return floats
  if (!minimized) return raiseFloat(floats, windowId, maxOpen)
  return { ...floats, [windowId]: { ...entry, minimized: true } }
}

export function withoutFloat(floats: Floats, windowId: string): Floats {
  if (!floats[windowId]) return floats
  const next = { ...floats }
  delete next[windowId]
  return next
}

export function isOnScreen(
  state: Pick<FloatSlice, "desktops" | "floats" | "activeDesktopIndex"> & {
    compactShell: boolean
    floatSheetId: string | null
  },
  windowId: string,
): boolean {
  const entry = state.floats[windowId]
  if (entry) return state.compactShell ? state.floatSheetId === windowId : !entry.minimized
  const desktop = state.desktops[state.activeDesktopIndex]
  if (!desktop?.layout || !desktop.activeContainerId) return false
  const container = containerById(desktop.layout, desktop.activeContainerId)
  return container?.activeWindowId === windowId
}
