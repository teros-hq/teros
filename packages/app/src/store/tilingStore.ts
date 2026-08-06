/**
 * Tiling Store - Tiling window manager layout state
 *
 * Inspired by i3/dwm/awesome:
 * - Tree-based split layout (horizontal/vertical)
 * - Each leaf node is a "container" with tabs
 * - No floating windows, everything is tiling
 */

import { create } from "zustand"
import { STORAGE_KEYS, storage, persistedDriver } from "../services/storage"
import { windowRegistry } from "../services/windowRegistry"

// ============================================
// TYPES
// ============================================

/** Split direction */
export type SplitDirection = "horizontal" | "vertical"

/** Split node (divides space in two) */
export interface SplitNode {
  type: "split"
  id: string
  direction: SplitDirection
  /** Ratio of the first child (0-1) */
  ratio: number
  // @todo nira - 2026-05-05: was LayoutNode — recursive type causes TS stack overflow.
  // Refactor to a tagged/flat union or explicit depth-limited type once tsc is green.
  first: any
  second: any
}

/** Container node (holds tabs with windows) */
export interface ContainerNode {
  type: "container"
  id: string
  /** IDs of the windows in this container (as tabs) */
  windowIds: string[]
  /** ID of the active window in this container */
  activeWindowId: string | null
}

/** A layout tree node */
export type LayoutNode = SplitNode | ContainerNode

/** A single entry in a window's navigation history */
export interface WindowHistoryEntry {
  type: string
  props: Record<string, any>
}

/** Max number of history entries per window */
const MAX_HISTORY_LENGTH = 50

/** Window data */
export interface TilingWindow {
  id: string
  type: string // Window type (e.g. 'chat')
  props: Record<string, any> // Window-specific props
  containerId: string // Container it belongs to
  desktopIndex: number // Desktop it belongs to
  hasNotification: boolean
  notificationCount?: number
  /** Navigation history for this window (back/forward) */
  history: WindowHistoryEntry[]
  /** Current position in history (points to current type+props) */
  historyIndex: number
}

/** A virtual desktop (workspace) */
export interface Desktop {
  id: string // 'desktop_0', 'desktop_1', etc.
  name?: string // Optional name
  layout: LayoutNode | null
  activeContainerId: string | null
}

/** Serializable state for persistence */
export interface SerializedWorkspaceState {
  version: 2
  desktops: Desktop[]
  windows: Record<string, TilingWindow>
  activeDesktopIndex: number
  maxDesktops: number
  nextId: number
}

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_MAX_DESKTOPS = 3

// ============================================
// STATE
// ============================================

interface TilingState {
  /** Array of desktops */
  desktops: Desktop[]

  /** All windows (global, indexed by ID) */
  windows: Record<string, TilingWindow>

  /** Active desktop index (0-based) */
  activeDesktopIndex: number

  /** Maximum number of desktops */
  maxDesktops: number

  /** Counter for unique IDs */
  nextId: number
}

/** Derived state computed from the active desktop */
interface TilingDerivedState {
  /** Layout of the active desktop (derived) */
  layout: LayoutNode | null

  /** Active container ID in the active desktop (derived) */
  activeContainerId: string | null
}

interface TilingActions {
  // ========================================
  // DESKTOP NAVIGATION
  // ========================================

  /** Switch to the specified desktop */
  switchToDesktop: (index: number) => void

  /** Go to the next desktop */
  nextDesktop: () => void

  /** Go to the previous desktop */
  prevDesktop: () => void

  /** Rename a desktop */
  renameDesktop: (index: number, name: string) => void

  /** Move window to another desktop */
  moveWindowToDesktop: (windowId: string, targetDesktopIndex: number) => void

  /** Get the active desktop */
  getActiveDesktop: () => Desktop

  /** Count windows in a desktop */
  getDesktopWindowCount: (desktopIndex: number) => number

  /** Restore desktops from persisted state (e.g. loaded from server) */
  restoreDesktops: (
    desktops: Desktop[],
    activeDesktopIndex: number,
    windows?: Record<string, unknown>,
  ) => void

  /** Reset all desktops to empty (e.g. when switching to a workspace with no saved state) */
  resetDesktops: () => void

  // ========================================
  // WINDOW MANAGEMENT
  // ========================================

  /**
   * Open window - by default replaces the active tab, with inNewTab=true opens a new tab.
   * Pass sourceWindowId to open in the same container as the caller window (avoids
   * stealing focus from a different pane).
   */
  openWindow: (
    type: string,
    props: Record<string, any>,
    inNewTab?: boolean,
    sourceWindowId?: string,
  ) => string | null

  /** Close window */
  closeWindow: (windowId: string) => void

  /** Update window props */
  updateWindowProps: (windowId: string, props: Partial<Record<string, any>>) => void

  /** Focus window (activates its container and tab) */
  focusWindow: (windowId: string) => void

  /** Replace type and props of an existing window (pushes to history) */
  replaceWindow: (windowId: string, newType: string, newProps: Record<string, any>) => void

  /** Navigate back in a window's history */
  navigateBack: (windowId: string) => void

  /** Navigate forward in a window's history */
  navigateForward: (windowId: string) => void

  // ========================================
  // CONTAINER MANAGEMENT
  // ========================================

  /** Focus a container */
  focusContainer: (containerId: string) => void

  /** Change active tab in a container */
  setActiveTab: (containerId: string, windowId: string) => void

  /** Reorder tabs in a container */
  reorderTabs: (containerId: string, fromIndex: number, toIndex: number) => void

  // ========================================
  // SPLIT MANAGEMENT
  // ========================================

  /** Split the active container */
  splitActive: (direction: SplitDirection) => void

  /** Split a specific container */
  splitContainer: (containerId: string, direction: SplitDirection) => void

  /** Adjust ratio of a split */
  setRatio: (splitId: string, ratio: number) => void

  /** Close container (and merge if empty) */
  closeContainer: (containerId: string) => void

  // ========================================
  // NAVIGATION
  // ========================================

  /** Move focus to the container in the given direction */
  focusDirection: (direction: "left" | "right" | "up" | "down") => void

  /** Move window to the container in the given direction */
  moveWindowDirection: (direction: "left" | "right" | "up" | "down") => void

  /** Move window to another existing container */
  moveWindowToContainer: (windowId: string, targetContainerId: string, insertIndex?: number) => void

  /** Move window creating a new split in the target container */
  moveWindowToNewSplit: (
    windowId: string,
    targetContainerId: string,
    direction: SplitDirection,
    position?: "before" | "after",
  ) => void

  /** Swap window with the active window of another container */
  swapWindows: (windowId: string, targetContainerId: string) => void

  /** Move multiple windows to another container */
  moveWindowsToContainer: (windowIds: string[], targetContainerId: string) => void

  /** Move multiple windows creating a new split */
  moveWindowsToNewSplit: (
    windowIds: string[],
    targetContainerId: string,
    direction: SplitDirection,
    position?: "before" | "after",
  ) => void

  /** Swap all windows of a container with those of another */
  swapContainerWindows: (sourceContainerId: string, targetContainerId: string) => void

  // ========================================
  // GLOBAL DRAG STATE (for cross-desktop drops)
  // ========================================

  /** windowId being dragged, null if none */
  globalDragWindowId: string | null
  /** windowIds being dragged (for group drags) */
  globalDragWindowIds: string[]
  /** whether it's a group drag */
  globalDragIsGroup: boolean
  setGlobalDrag: (windowId: string | null, windowIds: string[], isGroup: boolean) => void
  clearGlobalDrag: () => void

  // ========================================
  // NOTIFICATIONS
  // ========================================

  setWindowNotification: (windowId: string, has: boolean, count?: number) => void
  clearWindowNotification: (windowId: string) => void

  // ========================================
  // HELPERS
  // ========================================

  /** Get container by ID */
  getContainer: (containerId: string) => ContainerNode | null

  /** Get window by ID */
  getWindow: (windowId: string) => TilingWindow | undefined

  /** Find window by type and props */
  findWindow: (
    type: string,
    predicate: (props: Record<string, any>) => boolean,
  ) => TilingWindow | undefined

  // ========================================
  // PERSISTENCE
  // ========================================

  /** Restore layout from PersistedDriver cache (call after persistedDriver.load) */
  restoreFromStorage: () => Promise<void>

  /** Persist current layout to PersistedDriver (debounced write to backend) */
  persistToStorage: () => Promise<void>

  /** Reset desktops to empty state */
  resetState: () => void
}

// ============================================
// HELPERS
// ============================================

function generateId(prefix: string, counter: number): string {
  return `${prefix}_${counter}_${Math.random().toString(36).slice(2, 6)}`
}

/** Create empty desktops */
function createEmptyDesktops(count: number): Desktop[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `desktop_${i}`,
    name: undefined,
    layout: null,
    activeContainerId: null,
  }))
}

/** Find a node in the tree */
function findNode(layout: LayoutNode | null, id: string): LayoutNode | null {
  if (!layout) return null
  if (layout.id === id) return layout

  if (layout.type === "split") {
    const firstResult: LayoutNode | null = findNode(layout.first, id)
    if (firstResult) return firstResult
    return findNode(layout.second, id)
  }

  return null
}

/** Find the parent of a node */
function findParent(layout: LayoutNode | null, id: string): SplitNode | null {
  if (!layout || layout.type === "container") return null

  if (layout.first.id === id || layout.second.id === id) {
    return layout
  }

  const firstResult: SplitNode | null = findParent(layout.first, id)
  if (firstResult) return firstResult
  return findParent(layout.second, id)
}

/** Find all containers */
function findAllContainers(layout: LayoutNode | null): ContainerNode[] {
  if (!layout) return []

  if (layout.type === "container") {
    return [layout]
  }

  return [...findAllContainers(layout.first), ...findAllContainers(layout.second)]
}

/** Replace a node in the tree (immutable) */
function replaceNode(layout: LayoutNode, targetId: string, newNode: LayoutNode): LayoutNode {
  if (layout.id === targetId) {
    return newNode
  }

  if (layout.type === "split") {
    return {
      ...layout,
      first: replaceNode(layout.first, targetId, newNode),
      second: replaceNode(layout.second, targetId, newNode),
    }
  }

  return layout
}

/** Remove a node and return its sibling (for merge) */
function removeNode(layout: LayoutNode, targetId: string): LayoutNode | null {
  if (layout.type === "container") {
    return layout.id === targetId ? null : layout
  }

  // It's a split
  if (layout.first.id === targetId) {
    return layout.second
  }
  if (layout.second.id === targetId) {
    return layout.first
  }

  // Search in children
  const newFirst = removeNode(layout.first, targetId)
  const newSecond = removeNode(layout.second, targetId)

  if (newFirst === null) return newSecond
  if (newSecond === null) return newFirst

  if (newFirst !== layout.first || newSecond !== layout.second) {
    return { ...layout, first: newFirst, second: newSecond }
  }

  return layout
}

// ============================================
// DERIVED STATE HELPER
// ============================================

/** Compute derived state from desktops and activeDesktopIndex */
function computeDerivedState(desktops: Desktop[], activeDesktopIndex: number): TilingDerivedState {
  const activeDesktop = desktops[activeDesktopIndex]
  return {
    layout: activeDesktop?.layout ?? null,
    activeContainerId: activeDesktop?.activeContainerId ?? null,
  }
}

// ============================================
// STORE
// ============================================

export const useTilingStore = create<TilingState & TilingActions>()((set, get): TilingState & TilingActions => ({
  // Initial state
  desktops: createEmptyDesktops(DEFAULT_MAX_DESKTOPS),
  windows: {},
  activeDesktopIndex: 0,
  maxDesktops: DEFAULT_MAX_DESKTOPS,
  nextId: 1,

  // Global drag state
  globalDragWindowId: null,
  globalDragWindowIds: [],
  globalDragIsGroup: false,
  setGlobalDrag: (windowId, windowIds, isGroup) =>
    set({ globalDragWindowId: windowId, globalDragWindowIds: windowIds, globalDragIsGroup: isGroup }),
  clearGlobalDrag: () =>
    set({ globalDragWindowId: null, globalDragWindowIds: [], globalDragIsGroup: false }),

  // ========================================
  // DESKTOP NAVIGATION
  // ========================================

  switchToDesktop: (index) => {
    const state = get()
    if (index < 0 || index >= state.desktops.length) return
    if (index === state.activeDesktopIndex) return
    set({ activeDesktopIndex: index })
    // tab-state (sessionStorage): per-tab active desktop
    storage.set(STORAGE_KEYS.ACTIVE_DESKTOP_INDEX, index)
    // ui-state (localStorage): fallback for new tabs / device-level last known
    storage.set(STORAGE_KEYS.LAST_ACTIVE_DESKTOP_INDEX, index).catch((err) =>
      console.error('[TilingStore] Failed to persist lastActiveDesktopIndex:', err),
    )
  },

  nextDesktop: () => {
    const state = get()
    const nextIndex = (state.activeDesktopIndex + 1) % state.desktops.length
    set({ activeDesktopIndex: nextIndex })
  },

  prevDesktop: () => {
    const state = get()
    const prevIndex = (state.activeDesktopIndex - 1 + state.desktops.length) % state.desktops.length
    set({ activeDesktopIndex: prevIndex })
  },

  renameDesktop: (index, name) => {
    set((state) => {
      if (index < 0 || index >= state.desktops.length) return state
      const newDesktops = [...state.desktops]
      newDesktops[index] = { ...newDesktops[index], name }
      return { desktops: newDesktops }
    })
  },

  moveWindowToDesktop: (windowId, targetDesktopIndex) => {
    const state = get()
    const window = state.windows[windowId]
    if (!window) return
    if (targetDesktopIndex < 0 || targetDesktopIndex >= state.desktops.length) return
    if (window.desktopIndex === targetDesktopIndex) return

    const sourceDesktop = state.desktops[window.desktopIndex]
    const targetDesktop = state.desktops[targetDesktopIndex]

    if (!sourceDesktop.layout) return

    const sourceContainer = findNode(
      sourceDesktop.layout,
      window.containerId,
    ) as ContainerNode | null
    if (!sourceContainer) return

    // Remove from source container
    const newSourceWindowIds = sourceContainer.windowIds.filter((id) => id !== windowId)
    const newSourceActiveWindowId =
      sourceContainer.activeWindowId === windowId
        ? newSourceWindowIds[newSourceWindowIds.length - 1] || null
        : sourceContainer.activeWindowId

    // Update source desktop layout
    let newSourceLayout: LayoutNode | null
    if (newSourceWindowIds.length === 0) {
      newSourceLayout = removeNode(sourceDesktop.layout, sourceContainer.id)
    } else {
      newSourceLayout = replaceNode(sourceDesktop.layout, sourceContainer.id, {
        ...sourceContainer,
        windowIds: newSourceWindowIds,
        activeWindowId: newSourceActiveWindowId,
      })
    }

    let newSourceActiveContainerId = sourceDesktop.activeContainerId
    if (sourceDesktop.activeContainerId === sourceContainer.id && newSourceWindowIds.length === 0) {
      const remainingContainers = findAllContainers(newSourceLayout)
      newSourceActiveContainerId = remainingContainers[0]?.id || null
    }

    // Prepare target desktop
    let newTargetLayout = targetDesktop.layout
    let targetContainerId: string

    if (!newTargetLayout) {
      targetContainerId = generateId("container", state.nextId)
      newTargetLayout = {
        type: "container",
        id: targetContainerId,
        windowIds: [windowId],
        activeWindowId: windowId,
      }
    } else {
      targetContainerId =
        targetDesktop.activeContainerId || findAllContainers(newTargetLayout)[0]?.id
      if (!targetContainerId) return

      const targetContainer = findNode(newTargetLayout, targetContainerId) as ContainerNode
      newTargetLayout = replaceNode(newTargetLayout, targetContainerId, {
        ...targetContainer,
        windowIds: [...targetContainer.windowIds, windowId],
        activeWindowId: windowId,
      })
    }

    const newDesktops = [...state.desktops]
    newDesktops[window.desktopIndex] = {
      ...sourceDesktop,
      layout: newSourceLayout,
      activeContainerId: newSourceActiveContainerId,
    }
    newDesktops[targetDesktopIndex] = {
      ...targetDesktop,
      layout: newTargetLayout,
      activeContainerId: targetContainerId,
    }

    set({
      desktops: newDesktops,
      windows: {
        ...state.windows,
        [windowId]: {
          ...window,
          containerId: targetContainerId,
          desktopIndex: targetDesktopIndex,
        },
      },
      nextId: state.nextId + 1,
    })
  },

  getActiveDesktop: () => {
    const state = get()
    return state.desktops[state.activeDesktopIndex]
  },

  restoreDesktops: (desktops, activeDesktopIndex, rawWindows) => {
    const safeIndex = Math.max(0, Math.min(activeDesktopIndex, desktops.length - 1))

    // Deserialize windows if provided
    let restoredWindows: Record<string, TilingWindow> = {}
    if (rawWindows && Object.keys(rawWindows).length > 0) {
      console.log('[DesktopStateSync] restoring windows:', Object.keys(rawWindows))
      for (const [id, raw] of Object.entries(rawWindows)) {
        const w = raw as any
        if (!w || !w.type) continue

        // Warn on unknown types but still restore with raw props
        if (!windowRegistry.get(w.type)) {
          console.warn(`[DesktopStateSync] unknown window type: ${w.type}`)
        }

        // Deserialize the active props — fall back to raw on error or unknown type
        const props = deserializeProps(w.type, w.props ?? {})

        // The history persists serialized props too, so each entry must be
        // deserialized by ITS OWN type (a window can navigate across types).
        const rawHistory = w.history as WindowHistoryEntry[] | undefined
        const history = rawHistory
          ? rawHistory.map((entry) => ({
              type: entry.type,
              props: deserializeProps(entry.type, entry.props ?? {}),
            }))
          : [{ type: w.type, props }]

        // Always restore the window (never skip)
        restoredWindows[id] = {
          id,
          type: w.type,
          props,
          containerId: w.containerId ?? '',
          desktopIndex: w.desktopIndex ?? 0,
          hasNotification: false,
          notificationCount: undefined,
          history,
          historyIndex: w.historyIndex ?? 0,
        }
      }
    }

    // Clean layout refs against the restored windows
    const validWindowIds = new Set(Object.keys(restoredWindows))
    const cleanedDesktops = validWindowIds.size > 0
      ? desktops.map((desktop) => ({
          ...desktop,
          layout: cleanLayoutWindowRefs(desktop.layout, validWindowIds),
        }))
      : desktops

    set({
      desktops: cleanedDesktops,
      windows: restoredWindows,
      activeDesktopIndex: safeIndex,
      ...computeDerivedState(cleanedDesktops, safeIndex),
    })
  },

  resetDesktops: () => {
    const emptyDesktops = createEmptyDesktops(DEFAULT_MAX_DESKTOPS)
    set({
      desktops: emptyDesktops,
      activeDesktopIndex: 0,
      ...computeDerivedState(emptyDesktops, 0),
    })
  },

  getDesktopWindowCount: (desktopIndex) => {
    const state = get()
    return Object.values(state.windows).filter((w) => w.desktopIndex === desktopIndex).length
  },

  // ========================================
  // WINDOW MANAGEMENT
  // ========================================

  openWindow: (type, props, inNewTab = false, sourceWindowId?: string) => {
    const definition = windowRegistry.get(type)
    if (!definition) {
      console.error(`[TilingStore] Unknown window type: ${type}`)
      throw new Error(`Unknown window type: ${type}`)
    }

    const state = get()

    // Check if a window with same type and props already exists
    // For chat windows without channelId (drafts), we want to create a new window
    // even if there's another draft with the same agentId.
    // Launcher windows are also always created fresh (never deduplicated),
    // so that pressing + always opens a new launcher tab.
    const isDraftChat = type === "chat" && !props.channelId
    const isLauncher = type === "launcher"

    const existingWindow = (isDraftChat || isLauncher)
      ? null
      : Object.values(state.windows).find((w) => {
          if (w.type !== type) return false
          // Compare props - for unique identification
          // Both directions: new props match existing AND existing props match new
          const newPropsMatch = Object.keys(props).every((key) => w.props[key] === props[key])
          const existingPropsMatch = Object.keys(w.props).every(
            (key) => props[key] === w.props[key],
          )
          return newPropsMatch && existingPropsMatch
        })

    if (existingWindow) {
      // If in different desktop, switch to it
      if (existingWindow.desktopIndex !== state.activeDesktopIndex) {
        get().switchToDesktop(existingWindow.desktopIndex)
      }
      get().focusWindow(existingWindow.id)
      return existingWindow.id
    }

    const desktopIndex = state.activeDesktopIndex
    const desktop = state.desktops[desktopIndex]

    let newLayout = desktop.layout

    // Resolve which container to open into:
    // 1. If a sourceWindowId is given, use the container of that window (caller's pane)
    // 2. Otherwise fall back to the desktop's activeContainerId
    let containerId: string | null =
      (sourceWindowId && state.windows[sourceWindowId]?.containerId) ||
      desktop.activeContainerId

    // If there's no layout, create the first container
    if (!newLayout) {
      containerId = generateId("container", state.nextId)
      newLayout = {
        type: "container",
        id: containerId,
        windowIds: [],
        activeWindowId: null,
      }
    }

    // If there's no active container, use the first available
    if (!containerId) {
      const containers = findAllContainers(newLayout)
      if (containers.length > 0) {
        containerId = containers[0].id
      }
    }

    if (!containerId) {
      console.error("[TilingStore] No container available")
      return ""
    }

    const container = findNode(newLayout, containerId) as ContainerNode
    const activeWindowId = container.activeWindowId
    const activeWindow = activeWindowId ? state.windows[activeWindowId] : null

    // DEFAULT BEHAVIOR: Replace active tab (unless inNewTab=true or no active window)
    if (!inNewTab && activeWindow && activeWindowId) {
      // Use replaceWindow to swap the content
      get().replaceWindow(activeWindowId, type, props)
      return activeWindowId
    }

    // NEW TAB BEHAVIOR: Create new window and add to container
    const windowId = generateId("win", state.nextId)

    // Create the window
    const window: TilingWindow = {
      id: windowId,
      type,
      props,
      containerId,
      desktopIndex,
      hasNotification: false,
      history: [{ type, props }],
      historyIndex: 0,
    }

    // Add window to the container
    newLayout = replaceNode(newLayout, containerId, {
      ...container,
      windowIds: [...container.windowIds, windowId],
      activeWindowId: windowId,
    })

    // Update desktop
    const newDesktops = [...state.desktops]
    newDesktops[desktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: containerId,
    }

    set({
      desktops: newDesktops,
      windows: { ...state.windows, [windowId]: window },
      nextId: state.nextId + 1,
    })

    return windowId
  },

  closeWindow: (windowId) => {
    const state = get()
    const window = state.windows[windowId]
    if (!window) return

    const desktop = state.desktops[window.desktopIndex]
    if (!desktop.layout) return

    const container = findNode(desktop.layout, window.containerId) as ContainerNode | null
    if (!container) return

    const newWindowIds = container.windowIds.filter((id) => id !== windowId)
    const newActiveWindowId =
      container.activeWindowId === windowId
        ? newWindowIds[newWindowIds.length - 1] || null
        : container.activeWindowId

    // Update windows
    const newWindows = { ...state.windows }
    delete newWindows[windowId]

    // If the container becomes empty, close it
    if (newWindowIds.length === 0) {
      const newLayout = removeNode(desktop.layout, container.id)

      // Find new active container
      let newActiveContainerId: string | null = null
      if (newLayout) {
        const containers = findAllContainers(newLayout)
        newActiveContainerId = containers[0]?.id || null
      }

      const newDesktops = [...state.desktops]
      newDesktops[window.desktopIndex] = {
        ...desktop,
        layout: newLayout,
        activeContainerId: newActiveContainerId,
      }

      set({
        desktops: newDesktops,
        windows: newWindows,
      })
    } else {
      // Update container
      const newLayout = replaceNode(desktop.layout, container.id, {
        ...container,
        windowIds: newWindowIds,
        activeWindowId: newActiveWindowId,
      })

      const newDesktops = [...state.desktops]
      newDesktops[window.desktopIndex] = {
        ...desktop,
        layout: newLayout,
      }

      set({
        desktops: newDesktops,
        windows: newWindows,
      })
    }
  },

  updateWindowProps: (windowId, props) => {
    set((state) => {
      const window = state.windows[windowId]
      if (!window) return state

      return {
        windows: {
          ...state.windows,
          [windowId]: { ...window, props: { ...window.props, ...props } },
        },
      }
    })
  },

  focusWindow: (windowId) => {
    const state = get()
    const window = state.windows[windowId]
    if (!window) return

    const desktop = state.desktops[window.desktopIndex]
    if (!desktop.layout) return

    const container = findNode(desktop.layout, window.containerId) as ContainerNode | null
    if (!container) return

    // Update active tab and active container
    const newLayout = replaceNode(desktop.layout, container.id, {
      ...container,
      activeWindowId: windowId,
    })

    const newDesktops = [...state.desktops]
    newDesktops[window.desktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: container.id,
    }

    set({ desktops: newDesktops })

    // Clear notification
    get().clearWindowNotification(windowId)
  },

  replaceWindow: (windowId, newType, newProps) => {
    const state = get()
    const window = state.windows[windowId]
    if (!window) return

    const definition = windowRegistry.get(newType)
    if (!definition) {
      console.error(`[TilingStore] Unknown window type: ${newType}`)
      return
    }

    // Build new history: truncate any forward entries, then push new entry
    const currentHistory = window.history ?? [{ type: window.type, props: window.props }]
    const currentIndex = window.historyIndex ?? currentHistory.length - 1
    const truncated = currentHistory.slice(0, currentIndex + 1)
    truncated.push({ type: newType, props: newProps })

    // Cap history length to avoid unbounded growth
    const newHistory =
      truncated.length > MAX_HISTORY_LENGTH
        ? truncated.slice(truncated.length - MAX_HISTORY_LENGTH)
        : truncated

    set({
      windows: {
        ...state.windows,
        [windowId]: {
          ...window,
          type: newType,
          props: newProps,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        },
      },
    })
  },

  navigateBack: (windowId) => {
    const state = get()
    const window = state.windows[windowId]
    if (!window) return

    const history = window.history ?? [{ type: window.type, props: window.props }]
    const currentIndex = window.historyIndex ?? history.length - 1

    if (currentIndex <= 0) return // Nothing to go back to

    const newIndex = currentIndex - 1
    const { type, props } = history[newIndex]

    set({
      windows: {
        ...state.windows,
        [windowId]: {
          ...window,
          type,
          props,
          historyIndex: newIndex,
        },
      },
    })
  },

  navigateForward: (windowId) => {
    const state = get()
    const window = state.windows[windowId]
    if (!window) return

    const history = window.history ?? [{ type: window.type, props: window.props }]
    const currentIndex = window.historyIndex ?? history.length - 1

    if (currentIndex >= history.length - 1) return // Nothing to go forward to

    const newIndex = currentIndex + 1
    const { type, props } = history[newIndex]

    set({
      windows: {
        ...state.windows,
        [windowId]: {
          ...window,
          type,
          props,
          historyIndex: newIndex,
        },
      },
    })
  },

  // ========================================
  // CONTAINER MANAGEMENT
  // ========================================

  focusContainer: (containerId) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      activeContainerId: containerId,
    }
    set({ desktops: newDesktops })
  },

  setActiveTab: (containerId, windowId) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout) return

    const container = findNode(desktop.layout, containerId) as ContainerNode | null
    if (!container || !container.windowIds.includes(windowId)) return

    const newLayout = replaceNode(desktop.layout, containerId, {
      ...container,
      activeWindowId: windowId,
    })

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: containerId,
    }

    set({ desktops: newDesktops })

    get().clearWindowNotification(windowId)
  },

  reorderTabs: (containerId, fromIndex, toIndex) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout) return

    const container = findNode(desktop.layout, containerId) as ContainerNode | null
    if (!container) return

    const newWindowIds = [...container.windowIds]
    const [removed] = newWindowIds.splice(fromIndex, 1)
    newWindowIds.splice(toIndex, 0, removed)

    const newLayout = replaceNode(desktop.layout, containerId, {
      ...container,
      windowIds: newWindowIds,
    })

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
    }

    set({ desktops: newDesktops })
  },

  // ========================================
  // SPLIT MANAGEMENT
  // ========================================

  splitActive: (direction) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.activeContainerId) return
    get().splitContainer(desktop.activeContainerId, direction)
  },

  splitContainer: (containerId, direction) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout) return

    const container = findNode(desktop.layout, containerId) as ContainerNode | null
    if (!container) return

    // Create new empty container
    const newContainerId = generateId("container", state.nextId)
    const newContainer: ContainerNode = {
      type: "container",
      id: newContainerId,
      windowIds: [],
      activeWindowId: null,
    }

    // Create split with the original container and the new one
    const splitId = generateId("split", state.nextId + 1)
    const split: SplitNode = {
      type: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: container,
      second: newContainer,
    }

    // Replace the original container with the split
    const newLayout = replaceNode(desktop.layout, containerId, split)

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: newContainerId,
    }

    set({
      desktops: newDesktops,
      nextId: state.nextId + 2,
    })
  },

  setRatio: (splitId, ratio) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout) return

    const split = findNode(desktop.layout, splitId) as SplitNode | null
    if (!split || split.type !== "split") return

    const clampedRatio = Math.max(0.1, Math.min(0.9, ratio))

    const newLayout = replaceNode(desktop.layout, splitId, {
      ...split,
      ratio: clampedRatio,
    })

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
    }

    set({ desktops: newDesktops })
  },

  closeContainer: (containerId) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout) return

    const container = findNode(desktop.layout, containerId) as ContainerNode | null
    if (!container) return

    // Close all windows in the container
    const newWindows = { ...state.windows }
    container.windowIds.forEach((id) => delete newWindows[id])

    // Remove container from layout
    const newLayout = removeNode(desktop.layout, containerId)

    // Find new active container
    let newActiveContainerId: string | null = null
    if (newLayout) {
      const containers = findAllContainers(newLayout)
      newActiveContainerId = containers[0]?.id || null
    }

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: newActiveContainerId,
    }

    set({
      desktops: newDesktops,
      windows: newWindows,
    })
  },

  // ========================================
  // NAVIGATION
  // ========================================
  // NAVIGATION
  // ========================================

  focusDirection: (direction) => {
    console.log("[TilingStore] focusDirection not implemented:", direction)
  },

  moveWindowDirection: (direction) => {
    console.log("[TilingStore] moveWindowDirection not implemented:", direction)
  },

  swapWindows: (windowId, targetContainerId) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout) return

    const window = state.windows[windowId]
    if (!window) return

    // Do nothing if it's the same container
    if (window.containerId === targetContainerId) return

    const sourceContainer = findNode(desktop.layout, window.containerId) as ContainerNode | null
    const targetContainer = findNode(desktop.layout, targetContainerId) as ContainerNode | null

    if (!sourceContainer || !targetContainer) return

    // Get the active window of the target container
    const targetWindowId = targetContainer.activeWindowId
    if (!targetWindowId) {
      // If there's no active window in target, just move
      get().moveWindowToContainer(windowId, targetContainerId)
      return
    }

    const targetWindow = state.windows[targetWindowId]
    if (!targetWindow) return

    // Swap the windows between containers
    // 1. Remove windowId from source and add targetWindowId
    const newSourceWindowIds = sourceContainer.windowIds.map((id) =>
      id === windowId ? targetWindowId : id,
    )

    // 2. Remove targetWindowId from target and add windowId
    const newTargetWindowIds = targetContainer.windowIds.map((id) =>
      id === targetWindowId ? windowId : id,
    )

    // Update layout
    let newLayout = replaceNode(desktop.layout, sourceContainer.id, {
      ...sourceContainer,
      windowIds: newSourceWindowIds,
      activeWindowId: targetWindowId,
    })

    newLayout = replaceNode(newLayout, targetContainer.id, {
      ...targetContainer,
      windowIds: newTargetWindowIds,
      activeWindowId: windowId,
    })

    // Update containerId of both windows
    const newWindows = {
      ...state.windows,
      [windowId]: { ...window, containerId: targetContainerId },
      [targetWindowId]: { ...targetWindow, containerId: window.containerId },
    }

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: targetContainerId,
    }

    set({
      desktops: newDesktops,
      windows: newWindows,
    })
  },

  moveWindowsToContainer: (windowIds, targetContainerId) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout || windowIds.length === 0) return

    // Get the source container (we assume all windows come from the same one)
    const firstWindow = state.windows[windowIds[0]]
    if (!firstWindow) return

    const sourceContainerId = firstWindow.containerId
    if (sourceContainerId === targetContainerId) return

    const sourceContainer = findNode(desktop.layout, sourceContainerId) as ContainerNode | null
    const targetContainer = findNode(desktop.layout, targetContainerId) as ContainerNode | null

    if (!sourceContainer || !targetContainer) return

    // Remove all windows from the source container
    const newSourceWindowIds = sourceContainer.windowIds.filter((id) => !windowIds.includes(id))
    const newSourceActiveWindowId = newSourceWindowIds[0] || null

    // Add all to the destination container
    const newTargetWindowIds = [...targetContainer.windowIds, ...windowIds]

    // Update layout
    let newLayout: LayoutNode | null = replaceNode(desktop.layout, sourceContainer.id, {
      ...sourceContainer,
      windowIds: newSourceWindowIds,
      activeWindowId: newSourceActiveWindowId,
    })

    newLayout = replaceNode(newLayout!, targetContainer.id, {
      ...targetContainer,
      windowIds: newTargetWindowIds,
      activeWindowId: windowIds[0],
    })

    // Update all windows
    const newWindows = { ...state.windows }
    windowIds.forEach((id) => {
      if (newWindows[id]) {
        newWindows[id] = { ...newWindows[id], containerId: targetContainerId }
      }
    })

    // If the source container is now empty, remove it
    if (newSourceWindowIds.length === 0) {
      newLayout = removeNode(newLayout, sourceContainer.id)
    }

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: targetContainerId,
    }

    set({
      desktops: newDesktops,
      windows: newWindows,
    })
  },

  moveWindowsToNewSplit: (windowIds, targetContainerId, direction, position = "after") => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout || windowIds.length === 0) return

    const firstWindow = state.windows[windowIds[0]]
    if (!firstWindow) return

    const sourceContainerId = firstWindow.containerId
    const sourceContainer = findNode(desktop.layout, sourceContainerId) as ContainerNode | null
    const targetContainer = findNode(desktop.layout, targetContainerId) as ContainerNode | null

    if (!sourceContainer || !targetContainer) return

    // Remove windows from the source container
    const newSourceWindowIds = sourceContainer.windowIds.filter((id) => !windowIds.includes(id))
    const newSourceActiveWindowId = newSourceWindowIds[0] || null

    // Create new container for the windows
    const newContainerId = generateId("container", state.nextId)
    const newContainer: ContainerNode = {
      type: "container",
      id: newContainerId,
      windowIds: windowIds,
      activeWindowId: windowIds[0],
    }

    // Create split
    const splitId = generateId("split", state.nextId + 1)
    const split: SplitNode = {
      type: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: position === "before" ? newContainer : targetContainer,
      second: position === "before" ? targetContainer : newContainer,
    }

    // Update layout
    let newLayout: LayoutNode | null = replaceNode(desktop.layout, targetContainerId, split)

    // Update source container if different
    if (sourceContainerId !== targetContainerId) {
      newLayout = replaceNode(newLayout, sourceContainerId, {
        ...sourceContainer,
        windowIds: newSourceWindowIds,
        activeWindowId: newSourceActiveWindowId,
      })

      if (newSourceWindowIds.length === 0) {
        newLayout = removeNode(newLayout, sourceContainerId)
      }
    } else {
      // Update the container within the split
      newLayout = replaceNode(newLayout, targetContainerId, {
        ...targetContainer,
        windowIds: newSourceWindowIds,
        activeWindowId: newSourceActiveWindowId,
      })
    }

    // Update all windows
    const newWindows = { ...state.windows }
    windowIds.forEach((id) => {
      if (newWindows[id]) {
        newWindows[id] = { ...newWindows[id], containerId: newContainerId }
      }
    })

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: newContainerId,
    }

    set({
      desktops: newDesktops,
      windows: newWindows,
      nextId: state.nextId + 2,
    })
  },

  swapContainerWindows: (sourceContainerId, targetContainerId) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout || sourceContainerId === targetContainerId) return

    const sourceContainer = findNode(desktop.layout, sourceContainerId) as ContainerNode | null
    const targetContainer = findNode(desktop.layout, targetContainerId) as ContainerNode | null

    if (!sourceContainer || !targetContainer) return

    // Intercambiar los windowIds
    const sourceWindowIds = [...sourceContainer.windowIds]
    const targetWindowIds = [...targetContainer.windowIds]

    // Update layout
    let newLayout = replaceNode(desktop.layout, sourceContainerId, {
      ...sourceContainer,
      windowIds: targetWindowIds,
      activeWindowId: targetWindowIds[0] || null,
    })

    newLayout = replaceNode(newLayout, targetContainerId, {
      ...targetContainer,
      windowIds: sourceWindowIds,
      activeWindowId: sourceWindowIds[0] || null,
    })

    // Update containerId of all windows
    const newWindows = { ...state.windows }
    sourceWindowIds.forEach((id) => {
      if (newWindows[id]) {
        newWindows[id] = { ...newWindows[id], containerId: targetContainerId }
      }
    })
    targetWindowIds.forEach((id) => {
      if (newWindows[id]) {
        newWindows[id] = { ...newWindows[id], containerId: sourceContainerId }
      }
    })

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: targetContainerId,
    }

    set({
      desktops: newDesktops,
      windows: newWindows,
    })
  },

  moveWindowToContainer: (windowId, targetContainerId, insertIndex) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout) return

    const window = state.windows[windowId]
    if (!window) return

    const sourceContainer = findNode(desktop.layout, window.containerId) as ContainerNode | null
    const targetContainer = findNode(desktop.layout, targetContainerId) as ContainerNode | null

    if (!sourceContainer || !targetContainer) return

    // If it's the same container, just reorder
    if (window.containerId === targetContainerId) {
      if (insertIndex === undefined) return

      const currentIndex = sourceContainer.windowIds.indexOf(windowId)
      if (currentIndex === insertIndex || currentIndex === insertIndex - 1) return

      const newWindowIds = [...sourceContainer.windowIds]
      newWindowIds.splice(currentIndex, 1)
      // Adjust index if we're moving forward
      const adjustedIndex = currentIndex < insertIndex ? insertIndex - 1 : insertIndex
      newWindowIds.splice(adjustedIndex, 0, windowId)

      const newLayout = replaceNode(desktop.layout, sourceContainer.id, {
        ...sourceContainer,
        windowIds: newWindowIds,
      })

      const newDesktops = [...state.desktops]
      newDesktops[state.activeDesktopIndex] = {
        ...desktop,
        layout: newLayout,
      }

      set({ desktops: newDesktops })
      return
    }

    // Remove from the source container
    const newSourceWindowIds = sourceContainer.windowIds.filter((id) => id !== windowId)
    const newSourceActiveWindowId =
      sourceContainer.activeWindowId === windowId
        ? newSourceWindowIds[newSourceWindowIds.length - 1] || null
        : sourceContainer.activeWindowId

    // Add to the destination container at the specified position
    const newTargetWindowIds = [...targetContainer.windowIds]
    if (insertIndex !== undefined && insertIndex >= 0 && insertIndex <= newTargetWindowIds.length) {
      newTargetWindowIds.splice(insertIndex, 0, windowId)
    } else {
      newTargetWindowIds.push(windowId)
    }

    // Update layout
    let newLayout: LayoutNode | null = replaceNode(desktop.layout, sourceContainer.id, {
      ...sourceContainer,
      windowIds: newSourceWindowIds,
      activeWindowId: newSourceActiveWindowId,
    })

    newLayout = replaceNode(newLayout!, targetContainer.id, {
      ...targetContainer,
      windowIds: newTargetWindowIds,
      activeWindowId: windowId,
    })

    // Update window
    const newWindows = {
      ...state.windows,
      [windowId]: { ...window, containerId: targetContainerId },
    }

    // If the source container is now empty, remove it
    if (newSourceWindowIds.length === 0) {
      newLayout = removeNode(newLayout, sourceContainer.id)
    }

    // Find new active container if needed
    let newActiveContainerId: string | null = targetContainerId
    if (!newLayout) {
      newActiveContainerId = null
    }

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: newActiveContainerId,
    }

    set({
      desktops: newDesktops,
      windows: newWindows,
    })
  },

  moveWindowToNewSplit: (windowId, targetContainerId, direction, position = "after") => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop.layout) return

    const window = state.windows[windowId]
    if (!window) return

    const sourceContainer = findNode(desktop.layout, window.containerId) as ContainerNode | null
    const targetContainer = findNode(desktop.layout, targetContainerId) as ContainerNode | null

    if (!sourceContainer || !targetContainer) return

    // Remove from the source container
    const newSourceWindowIds = sourceContainer.windowIds.filter((id) => id !== windowId)
    const newSourceActiveWindowId =
      sourceContainer.activeWindowId === windowId
        ? newSourceWindowIds[newSourceWindowIds.length - 1] || null
        : sourceContainer.activeWindowId

    // Create new container for the window
    const newContainerId = generateId("container", state.nextId)
    const newContainer: ContainerNode = {
      type: "container",
      id: newContainerId,
      windowIds: [windowId],
      activeWindowId: windowId,
    }

    // Create split: position determines if the new one goes before or after
    const splitId = generateId("split", state.nextId + 1)
    const split: SplitNode = {
      type: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: position === "before" ? newContainer : targetContainer,
      second: position === "before" ? targetContainer : newContainer,
    }

    // Update layout: reemplazar target container con el split
    let newLayout: LayoutNode | null = replaceNode(desktop.layout, targetContainerId, split)

    // Update source container if different del target
    if (sourceContainer.id !== targetContainerId) {
      newLayout = replaceNode(newLayout, sourceContainer.id, {
        ...sourceContainer,
        windowIds: newSourceWindowIds,
        activeWindowId: newSourceActiveWindowId,
      })

      // If the source container is now empty, remove it
      if (newSourceWindowIds.length === 0) {
        newLayout = removeNode(newLayout, sourceContainer.id)
      }
    } else {
      // If source == destination, update the container within the split
      newLayout = replaceNode(newLayout, targetContainerId, {
        ...targetContainer,
        windowIds: newSourceWindowIds,
        activeWindowId: newSourceActiveWindowId,
      })
    }

    // Update window
    const newWindows = {
      ...state.windows,
      [windowId]: { ...window, containerId: newContainerId },
    }

    const newDesktops = [...state.desktops]
    newDesktops[state.activeDesktopIndex] = {
      ...desktop,
      layout: newLayout,
      activeContainerId: newContainerId,
    }

    set({
      desktops: newDesktops,
      windows: newWindows,
      nextId: state.nextId + 2,
    })
  },

  // ========================================
  // NOTIFICATIONS
  // ========================================

  setWindowNotification: (windowId, has, count) => {
    set((state) => {
      const window = state.windows[windowId]
      if (!window) return state

      return {
        windows: {
          ...state.windows,
          [windowId]: {
            ...window,
            hasNotification: has,
            notificationCount: count,
          },
        },
      }
    })
  },

  clearWindowNotification: (windowId) => {
    set((state) => {
      const window = state.windows[windowId]
      if (!window) return state

      return {
        windows: {
          ...state.windows,
          [windowId]: {
            ...window,
            hasNotification: false,
            notificationCount: undefined,
          },
        },
      }
    })
  },

  // ========================================
  // HELPERS
  // ========================================

  getContainer: (containerId) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop?.layout) return null
    return findNode(desktop.layout, containerId) as ContainerNode | null
  },

  getWindow: (windowId) => {
    return get().windows[windowId]
  },

  findWindow: (type, predicate) => {
    const state = get()
    return Object.values(state.windows).find((w) => w.type === type && predicate(w.props))
  },

  // ========================================
  // PERSISTENCE
  // ========================================

  restoreFromStorage: async () => {
    try {
      // Restore active desktop index: sessionStorage (per-tab) first, then localStorage fallback
      let savedIndex = await storage.get<number>(STORAGE_KEYS.ACTIVE_DESKTOP_INDEX)
      if (savedIndex === null) {
        savedIndex = await storage.get<number>(STORAGE_KEYS.LAST_ACTIVE_DESKTOP_INDEX)
      }

      const saved = await storage.get<SerializedWorkspaceState>(STORAGE_KEYS.WORKSPACE_LAYOUT)
      if (!saved) {
        console.log("[TilingStore] No saved layout found — resetting to empty")
        get().resetState()
        if (savedIndex !== null) set({ activeDesktopIndex: savedIndex })
        return
      }

      // Validate that window types exist in the registry
      const validWindows: Record<string, TilingWindow> = {}
      for (const [id, window] of Object.entries(saved.windows)) {
        if (windowRegistry.has(window.type)) {
          // Backwards-compat: add history if missing (pre-history saves)
          const withHistory: TilingWindow = {
            ...window,
            history: window.history ?? [{ type: window.type, props: window.props }],
            historyIndex: window.historyIndex ?? 0,
          }
          validWindows[id] = withHistory
        } else {
          console.warn("[TilingStore] Unknown window type, skipping:", window.type)
        }
      }

      // Clean up containers that reference invalid windows on each desktop
      const validWindowIds = new Set(Object.keys(validWindows))
      const cleanedDesktops = saved.desktops.map((desktop) => ({
        ...desktop,
        layout: cleanLayoutWindowRefs(desktop.layout, validWindowIds),
      }))

      // Sanitize: remove empty containers from restored layouts
      const sanitizedDesktops = sanitizeDesktops(cleanedDesktops)

      // activeDesktopIndex: sessionStorage takes precedence (per-tab) over persisted value
      const activeDesktopIndex = savedIndex !== null
        ? Math.max(0, Math.min(savedIndex, sanitizedDesktops.length - 1))
        : Math.max(0, Math.min(saved.activeDesktopIndex ?? 0, sanitizedDesktops.length - 1))

      set({
        desktops: sanitizedDesktops,
        windows: validWindows,
        activeDesktopIndex,
        maxDesktops: saved.maxDesktops ?? DEFAULT_MAX_DESKTOPS,
        nextId: saved.nextId,
      })

      console.log("[TilingStore] Layout restored:", Object.keys(validWindows).length, "windows")
    } catch (error) {
      console.error("[TilingStore] Failed to restore layout:", error)
    }
  },

  persistToStorage: async () => {
    try {
      const state = get()
      const serializedWindows = serializeWindowsForPersistence(state.windows)

      // Sanitize desktops before persisting (strip empty containers)
      const sanitized = sanitizeDesktops(state.desktops)

      await storage.set<SerializedWorkspaceState>(STORAGE_KEYS.WORKSPACE_LAYOUT, {
        version: 2,
        desktops: sanitized,
        windows: serializedWindows as Record<string, TilingWindow>,
        activeDesktopIndex: state.activeDesktopIndex,
        maxDesktops: state.maxDesktops,
        nextId: state.nextId,
      })
    } catch (error) {
      console.error("[TilingStore] Failed to persist layout:", error)
    }
  },

  resetState: () => {
    set({
      desktops: createEmptyDesktops(DEFAULT_MAX_DESKTOPS),
      windows: {},
      activeDesktopIndex: 0,
      maxDesktops: DEFAULT_MAX_DESKTOPS,
      nextId: 1,
    })
    storage.remove(STORAGE_KEYS.WORKSPACE_LAYOUT).catch(console.error)
    console.log("[TilingStore] State reset")
  },
}))

// ============================================
// PERSISTENCE HELPERS
// ============================================

/** Max history entries to persist per window (avoids bloating the payload) */
const MAX_PERSIST_HISTORY = 10

/**
 * Serialize one window type's props through the registry, falling back to the raw
 * props on error or unknown type. Shared by the active props and every history entry
 * so they persist identically.
 */
function serializeProps(type: string, props: Record<string, any>): unknown {
  const definition = windowRegistry.get(type)
  if (!definition?.serialize) return props
  try {
    return definition.serialize(props)
  } catch (error) {
    console.error(`[TilingStore] serialize error for window type ${type}:`, error)
    return props
  }
}

/** Inverse of {@link serializeProps}: deserialize via the registry, raw fallback. */
function deserializeProps(type: string, rawProps: Record<string, any>): Record<string, any> {
  const definition = windowRegistry.get(type)
  if (!definition?.deserialize) return rawProps
  try {
    return definition.deserialize(rawProps)
  } catch (error) {
    console.error(`[DesktopStateSync] deserialize error for window type ${type}:`, error)
    return rawProps
  }
}

/**
 * Serialize the windows map for persistence.
 * - Truncates history to MAX_PERSIST_HISTORY entries
 * - Serializes both the active props AND every history entry's props (each by its
 *   own type) via the registry, with a raw fallback on error/unknown type
 */
export function serializeWindowsForPersistence(
  windows: Record<string, TilingWindow>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [id, win] of Object.entries(windows)) {
    if (!windowRegistry.get(win.type)) {
      console.warn(`[TilingStore] unknown window type: ${win.type}`)
    }

    // Serialize the active props — fall back to raw on error
    const serializedProps = serializeProps(win.type, win.props)

    // Truncate history (keep most recent entries), then serialize each entry's props
    // by ITS OWN type (a window can navigate across types) so the history survives
    // reload identically to the active props.
    const history = win.history ?? [{ type: win.type, props: win.props }]
    const truncatedHistory = (
      history.length > MAX_PERSIST_HISTORY ? history.slice(history.length - MAX_PERSIST_HISTORY) : history
    ).map((entry) => ({ type: entry.type, props: serializeProps(entry.type, entry.props) }))

    result[id] = {
      id,
      type: win.type,
      props: serializedProps,
      containerId: win.containerId,
      desktopIndex: win.desktopIndex,
      history: truncatedHistory,
      historyIndex: Math.min(win.historyIndex ?? truncatedHistory.length - 1, truncatedHistory.length - 1),
    }
  }

  return result
}

/**
 * Recursively removes ContainerNodes with no windowIds from the layout tree.
 * Returns null when the entire subtree collapses to nothing.
 */
function sanitizeLayout(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null

  if (node.type === 'container') {
    const container = node as ContainerNode
    return container.windowIds.length > 0 ? container : null
  }

  // Split node — sanitize both children
  const first = sanitizeLayout(node.first)
  const second = sanitizeLayout(node.second)

  if (!first && !second) return null
  if (!first) return second
  if (!second) return first

  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/**
 * Sanitize all desktops: remove empty containers from their layouts.
 * Resets activeContainerId when it no longer exists in the sanitized layout.
 */
function sanitizeDesktops(desktops: Desktop[]): Desktop[] {
  return desktops.map((desktop) => {
    const newLayout = sanitizeLayout(desktop.layout)

    if (newLayout === desktop.layout) return desktop

    // If the active container was removed, find a new one
    let newActiveContainerId = desktop.activeContainerId
    if (newActiveContainerId && newLayout) {
      const stillExists = findContainerById(newLayout, newActiveContainerId)
      if (!stillExists) newActiveContainerId = getFirstContainerId(newLayout)
    } else if (!newLayout) {
      newActiveContainerId = null
    }

    return { ...desktop, layout: newLayout, activeContainerId: newActiveContainerId }
  })
}

function findContainerById(node: LayoutNode, id: string): boolean {
  if (node.type === 'container') return node.id === id
  const firstResult: boolean = findContainerById(node.first, id)
  if (firstResult) return true
  return findContainerById(node.second, id)
}

function getFirstContainerId(node: LayoutNode | null): string | null {
  if (!node) return null
  if (node.type === 'container') return node.id
  const firstResult: string | null = getFirstContainerId(node.first)
  if (firstResult !== null) return firstResult
  return getFirstContainerId(node.second)
}

/** Clean up references to invalid windows in the layout */
function cleanLayoutWindowRefs(
  layout: LayoutNode | null,
  validWindowIds: Set<string>,
): LayoutNode | null {
  if (!layout) return null

  if (layout.type === "container") {
    const validIds = layout.windowIds.filter((id) => validWindowIds.has(id))
    if (validIds.length === 0) {
      // Empty container, return null so it gets removed
      return null
    }
    return {
      ...layout,
      windowIds: validIds,
      activeWindowId: validIds.includes(layout.activeWindowId ?? "")
        ? layout.activeWindowId
        : (validIds[0] ?? null),
    }
  }

  // Split node
  const cleanedFirst = cleanLayoutWindowRefs(layout.first, validWindowIds)
  const cleanedSecond = cleanLayoutWindowRefs(layout.second, validWindowIds)

  // If both children are null, return null
  if (!cleanedFirst && !cleanedSecond) return null

  // If only one is null, return the other
  if (!cleanedFirst) return cleanedSecond
  if (!cleanedSecond) return cleanedFirst

  return {
    ...layout,
    first: cleanedFirst,
    second: cleanedSecond,
  }
}

// ============================================
// SELECTORS
// ============================================

/** Selector: get the active desktop's layout */
export const selectLayout = (state: TilingState): LayoutNode | null => {
  const desktop = state.desktops[state.activeDesktopIndex]
  return desktop?.layout ?? null
}

/** Selector: get the active desktop's activeContainerId */
export const selectActiveContainerId = (state: TilingState): string | null => {
  const desktop = state.desktops[state.activeDesktopIndex]
  return desktop?.activeContainerId ?? null
}

// ── Session lifecycle registration ──────────────────────────────────────────
// @todo nira - 2026-05-20: migrate to createSessionStore once circular deps resolved

import { storeRegistry } from './session/StoreRegistry'

storeRegistry.register('tiling', {
  resetSession: () => {
    useTilingStore.getState().resetState()
  },
})
