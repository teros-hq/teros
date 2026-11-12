/**
 * uiSync — live report + command executor wiring (spec 20261022_ui-state-mca.md,
 * REQ-1 + REQ-6 frontend side).
 *
 * REPORT SIDE (REQ-1)
 *   Subscribes to the tilingStore; on every meaningful change (window open/
 *   close/focus, tab switch, split/ratio, desktop switch, props update) builds
 *   a UiStateReport and sends it via `ui.report`. Debounced ≤500 ms, EXCEPT
 *   focus/tab/desktop changes which flush IMMEDIATELY (NFR-1). Re-reports
 *   immediately on `authenticated` (WS reconnect — a backend restart loses the
 *   in-memory model).
 *
 *   Reporting also (re)subscribes the session to the user's command topic —
 *   the backend does this on every accepted report, so commands reach this
 *   client from the first report on. `ui.subscribe` covers the window between
 *   workspace activation and the first report.
 *
 * EXECUTOR SIDE (REQ-6)
 *   Listens for `ui_command` events (forwarded by client.ts event forwarding)
 *   and applies them through the tilingStore API with commandId dedup and
 *   defensive no-ops (see executor.ts).
 *
 * NO LOOPS: commands change state → ONE normal debounced report; reports never
 * trigger commands.
 *
 * GATING: reports only fire when (a) a workspace is active, (b) the deviceId
 * is initialised, and (c) the layout in the store belongs to the ACTIVE
 * workspace (layoutRestoredForWorkspace) — never report a stale layout mid
 * workspace-switch (the restore race the tilingStore documents).
 *
 * Mount once, globally: `useUiSync()` in the workspace layout (the
 * useBillingRealtimeSync pattern). Module-level single-wiring guards make a
 * double mount harmless.
 */

import { useEffect } from "react"
import { Platform } from "react-native"
import type { UiStateReport } from "@teros/shared"
import { useTilingStore } from "../../store/tilingStore"
import { useNavbarStore } from "../../store/navbarStore"
import { useUiPreferencesStore } from "../../store/uiPreferencesStore"
import { getActiveWorkspaceId } from "../../store/workspaceStoreRef"
import { getTerosClient } from "../terosClientSingleton"
import { getDeviceId, getDeviceLabel, getUserAgent, initDeviceId } from "./deviceId"
import { handleBrowserCommand } from "./browserBridge"
import { applyUiCommand, CommandDedup, type UiCommandEvent } from "./executor"
import { buildReport } from "./reportBuilder"

/** REQ-1: debounce for layout/props changes (focus/tab/desktop flush at once). */
const REPORT_DEBOUNCE_MS = 500

/** Mobile breakpoint — mirrors TilingLayout's MOBILE_BREAKPOINT. */
const MOBILE_BREAKPOINT = 768

/** The transport request the report goes through (mocked in tests). */
type ReportSender = (report: UiStateReport) => Promise<unknown>

/** Injectable deps for tests. */
export interface UiSyncDeps {
  sendReport?: ReportSender
  /** Mobile projection override (defaults to viewport width / Platform). */
  isMobile?: () => boolean
  /** Now() for the debounce timer (defaults to Date.now). */
  now?: () => number
}

// ── Module-level wiring state (single-wiring guards) ─────────────────────────

let wired = false
let unsubTiling: (() => void) | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let lastSentJson = ""
const dedup = new CommandDedup()

/** True when the store's layout belongs to the ACTIVE workspace (restore gate). */
function layoutMatchesActiveWorkspace(): boolean {
  const s = useTilingStore.getState()
  const active = getActiveWorkspaceId()
  if (!active) return false
  return s.layoutRestoredForWorkspace === active
}

/** Build the current report (null when gating says "don't report"). */
export function buildCurrentReport(mobile: boolean): UiStateReport | null {
  const workspaceId = getActiveWorkspaceId()
  const deviceId = getDeviceId()
  if (!workspaceId || !deviceId) return null
  if (!layoutMatchesActiveWorkspace()) return null
  const s = useTilingStore.getState()
  return buildReport({
    desktops: s.desktops,
    windows: s.windows,
    activeDesktopIndex: s.activeDesktopIndex,
    workspaceId,
    deviceId,
    deviceLabel: getDeviceLabel(),
    userAgent: getUserAgent(),
    mobile,
  })
}

/** Send a report through the transport (skips identical consecutive payloads). */
async function sendReport(report: UiStateReport, send: ReportSender): Promise<void> {
  const json = JSON.stringify(report)
  if (json === lastSentJson) return // no meaningful change since the last one
  lastSentJson = json
  try {
    await send(report)
  } catch (err) {
    // Rejected (e.g. UI_BAD_REPORT, offline): forget the "last sent" so the
    // next attempt retries instead of silently deduping forever.
    lastSentJson = ""
    console.warn("[uiSync] ui.report failed (will retry on next change):", err)
  }
}

/** Flush now (immediate path: focus/tab/desktop, authenticated, tests). */
function flushNow(mobile: boolean, send: ReportSender): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  const report = buildCurrentReport(mobile)
  if (!report) return
  void sendReport(report, send)
}

/** Debounced path (layout/props changes — everything that isn't focus/tab/desktop). */
function scheduleReport(mobile: boolean, send: ReportSender): void {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    flushNow(mobile, send)
  }, REPORT_DEBOUNCE_MS)
}

/**
 * Did this store transition change focus / active tab / active desktop?
 * Those flush immediately (NFR-1: ≤1 s freshness for what the user looks at).
 */
function isFocusLikeChange(prev: { desktops: any[]; activeDesktopIndex: number }, next: { desktops: any[]; activeDesktopIndex: number }): boolean {
  if (prev.activeDesktopIndex !== next.activeDesktopIndex) return true
  if (prev.desktops.length !== next.desktops.length) return true
  for (let i = 0; i < next.desktops.length; i++) {
    const a = prev.desktops[i]
    const b = next.desktops[i]
    if (!a || !b) return true
    if (a.activeContainerId !== b.activeContainerId) return true
    if (a.layout !== b.layout) {
      // Layout object identity changes on tab switch/focus (replaceNode) but
      // also on ratio tweaks — compare the active-tab chain cheaply: the
      // focused window id of each desktop.
      if (focusedWindowOf(a) !== focusedWindowOf(b)) return true
    }
  }
  return false
}

/** Focused window of a desktop (active tab of its active container). */
function focusedWindowOf(desktop: { layout: any; activeContainerId: string | null }): string | null {
  if (!desktop.activeContainerId || !desktop.layout) return null
  const find = (node: any): string | null => {
    if (!node) return null
    if (node.type === "container") return node.id === desktop.activeContainerId ? node.activeWindowId : null
    return find(node.first) ?? find(node.second)
  }
  return find(desktop.layout)
}

/**
 * Wire report + executor to a client. Idempotent (module-level guard); the
 * React hook below is the production entry point, this is the testable core.
 */
export function wireUiSync(deps: UiSyncDeps = {}): () => void {
  if (wired) return () => {}
  wired = true

  const client = getTerosClient()
  const send: ReportSender =
    deps.sendReport ?? ((report) => client.transport.request("ui.report", report as unknown as Record<string, unknown>))
  const isMobile =
    deps.isMobile ??
    (() => {
      if (Platform.OS !== "web") return true
      const w = (globalThis as { window?: { innerWidth?: number } }).window?.innerWidth
      return typeof w === "number" ? w < MOBILE_BREAKPOINT : false
    })

  // ── Executor: ui_command events → tilingStore ──────────────────────────────
  const handleCommand = (event: unknown) => {
    // Browser commands (F3) are request-response: forward to the Electron
    // main process and answer via ui.command-result. They never reach the
    // fire-and-forget executor (a browser.* command has no tilingStore
    // meaning — and no correlationId handling there).
    const envelope = (event as { command?: { command?: unknown } })?.command
    const kind = envelope && typeof envelope === "object" ? envelope.command : undefined
    if (typeof kind === "string" && kind.startsWith("browser.")) {
      void handleBrowserCommand(event)
      return
    }
    // Adapter: zustand keeps ACTIONS on the state object (useTilingStore.getState())
    // and getState()/subscribe() on the hook itself. The executor expects one
    // store with both. Passing the bare hook (original bug) left actions
    // undefined — every command died in the executor's try/catch with a silent
    // TypeError (store.openWindow is not a function). Actions are stable
    // references in zustand, so reading them once per command is safe;
    // getState() stays live for state reads.
    const state = useTilingStore.getState()
    const storeAdapter = {
      ...state,
      getState: () => useTilingStore.getState(),
      // View commands (agent UI control): per-device view state applied on the
      // real stores — undefined collapses/theme = toggle.
      setNavbarCollapsed: (collapsed: boolean | undefined) => {
        const navbar = useNavbarStore.getState()
        navbar.setExpanded(collapsed === undefined ? !navbar.isExpanded : !collapsed)
      },
      setTheme: (theme: "dark" | "light" | undefined) => {
        const prefs = useUiPreferencesStore.getState()
        if (theme === undefined) prefs.toggleTheme()
        else prefs.setTheme(theme)
      },
    }
    applyUiCommand(event as UiCommandEvent, storeAdapter as unknown as ExecutorLike, dedup, getDeviceId())
  }
  client.on("ui_command", handleCommand)

  // ── Report side: tilingStore subscription ──────────────────────────────────
  const onStoreChange = (state: any, prevState: any) => {
    // Ignore pure ephemeral churn (notifications, drag state) — only layout/
    // windows/focus matter. Zustand v5: listener gets (state, prevState).
    const layoutChanged =
      state.desktops !== prevState.desktops || state.windows !== prevState.windows
    const focusChanged = isFocusLikeChange(prevState, state)
    if (!layoutChanged && !focusChanged) return
    if (focusChanged) flushNow(isMobile(), send)
    else scheduleReport(isMobile(), send)
  }
  unsubTiling = useTilingStore.subscribe(onStoreChange)

  // ── Reconnect: re-report immediately (backend restart loses the model) ────
  const handleAuthenticated = () => {
    lastSentJson = "" // force send even if identical to the pre-disconnect one
    flushNow(isMobile(), send)
    // Re-subscribe the command topic: a new WS session has no subscriptions.
    // The next report re-subscribes it server-side too; this covers the gap.
    const workspaceId = getActiveWorkspaceId()
    if (workspaceId) {
      client.transport
        .request("ui.subscribe", { workspaceId })
        .catch((err) => console.warn("[uiSync] ui.subscribe failed:", err))
    }
  }
  client.on("authenticated", handleAuthenticated)

  // ── First report + topic subscription once the device id is ready ──────────
  void initDeviceId().then(() => {
    flushNow(isMobile(), send)
    const workspaceId = getActiveWorkspaceId()
    if (workspaceId) {
      client.transport
        .request("ui.subscribe", { workspaceId })
        .catch((err) => console.warn("[uiSync] ui.subscribe failed:", err))
    }
  })

  return () => {
    wired = false
    client.off("ui_command", handleCommand)
    client.off("authenticated", handleAuthenticated)
    unsubTiling?.()
    unsubTiling = null
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    lastSentJson = ""
  }
}

/** The tilingStore shape the executor needs (zustand store object satisfies it). */
type ExecutorLike = Parameters<typeof applyUiCommand>[1]

/**
 * useUiSync — mount once in the workspace layout. Wires report + executor for
 * the lifetime of the workspace shell; unwires on unmount (dev StrictMode
 * double-mount is absorbed by the module-level single-wiring guard).
 */
export function useUiSync(): void {
  useEffect(() => {
    const unwire = wireUiSync()
    return unwire
  }, [])
}
