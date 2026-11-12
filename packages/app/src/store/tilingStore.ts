/**
 * Tiling Store - Tiling window manager layout state
 *
 * Inspired by i3/dwm/awesome:
 * - Tree-based split layout (horizontal/vertical)
 * - Each leaf node is a "container" with tabs
 * - No floating windows, everything is tiling
 */

import { create } from "zustand"
import { STORAGE_KEYS, storage, persistedDriver, getCurrentWorkspaceId } from "../services/storage"
import { windowRegistry } from "../services/windowRegistry"
import { getResolvedFlag, useFeatureFlagsStore } from "./featureFlagsStore"
import { preloadWindowChunks } from "../lib/preloadWindowChunks"
import { getTerosClient } from "../services/terosClientSingleton"
import { getActiveWorkspaceId } from "./workspaceStoreRef"

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
  /**
   * Preview tab (docs/specs/ui/preview-tabs.md): opening another window in
   * preview mode into the same pane REUSES this tab (replaces its type/props)
   * instead of adding one. Pinned (absent/false) by `pinWindow`.
   */
  preview?: boolean
  /** The window that opened this one in preview mode (mobile "back" returns there). */
  openerId?: string
}

/**
 * Options for `openWindow` (the object form of its third argument).
 * The positional form `openWindow(type, props, inNewTab?, sourceWindowId?)`
 * keeps working.
 */
export interface OpenWindowOptions {
  /**
   * Add a tab instead of routing to the desktop's preview tab. Ctrl/cmd-click
   * and explicit new-tab callers pass this — it bypasses preview routing.
   */
  inNewTab?: boolean
  /** The caller window: keeps the focus when the open routes to a preview. */
  sourceWindowId?: string
  /**
   * Open into the desktop's PREVIEW tab explicitly (the default for new
   * content anyway — docs/specs/ui/preview-tabs.md). The desktop's existing
   * preview tab is reused; without one the tab is created in the panel most
   * to the right and top. An identical window that already exists is focused
   * instead. On the compact shell the preview is pushed in the source pane.
   */
  preview?: boolean
  /**
   * With `preview`: open as a PINNED tab in the same target panel (or pin
   * the identical window if it already exists) — the double-click gesture.
   */
  pin?: boolean
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

const DEFAULT_MAX_DESKTOPS = 1

/** Hard limit of user-created desktops (dynamic desktops — one per physical
 * screen; matches the backend's UI_MAX_DESKTOPS report cap). */
export const MAX_DESKTOPS = 10

// ============================================
// STATE
// ============================================

interface TilingState extends TilingDerivedState {
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

  /** Whether the persisted layout has been restored from storage.
   * False until restoreFromStorage completes (or finds no saved layout).
   * Components should wait for this before opening windows to avoid
   * the restored layout overwriting freshly-opened windows. */
  layoutRestored: boolean

  /** Monotonic counter of completed restores — incremented on every
   * restoreFromStorage completion (restored layout, empty, or error).
   * Lets consumers tell restores apart instead of latching on the first
   * one in history (the workspace-switch restore race). */
  restoreGeneration: number

  /** The workspace whose layout the LAST completed restore loaded — the
   * workspace active at completion time (the same source the PersistedDriver
   * buckets state by). Consumers that must not judge the layout before THEIR
   * workspace's restore lands gate on this equaling the workspace they
   * care about. */
  layoutRestoredForWorkspace: string | null

  /** True while the compact (phone) shell is mounted (see setCompactShell). */
  compactShell: boolean
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

  /**
   * Create a new empty desktop at the end and switch to it (dynamic desktops).
   * Hard-capped at MAX_DESKTOPS (10) — a no-op at the cap. Auto-named
   * "Desktop N" (N = new length). Returns the new index, or null at the cap.
   */
  addDesktop: () => number | null

  /**
   * Remove a desktop by index (dynamic desktops). Never removes the last
   * remaining desktop (no-op returning false). Windows on the removed desktop
   * are MOVED to the previous desktop (index-1, falling back to the first) —
   * never silently closed. Desktops after it shift down; every window's
   * desktopIndex is reindexed; activeDesktopIndex follows the merged desktop.
   */
  removeDesktop: (index: number) => boolean

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
   * Open window. NEW content routes to the desktop's PREVIEW tab by default
   * (docs/specs/ui/preview-tabs.md): the desktop's preview tab is reused, or
   * created in the rightmost+topmost panel. `inNewTab` bypasses that (a
   * normal new tab); an identical open window is focused, never duplicated.
   * Pass sourceWindowId to keep the focus on the caller (keyboard lists).
   */
  openWindow: (
    type: string,
    props: Record<string, any>,
    inNewTabOrOptions?: boolean | OpenWindowOptions,
    sourceWindowId?: string,
  ) => string | null

  /** Turn a preview tab into a normal (pinned) tab. No-op for pinned tabs. */
  pinWindow: (windowId: string) => void

  /**
   * "New tab" (the + button): pin the desktop's current preview (temporary)
   * tab, then open a fresh launcher tab that becomes the new preview. At most
   * one preview exists at any time; with no preview nothing is pinned.
   */
  openNewTab: (sourceWindowId?: string) => string | null

  /**
   * Whether the shell is the compact (phone) layout — set by
   * MobileTilingLayout. Preview windows are then pushed in the source pane.
   */
  setCompactShell: (compact: boolean) => void

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

/**
 * Clamp an index into the desktops range (0..count-1). Guarantees the store
 * invariant 0 <= activeDesktopIndex < desktops.length after any mutation or
 * restore that can leave a stale index (per-tab sessionStorage from a session
 * with more desktops, a removed desktop, a workspace-switch race).
 */
function clampDesktopIndex(index: number, desktopCount: number): number {
  if (desktopCount <= 0) return 0
  return Math.max(0, Math.min(index, desktopCount - 1))
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
// WORKSPACE BOUNDARY GUARD
// ============================================

/**
 * Cache mapping channelId → workspaceId (or null for superagent channels).
 * Populated lazily when a chat window is opened. Avoids repeated backend calls
 * for channels the user has already opened in this session.
 */
const _channelWorkspaceCache = new Map<string, string | null>()

/**
 * Check if a channel belongs to the currently active workspace.
 * Channels with no workspaceId (superagent channels) are always allowed.
 * Returns true if the channel is in the active workspace or has no workspace.
 */
function _isChannelInActiveWorkspace(channelId: string, channelWorkspaceId: string | null): boolean {
  // Superagent channels (no workspaceId) are always allowed
  if (!channelWorkspaceId) return true

  // Read through the cycle-breaker module — workspaceStore registers itself
  // there at load time (a direct import would create a circular dependency,
  // and the old lazy `require()` is not resolvable under ESM/vitest).
  const activeWorkspaceId = getActiveWorkspaceId()

  // If no active workspace, allow (shouldn't happen in practice, but fail-open for edge cases)
  if (!activeWorkspaceId) return true

  if (channelWorkspaceId !== activeWorkspaceId) {
    console.warn(
      `[TilingStore] Blocked opening conversation ${channelId}: belongs to workspace ${channelWorkspaceId}, active is ${activeWorkspaceId}`,
    )
    return false
  }

  return true
}

/**
 * Async verification for cache-miss channels. Fetches the channel's workspaceId
 * from the backend, caches it, and if it belongs to the active workspace,
 * re-opens the window (this time with a cache hit → synchronous path).
 */
async function _verifyAndOpenChatWindow(
  channelId: string,
  type: string,
  props: Record<string, any>,
  options: OpenWindowOptions,
  get: () => any,
  set: (partial: any) => void,
): Promise<void> {
  try {
    const client = getTerosClient()
    const ch = (await client.channel.get(channelId)) as any
    const wsId: string | null = ch?.workspaceId ?? null

    // Cache the result
    _channelWorkspaceCache.set(channelId, wsId)

    if (_isChannelInActiveWorkspace(channelId, wsId)) {
      // Workspace matches — re-open through the normal path (cache hit this time)
      const state = get()
      state.openWindow(type, props, options)
    }
    // If mismatch, the warning was already logged by _isChannelInActiveWorkspace
  } catch (err) {
    // On error (network, channel not found, etc.), allow opening — the ChatView
    // will handle the error state (notFound, etc.)
    console.warn(`[TilingStore] Could not verify workspace for channel ${channelId}:`, err)
    const state = get()
    state.openWindow(type, props, options)
  }
}

/** Export for testing — allows tests to pre-populate the cache */
export function _setChannelWorkspace(channelId: string, workspaceId: string | null): void {
  _channelWorkspaceCache.set(channelId, workspaceId)
}

/** Export for testing — clear the cache between tests */
export function _clearChannelWorkspaceCache(): void {
  _channelWorkspaceCache.clear()
}

// ============================================
// PREVIEW TABS (docs/specs/ui/preview-tabs.md)
// ============================================

/**
 * The preview tab is GLOBAL per desktop (VS Code preview tabs, Pablo 2026-10-30):
 * every NEW open lands in the desktop's preview tab — reused when one exists
 * anywhere in the desktop, else created in the panel that is most to the
 * RIGHT and, among those, most to the TOP. Pinning (pinWindow) turns it into
 * a normal tab; the next open then creates a fresh preview tab.
 */

/**
 * The pane a fresh preview tab opens in: the container whose rect is most to
 * the right, and among ties most to the top — computed from the layout tree,
 * no DOM. Geometry: walk the tree with the unit square [0,1]². A horizontal
 * split (XStack) divides x: first gets [x, x + w·ratio], second the rest. A
 * vertical split (YStack) divides y the same way, first on top. Every leaf
 * ends with its normalized rect; we compare right edges (x+w), tie-break on
 * top edges (y). Ties beyond that (same column, e.g. two stacked panes under
 * one horizontal split with equal widths) resolve to the upper one — stable
 * because findAllContainers order is deterministic.
 *
 * Nested-splits example: H(A, V(B, C)) with ratio 0.5 →
 *   A = [0, 0, 0.5, 1] (right 0.5) · B = [0.5, 0, 1, 0.5] (right 1, top 0)
 *   C = [0.5, 0.5, 1, 1] (right 1, top 0.5) → B wins (same right edge, higher).
 */
export function findRightmostTopmostContainer(layout: LayoutNode | null): string | null {
  const all = findAllContainers(layout)
  if (all.length === 0) return null

  /** Rect of each container: [x, y, w, h] in normalized units. */
  const rects = new Map<string, [number, number, number, number]>()
  const walk = (node: LayoutNode, x: number, y: number, w: number, h: number): void => {
    if (node.type === "container") {
      rects.set(node.id, [x, y, w, h])
      return
    }
    if (node.direction === "horizontal") {
      walk(node.first, x, y, w * node.ratio, h)
      walk(node.second, x + w * node.ratio, y, w * (1 - node.ratio), h)
    } else {
      walk(node.first, x, y, w, h * node.ratio)
      walk(node.second, x, y + h * node.ratio, w, h * (1 - node.ratio))
    }
  }
  if (layout) walk(layout, 0, 0, 1, 1)

  let best: ContainerNode | null = null
  let bestRight = -1
  let bestTop = Infinity
  for (const c of all) {
    const r = rects.get(c.id)
    if (!r) continue
    const right = r[0] + r[2]
    const top = r[1]
    if (right > bestRight + 1e-9 || (Math.abs(right - bestRight) <= 1e-9 && top < bestTop - 1e-9)) {
      best = c
      bestRight = right
      bestTop = top
    }
  }
  return best?.id ?? null
}

/**
 * The desktop's preview tab: the first window flagged `preview` whose
 * container lives in that desktop's layout. Independent per desktop — each
 * desktop keeps its own preview tab.
 */
export function findDesktopPreviewWindow(
  desktops: Desktop[],
  windows: Record<string, TilingWindow>,
  desktopIndex: number,
): TilingWindow | null {
  const desktop = desktops[desktopIndex]
  if (!desktop?.layout) return null
  const paneIds = new Set(findAllContainers(desktop.layout).map((c) => c.id))
  for (const w of Object.values(windows)) {
    if (w.preview && w.desktopIndex === desktopIndex && paneIds.has(w.containerId)) return w
  }
  return null
}

/**
 * At most ONE preview tab per desktop. Desktop merges (removeDesktop),
 * cross-desktop moves and old persisted states can leave two; keep the
 * rightmost-topmost one and pin the rest (they survive as normal tabs —
 * nothing is lost, they just stop being transient).
 */
function normalizeDesktopPreviews(
  desktops: Desktop[],
  windows: Record<string, TilingWindow>,
): Record<string, TilingWindow> {
  let out = windows
  desktops.forEach((desktop, desktopIndex) => {
    if (!desktop.layout) return
    const paneIds = new Set(findAllContainers(desktop.layout).map((c) => c.id))
    const previews = Object.values(out).filter(
      (w) => w.preview && w.desktopIndex === desktopIndex && paneIds.has(w.containerId),
    )
    if (previews.length <= 1) return
    // Keep the one in the rightmost+topmost pane; when several share that
    // pane (a merge), keep the first by window id — stable. The rest are
    // pinned: they survive as normal tabs, nothing is lost.
    const keep = findRightmostTopmostContainer(desktop.layout)
    const doomed = previews.filter((w) => w.containerId !== keep)
    const inKeep = previews.filter((w) => w.containerId === keep)
    const toPin = doomed.length > 0 ? doomed : inKeep.slice(1)
    if (toPin.length === 0) return
    out = { ...out }
    for (const w of toPin) out[w.id] = { ...w, preview: false }
  })
  return out
}

/**
 * Make `windowId` the visible tab of its pane. On the desktop shell the focus
 * stays on the caller's pane (selecting rows in a list keeps the keyboard
 * there); on the compact shell the pane is focused (that is what shows it).
 */
function showTabInPlace(
  get: () => TilingState & TilingActions,
  set: (partial: Partial<TilingState>) => void,
  windowId: string,
  _sourceWindowId: string | undefined,
): void {
  const state = get()
  const window = state.windows[windowId]
  if (!window) return
  if (state.compactShell) {
    get().focusWindow(windowId)
    return
  }
  const desktop = state.desktops[window.desktopIndex]
  if (!desktop?.layout) return
  const container = findNode(desktop.layout, window.containerId) as ContainerNode | null
  if (!container || container.activeWindowId === windowId) return
  const newDesktops = [...state.desktops]
  newDesktops[window.desktopIndex] = {
    ...desktop,
    layout: replaceNode(desktop.layout, container.id, { ...container, activeWindowId: windowId }),
  }
  set({ desktops: newDesktops })
}

/**
 * Open `type/props` into the desktop's PREVIEW tab (docs/specs/ui/preview-tabs.md):
 *
 * 1. The desktop already has a preview tab → REUSE it: replace its type/props
 *    (pushing onto its history) and show it in its pane. It stays preview.
 * 2. No preview tab → create one as a new tab in the desktop's RIGHTMOST +
 *    TOPMOST panel (findRightmostTopmostContainer — an existing panel, no
 *    split is created).
 *
 * With `pin` (the double-click gesture) the tab is opened PINNED in the same
 * target panel instead — beside any preview, never replacing it.
 *
 * Focus: with a `sourceWindowId` the caller keeps the focus (keyboard lists);
 * without one the preview tab is focused (VS Code's click-browse). On the
 * compact shell the preview is pushed in the source pane with `openerId`
 * for the bar's back caret.
 */
function openPreview(
  get: () => TilingState & TilingActions,
  set: (partial: Partial<TilingState>) => void,
  type: string,
  props: Record<string, any>,
  sourceWindowId: string | undefined,
  pin: boolean,
): string | null {
  const state = get()
  // Defensive clamp: same invariant as openWindow (see note there).
  const desktopIndex = clampDesktopIndex(state.activeDesktopIndex, state.desktops.length)
  const desktop = state.desktops[desktopIndex]
  let layout = desktop.layout

  // Empty desktop: open as the first window, flagged as preview (unless pin).
  if (!layout) {
    const id = get().openWindow(type, props, { inNewTab: true, sourceWindowId })
    if (id && !pin) {
      set({ windows: { ...get().windows, [id]: { ...get().windows[id], preview: true } } })
    }
    return id
  }

  // The desktop's preview tab, wherever it lives: REUSE it (both shells:
  // showTabInPlace focuses it on compact, shows it in place on desktop).
  // Acting FROM the preview does NOT pin it (Pablo 2026-11-01): ONLY the pin
  // click turns the preview tab into a fixed tab — every other open, from
  // wherever it comes, replaces the preview's content. (The old "act from a
  // preview pins it" rule opened the new content in a separate tab, which is
  // exactly the bug this sweep fixes.) With `pin` (double-click) the tab is
  // opened PINNED beside the preview instead.
  const existing = findDesktopPreviewWindow(state.desktops, state.windows, desktopIndex)
  if (existing && !pin) {
    const w = state.windows[existing.id]
    const history = w.history ?? [{ type: w.type, props: w.props }]
    const index = w.historyIndex ?? history.length - 1
    const nextHistory = [...history.slice(0, index + 1), { type, props }]
    const capped =
      nextHistory.length > MAX_HISTORY_LENGTH
        ? nextHistory.slice(nextHistory.length - MAX_HISTORY_LENGTH)
        : nextHistory
    const windows = {
      ...state.windows,
      [existing.id]: {
        ...w,
        type,
        props,
        history: capped,
        historyIndex: capped.length - 1,
        openerId: sourceWindowId ?? w.openerId,
      },
    }
    set({ windows })
    showTabInPlace(get, set, existing.id, sourceWindowId)
    return existing.id
  }

  // Compact (phone) shell, no preview yet: push a NEW preview tab into the
  // SOURCE pane, focused, with openerId for the bar's back caret — there is
  // no room for a side pane.
  if (state.compactShell) {
    const sourceContainerId =
      (sourceWindowId && state.windows[sourceWindowId]?.containerId) ||
      desktop.activeContainerId ||
      findAllContainers(layout)[0]?.id
    if (!sourceContainerId) return null
    const target = findNode(layout, sourceContainerId) as ContainerNode | null
    if (!target) return null
    return insertIntoPane(get, set, desktopIndex, layout, target, type, props, sourceWindowId, pin, true)
  }

  // Desktop shell, no preview yet: a fresh preview tab (or a pinned tab with
  // `pin`) in the RIGHTMOST+TOPMOST panel.
  const targetId = findRightmostTopmostContainer(layout)
  if (!targetId) return null
  const target = findNode(layout, targetId) as ContainerNode
  return insertIntoPane(get, set, desktopIndex, layout, target, type, props, sourceWindowId, pin, false)
}

/**
 * Add `type/props` to `pane` as a new tab (preview unless `pin`) and make it
 * the pane's active tab. `focusPane` also focuses the pane itself (compact
 * shell / preview-without-caller); otherwise the caller's focus is kept.
 */
function insertIntoPane(
  get: () => TilingState & TilingActions,
  set: (partial: Partial<TilingState>) => void,
  desktopIndex: number,
  layout: LayoutNode,
  pane: ContainerNode,
  type: string,
  props: Record<string, any>,
  sourceWindowId: string | undefined,
  pin: boolean,
  focusPane: boolean,
): string | null {
  const state = get()
  const desktop = state.desktops[desktopIndex]
  const windowId = generateId("win", state.nextId)
  const windows = {
    ...state.windows,
    [windowId]: {
      id: windowId,
      type,
      props,
      containerId: pane.id,
      desktopIndex,
      hasNotification: false,
      history: [{ type, props }],
      historyIndex: 0,
      preview: !pin,
      ...(sourceWindowId ? { openerId: sourceWindowId } : {}),
    } as TilingWindow,
  }
  const newLayout = replaceNode(layout, pane.id, {
    ...pane,
    windowIds: [...pane.windowIds, windowId],
    activeWindowId: windowId,
  })
  const newDesktops = [...state.desktops]
  newDesktops[desktopIndex] = {
    ...desktop,
    layout: newLayout,
    ...(focusPane || sourceWindowId === undefined ? { activeContainerId: pane.id } : {}),
  }
  set({ desktops: newDesktops, windows, nextId: state.nextId + 1 })
  return windowId
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
  layoutRestored: false,
  restoreGeneration: 0,
  layoutRestoredForWorkspace: null,
  compactShell: false,
  // Derived state (TilingState extends TilingDerivedState): kept in sync by
  // computeDerivedState on every desktops/activeDesktopIndex transition.
  layout: null,
  activeContainerId: null,

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

  addDesktop: () => {
    const state = get()
    // Hard cap (MAX_DESKTOPS = 10): a silent no-op at the limit — the UI
    // disables the + button there, this guards every other entry point.
    if (state.desktops.length >= MAX_DESKTOPS) return null

    const newIndex = state.desktops.length
    const newDesktop: Desktop = {
      id: `desktop_${newIndex}_${Math.random().toString(36).slice(2, 6)}`,
      name: `Desktop ${newIndex + 1}`,
      layout: null,
      activeContainerId: null,
    }

    const desktops = [...state.desktops, newDesktop]
    set({
      desktops,
      activeDesktopIndex: newIndex,
      ...computeDerivedState(desktops, newIndex),
    })
    // tab-state (sessionStorage): per-tab active desktop
    storage.set(STORAGE_KEYS.ACTIVE_DESKTOP_INDEX, newIndex)
    // ui-state (localStorage): fallback for new tabs / device-level last known
    storage.set(STORAGE_KEYS.LAST_ACTIVE_DESKTOP_INDEX, newIndex).catch((err) =>
      console.error('[TilingStore] Failed to persist lastActiveDesktopIndex:', err),
    )
    return newIndex
  },

  removeDesktop: (index) => {
    const state = get()
    // Never remove the last remaining desktop — minimum 1 always stands.
    if (state.desktops.length <= 1) return false
    if (index < 0 || index >= state.desktops.length) return false

    // Merge target: the PREVIOUS desktop (index-1), falling back to the first
    // when removing desktop 0. Chosen over "the first" so the merge lands on
    // the desktop the user most likely came from (Pablo's per-screen setup).
    const targetIndex = index > 0 ? index - 1 : 0
    const target = state.desktops[targetIndex]

    // ── 1. Move the removed desktop's windows into the target desktop ──────
    // Same merge semantics as moveWindowToDesktop: into the target's active
    // container (or a fresh container when the target is empty). Windows are
    // NEVER closed — the desktop disappears, its content survives.
    let newTargetLayout = target.layout
    let targetContainerId: string | null
    let nextId = state.nextId

    const removedWindowIds = Object.values(state.windows)
      .filter((w) => w.desktopIndex === index)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => w.id)

    if (removedWindowIds.length > 0) {
      if (!newTargetLayout) {
        targetContainerId = generateId("container", nextId)
        nextId += 1
        newTargetLayout = {
          type: "container",
          id: targetContainerId,
          windowIds: removedWindowIds,
          activeWindowId: removedWindowIds[0],
        }
      } else {
        targetContainerId =
          target.activeContainerId || findAllContainers(newTargetLayout)[0]?.id
        if (!targetContainerId) return false
        const targetContainer = findNode(newTargetLayout, targetContainerId) as ContainerNode
        newTargetLayout = replaceNode(newTargetLayout, targetContainerId, {
          ...targetContainer,
          windowIds: [...targetContainer.windowIds, ...removedWindowIds],
          activeWindowId: targetContainer.activeWindowId ?? removedWindowIds[0],
        })
      }
    } else {
      targetContainerId = target.activeContainerId ?? null
    }

    // ── 2. Splice the desktop out; shift the ones after it down ────────────
    const newDesktops = state.desktops.filter((_, i) => i !== index)
    newDesktops[targetIndex] = {
      ...target,
      layout: newTargetLayout,
      activeContainerId: targetContainerId ?? target.activeContainerId,
    }

    // ── 3. Reindex every window: merged windows point at the target, windows
    // on desktops after the removed one shift down by one ────────────────────
    const newWindows: Record<string, TilingWindow> = {}
    for (const [id, win] of Object.entries(state.windows)) {
      if (win.desktopIndex === index) {
        newWindows[id] = { ...win, desktopIndex: targetIndex, containerId: targetContainerId ?? win.containerId }
      } else if (win.desktopIndex > index) {
        newWindows[id] = { ...win, desktopIndex: win.desktopIndex - 1 }
      } else {
        newWindows[id] = win
      }
    }

    // ── 4. Active desktop follows the merge target (clamped to the new range) ──
    const newActiveIndex = Math.max(0, Math.min(targetIndex, newDesktops.length - 1))

    // Preview invariant: the merge can leave two preview tabs on the target
    // desktop — keep the rightmost+topmost, pin the rest.
    const mergedWindows = normalizeDesktopPreviews(newDesktops, newWindows)

    set({
      desktops: newDesktops,
      windows: mergedWindows,
      activeDesktopIndex: newActiveIndex,
      nextId,
      ...computeDerivedState(newDesktops, newActiveIndex),
    })
    // tab-state (sessionStorage) + ui-state (localStorage): keep per-tab and
    // device-level index in sync — same pattern as switchToDesktop
    storage.set(STORAGE_KEYS.ACTIVE_DESKTOP_INDEX, newActiveIndex)
    storage.set(STORAGE_KEYS.LAST_ACTIVE_DESKTOP_INDEX, newActiveIndex).catch((err) =>
      console.error('[TilingStore] Failed to persist lastActiveDesktopIndex:', err),
    )
    return true
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

    // Preview invariant: a moved preview can meet the target desktop's own —
    // keep the rightmost+topmost, pin the rest.
    const movedWindows = normalizeDesktopPreviews(newDesktops, {
      ...state.windows,
      [windowId]: {
        ...window,
        containerId: targetContainerId,
        desktopIndex: targetDesktopIndex,
      },
    })

    set({
      desktops: newDesktops,
      windows: movedWindows,
      nextId: state.nextId + 1,
    })
  },

  getActiveDesktop: () => {
    const state = get()
    // Clamp: the signature promises a Desktop — a stale index must never leak
    // an undefined desktop to callers.
    return state.desktops[clampDesktopIndex(state.activeDesktopIndex, state.desktops.length)]
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
          ...(w.preview ? { preview: true } : {}),
          ...(typeof w.openerId === 'string' ? { openerId: w.openerId } : {}),
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

    // Preview invariant: at most one preview tab per desktop (old persisted
    // states may carry more — keep the rightmost+topmost, pin the rest).
    const normalizedWindows = normalizeDesktopPreviews(cleanedDesktops, restoredWindows)

    set({
      desktops: cleanedDesktops,
      windows: normalizedWindows,
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

  openNewTab: (sourceWindowId) => {
    const state = get()
    const existing = findDesktopPreviewWindow(state.desktops, state.windows, state.activeDesktopIndex)
    if (existing) get().pinWindow(existing.id)
    const id = get().openWindow("launcher", {}, { inNewTab: true, sourceWindowId })
    // Compact shell has no preview tabs (one pane, pushed in place).
    if (id && !get().compactShell) {
      const w = get().windows[id]
      if (w) set({ windows: { ...get().windows, [id]: { ...w, preview: true } } })
    }
    return id
  },

  openWindow: (type, props, inNewTabOrOptions = false, positionalSourceWindowId?: string) => {
    const options: OpenWindowOptions =
      typeof inNewTabOrOptions === "object" && inNewTabOrOptions !== null
        ? inNewTabOrOptions
        : { inNewTab: Boolean(inNewTabOrOptions), sourceWindowId: positionalSourceWindowId }
    const inNewTab = options.inNewTab ?? false
    const sourceWindowId = options.sourceWindowId
    const definition = windowRegistry.get(type)
    if (!definition) {
      console.error(`[TilingStore] Unknown window type: ${type}`)
      throw new Error(`Unknown window type: ${type}`)
    }

    // Audience guard: admin / dev windows never open for a viewer outside
    // their audience (the launcher hides them; this covers every other path).
    if (!windowRegistry.canOpen(definition)) {
      console.warn(`[TilingStore] Window type "${type}" is not available to this user (audience "${definition.audience}")`)
      return null
    }

    // Feature flag guard: block opening windows whose flag is disabled
    if (definition.featureFlag) {
      const flagValue = getResolvedFlag<boolean>(
        useFeatureFlagsStore.getState(),
        definition.featureFlag,
      )
      if (!flagValue) {
        console.warn(`[TilingStore] Window type "${type}" is disabled by feature flag "${definition.featureFlag}"`)
        return null
      }
    }

    // Workspace boundary guard: block opening conversations from a different workspace.
    // Only applies to 'chat' windows that reference an existing channel (have channelId).
    // Draft chats (no channelId) and non-conversation windows are not affected.
    if (type === "chat" && props.channelId) {
      const channelId = props.channelId as string
      const cachedWs = _channelWorkspaceCache.get(channelId)

      if (cachedWs !== undefined) {
        // Cache hit — synchronous check
        if (!_isChannelInActiveWorkspace(channelId, cachedWs)) {
          return null
        }
      } else {
        // Cache miss — fire async check, block for now.
        // If the check passes, the window is opened asynchronously.
        _verifyAndOpenChatWindow(channelId, type, props, options, get, set)
        return null
      }
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
      if (options.preview) {
        // Preview: show it in its pane without moving the focus off the caller.
        if (options.pin) get().pinWindow(existingWindow.id)
        showTabInPlace(get, set, existingWindow.id, sourceWindowId)
        return existingWindow.id
      }
      get().focusWindow(existingWindow.id)
      return existingWindow.id
    }

    if (options.preview) {
      return openPreview(get, set, type, props, sourceWindowId, Boolean(options.pin))
    }

    // ── GLOBAL PREVIEW ROUTING (docs/specs/ui/preview-tabs.md) ─────────────
    // Every NEW open (no identical window exists) lands in the desktop's
    // preview tab — VS Code preview tabs, per desktop. Opt-outs:
    //   · inNewTab (ctrl/cmd-click and explicit new-tab callers) — untouched
    //   · launcher — a working surface, always fresh tabs
    //   · definition.noPreview — live views & editors (terminal, browser…)
    //   · the compact shell — one pane, the preview pushes in place there
    // Draft chats are NOT an opt-out (Pablo 2026-11-01, configure agent →
    // Chat): a draft is new content like any other — it reuses the desktop's
    // preview tab. Writing in it pins it (the composer calls pinWindow),
    // which is exactly the VS Code gesture: browse → pin on edit.
    // Opt-outs (and inNewTab) open a NEW NORMAL TAB: with the preview tab as
    // the replace target, silently swapping a working surface for something
    // else is no longer the default anywhere.
    const previewable =
      !inNewTab &&
      !isLauncher &&
      !definition.noPreview &&
      !state.compactShell &&
      state.desktops[state.activeDesktopIndex]?.layout != null
    if (previewable) {
      return openPreview(get, set, type, props, sourceWindowId, false)
    }

    // Defensive clamp: an out-of-range activeDesktopIndex (stale restore,
    // workspace-switch race) must not crash on `desktop.layout` — resolve to a
    // valid desktop instead.
    const desktopIndex = clampDesktopIndex(state.activeDesktopIndex, state.desktops.length)
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

    // NEW TAB BEHAVIOR: Create new window and add to container. (The old
    // "replace the active tab" default is gone — the desktop's preview tab
    // is the replace target now; everything else is a new tab.)
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

  pinWindow: (windowId) => {
    const window = get().windows[windowId]
    if (!window || !window.preview) return
    set((state) => ({
      windows: { ...state.windows, [windowId]: { ...state.windows[windowId], preview: false } },
    }))
  },

  setCompactShell: (compact) => {
    if (get().compactShell !== compact) set({ compactShell: compact })
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

    // Feature flag guard: block replacing with a window type whose flag is disabled
    if (definition.featureFlag) {
      const flagValue = getResolvedFlag<boolean>(
        useFeatureFlagsStore.getState(),
        definition.featureFlag,
      )
      if (!flagValue) {
        console.warn(`[TilingStore] Window type "${newType}" is disabled by feature flag "${definition.featureFlag}"`)
        return
      }
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
    if (!desktop.activeContainerId) return
    get().splitContainer(desktop.activeContainerId, direction)
  },

  splitContainer: (containerId, direction) => {
    const state = get()
    const desktop = state.desktops[state.activeDesktopIndex]
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return
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
    if (!desktop) return null
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
    // Stamp this completion: monotonic generation + the workspace active at
    // completion time (the same source the PersistedDriver buckets by).
    // Consumers gate on "THIS workspace's restore has landed" instead of
    // latching on the first restore in history (workspace-switch race).
    const completeRestore = () => ({
      layoutRestored: true,
      restoreGeneration: get().restoreGeneration + 1,
      layoutRestoredForWorkspace: getCurrentWorkspaceId(),
    })

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
        // Clamp the restored per-tab index to the fresh desktops range: a stale
        // sessionStorage/localStorage index from a session with more desktops
        // must never leave activeDesktopIndex out of range (openWindow crash).
        if (savedIndex !== null) {
          set({ activeDesktopIndex: clampDesktopIndex(savedIndex, get().desktops.length) })
        }
        set({ ...completeRestore() })
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
        ...completeRestore(),
      })

      console.log("[TilingStore] Layout restored:", Object.keys(validWindows).length, "windows")

      // Preload the JS chunks for all restored window types so they're
      // ready (or at least fetching) before the user interacts with them.
      // This makes cold loads after reconnect much smoother and reduces
      // the window where a stalled import could show an eternal spinner.
      const windowTypes = new Set<string>()
      for (const w of Object.values(validWindows)) {
        windowTypes.add(w.type)
      }
      preloadWindowChunks(Array.from(windowTypes))
    } catch (error) {
      console.error("[TilingStore] Failed to restore layout:", error)
      set({ ...completeRestore() })
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
      ...(win.preview ? { preview: true } : {}),
      ...(win.openerId ? { openerId: win.openerId } : {}),
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
