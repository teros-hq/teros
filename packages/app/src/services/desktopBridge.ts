/**
 * Teros Desktop bridge — the renderer-side half of the native browser window
 * (Teros Desktop F2, task tn_etrmG0vkwf4sQ6SJ).
 *
 * When the SPA runs inside the Teros Electron shell, the shell's preload
 * injects `window.terosDesktop` (contextBridge, minimal surface). This module
 * is the ONLY place in the SPA that touches it: everything else goes through
 * `getDesktopBridge()` / `isDesktopShell()`, so the SPA keeps building and
 * running unchanged for plain web (no bridge → Plan A iframe fallback).
 *
 * Contract (main process ↔ renderer), version 1 — see
 * docs/specs/20261031_desktop-f2-browser-window.md for the full protocol:
 *
 * RENDERER → MAIN (invoke, request/response):
 *   teros-browser-create   { windowId, url? }            → BrowserTabState | null
 *   teros-browser-navigate { windowId, url }             → { url } | null
 *   teros-browser-action   { windowId, action }          → { ok } | null
 *       action: 'back' | 'forward' | 'reload' | 'stop'
 *   teros-browser-destroy  { windowId }                  → { ok }
 *   teros-browser-get-state { windowId }                 → BrowserTabState | null
 *
 * RENDERER → MAIN (send, fire-and-forget — layout sync):
 *   teros-browser-rect { windowId, rect, visible, reason }
 *       rect: { x, y, width, height } in CSS pixels, relative to the
 *       window's content area (getBoundingClientRect of the placeholder).
 *       visible: false → the main process hides the native view (tab not
 *       active / desktop not active / overlay open / window minimized).
 *       reason: 'mount' | 'resize' | 'layout' | 'visibility' — for logs.
 *
 * MAIN → RENDERER (broadcast, `on`):
 *   teros-browser-state { windowId, url, title, canGoBack, canGoForward,
 *                          loading }                     → BrowserTabState
 *       Emitted on every navigation / title change so the toolbar's URL bar,
 *       the tab title and the back/forward buttons stay in sync with the
 *       native view (the renderer cannot observe navigations inside a
 *       WebContentsView it does not own).
 *   teros-browser-focus-url { windowId }                → (DBAB-REQ-7)
 *       The shell consumed Cmd/Ctrl+L inside the native page: focus that
 *       window's address field. Optional (older shells never send it).
 *
 * RENDERER → MAIN (invoke, optional — DBAB-REQ-13 / DBAC-REQ-2):
 *   teros-browser-suggest     { query }                → BrowserSuggestResponse
 *       History + provider completions for the address field.
 *   teros-browser-set-consent { windowId, enabled }    → { agentConsent }
 *       The user's "agent may handle this tab" toggle — the ONLY path that
 *       enables agent input on a tab. Reflected as `agentConsent` in pushes.
 *
 * The native view is ALWAYS rendered above the DOM of its rectangle (that is
 * how Electron composites WebContentsViews). Overlays (modals, popovers) get
 * above it by the renderer reporting `visible: false` while an overlay is
 * open — documented in F2-browser-window.md §Overlays.
 */

/** State of one native browser tab, as tracked by the main process. */
export interface BrowserTabState {
  windowId: string
  /** Current URL of the native view ('' before the first navigation). */
  url: string
  /** Page title (falls back to the hostname). */
  title: string
  canGoBack: boolean
  canGoForward: boolean
  /** A navigation is in flight (spinner in the toolbar). */
  loading: boolean
  /**
   * The user's consent for agent input on this tab (DBAC-REQ-2), OFF by
   * default. Absent on shells older than DBAC — the toolbar then shows no
   * toggle.
   */
  agentConsent?: boolean
}

/** One remembered page of the shell's visit log (DBAB-REQ-13). */
export interface BrowserHistoryEntry {
  url: string
  title: string
  visits: number
  /** ms epoch of the last visit */
  lastVisitAt: number
}

/** What the shell answers for an address-field query (DBAB-REQ-13). */
export interface BrowserSuggestResponse {
  query: string
  history: BrowserHistoryEntry[]
  /** Provider completions (free text) — empty when the query is URL-shaped or the provider failed. */
  completions: string[]
}

/** Rect of the placeholder, CSS px, relative to the window content area. */
export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** Why a rect update is being sent — purely diagnostic. */
export type BrowserRectReason = "mount" | "resize" | "layout" | "visibility"

/** The preload-injected surface (see the contract above). */
export interface DesktopBridge {
  readonly platform: "electron"
  readonly version: 1
  invokeBrowserCreate(windowId: string, url?: string): Promise<BrowserTabState | null>
  invokeBrowserNavigate(windowId: string, url: string): Promise<{ url: string } | null>
  invokeBrowserAction(
    windowId: string,
    action: "back" | "forward" | "reload" | "stop",
  ): Promise<{ ok: boolean } | null>
  invokeBrowserDestroy(windowId: string): Promise<{ ok: boolean }>
  invokeBrowserGetState(windowId: string): Promise<BrowserTabState | null>
  sendBrowserRect(
    windowId: string,
    rect: BrowserRect,
    visible: boolean,
    reason: BrowserRectReason,
  ): void
  /** Subscribe to main→renderer state events. Returns an unsubscribe fn. */
  onBrowserState(cb: (state: BrowserTabState) => void): () => void
  /**
   * Subscribe to `teros-browser-focus-url { windowId }` — the shell caught
   * Cmd/Ctrl+L inside the native page and wants that window's address field
   * focused (DBAB-REQ-7). Optional: shells older than DBAB do not send it.
   */
  onBrowserFocusUrl?(cb: (windowId: string) => void): () => void
  /**
   * Suggestions for the address field (DBAB-REQ-13): the shell's visit log
   * plus provider completions. Optional: older shells leave the list at its
   * first row only.
   */
  invokeBrowserSuggest?(query: string): Promise<BrowserSuggestResponse | null>
  /**
   * The user's consent toggle for agent input on a tab (DBAC-REQ-2). Only
   * the toolbar calls it; the new value comes back in the next state push.
   */
  invokeBrowserSetConsent?(windowId: string, enabled: boolean): Promise<{ agentConsent: boolean } | null>
}

declare global {
  // eslint-disable-next-line no-var
  var terosDesktop: DesktopBridge | undefined
}

/** Whether the SPA is running inside the Teros Electron shell. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && window.terosDesktop !== undefined
}

/**
 * The bridge, or null on plain web. Callers must handle null (fallback to
 * Plan A iframe) — never assume the shell exists.
 */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null
  return window.terosDesktop ?? null
}
