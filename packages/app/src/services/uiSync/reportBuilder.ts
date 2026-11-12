/**
 * Report builder — tilingStore state → UiStateReport (spec 20261022_ui-state-mca.md, REQ-1).
 *
 * Pure functions: no subscriptions, no transport. The sync module (index.ts)
 * calls `buildReport` on every meaningful store change and sends the result
 * via `ui.report`. The mapping is 1:1 with the spec's Terminology:
 *
 *   tilingStore Desktop    → UiDesktop { desktopId, name?, layout }
 *   SplitNode              → { kind:'split', direction, ratio, children[2] }
 *   ContainerNode          → { kind:'container', windowIds, activeWindowId }
 *   TilingWindow           → UiWindow { windowId, type, props (serialize()), title? }
 *
 * Mobile (Q5): the phone shell (MobileTilingLayout) consolidates every tab into
 * one strip, so the reported layout is the DEGENERATE form — every container of
 * the active desktop collected as a flat stack of containers, no ratios. Same
 * envelope, same commands; only the projection differs.
 *
 * Everything is defensive: a window type whose serialize() throws falls back
 * to raw props (the tilingStore persistence pattern); ids/labels are clamped to
 * the backend's validation caps so a report is never rejected over cosmetics.
 */

import type {
  UiDesktop,
  UiLayoutNode,
  UiStateReport,
  UiWindow,
  UiWindowType,
} from "@teros/shared"
import { UI_MAX_DESKTOPS, UI_MAX_WINDOWS } from "@teros/shared"
import type { ContainerNode, Desktop, LayoutNode, SplitNode, TilingWindow } from "../../store/tilingStore"
import { windowRegistry } from "../windowRegistry"

// ── Caps (mirror the backend's validateUiStateReport — see ui-state-manager.ts) ──

const MAX_ID_LEN = 200
const MAX_LABEL_LEN = 200
const MAX_TITLE_LEN = 500
/** User agents run ~300 chars today; 512 leaves headroom without letting a
 * pathological value bloat every report. */
const MAX_UA_LEN = 512

/** Clamp a string to the backend's id/label/title caps; null when unusable. */
function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length === 0) return null
  return v.length > max ? v.slice(0, max) : v
}

// ── Layout projection ────────────────────────────────────────────────────────

/** SplitNode → UiLayoutNode split branch (ratio kept — the panel width model). */
function projectSplit(node: SplitNode, opts: { includeRatio: boolean }): UiLayoutNode {
  return {
    kind: "split",
    direction: node.direction,
    ...(opts.includeRatio && Number.isFinite(node.ratio)
      ? { ratio: Math.max(0, Math.min(1, node.ratio)) }
      : {}),
    children: [
      projectNode(node.first, opts),
      projectNode(node.second, opts),
    ] as [UiLayoutNode, UiLayoutNode],
  }
}

/** ContainerNode → UiLayoutNode container branch (a tab group). */
function projectContainer(node: ContainerNode): UiLayoutNode {
  return {
    kind: "container",
    windowIds: node.windowIds.filter((id): id is string => typeof id === "string"),
    activeWindowId: typeof node.activeWindowId === "string" ? node.activeWindowId : null,
  }
}

function projectNode(node: LayoutNode | null, opts: { includeRatio: boolean }): UiLayoutNode | null {
  if (!node) return null
  if (node.type === "split") return projectSplit(node as SplitNode, opts)
  return projectContainer(node as ContainerNode)
}

/**
 * Mobile degenerate layout (Q5): the phone shell (MobileTilingLayout)
 * consolidates every tab from every container into ONE strip, so the equivalent
 * simplified layout is a single container holding all windows of the desktop,
 * active = the desktop's focused window. No splits, no ratios.
 */
function projectMobileStack(desktop: Desktop): UiLayoutNode | null {
  const windowIds: string[] = []
  collectWindowIdList(desktop.layout, windowIds)
  if (windowIds.length === 0) return null
  const activeWindowId =
    (desktop.activeContainerId
      ? activeWindowOfContainer(desktop.layout, desktop.activeContainerId)
      : null) ?? windowIds[0] ?? null
  return {
    kind: "container",
    windowIds,
    activeWindowId,
  }
}

/** Depth-first window-id collection into an ordered list (mobile strip order). */
function collectWindowIdList(node: LayoutNode | null, out: string[]): void {
  if (!node) return
  if (node.type === "container") {
    for (const id of (node as ContainerNode).windowIds) {
      if (typeof id === "string") out.push(id)
    }
    return
  }
  collectWindowIdList((node as SplitNode).first, out)
  collectWindowIdList((node as SplitNode).second, out)
}

/** Depth-first container collection (the MobileTilingLayout collectAllWindows pattern). */
function collectContainers(node: LayoutNode | null): ContainerNode[] {
  if (!node) return []
  if (node.type === "container") return [node as ContainerNode]
  return [...collectContainers((node as SplitNode).first), ...collectContainers((node as SplitNode).second)]
}

// ── Window projection ────────────────────────────────────────────────────────

/** One TilingWindow → UiWindow; props through the type's serialize(), raw fallback. */
export function projectWindow(win: TilingWindow): UiWindow {
  const def = windowRegistry.get(win.type)
  let props: Record<string, unknown> = { ...win.props }
  if (def?.serialize) {
    try {
      const serialized = def.serialize(win.props)
      if (serialized && typeof serialized === "object") props = { ...serialized }
    } catch (err) {
      console.warn(`[uiSync] serialize() failed for window type ${win.type}:`, err)
    }
  }
  const title = def?.getTitle ? safeTitle(def, win) : undefined
  return {
    windowId: win.id,
    type: win.type,
    props,
    ...(title !== undefined ? { title } : {}),
  }
}

/** getTitle() through the registry, clamped to the backend's title cap. */
function safeTitle(def: { getTitle: (props: Record<string, unknown>) => string }, win: TilingWindow): string | undefined {
  try {
    const t = def.getTitle(win.props)
    return clampStr(t, MAX_TITLE_LEN) ?? undefined
  } catch {
    return undefined
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/**
 * The dynamic window-type catalog (Q4): the client's registry is the source of
 * truth. `{type, displayName, isLauncher, audience}` per registered type.
 */
export function buildWindowTypes(): UiWindowType[] {
  return windowRegistry.getAll().map((def) => ({
    type: def.type,
    displayName: clampStr(def.displayName, MAX_LABEL_LEN) ?? def.type,
    ...(def.isLauncher ? { isLauncher: true } : {}),
    ...(def.audience ? { audience: def.audience } : {}),
  }))
}

// ── Report ────────────────────────────────────────────────────────────────────

export interface BuildReportInput {
  /** The tilingStore state slice (desktops, windows, activeDesktopIndex). */
  desktops: Desktop[]
  windows: Record<string, TilingWindow>
  activeDesktopIndex: number
  /** The workspace the layout belongs to (the active workspace). */
  workspaceId: string
  deviceId: string
  deviceLabel?: string
  /** The client's user agent (diagnostics; omitted when there is none). */
  userAgent?: string
  /** Mobile projection: degenerate container stack, no ratios (Q5). */
  mobile?: boolean
}

/**
 * Store state → UiStateReport. Focused window = the active tab of the active
 * container of the ACTIVE desktop (spec Terminology). Windows beyond the
 * backend cap are dropped (never rejected) so a pathological store can't break
 * reporting.
 */
export function buildReport(input: BuildReportInput): UiStateReport {
  const { desktops, windows, activeDesktopIndex, workspaceId, deviceId, mobile } = input
  const deviceLabel = clampStr(input.deviceLabel, MAX_LABEL_LEN) ?? undefined
  const userAgent = clampStr(input.userAgent, MAX_UA_LEN) ?? undefined

  const activeDesktop = desktops[Math.max(0, Math.min(activeDesktopIndex, desktops.length - 1))]

  const uiDesktops: UiDesktop[] = desktops.slice(0, UI_MAX_DESKTOPS).map((desktop) => {
    const layout = mobile
      ? projectMobileStack(desktop)
      : projectNode(desktop.layout, { includeRatio: true })
    return {
      desktopId: desktop.id,
      ...(desktop.name ? { name: clampStr(desktop.name, MAX_LABEL_LEN) ?? undefined } : {}),
      layout,
    }
  })

  // Windows: only those the layout actually references (per desktop), capped.
  const windowIds = new Set<string>()
  for (const d of desktops) collectWindowIds(d.layout, windowIds)
  const uiWindows: Record<string, UiWindow> = {}
  let count = 0
  for (const id of windowIds) {
    if (count >= UI_MAX_WINDOWS) break
    const win = windows[id]
    if (!win) continue
    uiWindows[id] = projectWindow(win)
    count++
  }

  // Focused window: active tab of the active container of the active desktop.
  const focusedWindowId = activeDesktop?.activeContainerId
    ? activeWindowOfContainer(activeDesktop.layout, activeDesktop.activeContainerId)
    : null

  const activeDesktopId =
    activeDesktop?.id ?? desktops[0]?.id ?? "desktop_0"

  return {
    workspaceId: clampStr(workspaceId, MAX_ID_LEN) ?? "",
    deviceId: clampStr(deviceId, MAX_ID_LEN) ?? "",
    ...(deviceLabel !== undefined ? { deviceLabel } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
    desktops: uiDesktops.length > 0 ? uiDesktops : [{ desktopId: "desktop_0", layout: null }],
    activeDesktopId,
    windows: uiWindows,
    focusedWindowId,
    windowTypes: buildWindowTypes(),
  }
}

/** Depth-first window-id collection from a layout tree. */
function collectWindowIds(node: LayoutNode | null, out: Set<string>): void {
  if (!node) return
  if (node.type === "container") {
    for (const id of (node as ContainerNode).windowIds) out.add(id)
    return
  }
  collectWindowIds((node as SplitNode).first, out)
  collectWindowIds((node as SplitNode).second, out)
}

/** The active window of `containerId` in the tree, null when absent. */
function activeWindowOfContainer(layout: LayoutNode | null, containerId: string): string | null {
  if (!layout) return null
  if (layout.type === "container") {
    return layout.id === containerId ? layout.activeWindowId : null
  }
  return (
    activeWindowOfContainer((layout as SplitNode).first, containerId) ??
    activeWindowOfContainer((layout as SplitNode).second, containerId)
  )
}
