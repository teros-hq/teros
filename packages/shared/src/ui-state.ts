/**
 * UI State & Window Control — standardized wire types
 * (spec 20261022_ui-state-mca.md, Terminology — these names are normative).
 *
 * The vocabulary of the Teros desktop: Desktop / Split / Container / Window /
 * window type + props, the live per-device UIState report, and the command
 * envelope agents use to drive the frontend. Frontend types map 1:1
 * (tilingStore Desktop / SplitNode / ContainerNode / TilingWindow); backend
 * and MCA use exactly these names.
 *
 * Two command classes (REQ-4):
 *   - Broadcast commands (open / close / update-window-props) → every device
 *     applies the identical change, focus included.
 *   - Frontend actions (focus-window, set-active-desktop) → one device's
 *     view, the active device by default.
 */

// ── Layout ──────────────────────────────────────────────────────────────────

/** A loaded window. `type` + `props` = WHAT the window loads (serialize() output). */
export interface UiWindow {
  windowId: string
  /** 'chat' | 'terminal' | 'board' | … — the catalog is dynamic (windowTypes). */
  type: string
  props: Record<string, unknown>
  /** Client-known title, if any. */
  title?: string
}

/**
 * Layout tree node: a Split (two panes along one axis + ratio) or a Container
 * (a tab group — the active tab is the loaded window). `ratio` is the share of
 * children[0]: this IS the panel width/height model. Mobile reports a
 * simplified stack of containers and omits ratios.
 */
export type UiLayoutNode =
  | {
      kind: 'split'
      direction: 'horizontal' | 'vertical'
      /** Share of children[0], 0..1. OPTIONAL — mobile omits it. */
      ratio?: number
      children: [UiLayoutNode, UiLayoutNode]
    }
  | {
      kind: 'container'
      windowIds: string[]
      activeWindowId: string | null
    }

/** A virtual desktop of the tiling workspace. */
export interface UiDesktop {
  desktopId: string
  name?: string
  /** Mobile: degenerate stack of containers. */
  layout: UiLayoutNode | null
}

// ── Dynamic catalog ─────────────────────────────────────────────────────────

/** A window type as reported by the frontend's registry (the catalog is dynamic). */
export interface UiWindowType {
  type: string
  displayName: string
  isLauncher?: boolean
  audience?: 'user' | 'admin' | 'dev'
}

// ── Live state ──────────────────────────────────────────────────────────────

/** ui.report payload — the live snapshot of one client (frontend → backend). */
export interface UiStateReport {
  workspaceId: string
  /** Stable per browser/client, persisted locally. */
  deviceId: string
  /** "Web · Chrome", "iPhone", "Desktop · macOS" … */
  deviceLabel?: string
  /** The reporting client's user agent (diagnostics, best effort). Inside the
   * desktop shell this is the shell-masked Chrome UA — it still carries the
   * real Chromium + OS tokens (the shell strips only its own app tokens). */
  userAgent?: string
  desktops: UiDesktop[]
  activeDesktopId: string
  windows: Record<string, UiWindow>
  focusedWindowId: string | null
  /** The reporting client's window-type registry. */
  windowTypes: UiWindowType[]
}

/** Terminal session summary (terminal-window enrichment, resolved at read time). */
export interface UiTerminalSessionSummary {
  terminalId: string
  title: string
  kind: string
}

/**
 * Read-time semantic enrichment so an agent can read the state without extra
 * lookups (REQ-3): chat → agentName + channelTitle; terminal → session
 * titles/kind; board → projectName. Absent when the type has no enrichment.
 */
export interface UiWindowEnrichment {
  /** chat windows */
  agentName?: string
  channelTitle?: string
  /** terminal windows */
  sessions?: UiTerminalSessionSummary[]
  /** board windows */
  projectName?: string
}

/** A UiWindow plus its read-time enrichment. */
export interface UiEnrichedWindow extends UiWindow {
  enrichment?: UiWindowEnrichment
}

/** ui.get-state entry (backend → agent): one device's live state + presence. */
export interface UiDeviceState extends Omit<UiStateReport, 'windows'> {
  windows: Record<string, UiEnrichedWindow>
  /** ISO timestamp of the latest accepted report. */
  lastSeen: string
  online: boolean
}

// ── Commands ────────────────────────────────────────────────────────────────

export type UiCommandKind =
  | 'open-window'
  | 'close-window'
  | 'update-window-props'
  | 'focus-window'
  | 'set-active-desktop'
  | 'create-desktop'
  | 'remove-desktop'
  | 'set-navbar-collapsed'
  | 'set-theme'
  // Browser commands (Teros Desktop F3, task tn_Q9fbZS5wwxWiYRPl) — agent
  // control of a browser TAB the user has open inside Teros. Always targeted
  // at ONE device (the tab lives in one Electron main process) and always
  // request-response: the executor in the desktop main process answers with
  // the result (a11y tree, screenshot, …) through ui.command-result.
  | 'browser.open-url'
  | 'browser.get-state'
  | 'browser.click'
  | 'browser.type'
  | 'browser.screenshot'
  | 'browser.control'
  // DBAC-REQ-12 (docs/specs/20261031_desktop-browser-agent-control.md):
  // wheel scroll and a trusted key press in the tab.
  | 'browser.scroll'
  | 'browser.press-key'

/** browser.scroll directions (DBAC-REQ-9). */
export type UiBrowserScrollDirection = 'up' | 'down' | 'left' | 'right'

/** browser.press-key modifiers (DBAC-REQ-8). */
export type UiBrowserKeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

/**
 * Browser command verbs for 'browser.control' — the agent-side view of the
 * consent + fence state. 'status' reads it; 'take'/'release' are advisory
 * (the fence is focus-based: the user ALWAYS wins by interacting).
 */
export type UiBrowserControlVerb = 'take' | 'release' | 'status'

/** 'all' (broadcast) · 'active' (most recently active online device) · a deviceId. */
export type UiTarget = 'all' | 'active' | string

/** Side of the desktop's active pane a commanded window can be placed in (open-window). */
export type UiPane = 'left' | 'right' | 'top' | 'bottom'

/**
 * Command envelope. Payload fields per kind (validated by the ui domain):
 *   open-window         { windowType, props, focus? = true, desktopId?, pane? } —
 *                        focus applies on EVERY receiving device (Q8). desktopId
 *                        opens on that desktop (per-device; validated against the
 *                        resolved target device). pane places the window in its
 *                        own split pane on that side of the desktop's active pane.
 *   close-window        { windowId }
 *   update-window-props { windowId, props }  — props MERGE
 *   focus-window        { windowId }
 *   set-active-desktop  { desktopId }
 *   create-desktop      { name? } — new empty desktop at the end (cap 10),
 *                        auto-switches to it; name defaults to "Desktop N"
 *   remove-desktop      { desktopId } — windows migrate to the previous
 *                        desktop; never the last remaining one
 *   set-navbar-collapsed { collapsed? } — true = collapse, false = expand,
 *                        omitted = toggle
 *   set-theme           { theme? } — 'dark' | 'light', omitted = toggle
 */
export interface UiCommand {
  /** Unique; clients dedup by it. */
  commandId: string
  command: UiCommandKind
  /** Resolved per REQ-4 defaults when omitted by the caller. */
  target: UiTarget
  windowType?: string
  props?: Record<string, unknown>
  /** open-window: focus the window on every receiving device (default true). */
  focus?: boolean
  windowId?: string
  desktopId?: string
  /** create-desktop: optional name (defaults to "Desktop N" client-side). */
  name?: string
  /** set-navbar-collapsed: true = collapse, false = expand; omitted = toggle. */
  collapsed?: boolean
  /** set-theme: explicit theme; omitted = toggle. */
  theme?: 'dark' | 'light'
  /** open-window: own pane on this side of the desktop's active pane. */
  pane?: UiPane
  // ── Browser commands (F3) ────────────────────────────────────────────────
  /** browser.*: the browser window/tab the command addresses (from ui-state). */
  tabId?: string
  /** browser.open-url: the URL to load in that tab (https:// added if bare). */
  url?: string
  /** browser.get-state: include a screenshot with the a11y tree (default false). */
  screenshot?: boolean
  /** browser.get-state: max chars of the snapshot text (default 12000). */
  maxChars?: number
  /** browser.click: target — an [ref=eNN] from get-state, or explicit x,y. */
  ref?: string
  x?: number
  y?: number
  /** browser.click/type: what to observe after acting — 'snapshot' | 'summary' | 'none' (default snapshot). */
  observe?: 'snapshot' | 'summary' | 'none'
  /** browser.type: the text to type into the focused element (or ref first). */
  text?: string
  /** browser.type: clear the field before typing (default true when ref given). */
  clear?: boolean
  /** browser.type: press Enter after typing (default false). */
  submit?: boolean
  /** browser.screenshot: target width in px (downscaled, default 1024). */
  width?: number
  /** browser.screenshot: JPEG quality 0-100 (default 60). */
  quality?: number
  /** browser.control: 'take' | 'release' | 'status'. */
  verb?: UiBrowserControlVerb
  /** browser.scroll: which way (DBAC-REQ-9). */
  direction?: UiBrowserScrollDirection
  /** browser.scroll: CSS pixels (default 80% of the view). */
  amount?: number
  /** browser.press-key: a named key (Enter, Escape, Tab, Arrow*, …) or one character (DBAC-REQ-8). */
  key?: string
  /** browser.press-key: held modifiers. */
  modifiers?: UiBrowserKeyModifier[]
}

// ── Request-response over the UI channel (F3) ───────────────────────────────

/**
 * A command that expects a RESULT from the client (browser.* commands — the
 * a11y tree / screenshot must travel back to the agent's conversation).
 *
 * Fire-and-forget commands (everything else) are unchanged: broadcast/targeted
 * delivery, no correlation. A command is request-response iff its kind starts
 * with 'browser.' — the single rule, checked by isRequestResponseCommand().
 */
export function isRequestResponseCommand(kind: UiCommandKind): boolean {
  return kind.startsWith('browser.')
}

/**
 * Envelope for request-response commands: UiCommand plus the correlationId
 * the client echoes back in ui.command-result. Generated by the backend when
 * a browser command is dispatched (the agent never sees it).
 */
export interface UiCorrelatedCommand extends UiCommand {
  /** Echoed by the client in ui.command-result; resolves the pending reply. */
  correlationId: string
}

/**
 * ui.command-result payload (desktop client → backend): the outcome of ONE
 * correlated command. `ok: false` + `code` carries the executor's error
 * semantics (agent_control_disabled, human_has_control, browser_not_open,
 * ref_not_found, …) so the agent-facing tool can phrase them precisely.
 */
export interface UiCommandResultPayload {
  workspaceId: string
  /** The correlationId of the command being answered. */
  correlationId: string
  ok: boolean
  /** Executor result on success (a11y tree text, screenshot dataUrl, …). */
  result?: Record<string, unknown>
  /** Executor error code on failure (machine-readable, phrased agent-side). */
  code?: string
  /** Human-readable error message on failure. */
  message?: string
}

/**
 * The outcome the agent-facing tool returns for a browser command: the
 * executor's result (or error) plus delivery metadata. `pending: false` +
 * `code: 'UI_COMMAND_TIMEOUT'` means the desktop never answered in time.
 */
export interface UiBrowserCommandOutcome {
  command: string
  delivered: boolean
  /** True when the desktop answered within the timeout. */
  answered: boolean
  ok: boolean
  result?: Record<string, unknown>
  code?: string
  message?: string
}

/**
 * Default target per command class (REQ-4). Broadcast commands change window
 * state on every device; frontend actions change ONE device's view — the four
 * view/desktop kinds (create/remove desktop, navbar, theme) are per-device
 * state, so they are frontend actions too.
 */
export const UI_COMMAND_DEFAULT_TARGET: Record<UiCommandKind, 'all' | 'active'> = {
  'open-window': 'all',
  'close-window': 'all',
  'update-window-props': 'all',
  'focus-window': 'active',
  'set-active-desktop': 'active',
  'create-desktop': 'active',
  'remove-desktop': 'active',
  'set-navbar-collapsed': 'active',
  'set-theme': 'active',
  // Browser commands act on ONE tab in ONE device's Electron main process —
  // broadcast would be a double-click. Always 'active'; an explicit deviceId
  // is accepted too, never 'all' (rejected by the domain).
  'browser.open-url': 'active',
  'browser.get-state': 'active',
  'browser.click': 'active',
  'browser.type': 'active',
  'browser.screenshot': 'active',
  'browser.control': 'active',
  'browser.scroll': 'active',
  'browser.press-key': 'active',
}

// ── Caps (REQ-1 edge cases / NFR-4) ─────────────────────────────────────────

/** Registry size today; oversized reports are rejected (UI_BAD_REPORT). */
export const UI_MAX_WINDOWS = 45
/** Hard cap for user-created desktops (dynamic desktops, task tn_pA4USvSgNqk9NLS3). */
export const UI_MAX_DESKTOPS = 10
/** The in-memory model is bounded per user (NFR-4). */
export const UI_MAX_DEVICES_PER_USER = 10
/** Defensive catalog cap (the registry is ~45 types today). */
export const UI_MAX_WINDOW_TYPES = 64
/** Whole-report byte cap (NFR-4: ≤ ~15 KB typical, 45 windows worst case). */
export const UI_MAX_REPORT_BYTES = 256 * 1024

// ── Browser command tunables (F3) ────────────────────────────────────────────

/**
 * How long the backend holds a pending browser command before answering the
 * agent with UI_COMMAND_TIMEOUT. 25s: comfortably above the desktop executor's
 * slowest path (open-url + first paint ≈ 2s, getFullAXTree on a heavy page
 * ≈ 3-5s) and below the MCA bridge's 30s adminRequest ceiling, so the agent
 * gets a clean timeout error instead of a dropped WS request.
 */
export const UI_BROWSER_COMMAND_TIMEOUT_MS = 25_000
/** Bounded pending map (per backend process): one entry per in-flight command. */
export const UI_MAX_PENDING_BROWSER_COMMANDS = 128
/** Max bytes of a command result payload (a11y tree ≤12k chars + screenshot dataUrl ≈ 200-400 KB). */
export const UI_MAX_COMMAND_RESULT_BYTES = 2 * 1024 * 1024
