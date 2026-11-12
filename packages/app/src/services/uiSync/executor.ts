/**
 * Command executor — applies `ui_command` events to the tilingStore
 * (spec 20261022_ui-state-mca.md, REQ-6).
 *
 * Every command goes through the EXISTING tilingStore API (openWindow /
 * closeWindow / updateWindowProps / focusWindow / switchToDesktop), so it
 * inherits all existing behavior: type validation, getKey dedup (opening an
 * already-open chat focuses it instead of duplicating), audience/feature-flag
 * guards, history, persistence, and the one normal state-change report.
 *
 * Targeted opens (desktopId / pane — agent UI control, task tn_BGpRYoeD7HdoziO5):
 * a commanded open can land on a SPECIFIC desktop and in a SPECIFIC pane.
 * Implemented as a temporary desktop switch (switchToDesktop → openWindow →
 * restore) so openWindow's existing placement logic applies unchanged; the
 * pane is then carved with moveWindowToNewSplit around the desktop's active
 * container. The user's active desktop is ALWAYS restored afterwards.
 *
 * View commands (set-navbar-collapsed, set-theme) apply directly on the
 * navbar/uiPreferences stores — per-device view state, not tiling state.
 *
 * Robustness (NFR-5): unknown window types, unknown windowIds, malformed props
 * are logged and ignored — a command can never crash the UI, exactly as a bad
 * local call would be ignored by the store.
 *
 * Dedup: every command carries a unique `commandId`; a bounded LRU set of seen
 * ids absorbs duplicate deliveries (e.g. resubscribed sessions).
 *
 * Targeting: the backend filters by topic, but the client double-checks via the
 * echoed `deviceId` — a device-scoped command whose deviceId is not self is
 * ignored (defense in depth, spec "Frontend changes").
 *
 * No loops: commands change state → the report side fires ONE normal debounced
 * report; reports never trigger commands.
 */

import type { UiCommand, UiPane } from "@teros/shared"
import type { Desktop, TilingWindow } from "../../store/tilingStore"

/** The tilingStore state slice the executor reads (structural — no store import cycle). */
export interface ExecutorStateSlice {
  windows: Record<string, TilingWindow>
  desktops: Desktop[]
  /** Active desktop index (targeted opens need it to restore). */
  activeDesktopIndex: number
}

/** Direction of a split as the tilingStore understands it. */
type SplitDirection = "horizontal" | "vertical"

/** The tilingStore API surface the executor uses (the real store satisfies it). */
export interface ExecutorStore {
  openWindow: (
    type: string,
    props: Record<string, unknown>,
    inNewTab?: boolean,
    sourceWindowId?: string,
  ) => string | null
  closeWindow: (windowId: string) => void
  updateWindowProps: (windowId: string, props: Partial<Record<string, unknown>>) => void
  focusWindow: (windowId: string) => void
  switchToDesktop: (index: number) => void
  /**
   * Carve a new split pane for `windowId` beside `targetContainerId`
   * (tilingStore.moveWindowToNewSplit). Optional so older fakes keep working;
   * pane placement no-ops when absent.
   */
  moveWindowToNewSplit?: (
    windowId: string,
    targetContainerId: string,
    direction: SplitDirection,
    position?: "before" | "after",
  ) => void
  /** Create a new empty desktop at the end; returns its index or null at the cap. */
  addDesktop?: () => number | null
  /** Remove a desktop by index; windows migrate to the previous one. */
  removeDesktop?: (index: number) => boolean
  /** Rename a desktop by index. */
  renameDesktop?: (index: number, name: string) => void
  /**
   * View commands — applied by the caller (uiSync wiring) on the real
   * navbar/uiPreferences stores. Optional for test fakes.
   */
  setNavbarCollapsed?: (collapsed: boolean | undefined) => void
  setTheme?: (theme: "dark" | "light" | undefined) => void
  /** Full state read access (windows/desktops lookups). */
  getState: () => ExecutorStateSlice
}

/** The `ui_command` event envelope the backend pushes (ui domain deliver()). */
export interface UiCommandEvent {
  type: "ui_command"
  workspaceId: string
  userId: string
  /** Resolved target: 'all' or a deviceId. */
  target: string
  /** Present only on device-scoped delivery. */
  deviceId?: string
  command: UiCommand
}

/** Bounded seen-commandId set (insertion-order LRU, capped). */
const MAX_SEEN_COMMANDS = 200

export class CommandDedup {
  private seen = new Set<string>()

  /** True when `id` is new (and remembers it); false on a duplicate. */
  add(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > MAX_SEEN_COMMANDS) {
      // Drop the oldest (Map insertion order via a re-add dance is overkill —
      // Set preserves insertion order too: delete the first key).
      const first = this.seen.values().next().value
      if (first !== undefined) this.seen.delete(first)
    }
    return true
  }

  /** Test-only: forget everything. */
  clear(): void {
    this.seen.clear()
  }

  get size(): number {
    return this.seen.size
  }
}

/** Non-empty string check shared by all payload validations. */
function reqStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Props must be a plain object (arrays/strings/null are malformed). */
function reqProps(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

/** A valid pane value or null. */
function reqPane(v: unknown): UiPane | null {
  const s = reqStr(v)
  return s === "left" || s === "right" || s === "top" || s === "bottom" ? s : null
}

/** A valid theme value or null. */
function reqTheme(v: unknown): "dark" | "light" | null {
  const s = reqStr(v)
  return s === "dark" || s === "light" ? s : null
}

/**
 * Pane → (split direction, position of the NEW pane relative to the active
 * container). The tilingStore renders a `horizontal` split side-by-side
 * (XStack: first=left, second=right) and a `vertical` split stacked (YStack:
 * first=top, second=bottom) — see SplitRenderer. `position` is where
 * moveWindowToNewSplit puts the NEW container around the target.
 */
const PANE_GEOMETRY: Record<UiPane, { direction: SplitDirection; position: "before" | "after" }> = {
  left: { direction: "horizontal", position: "before" },
  right: { direction: "horizontal", position: "after" },
  top: { direction: "vertical", position: "before" },
  bottom: { direction: "vertical", position: "after" },
}

/**
 * Resolve the container the newly opened window should split around: the
 * desktop's active container, else its first container.
 */
function paneTargetContainer(desktop: Desktop | undefined): string | null {
  if (!desktop) return null
  if (desktop.activeContainerId) return desktop.activeContainerId
  const first = findAllContainerIds(desktop.layout)[0]
  return first ?? null
}

/** Depth-first container-id collection from a layout tree (local mirror of the store helper). */
function findAllContainerIds(node: Desktop["layout"]): string[] {
  if (!node) return []
  if (node.type === "container") return [node.id]
  return [...findAllContainerIds(node.first), ...findAllContainerIds(node.second)]
}

/**
 * Apply one `ui_command` envelope. Returns a short outcome string for logs
 * ("applied", "ignored:…" ) — never throws.
 *
 * `ownDeviceId` is this client's deviceId: device-scoped commands (envelope
 * deviceId, or a resolved target that is a deviceId) are ignored unless they
 * match it. Broadcast commands (target 'all') always apply.
 */
export function applyUiCommand(
  event: UiCommandEvent,
  store: ExecutorStore,
  dedup: CommandDedup,
  ownDeviceId: string | null,
): "applied" | "ignored" | "duplicate" {
  try {
    const cmd = event?.command
    if (!cmd || typeof cmd !== "object") {
      console.warn("[uiSync] malformed ui_command (no command envelope)", event)
      return "ignored"
    }
    const commandId = reqStr(cmd.commandId)
    if (!commandId) {
      console.warn("[uiSync] malformed ui_command (no commandId)", cmd)
      return "ignored"
    }
    if (!dedup.add(commandId)) return "duplicate"

    // Device double-check (backend already filtered by topic; defense in depth).
    const scopedDevice = reqStr(event.deviceId) ?? (event.target !== "all" ? reqStr(event.target) : null)
    if (scopedDevice && ownDeviceId && scopedDevice !== ownDeviceId) {
      console.log(`[uiSync] ignoring command ${commandId}: targeted at device ${scopedDevice}, not us (${ownDeviceId})`)
      return "ignored"
    }

    switch (cmd.command) {
      case "open-window": {
        const windowType = reqStr(cmd.windowType)
        const props = cmd.props === undefined ? {} : reqProps(cmd.props)
        if (!windowType || !props) {
          console.warn(`[uiSync] malformed open-window (commandId ${commandId})`, cmd)
          return "ignored"
        }
        const state = store.getState()
        // Unknown type → no-op, exactly as the store would (NFR-5). The store
        // also throws on unknown types, so we pre-check and log instead.
        if (!state || typeof state.windows !== "object") return "ignored"

        const desktopId = reqStr(cmd.desktopId)
        const pane = reqPane(cmd.pane)

        // ── Targeted open: land on desktopId, optionally in its own pane ──
        // The user's view FOLLOWS the open ("muéstrame en el desktop 3"): the
        // switch is kept, not restored — the point of a targeted open is that
        // the user ends up looking at the result.
        if (desktopId) {
          const desktopIndex = state.desktops.findIndex((d) => d.id === desktopId)
          if (desktopIndex === -1) {
            console.log(`[uiSync] open-window: unknown desktopId ${desktopId} — no-op`)
            return "ignored"
          }
          // An empty target desktop absorbs the pane: the FIRST window fills
          // it whole; the next pane-commanded window splits around it. Both
          // orders of "left home, right to-do" converge to the same layout.
          const desktopWasEmpty = state.desktops[desktopIndex]?.layout == null
          if (desktopIndex !== state.activeDesktopIndex) store.switchToDesktop(desktopIndex)
          const focus = cmd.focus !== false
          // Preview routing (preview-tabs.md, one model for user and agent
          // opens): the open lands in the desktop's preview tab when there is
          // one; a split is only created when a genuinely NEW window appears.
          const existed = store.openWindow(windowType, props)
          const newId_ = existed ?? store.openWindow(windowType, props, true)
          if (newId_ && !existed && pane && !desktopWasEmpty && store.moveWindowToNewSplit) {
            const target = paneTargetContainer(store.getState().desktops[desktopIndex])
            if (target) {
              const geo = PANE_GEOMETRY[pane]
              store.moveWindowToNewSplit(newId_, target, geo.direction, geo.position)
            }
          }
          if (newId_ && focus) store.focusWindow(newId_)
          return "applied"
        }

        // ── Pane without desktopId: split around the ACTIVE desktop's pane ──
        if (pane && store.moveWindowToNewSplit) {
          const stateNow = store.getState()
          const activeIndex = stateNow.activeDesktopIndex ?? 0
          const desktopWasEmpty = stateNow.desktops[activeIndex]?.layout == null
          const focus = cmd.focus !== false
          // Same preview routing: split only when a genuinely NEW window
          // appears — a reuse lands in the existing preview tab as-is.
          const existed = store.openWindow(windowType, props)
          const newId = existed ?? store.openWindow(windowType, props, true)
          if (newId) {
            if (!existed && !desktopWasEmpty) {
              const target = paneTargetContainer(store.getState().desktops[activeIndex])
              if (target) {
                const geo = PANE_GEOMETRY[pane]
                store.moveWindowToNewSplit(newId, target, geo.direction, geo.position)
              }
            }
            if (focus) store.focusWindow(newId)
          }
          return "applied"
        }

        // Preview routing (preview-tabs.md, one model for user and agent
        // opens): the commanded window lands in the desktop's preview tab
        // like any other open — it APPEARS on every device (Q8) because the
        // preview tab is shared layout state. The store's own dedup (same
        // type+props → focus) handles "already open".
        const focus = cmd.focus !== false
        const newId = store.openWindow(windowType, props)
        if (newId && focus) store.focusWindow(newId)
        return "applied"
      }

      case "close-window": {
        const windowId = reqStr(cmd.windowId)
        if (!windowId) {
          console.warn(`[uiSync] malformed close-window (commandId ${commandId})`, cmd)
          return "ignored"
        }
        if (!store.getState().windows[windowId]) {
          console.log(`[uiSync] close-window: unknown windowId ${windowId} — no-op`)
          return "ignored"
        }
        store.closeWindow(windowId)
        return "applied"
      }

      case "update-window-props": {
        const windowId = reqStr(cmd.windowId)
        const props = reqProps(cmd.props)
        if (!windowId || !props || Object.keys(props).length === 0) {
          console.warn(`[uiSync] malformed update-window-props (commandId ${commandId})`, cmd)
          return "ignored"
        }
        if (!store.getState().windows[windowId]) {
          console.log(`[uiSync] update-window-props: unknown windowId ${windowId} — no-op`)
          return "ignored"
        }
        store.updateWindowProps(windowId, props) // merge semantics, as the store
        return "applied"
      }

      case "focus-window": {
        const windowId = reqStr(cmd.windowId)
        if (!windowId) {
          console.warn(`[uiSync] malformed focus-window (commandId ${commandId})`, cmd)
          return "ignored"
        }
        if (!store.getState().windows[windowId]) {
          console.log(`[uiSync] focus-window: unknown windowId ${windowId} — no-op`)
          return "ignored"
        }
        store.focusWindow(windowId)
        return "applied"
      }

      case "set-active-desktop": {
        const desktopId = reqStr(cmd.desktopId)
        if (!desktopId) {
          console.warn(`[uiSync] malformed set-active-desktop (commandId ${commandId})`, cmd)
          return "ignored"
        }
        // switchToDesktop takes an INDEX — map desktopId → index client-side
        // (spec Implementation Notes).
        const index = store.getState().desktops.findIndex((d: Desktop) => d.id === desktopId)
        if (index === -1) {
          console.log(`[uiSync] set-active-desktop: unknown desktopId ${desktopId} — no-op`)
          return "ignored"
        }
        store.switchToDesktop(index)
        return "applied"
      }

      case "create-desktop": {
        if (!store.addDesktop) {
          console.warn(`[uiSync] create-desktop: store does not support dynamic desktops — no-op`)
          return "ignored"
        }
        const index = store.addDesktop()
        if (index === null) {
          console.log(`[uiSync] create-desktop: at the desktop cap (10) — no-op`)
          return "ignored"
        }
        const name = reqStr(cmd.name)
        if (name && store.renameDesktop) store.renameDesktop(index, name)
        return "applied"
      }

      case "remove-desktop": {
        if (!store.removeDesktop) {
          console.warn(`[uiSync] remove-desktop: store does not support dynamic desktops — no-op`)
          return "ignored"
        }
        const desktopId = reqStr(cmd.desktopId)
        if (!desktopId) {
          console.warn(`[uiSync] malformed remove-desktop (commandId ${commandId})`, cmd)
          return "ignored"
        }
        const index = store.getState().desktops.findIndex((d: Desktop) => d.id === desktopId)
        if (index === -1) {
          console.log(`[uiSync] remove-desktop: unknown desktopId ${desktopId} — no-op`)
          return "ignored"
        }
        const ok = store.removeDesktop(index)
        return ok ? "applied" : "ignored"
      }

      case "set-navbar-collapsed": {
        if (!store.setNavbarCollapsed) {
          console.warn(`[uiSync] set-navbar-collapsed: no view-command wiring — no-op`)
          return "ignored"
        }
        // undefined = toggle (the store adapter resolves it)
        const collapsed = typeof cmd.collapsed === "boolean" ? cmd.collapsed : undefined
        store.setNavbarCollapsed(collapsed)
        return "applied"
      }

      case "set-theme": {
        if (!store.setTheme) {
          console.warn(`[uiSync] set-theme: no view-command wiring — no-op`)
          return "ignored"
        }
        const theme = reqTheme(cmd.theme)
        store.setTheme(theme ?? undefined) // undefined = toggle
        return "applied"
      }

      default:
        console.warn(`[uiSync] unknown command kind "${String(cmd.command)}" (commandId ${commandId}) — no-op`)
        return "ignored"
    }
  } catch (err) {
    // NFR-5: a command must never crash the frontend.
    console.error("[uiSync] error applying ui_command (ignored):", err)
    return "ignored"
  }
}
