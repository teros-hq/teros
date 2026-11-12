/**
 * Visible-tab tools of the Browser MCA (spec BRW-REQ-6) and the gate the
 * input tools consult (BRW-REQ-5). Registered from index.ts; `current`
 * is the tab the agent pointed the other tools at with browser-use-tab.
 */

import type { McaServer, ToolContext } from "@teros/mca-sdk"
import { gate } from "./fence.js"
import type { SuggestService } from "./suggest.js"
import type { VisibleTab, VisibleTabs } from "./tabs.js"

/** Tools that act on the page: refused on a visible tab without consent / while the person uses it. */
export const INPUT_TOOLS = new Set([
  "browser-navigate",
  "browser-navigate-back",
  "browser-click",
  "browser-type",
  "browser-press-key",
  "browser-fill-form",
  "browser-drag",
  "browser-hover",
  "browser-select-option",
  "browser-file-upload",
  "browser-evaluate",
  "browser-run-code",
  "browser-handle-dialog",
  "browser-resize",
  "browser-emulate-device",
  "browser-start-recording",
  "browser-close",
])

export interface VisibleRuntime {
  tabs: VisibleTabs
  suggest: SuggestService
  /** The visible tab the agent's tools currently act on (browser-use-tab), or null. */
  current: VisibleTab | null
}

function scopeOf(ctx: ToolContext): { userId: string; workspaceId: string } {
  return {
    userId: ctx.execution.userId,
    workspaceId: ctx.execution.workspaceId ?? ctx.execution.appId,
  }
}

function describe(tab: VisibleTab, current: VisibleTab | null) {
  return {
    tabId: tab.id,
    streamId: tab.stream.id,
    url: tab.state.url,
    title: tab.state.title,
    loading: tab.state.loading,
    viewers: tab.viewers.length,
    agentConsent: tab.fence.consent,
    control: tab.fence.holder(),
    current: current === tab,
  }
}

/**
 * @spec BRW-REQ-5 — why an input tool must not run now, as the tool's
 * answer (structured, never thrown: the agent reads `code` and acts).
 */
export function gateCurrent(
  rt: VisibleRuntime | null,
): { ok: false; code: string; message: string; tabId: string } | null {
  const tab = rt?.current
  if (!tab || tab.closed) return null
  const refusal = gate(tab.fence)
  if (!refusal) return null
  return { ok: false, code: refusal.code, message: refusal.message, tabId: tab.id }
}

const NO_STREAMS = {
  ok: false,
  code: "streams_unavailable",
  message: "Visible tabs need the backend socket (MCA_WS_URL); this MCA is running without it.",
} as const

/**
 * Tools register unconditionally (tools.json is generated from a run without
 * a backend socket); `getRt()` answers null until streams exist.
 */
export function registerVisibleTools(server: McaServer, getRt: () => VisibleRuntime | null): void {
  // ── browser-view: the Browser window attaches to its tab ──
  server.tool("browser-view", {
    annotations: { readOnlyHint: false, safeWriteHint: true },
    description:
      "Show a visible browser tab to the user: ensures the tab (yours) and the live stream the Browser window attaches to. Used by the Teros UI; answers { streamId, tabId, state }.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "The Browser window id (stable per window)" },
        url: { type: "string", description: "URL to load when the tab is new (optional)" },
        width: { type: "number", description: "Viewer width in CSS px (optional)" },
        height: { type: "number", description: "Viewer height in CSS px (optional)" },
      },
      required: ["tabId"],
    },
    handler: async (
      args: { tabId: string; url?: string; width?: number; height?: number },
      ctx: ToolContext,
    ) => {
      const rt = getRt()
      if (!rt) return NO_STREAMS
      const size =
        args.width && args.height
          ? { width: Math.round(args.width), height: Math.round(args.height) }
          : undefined
      const tab = await rt.tabs.ensure(
        scopeOf(ctx),
        String(args.tabId).slice(0, 200),
        args.url,
        size,
      )
      return { ok: true, streamId: tab.stream.id, tabId: tab.id, state: tab.state }
    },
  })

  // ── browser-open-tab: an agent opens a tab the user can see ──
  server.tool("browser-open-tab", {
    annotations: { readOnlyHint: false, safeWriteHint: true },
    description:
      'Open a VISIBLE browser tab for the user (it appears as a Browser window in Teros) and point the other browser tools at it. The user must enable "Agent control" in that window before you can act in it; reading (snapshot, screenshot) always works.',
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        tabId: { type: "string", description: "Optional stable id; generated when absent" },
      },
      required: ["url"],
    },
    handler: async (args: { url: string; tabId?: string }, ctx: ToolContext) => {
      const rt = getRt()
      if (!rt) return NO_STREAMS
      const tabId =
        (args.tabId && String(args.tabId).slice(0, 200)) ||
        `tab_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const tab = await rt.tabs.ensure(scopeOf(ctx), tabId, args.url)
      rt.current = tab
      return {
        ok: true,
        ...describe(tab, rt.current),
        note: 'Other browser tools now act on this tab. Ask the user to switch "Agent control" on in the Browser window before clicking or typing.',
      }
    },
  })

  server.tool("browser-list-tabs", {
    annotations: { readOnlyHint: true },
    description:
      "List the visible browser tabs of the current user, with who is watching and whether agent control is on.",
    parameters: { type: "object", properties: {} },
    handler: async (_args: Record<string, never>, ctx: ToolContext) => {
      const rt = getRt()
      if (!rt) return { tabs: [] }
      return {
        tabs: rt.tabs.listFor(ctx.execution.userId).map((t: VisibleTab) => describe(t, rt.current)),
      }
    },
  })

  server.tool("browser-close-tab", {
    annotations: { readOnlyHint: false, safeWriteHint: true },
    description: "Close a visible browser tab (the Browser window shows it as closed).",
    parameters: { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"] },
    handler: async (args: { tabId: string }, ctx: ToolContext) => {
      const rt = getRt()
      if (!rt) return NO_STREAMS
      const tab = rt.tabs.get(String(args.tabId))
      if (!tab || tab.scope.userId !== ctx.execution.userId)
        return { ok: false, code: "browser_not_open", message: `No visible tab ${args.tabId}` }
      if (rt.current === tab) rt.current = null
      await rt.tabs.close(tab.id, "closed_by_agent")
      return { ok: true, tabId: tab.id }
    },
  })

  // ── browser-use-tab: point the tools at a visible tab (or back to headless) ──
  server.tool("browser-use-tab", {
    annotations: { readOnlyHint: false, safeWriteHint: true },
    description:
      "Point every other browser tool at a VISIBLE tab the user can see (from browser-list-tabs / browser-open-tab), or pass tabId null to go back to your own headless page. Answers the tab's state and who controls it.",
    parameters: {
      type: "object",
      properties: {
        tabId: {
          type: ["string", "null"],
          description: "A visible tab id, or null for the headless page",
        },
      },
      required: ["tabId"],
    },
    handler: async (args: { tabId: string | null }, ctx: ToolContext) => {
      const rt = getRt()
      if (!rt) return NO_STREAMS
      if (args.tabId === null || args.tabId === undefined || args.tabId === "") {
        rt.current = null
        return { ok: true, current: null, note: "Tools act on your own headless page again." }
      }
      const tab = rt.tabs.get(String(args.tabId))
      if (!tab || tab.scope.userId !== ctx.execution.userId) {
        return {
          ok: false,
          code: "browser_not_open",
          message: `No visible tab ${args.tabId} — see browser-list-tabs.`,
        }
      }
      rt.current = tab
      return { ok: true, ...describe(tab, rt.current), ...tab.fence.status() }
    },
  })

  server.tool("browser-control", {
    annotations: { readOnlyHint: true },
    description:
      "Who controls the current visible tab: status, or take/release advisory agent priority. The person at the tab always wins; consent is the user's toggle.",
    parameters: {
      type: "object",
      properties: { verb: { type: "string", enum: ["status", "take", "release"] } },
    },
    handler: async (args: { verb?: string }) => {
      const rt = getRt()
      const tab = rt?.current
      if (!tab || tab.closed)
        return {
          ok: false,
          code: "browser_not_open",
          message: "No visible tab selected — browser-use-tab first.",
        }
      if (args.verb === "take") tab.fence.agentPriority = true
      if (args.verb === "release") tab.fence.agentPriority = false
      tab.setState({})
      return { ok: true, tabId: tab.id, ...tab.fence.status() }
    },
  })

  // ── browser-suggest: the address bar's rows (DBAB-REQ-13) ──
  server.tool("browser-suggest", {
    annotations: { readOnlyHint: true },
    description:
      "Address-bar suggestions for the Browser window: the user's visit history here + search completions. Used by the Teros UI.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    handler: async (args: { query: string }, ctx: ToolContext) => {
      const rt = getRt()
      if (!rt) return { query: String(args.query ?? ""), history: [], completions: [] }
      return rt.suggest.suggest(ctx.execution.userId, String(args.query ?? "").slice(0, 500))
    },
  })
}
