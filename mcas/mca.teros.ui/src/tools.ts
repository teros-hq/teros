/**
 * mca.teros.ui — tool handlers
 *
 * Thin wrapper over the backend's ui.* domain (spec 20261022_ui-state-mca.md,
 * REQ-5). Two tool classes:
 *
 *   READ        ui-state → ui.get-state — the user's live desktop, per device.
 *   COMMANDS    ui-open / ui-close / ui-update-props → ui.command
 *               (broadcast: every device applies the identical change) and
 *               ui-focus / ui-set-desktop → ui.command (frontend actions:
 *               the active device only).
 *
 * Every handler is an exported ToolConfig so unit tests can call them
 * directly with a fake bridge (setBackendActionOverride).
 *
 * Permission defaults (Q2, Pablo 2026-10-22): ui-state is read-only
 * (readOnlyHint → seeds 'allow'); every command tool seeds 'ask' — uniformly,
 * including workspace agents. The user can change them per app later.
 *
 * Tool descriptions stay GENERIC about window types on purpose (Q4): the
 * catalog is dynamic — reported live by each frontend in ui-state's
 * `windowTypes` — so the description only points at it and lists the common
 * types as examples.
 */

import type { ToolConfig, ToolContext } from "@teros/mca-sdk"
import { backendAction, connectWsClient, isWsConnected } from "./lib"

// =============================================================================
// Wire types (mirror @teros/shared ui-state.ts — kept local so the MCA does
// not need a build-time dependency on the shared package)
// =============================================================================

interface UiWindowType {
  type: string
  displayName: string
  isLauncher?: boolean
  audience?: string
}

interface UiEnrichedWindow {
  windowId: string
  type: string
  props: Record<string, unknown>
  title?: string
  enrichment?: {
    agentName?: string
    channelTitle?: string
    sessions?: Array<{ terminalId: string; title: string; kind: string }>
    projectName?: string
  }
}

interface UiDeviceState {
  workspaceId: string
  deviceId: string
  deviceLabel?: string
  userAgent?: string
  desktops: Array<{
    desktopId: string
    name?: string
    layout: unknown
  }>
  activeDesktopId: string
  windows: Record<string, UiEnrichedWindow>
  focusedWindowId: string | null
  windowTypes: UiWindowType[]
  lastSeen: string
  online: boolean
}

interface UiCommandResult {
  delivered: number
  target: string
}

/**
 * The request-response outcome of a browser command (backend ui.command
 * browser.* branch): the desktop executor's answer plus delivery metadata.
 */
interface UiBrowserCommandReply extends Record<string, unknown> {
  command: string
  delivered: boolean
  answered: boolean
  ok: boolean
  target?: string
  result?: Record<string, unknown>
  code?: string
  message?: string
}

// =============================================================================
// Helpers
// =============================================================================

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function requireWorkspaceId(context: ToolContext): string {
  const workspaceId = context.execution?.workspaceId
  if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
    throw new Error(
      "workspaceId is missing from the execution context — the UI tools are workspace-scoped. " +
        "Install the app in a workspace and run the tool from one of its channels.",
    )
  }
  return workspaceId
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Backend handler errors carry a machine code (`.code` — UI_UNKNOWN_DEVICE,
 * UI_RATE_LIMITED, FORBIDDEN_WORKSPACE_ROLE, …) that the MCA HTTP layer does
 * NOT propagate (the SDK wraps every handler throw as INTERNAL_ERROR with the
 * message only). Embed the code in the message text so agents and callers can
 * still branch on it: `[UI_UNKNOWN_DEVICE] Device "x" is not online…`.
 */
function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && typeof (error as { code?: unknown }).code === "string") {
    return (error as unknown as { code: string }).code
  }
  return undefined
}

/** backendAction + code-preserving error phrasing. */
async function backendCall<T>(
  action: string,
  params: Record<string, unknown>,
): Promise<T> {
  try {
    return await backendAction<T>(action, params)
  } catch (error) {
    const code = errorCode(error)
    if (code) {
      throw new Error(`[${code}] ${errorMessage(error)}`)
    }
    throw error
  }
}

/**
 * Shared `target` parameter schema — every command tool accepts it
 * ('all' | 'active' | a deviceId from ui-state).
 */
const TARGET_PARAM = {
  type: "string",
  description:
    "Which devices receive the command: 'all' (every connected device), 'active' (the most " +
    "recently active one) or an explicit deviceId from ui-state. Default depends on the " +
    "command — see the tool description.",
}

/**
 * The outcome object every command tool returns. `delivered: 0` MUST be
 * unmissable (REQ-5): the user has no connected client, nothing happened on
 * any screen — the agent must not read it as success.
 */
function commandOutcome(command: string, result: UiCommandResult): Record<string, unknown> {
  if (result.delivered === 0) {
    return {
      command,
      delivered: 0,
      target: result.target,
      applied: false,
      outcome:
        "NOTHING HAPPENED — the user has no connected client: no window was opened or changed " +
        "on any screen. Nothing is pending either; the command was simply not delivered. " +
        "Tell the user to open Teros and try again if they want to see it.",
    }
  }
  return {
    command,
    delivered: result.delivered,
    target: result.target,
    applied: true,
    outcome:
      result.target === "all"
        ? `Delivered to ${result.delivered} client session(s) on every connected device — each one applies the same change.`
        : `Delivered to ${result.delivered} client session(s) of the target device.`,
  }
}

/**
 * Send a ui.command with the common envelope. The backend applies the
 * command's default target when `target` is omitted.
 */
async function sendCommand(
  context: ToolContext,
  command: string,
  payload: Record<string, unknown>,
): Promise<UiCommandResult> {
  const workspaceId = requireWorkspaceId(context)
  return backendCall<UiCommandResult>("ui.command", {
    workspaceId,
    command,
    ...payload,
  })
}

// =============================================================================
// BROWSER COMMANDS (Teros Desktop F3) — request-response over the UI channel
// =============================================================================

/**
 * The executor's error codes the desktop main process returns, phrased for
 * the agent (same semantics as the spike / mca.teros.computer). Keyed so the
 * tool result tells the agent exactly what to do next.
 */
const BROWSER_ERROR_HINTS: Record<string, string> = {
  agent_control_disabled:
    'The user has NOT enabled "the agent may handle my browser" — consent is OFF by default. ' +
    "Looking (browser-get-state, browser-screenshot) still works. Ask the user to turn it on in the browser tab's toolbar.",
  human_has_control:
    "A person is actively using this browser tab right now (the take-over fence). You can still LOOK " +
    "(browser-get-state, browser-screenshot) but inputs are blocked until they stop interacting — wait a few seconds and retry.",
  browser_not_open: "The browser tab is gone (closed or crashed). Read ui-state for the current window list.",
  ref_not_found:
    "The [ref=eNN] is stale — the page changed since your last browser-get-state. Take a fresh snapshot and use new refs.",
  ref_no_bounds:
    "That element and its ancestors have no on-screen bounds (hidden or off-screen). Scroll, or click by x,y coordinates from a screenshot.",
  cdp_error: "The page rejected a CDP operation (it may have navigated mid-action). Retry with a fresh browser-get-state.",
  UI_COMMAND_TIMEOUT:
    "The desktop app did not answer in time — it may be suspended, busy, or an older build without browser support. " +
    "Tell the user and retry once they confirm the app is open.",
  UI_DELIVERY_FAILED: "The command could not be delivered to the device's WebSocket session. Retry.",
  UI_BUSY: "Too many in-flight browser commands. Wait a moment and retry.",
  UI_UNKNOWN_TAB: "The tabId does not exist on that device (it may have been closed). Read ui-state for fresh tabIds.",
}

/** Phrase a browser command outcome for the agent (success or executor error). */
function browserOutcomeText(outcome: UiBrowserCommandReply): string {
  if (!outcome.delivered) {
    if (outcome.code === "UI_BUSY") return outcome.message ?? "The backend is saturated with browser commands."
    return (
      "NOTHING HAPPENED — the user has no connected desktop client: the browser command was not delivered. " +
      "Browser tools only work when the Teros desktop app is running and online."
    )
  }
  if (!outcome.answered) {
    return outcome.message ?? "The desktop did not answer the command in time."
  }
  if (!outcome.ok) {
    const code = outcome.code ?? "unknown"
    const hint = BROWSER_ERROR_HINTS[code] ?? outcome.message ?? "The browser executor reported an error."
    return `[${code}] ${hint}`
  }
  return "OK"
}

/**
 * Send a browser.* command and await the desktop executor's answer
 * (request-response: the backend holds the command until the client replies
 * via ui.command-result or the 25s timeout fires). Throws nothing — every
 * outcome, including errors, is a structured result the agent can read.
 */
async function sendBrowserCommand(
  context: ToolContext,
  command: string,
  payload: Record<string, unknown>,
): Promise<UiBrowserCommandReply> {
  const workspaceId = requireWorkspaceId(context)
  // 30s ceiling: above the backend's 25s pending timeout so the backend's
  // clean timeout outcome wins over a raw WS timeout.
  return backendCall<UiBrowserCommandReply>(
    "ui.command",
    { workspaceId, command, ...payload },
    30_000,
  )
}

/** Validate a tabId argument (shared by every browser tool). */
function requireTabId(args: Record<string, unknown>): string {
  const tabId = args.tabId
  if (typeof tabId !== "string" || tabId.length === 0) {
    throw new Error("tabId is required — the browser window's windowId from ui-state")
  }
  return tabId
}

// =============================================================================
// READ
// =============================================================================

export const uiState: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: true,
    summary: "Read what the user is seeing on their screens right now",
    group: "UI Control",
  },
  description:
    "Read the user's live interface state — what they are looking at RIGHT NOW, on every " +
    "connected device. For each device: its open windows with type + props (chats with " +
    "channel/agent, terminal sessions, boards, …) enriched with readable names (agentName, " +
    "channelTitle, session titles, projectName), the desktop layout tree with split ratios, " +
    "the focused window, the active desktop, the device label (deviceLabel — 'Desktop · macOS' " +
    "is the Teros desktop app, 'Web · Chrome' a browser tab, 'iPhone' the phone) plus the " +
    "client's userAgent for diagnostics, and the live window-type " +
    "catalog (windowTypes — the dynamic list of window types that device supports; check it " +
    "before ui-open). Use this to answer \"what is the user seeing?\", to get windowIds for " +
    "ui-close / ui-update-props / ui-focus, desktopIds for ui-set-desktop, and deviceIds for " +
    "targeted commands. Empty devices = the user is offline (no connected client).",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (_args, context) => {
    const workspaceId = requireWorkspaceId(context)
    const result = await backendCall<{ devices: UiDeviceState[] }>("ui.get-state", {
      workspaceId,
    })
    const devices = result.devices ?? []
    const online = devices.filter((d) => d.online)
    return {
      devices,
      onlineCount: online.length,
      offlineCount: devices.length - online.length,
      focusedWindowPerDevice: Object.fromEntries(
        devices.map((d) => [d.deviceId, d.focusedWindowId]),
      ),
      windowTypes: devices.length > 0 ? devices[0].windowTypes : [],
      note:
        devices.length === 0
          ? "The user has no connected client right now — no device is reporting its screen."
          : undefined,
    }
  },
}

// =============================================================================
// COMMANDS — broadcast (window state → all devices)
// =============================================================================

export const uiOpen: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Open a window on the user's screen(s)",
    group: "UI Control",
  },
  description:
    "Open a window on the user's screen. BROADCAST by default (target 'all'): the window " +
    "opens AND focuses on EVERY connected device — all screens apply the identical change. " +
    "If a window of the same type+props already exists on a device, it is focused there, " +
    "not duplicated. Window types are DYNAMIC — call ui-state first and read its " +
    "`windowTypes` catalog (each entry has type + displayName); common examples: " +
    "chat {agentId | channelId}, terminal, board {projectId}. Pass the type's props exactly " +
    "as ui-state shows them for that window type. With focus (default true) every receiving " +
    "device focuses the window. TARGETED OPEN: pass desktopId (from ui-state's desktops " +
    "list) to open on that specific desktop instead of the active one — the user's view " +
    "switches to it (\"open the to-do list on desktop 3\"); an unknown desktopId is a clear " +
    "error (UI_UNKNOWN_DESKTOP), not a silent no-op. Pass pane ('left' | 'right' | 'top' | " +
    "'bottom') to place the window in its OWN split pane on that side — combine with " +
    "desktopId for \"on desktop 3, to-do list on the right, home on the left\" (open them " +
    "one after the other; the first window fills an empty desktop, the second splits). " +
    "If the result says delivered: 0, NOTHING was opened on any screen — the user has no " +
    "connected client.",
  parameters: {
    type: "object",
    properties: {
      windowType: {
        type: "string",
        description:
          "Window type to open — from the live `windowTypes` catalog in ui-state " +
          "(e.g. 'chat', 'terminal', 'board'). Unknown types are ignored client-side.",
      },
      props: {
        type: "object",
        description:
          "What the window loads — the type's props, exactly as ui-state reports them for " +
          "existing windows of that type. Examples: chat {agentId} or {channelId}, " +
          "board {projectId}.",
        additionalProperties: true,
      },
      focus: {
        type: "boolean",
        description:
          "Focus the window on every receiving device (default: true). With false it opens " +
          "in the background everywhere.",
        default: true,
      },
      desktopId: {
        type: "string",
        description:
          "Target desktop (from ui-state's desktops[].desktopId) — the window opens THERE " +
          "and the user's view switches to that desktop. Unknown desktopId → clear error " +
          "listing that device's desktops. Without it the window opens on every device's " +
          "current desktop.",
      },
      pane: {
        type: "string",
        enum: ["left", "right", "top", "bottom"],
        description:
          "Place the window in its own split pane on this side of the desktop's active " +
          "pane. First window on an empty desktop fills it whole (the pane is absorbed); " +
          "the next pane-commanded window splits around it. Use with desktopId for " +
          "\"right half to-do, left half home\".",
      },
      target: TARGET_PARAM,
    },
    required: ["windowType"],
  },
  handler: async (args, context) => {
    const windowType = requireString(args, "windowType")

    let props: Record<string, unknown> = {}
    if (args.props !== undefined && args.props !== null) {
      if (typeof args.props !== "object" || Array.isArray(args.props)) {
        throw new Error("props must be an object (the window type's props)")
      }
      props = args.props as Record<string, unknown>
    }

    if (args.focus !== undefined && typeof args.focus !== "boolean") {
      throw new Error("focus must be a boolean")
    }

    if (args.pane !== undefined && !["left", "right", "top", "bottom"].includes(args.pane as string)) {
      throw new Error("pane must be one of: left, right, top, bottom")
    }

    const result = await sendCommand(context, "open-window", {
      windowType,
      props,
      ...(typeof args.focus === "boolean" ? { focus: args.focus } : {}),
      ...(typeof args.desktopId === "string" && args.desktopId ? { desktopId: args.desktopId } : {}),
      ...(typeof args.pane === "string" && args.pane ? { pane: args.pane } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("open-window", result)
  },
}

export const uiClose: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    summary: "Close a window on the user's screen(s)",
    group: "UI Control",
  },
  description:
    "Close a window on the user's screen. BROADCAST by default (target 'all'): the window " +
    "closes on EVERY connected device. The windowId comes from ui-state (windows are keyed " +
    "by windowId per device). If the window was already closed on a device in the meantime, " +
    "that device ignores the command (delivery ≠ application) — the result still reports how " +
    "many clients received it. delivered: 0 means the user has no connected client and " +
    "nothing was closed on any screen.",
  parameters: {
    type: "object",
    properties: {
      windowId: {
        type: "string",
        description: "The window to close — a windowId from ui-state.",
      },
      target: TARGET_PARAM,
    },
    required: ["windowId"],
  },
  handler: async (args, context) => {
    const windowId = requireString(args, "windowId")
    const result = await sendCommand(context, "close-window", {
      windowId,
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("close-window", result)
  },
}

export const uiUpdateProps: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Update a window's props on the user's screen(s)",
    group: "UI Control",
  },
  description:
    "Update what a window loads on the user's screen. BROADCAST by default (target 'all'): " +
    "the props are MERGED (not replaced) on EVERY connected device — pass only the keys you " +
    "want to change. The windowId comes from ui-state. Typical uses: switch a terminal " +
    "window's active session, point a board window at another project. If the window no " +
    "longer exists on a device, that device ignores the command (delivery ≠ application). " +
    "delivered: 0 means the user has no connected client and nothing was changed on any " +
    "screen.",
  parameters: {
    type: "object",
    properties: {
      windowId: {
        type: "string",
        description: "The window to update — a windowId from ui-state.",
      },
      props: {
        type: "object",
        description:
          "Props to MERGE into the window (only the keys to change) — same shape ui-state " +
          "reports for that window type.",
        additionalProperties: true,
      },
      target: TARGET_PARAM,
    },
    required: ["windowId", "props"],
  },
  handler: async (args, context) => {
    const windowId = requireString(args, "windowId")

    if (args.props === undefined || args.props === null) {
      throw new Error("props is required (the keys to merge)")
    }
    if (typeof args.props !== "object" || Array.isArray(args.props)) {
      throw new Error("props must be an object (the keys to merge)")
    }
    const props = args.props as Record<string, unknown>
    if (Object.keys(props).length === 0) {
      throw new Error("props must have at least one key to merge")
    }

    const result = await sendCommand(context, "update-window-props", {
      windowId,
      props,
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("update-window-props", result)
  },
}

// =============================================================================
// COMMANDS — frontend actions (view of one device)
// =============================================================================

export const uiFocus: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Focus a window on the user's active device",
    group: "UI Control",
  },
  description:
    "Bring a window to the foreground on the user's screen. FRONTEND ACTION: unlike " +
    "ui-open/ui-close/ui-update-props it targets ONE device — by default the most recently " +
    "active one (target 'active'); pass an explicit deviceId from ui-state to focus on a " +
    "specific device. The windowId comes from ui-state. If the window was closed in the " +
    "meantime, the client ignores the command (delivery ≠ application). delivered: 0 means " +
    "the user has no connected client — nothing was focused on any screen.",
  parameters: {
    type: "object",
    properties: {
      windowId: {
        type: "string",
        description: "The window to focus — a windowId from ui-state.",
      },
      target: TARGET_PARAM,
    },
    required: ["windowId"],
  },
  handler: async (args, context) => {
    const windowId = requireString(args, "windowId")
    const result = await sendCommand(context, "focus-window", {
      windowId,
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("focus-window", result)
  },
}

export const uiSetDesktop: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Switch the user's active desktop",
    group: "UI Control",
  },
  description:
    "Switch which virtual desktop the user is looking at. FRONTEND ACTION: targets ONE " +
    "device — by default the most recently active one (target 'active'); pass an explicit " +
    "deviceId from ui-state for a specific device. The desktopId comes from ui-state " +
    "(desktops[].desktopId of the target device). Other devices are untouched. delivered: 0 " +
    "means the user has no connected client — nothing changed on any screen.",
  parameters: {
    type: "object",
    properties: {
      desktopId: {
        type: "string",
        description: "The desktop to switch to — a desktopId from ui-state.",
      },
      target: TARGET_PARAM,
    },
    required: ["desktopId"],
  },
  handler: async (args, context) => {
    const desktopId = requireString(args, "desktopId")
    const result = await sendCommand(context, "set-active-desktop", {
      desktopId,
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("set-active-desktop", result)
  },
}

// =============================================================================
// COMMANDS — desktop & view control (agent UI control, task tn_BGpRYoeD7HdoziO5)
// =============================================================================

export const uiCreateDesktop: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Create a new virtual desktop on the user's device",
    group: "UI Control",
  },
  description:
    "Create a new empty virtual desktop at the end and switch the user to it. FRONTEND " +
    "ACTION: targets ONE device — by default the most recently active one (target " +
    "'active'); pass an explicit deviceId from ui-state for a specific device. Optional " +
    "name (defaults to \"Desktop N\"). Hard cap: 10 desktops — at the cap nothing is " +
    "created (the client ignores it; check ui-state). Use this before ui-open with a " +
    "desktopId when the user asks for content on a desktop that doesn't exist yet: create " +
    "it, read the new desktopId from ui-state, then open into it. delivered: 0 means the " +
    "user has no connected client — nothing was created.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Optional desktop name (defaults to "Desktop N").',
      },
      target: TARGET_PARAM,
    },
  },
  handler: async (args, context) => {
    if (args.name !== undefined && typeof args.name !== "string") {
      throw new Error("name must be a string")
    }
    if (typeof args.name === "string" && args.name.length === 0) {
      throw new Error("name must not be empty")
    }
    const result = await sendCommand(context, "create-desktop", {
      ...(typeof args.name === "string" && args.name ? { name: args.name } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("create-desktop", result)
  },
}

export const uiRemoveDesktop: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    summary: "Remove a virtual desktop on the user's device",
    group: "UI Control",
  },
  description:
    "Remove a virtual desktop. FRONTEND ACTION: targets ONE device — by default the most " +
    "recently active one (target 'active'); pass an explicit deviceId from ui-state for a " +
    "specific device. The desktopId comes from ui-state. Safe by design: the LAST " +
    "remaining desktop is never removed; the removed desktop's windows MIGRATE to the " +
    "previous desktop (they are never closed). An unknown desktopId is a clear error " +
    "(UI_UNKNOWN_DESKTOP), not a silent no-op. delivered: 0 means the user has no " +
    "connected client — nothing was removed.",
  parameters: {
    type: "object",
    properties: {
      desktopId: {
        type: "string",
        description: "The desktop to remove — a desktopId from ui-state.",
      },
      target: TARGET_PARAM,
    },
    required: ["desktopId"],
  },
  handler: async (args, context) => {
    const desktopId = requireString(args, "desktopId")
    const result = await sendCommand(context, "remove-desktop", {
      desktopId,
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("remove-desktop", result)
  },
}

export const uiSetNavbar: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Collapse or expand the user's left navbar",
    group: "UI Control",
  },
  description:
    "Collapse or expand the user's left navbar (sidebar). FRONTEND ACTION: targets ONE " +
    "device — by default the most recently active one (target 'active'); pass an explicit " +
    "deviceId from ui-state for a specific device. collapsed: true = collapse to the " +
    "icon rail, false = expand; OMIT it to toggle. The choice persists for the user. " +
    "delivered: 0 means the user has no connected client — nothing changed.",
  parameters: {
    type: "object",
    properties: {
      collapsed: {
        type: "boolean",
        description:
          "true = collapse the navbar, false = expand it. Omit to toggle the current state.",
      },
      target: TARGET_PARAM,
    },
  },
  handler: async (args, context) => {
    if (args.collapsed !== undefined && typeof args.collapsed !== "boolean") {
      throw new Error("collapsed must be a boolean")
    }
    const result = await sendCommand(context, "set-navbar-collapsed", {
      ...(typeof args.collapsed === "boolean" ? { collapsed: args.collapsed } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("set-navbar-collapsed", result)
  },
}

export const uiSetTheme: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Switch the user's theme (dark/light)",
    group: "UI Control",
  },
  description:
    "Switch the user's interface theme between dark and light. FRONTEND ACTION: targets " +
    "ONE device — by default the most recently active one (target 'active'); pass an " +
    "explicit deviceId from ui-state for a specific device. theme: 'dark' or 'light'; " +
    "OMIT it to toggle. The choice persists for the user. delivered: 0 means the user has " +
    "no connected client — nothing changed.",
  parameters: {
    type: "object",
    properties: {
      theme: {
        type: "string",
        enum: ["dark", "light"],
        description: "'dark' or 'light'. Omit to toggle the current theme.",
      },
      target: TARGET_PARAM,
    },
  },
  handler: async (args, context) => {
    if (args.theme !== undefined && !["dark", "light"].includes(args.theme as string)) {
      throw new Error("theme must be 'dark' or 'light'")
    }
    const result = await sendCommand(context, "set-theme", {
      ...(typeof args.theme === "string" && args.theme ? { theme: args.theme } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    return commandOutcome("set-theme", result)
  },
}

// =============================================================================
// BROWSER TOOLS (Teros Desktop F3) — the agent's eyes and hands on the user's
// browser tab. Request-response over the UI channel; the desktop's Electron
// main process executes via CDP. Consent OFF by default + take-over fence.
// =============================================================================

/** Shared tabId + target parameter docs for the browser tools. */
const BROWSER_TAB_PARAM = {
  type: "string",
  description:
    "The browser tab to act on — the windowId of a browser window from ui-state (type 'browser'). " +
    "Browser tools only work on the Teros desktop app (a browser tab is a native window there).",
}
const BROWSER_TARGET_PARAM = {
  type: "string",
  description:
    "Optional deviceId from ui-state when the user has several devices — default is the active one.",
}

export const browserGetState: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: true,
    summary: "Read the user's browser tab: a11y tree + page info",
    group: "Browser Control",
  },
  description:
    "Read what the user is looking at in one of their browser tabs INSIDE Teros (desktop app): the page " +
    "URL/title, the control/fence status, and the accessibility tree as indented lines with [ref=eNN] tags " +
    "you can click/type by (same format as the computer MCA). LOOKING is always allowed — even while the " +
    "user holds control or consent is off. Get tabId from ui-state (windows with type 'browser'). With " +
    "screenshot:true a downscaled JPEG of the tab comes back as an attachment. Use this before any click/type " +
    "to get fresh refs.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      screenshot: {
        type: "boolean",
        description: "Also attach a screenshot of the tab (downscaled JPEG). Default false.",
      },
      maxChars: {
        type: "number",
        description: "Max chars of the a11y tree text (500-100000, default 12000).",
      },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    const outcome = await sendBrowserCommand(context, "browser.get-state", {
      tabId,
      ...(args.screenshot === true ? { screenshot: true } : {}),
      ...(typeof args.maxChars === "number" ? { maxChars: args.maxChars } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    const result = outcome.result ?? {}
    const snapshot = typeof result.snapshot === "string" ? result.snapshot : undefined
    const dataUrl = typeof result.screenshotDataUrl === "string" ? result.screenshotDataUrl : undefined

    // Screenshot: objects-first — persist the dataUrl bytes and return an
    // attachment URL (same standard as the playwright/computer MCAs).
    let attachments: Array<{ url: string; mime: string; filename?: string }> | undefined
    if (dataUrl && context.objects) {
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
      const buffer = Buffer.from(base64, "base64")
      const put = await context.objects.put(buffer, "image/jpeg", {
        source: "mca.teros.ui",
        tool: "browser-get-state",
        filename: `browser-${tabId}.jpg`,
      })
      if (put.success) {
        attachments = [{ url: put.url, mime: "image/jpeg", filename: `browser-${tabId}.jpg` }]
      }
    }

    return {
      outcome: browserOutcomeText(outcome),
      ok: outcome.ok,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(typeof result.url === "string" ? { url: result.url } : {}),
      ...(typeof result.title === "string" ? { title: result.title } : {}),
      ...(typeof result.control === "string" ? { control: result.control } : {}),
      ...(snapshot !== undefined ? { snapshot } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
    }
  },
}

export const browserClick: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Click in the user's browser tab (by ref or x,y)",
    group: "Browser Control",
  },
  description:
    "Click an element in the user's browser tab. Trusted input (CDP Input.dispatchMouseEvent — the page " +
    "sees a real click). Target: ref (an [ref=eNN] from browser-get-state — preferred) or explicit x,y " +
    "coordinates in the tab. Requires the user's consent ('the agent may handle my browser', OFF by " +
    "default) and that they are not actively using the tab (take-over fence) — otherwise you get " +
    "agent_control_disabled / human_has_control and should tell the user. After the click you get a fresh " +
    "a11y snapshot by default (observe:'snapshot'); use 'summary' for just the page line or 'none' for " +
    "just the click receipt.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      ref: {
        type: "string",
        description: "The [ref=eNN] to click — from a recent browser-get-state of this tab.",
      },
      x: { type: "number", description: "X coordinate (with y) when clicking by position." },
      y: { type: "number", description: "Y coordinate (with x) when clicking by position." },
      observe: {
        type: "string",
        enum: ["snapshot", "summary", "none"],
        description: "What to return after the click: full a11y snapshot (default), just the page summary, or nothing.",
      },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    if (args.ref === undefined && (typeof args.x !== "number" || typeof args.y !== "number")) {
      throw new Error("browser-click needs ref (from browser-get-state) or x,y coordinates")
    }
    const outcome = await sendBrowserCommand(context, "browser.click", {
      tabId,
      ...(typeof args.ref === "string" && args.ref ? { ref: args.ref } : {}),
      ...(typeof args.x === "number" ? { x: args.x } : {}),
      ...(typeof args.y === "number" ? { y: args.y } : {}),
      ...(typeof args.observe === "string" && args.observe ? { observe: args.observe } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    const result = outcome.result ?? {}
    return {
      outcome: browserOutcomeText(outcome),
      ok: outcome.ok,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(result.acted !== undefined ? { acted: result.acted } : {}),
      ...(typeof result.snapshot === "string" ? { snapshot: result.snapshot } : {}),
      ...(typeof result.url === "string" ? { url: result.url } : {}),
    }
  },
}

export const browserType: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Type text into the user's browser tab",
    group: "Browser Control",
  },
  description:
    "Type text into the user's browser tab — into a field chosen by ref (clicked and focused first, " +
    "cleared by default) or whatever element currently has focus. Trusted input (CDP insertText). " +
    "submit:true presses Enter after typing (search boxes, chat inputs). Requires consent (OFF by default) " +
    "and the take-over fence to be free — agent_control_disabled / human_has_control tell you to ask the " +
    "user. Returns a fresh a11y snapshot by default.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      text: { type: "string", description: "The text to type (max 5000 chars per call)." },
      ref: {
        type: "string",
        description: "Optional [ref=eNN] of the field — it is clicked/focused and cleared before typing.",
      },
      clear: {
        type: "boolean",
        description: "Clear the field before typing when ref is given (default true).",
      },
      submit: { type: "boolean", description: "Press Enter after typing (default false)." },
      observe: {
        type: "string",
        enum: ["snapshot", "summary", "none"],
        description: "What to return after typing: full a11y snapshot (default), page summary, or nothing.",
      },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId", "text"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    if (typeof args.text !== "string" || args.text.length === 0) {
      throw new Error("text is required")
    }
    if (args.text.length > 5000) {
      throw new Error("text is too long (max 5000 chars per call) — split it")
    }
    const outcome = await sendBrowserCommand(context, "browser.type", {
      tabId,
      text: args.text,
      ...(typeof args.ref === "string" && args.ref ? { ref: args.ref } : {}),
      ...(args.clear === false ? { clear: false } : {}),
      ...(args.submit === true ? { submit: true } : {}),
      ...(typeof args.observe === "string" && args.observe ? { observe: args.observe } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    const result = outcome.result ?? {}
    return {
      outcome: browserOutcomeText(outcome),
      ok: outcome.ok,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(result.typed !== undefined ? { typed: result.typed } : {}),
      ...(typeof result.snapshot === "string" ? { snapshot: result.snapshot } : {}),
      ...(typeof result.url === "string" ? { url: result.url } : {}),
    }
  },
}

export const browserScreenshot: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: true,
    summary: "Screenshot the user's browser tab",
    group: "Browser Control",
  },
  description:
    "Capture a screenshot of the user's browser tab (downscaled JPEG, attached to the result). " +
    "LOOKING is always allowed — no consent needed, works even while the user holds control. Use it to " +
    "read pages whose a11y tree is sparse (canvases, images) or to verify what a click did visually.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      width: { type: "number", description: "Target width in px (320-2560, default 1024)." },
      quality: { type: "number", description: "JPEG quality 10-100 (default 60)." },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    const outcome = await sendBrowserCommand(context, "browser.screenshot", {
      tabId,
      ...(typeof args.width === "number" ? { width: args.width } : {}),
      ...(typeof args.quality === "number" ? { quality: args.quality } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    const result = outcome.result ?? {}
    const dataUrl = typeof result.screenshotDataUrl === "string" ? result.screenshotDataUrl : undefined

    let attachments: Array<{ url: string; mime: string; filename?: string }> | undefined
    if (dataUrl && context.objects) {
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
      const buffer = Buffer.from(base64, "base64")
      const put = await context.objects.put(buffer, "image/jpeg", {
        source: "mca.teros.ui",
        tool: "browser-screenshot",
        filename: `browser-${tabId}.jpg`,
      })
      if (put.success) {
        attachments = [{ url: put.url, mime: "image/jpeg", filename: `browser-${tabId}.jpg` }]
      }
    }

    return {
      outcome: browserOutcomeText(outcome),
      ok: outcome.ok,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(typeof result.width === "number" ? { width: result.width } : {}),
      ...(typeof result.height === "number" ? { height: result.height } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(attachments === undefined && dataUrl !== undefined
        ? { note: "screenshot received but object persistence unavailable" }
        : {}),
    }
  },
}

export const browserOpenUrl: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Navigate the user's browser tab to a URL",
    group: "Browser Control",
  },
  description:
    "Navigate the user's browser tab to a URL (top-level navigation — the tab is a real browser inside " +
    "Teros). Requires consent (OFF by default) and the fence to be free. Returns the loaded page's URL + " +
    "title and a fresh a11y snapshot. Use it when the user asks you to open something in the tab they are " +
    "looking at.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      url: { type: "string", description: "The URL to load (https:// is added when omitted)." },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId", "url"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    if (typeof args.url !== "string" || args.url.length === 0) {
      throw new Error("url is required")
    }
    const outcome = await sendBrowserCommand(context, "browser.open-url", {
      tabId,
      url: args.url,
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    const result = outcome.result ?? {}
    return {
      outcome: browserOutcomeText(outcome),
      ok: outcome.ok,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(typeof result.url === "string" ? { url: result.url } : {}),
      ...(typeof result.title === "string" ? { title: result.title } : {}),
      ...(typeof result.snapshot === "string" ? { snapshot: result.snapshot } : {}),
    }
  },
}

export const browserControl: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Check/take/release agent control of the user's tab",
    group: "Browser Control",
  },
  description:
    "The consent + fence status of a browser tab, and the advisory take/release verbs. verb 'status' " +
    "(default) reads who holds control and whether agent control is enabled; 'take' asserts you want to " +
    "act (advisory — the fence is focus-based and the user ALWAYS wins by interacting); 'release' hands " +
    "priority back. Call status before acting to know whether consent is on; agent_control_disabled means " +
    "the user must enable 'the agent may handle my browser' in the tab's toolbar — you cannot enable it " +
    "for them.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      verb: {
        type: "string",
        enum: ["take", "release", "status"],
        description: "'status' (default) reads the state; 'take'/'release' are advisory control verbs.",
      },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    const verb = args.verb === "take" || args.verb === "release" ? args.verb : "status"
    const outcome = await sendBrowserCommand(context, "browser.control", {
      tabId,
      verb,
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    const result = outcome.result ?? {}
    return {
      outcome: browserOutcomeText(outcome),
      ok: outcome.ok,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(result.control !== undefined ? { control: result.control } : {}),
      ...(result.fence !== undefined ? { fence: result.fence } : {}),
    }
  },
}

// =============================================================================
// BROWSER TABS + MORE INPUTS (DBAC-REQ-14 — docs/specs/20261031_desktop-browser-
// agent-control.md). The tab tools compose the generic window commands so an
// agent can open a tab beside the user, act on it and close it without a
// detour through ui-open / ui-state.
// =============================================================================

/** Polling for the tab a browser-open-tab created (test seam: shorten both). */
export const OPEN_TAB_POLL = { intervalMs: 400, timeoutMs: 4_000 }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** https:// for a bare host (same rule as the desktop's open-url). */
function normalizeTabUrl(raw: string): string {
  const t = raw.trim()
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : `https://${t}`
}

interface BrowserTabInfo {
  tabId: string
  url: string
  title: string
  focused: boolean
}

/** The browser windows of one device as tab infos. */
function browserTabsOf(device: UiDeviceState): BrowserTabInfo[] {
  return Object.values(device.windows ?? {})
    .filter((w) => w.type === "browser")
    .map((w) => ({
      tabId: w.windowId,
      url: typeof w.props?.url === "string" ? (w.props.url as string) : "",
      title: w.title ?? (typeof w.props?.title === "string" ? (w.props.title as string) : ""),
      focused: device.focusedWindowId === w.windowId,
    }))
}

async function devicesOf(context: ToolContext): Promise<UiDeviceState[]> {
  const workspaceId = requireWorkspaceId(context)
  const result = await backendCall<{ devices: UiDeviceState[] }>("ui.get-state", { workspaceId })
  return result.devices ?? []
}

/** Pick the device a tool targets: an explicit deviceId, else the most recent online one. */
function pickDevice(devices: UiDeviceState[], target: unknown): UiDeviceState | undefined {
  if (typeof target === "string" && target && target !== "active" && target !== "all") {
    return devices.find((d) => d.deviceId === target)
  }
  const online = devices.filter((d) => d.online)
  return online.sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))[0]
}

export const browserOpenTab: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Open a new browser tab beside the user (default: a pane on the right)",
    group: "Browser Control",
  },
  description:
    "Open a NEW browser tab inside the user's Teros desktop app and load a URL in it — by default in its own " +
    "pane on the RIGHT of what the user is looking at (pane: left | right | top | bottom; a desktopId from " +
    "ui-state opens it on that desktop). Returns the tab's tabId as soon as the device reports the new window " +
    "(a few hundred ms) — then use browser-get-state / browser-click / browser-type / browser-scroll / " +
    "browser-press-key / browser-screenshot on it, and browser-close-tab when done. Acting in the tab still " +
    "needs the user's consent toggle (OFF by default; looking does not). If an identical tab already exists " +
    "it is focused and its tabId returned. tabId: null with a note means the device has not reported the " +
    "window yet — call browser-list-tabs. delivered: 0 means the user has no connected desktop app.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to load (https:// is added when omitted)." },
      pane: {
        type: "string",
        enum: ["left", "right", "top", "bottom"],
        description: "Which side of the user's active pane the tab opens in. Default: right.",
      },
      desktopId: {
        type: "string",
        description: "Open on this desktop (from ui-state's desktops[].desktopId) instead of the active one.",
      },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["url"],
  },
  handler: async (args, context) => {
    if (typeof args.url !== "string" || args.url.trim().length === 0) {
      throw new Error("url is required")
    }
    const url = normalizeTabUrl(args.url)
    const pane = typeof args.pane === "string" && args.pane ? args.pane : "right"
    if (!["left", "right", "top", "bottom"].includes(pane)) {
      throw new Error("pane must be one of: left, right, top, bottom")
    }
    const target = typeof args.target === "string" && args.target && args.target !== "all" ? args.target : "active"

    // Remember the browser windows that exist BEFORE, so the new one is unambiguous.
    const before = pickDevice(await devicesOf(context), target)
    const knownTabs = new Set(before ? browserTabsOf(before).map((t) => t.tabId) : [])

    const result = await sendCommand(context, "open-window", {
      windowType: "browser",
      props: { url },
      pane,
      focus: true,
      target,
      ...(typeof args.desktopId === "string" && args.desktopId ? { desktopId: args.desktopId } : {}),
    })
    if (result.delivered === 0) {
      return { ...commandOutcome("open-window", result), tabId: null, url }
    }
    const deviceId = result.target

    const deadline = Date.now() + OPEN_TAB_POLL.timeoutMs
    let fallback: BrowserTabInfo | undefined
    while (Date.now() <= deadline) {
      await sleep(OPEN_TAB_POLL.intervalMs)
      const device = (await devicesOf(context)).find((d) => d.deviceId === deviceId)
      if (!device) continue
      const tabs = browserTabsOf(device)
      const fresh = tabs.find((t) => !knownTabs.has(t.tabId) && sameSite(t.url, url))
      const same = tabs.find((t) => sameSite(t.url, url))
      if (fresh || same) {
        const tab = (fresh ?? same) as BrowserTabInfo
        return {
          outcome: `Browser tab ${tab.tabId} is open on the ${pane} with ${tab.url || url}. Looking works right away; acting needs the user's consent toggle in that tab's toolbar.`,
          tabId: tab.tabId,
          url: tab.url || url,
          ...(tab.title ? { title: tab.title } : {}),
          deviceId,
          pane,
          delivered: result.delivered,
        }
      }
      fallback = tabs.find((t) => !knownTabs.has(t.tabId))
      if (fallback) {
        return {
          outcome: `A new browser tab ${fallback.tabId} appeared on the ${pane} (its page has not reported ${url} yet).`,
          tabId: fallback.tabId,
          url: fallback.url || url,
          deviceId,
          pane,
          delivered: result.delivered,
        }
      }
    }
    return {
      outcome:
        `The open command was delivered (${result.delivered} session(s)) but the device has not reported the new ` +
        "browser window yet. Call browser-list-tabs in a moment to get its tabId.",
      tabId: null,
      url,
      deviceId,
      pane,
      delivered: result.delivered,
      note: "tab not yet reported — use browser-list-tabs",
    }
  },
}

/** Same page, ignoring scheme-less input, trailing slash and a www prefix. */
function sameSite(reported: string, requested: string): boolean {
  if (!reported) return false
  const norm = (u: string) => {
    try {
      const x = new URL(u)
      return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}${x.search}`
    } catch {
      return u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")
    }
  }
  const a = norm(reported)
  const b = norm(requested)
  return a === b || a.startsWith(b) || b.startsWith(a)
}

export const browserListTabs: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: true,
    summary: "List the user's browser tabs (desktop app)",
    group: "Browser Control",
  },
  description:
    "List the browser tabs open inside the user's Teros desktop app, per connected device: tabId (what every " +
    "other browser tool takes), url, title and whether the tab is the focused window. Use it to find a tab the " +
    "user is looking at, or after browser-open-tab returned tabId: null. No tabs and no online device means " +
    "the user does not have the desktop app open.",
  parameters: {
    type: "object",
    properties: {
      target: BROWSER_TARGET_PARAM,
    },
  },
  handler: async (args, context) => {
    const devices = await devicesOf(context)
    const wanted = typeof args.target === "string" && args.target && args.target !== "active" && args.target !== "all" ? args.target : null
    const listed = devices
      .filter((d) => (wanted ? d.deviceId === wanted : true))
      .map((d) => ({ deviceId: d.deviceId, deviceLabel: d.deviceLabel, online: d.online, tabs: browserTabsOf(d) }))
    const total = listed.reduce((n, d) => n + d.tabs.length, 0)
    return {
      devices: listed,
      totalTabs: total,
      outcome:
        total === 0
          ? devices.some((d) => d.online)
            ? "No browser tab is open on the user's connected device(s). browser-open-tab opens one."
            : "The user has no connected client — no device is reporting its screen."
          : `${total} browser tab(s) across ${listed.length} device(s).`,
    }
  },
}

export const browserCloseTab: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    summary: "Close one of the user's browser tabs",
    group: "Browser Control",
  },
  description:
    "Close a browser tab inside the user's Teros desktop app (the tabId from browser-open-tab or " +
    "browser-list-tabs). The window closes on the target device; if it was already closed the client ignores " +
    "the command. Close the tabs you opened when your task is done.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    const target = typeof args.target === "string" && args.target && args.target !== "all" ? args.target : "active"
    const result = await sendCommand(context, "close-window", { windowId: tabId, target })
    return { ...commandOutcome("close-window", result), tabId }
  },
}

export const browserScroll: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Scroll the user's browser tab",
    group: "Browser Control",
  },
  description:
    "Scroll the page in the user's browser tab with a trusted wheel event: direction up | down | left | right, " +
    "optional amount in CSS pixels (default 80% of the view), optionally over a ref (a scrollable element from " +
    "browser-get-state). Requires consent (OFF by default) and a free fence. Returns a fresh a11y snapshot by " +
    "default — use observe 'summary' or 'none' when you only need to move.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Which way to scroll." },
      amount: { type: "number", description: "CSS pixels (1-10000). Default: 80% of the view's height or width." },
      ref: { type: "string", description: "Optional [ref=eNN] to scroll over (a scrollable panel)." },
      observe: {
        type: "string",
        enum: ["snapshot", "summary", "none"],
        description: "What to return after scrolling: full a11y snapshot (default), page summary, or nothing.",
      },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId", "direction"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    if (typeof args.direction !== "string" || !["up", "down", "left", "right"].includes(args.direction)) {
      throw new Error("direction must be one of: up, down, left, right")
    }
    if (args.amount !== undefined && (typeof args.amount !== "number" || !Number.isInteger(args.amount) || args.amount < 1 || args.amount > 10_000)) {
      throw new Error("amount must be an integer between 1 and 10000 (CSS pixels)")
    }
    const outcome = await sendBrowserCommand(context, "browser.scroll", {
      tabId,
      direction: args.direction,
      ...(typeof args.amount === "number" ? { amount: args.amount } : {}),
      ...(typeof args.ref === "string" && args.ref ? { ref: args.ref } : {}),
      ...(typeof args.observe === "string" && args.observe ? { observe: args.observe } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    const result = outcome.result ?? {}
    return {
      outcome: browserOutcomeText(outcome),
      ok: outcome.ok,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(result.scrolled !== undefined ? { scrolled: result.scrolled } : {}),
      ...(typeof result.snapshot === "string" ? { snapshot: result.snapshot } : {}),
      ...(typeof result.url === "string" ? { url: result.url } : {}),
    }
  },
}

export const browserPressKey: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: false,
    summary: "Press a key in the user's browser tab",
    group: "Browser Control",
  },
  description:
    "Press ONE key in the user's browser tab with trusted input: a named key (Enter, Escape, Tab, Backspace, " +
    "Delete, ArrowUp/ArrowDown/ArrowLeft/ArrowRight, Home, End, PageUp, PageDown, Space) or a single character, " +
    "with optional modifiers (Alt, Control, Meta, Shift). Optionally click a ref first to focus it. Use it for " +
    "Escape to close dialogs, Tab to move focus, Enter to submit, arrows in menus. Requires consent (OFF by " +
    "default) and a free fence. Returns a fresh a11y snapshot by default.",
  parameters: {
    type: "object",
    properties: {
      tabId: BROWSER_TAB_PARAM,
      key: { type: "string", description: "The key: a named key (Enter, Escape, Tab, ArrowDown, …) or one character." },
      modifiers: {
        type: "array",
        items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
        description: "Modifiers held while pressing (max 4).",
      },
      ref: { type: "string", description: "Optional [ref=eNN] to click/focus before pressing." },
      observe: {
        type: "string",
        enum: ["snapshot", "summary", "none"],
        description: "What to return after pressing: full a11y snapshot (default), page summary, or nothing.",
      },
      target: BROWSER_TARGET_PARAM,
    },
    required: ["tabId", "key"],
  },
  handler: async (args, context) => {
    const tabId = requireTabId(args)
    if (typeof args.key !== "string" || args.key.length === 0 || args.key.length > 32) {
      throw new Error("key is required (a named key such as Enter, Escape, Tab, ArrowDown, or one character)")
    }
    if (args.modifiers !== undefined) {
      if (!Array.isArray(args.modifiers) || args.modifiers.length > 4 || args.modifiers.some((m) => !["Alt", "Control", "Meta", "Shift"].includes(String(m)))) {
        throw new Error("modifiers must be an array of up to 4 of: Alt, Control, Meta, Shift")
      }
    }
    const outcome = await sendBrowserCommand(context, "browser.press-key", {
      tabId,
      key: args.key,
      ...(Array.isArray(args.modifiers) && args.modifiers.length > 0 ? { modifiers: args.modifiers } : {}),
      ...(typeof args.ref === "string" && args.ref ? { ref: args.ref } : {}),
      ...(typeof args.observe === "string" && args.observe ? { observe: args.observe } : {}),
      ...(typeof args.target === "string" && args.target ? { target: args.target } : {}),
    })
    const result = outcome.result ?? {}
    return {
      outcome: browserOutcomeText(outcome),
      ok: outcome.ok,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(result.pressed !== undefined ? { pressed: result.pressed } : {}),
      ...(typeof result.snapshot === "string" ? { snapshot: result.snapshot } : {}),
      ...(typeof result.url === "string" ? { url: result.url } : {}),
    }
  },
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

export const VERSION = "1.3.0"

export const healthCheck: ToolConfig<Record<string, unknown>, unknown> = {
  annotations: {
    readOnlyHint: true,
  },
  description:
    "Internal health check tool. Verifies WebSocket connectivity to the backend ui.* API.",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (_args, context) => {
    const { HealthCheckBuilder } = await import("@teros/mca-sdk")
    const builder = new HealthCheckBuilder({}).setVersion(VERSION)

    // Self-healing: if the bridge is not connected, try to connect before
    // reporting degraded — the lazy connect may simply never have been
    // triggered yet (cold start), which is not a real outage.
    if (!isWsConnected()) {
      try {
        await connectWsClient()
      } catch {
        // fall through to the degraded report below
      }
    }

    if (!isWsConnected()) {
      builder.addIssue("DEPENDENCY_UNAVAILABLE", "Not connected to backend WebSocket", {
        type: "auto_retry",
        description: "WebSocket connection to the backend is not established",
      })
      return builder.build()
    }

    try {
      // Harmless read against the app's workspace. The bridge context has no
      // actor, so ui.get-state needs the workspaceId explicitly — a missing
      // one is a MISSING_WORKSPACE_ID error, not a connectivity problem.
      // Through the override seam (unit tests) this is a no-op fake.
      const workspaceId = context.execution?.workspaceId
      await backendCall("ui.get-state", workspaceId ? { workspaceId } : {})
    } catch (error: any) {
      builder.addIssue("DEPENDENCY_UNAVAILABLE", `ui.get-state failed: ${errorMessage(error)}`, {
        type: "auto_retry",
        description: "Backend ui.* API temporarily unavailable",
      })
    }

    return builder.build()
  },
}
