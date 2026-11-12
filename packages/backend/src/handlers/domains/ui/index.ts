/**
 * UI domain — live mirror of the user's desktop + window commands
 * (spec 20261022_ui-state-mca.md, REQ-2/3/4 backend side).
 *
 * Actions:
 *   ui.report     → Frontend session stores its live UiStateReport (per device)
 *                   in the UiStateManager and broadcasts `ui_state_changed`
 *                   on `ui:{workspaceId}`. The reporting session is auto-
 *                   subscribed to the user's command topics.
 *   ui.get-state  → `{ devices: UiDeviceState[] }` — every connected device of
 *                   the caller's user in the workspace, semantically enriched
 *                   at read time (chat → agentName/channelTitle, terminal →
 *                   session titles/kind, board → projectName).
 *   ui.command    → Drive the frontend: broadcast commands (open/close/update
 *                   window props → all devices) and frontend actions (focus,
 *                   set-active-desktop → the active device). Delivered as
 *                   `ui_command` events; returns { delivered, target }.
 *   ui.subscribe  → Subscribe the session to the user's command topic
 *                   (ui_cmds:{userId}:{workspaceId}) before the first report.
 *   ui.unsubscribe → Drop that subscription.
 *
 * Authz (terminal-domain precedent, decision D6): the screen can show
 * sensitive content, so reading it (ui.get-state) AND commanding it
 * (ui.command) require workspace WRITE access — a read-role member gets an
 * error, never partial data (FORBIDDEN_WORKSPACE_ROLE), and unknown
 * workspaces fail closed. ui.report only needs membership: it is the user's
 * own frontend session describing its own screen, and it is rejected outright
 * when it arrives through the MCA bridge (admin_request resolves the app
 * owner's userId — a bridge report would poison the owner's mirror).
 *
 * Delivery: PubSubService topics. Broadcast → `ui_cmds:{userId}:{workspaceId}`
 * (every reporting session is auto-subscribed on report; ui.subscribe covers
 * sessions that have not reported yet). Device-scoped → the per-device topic
 * `ui_cmds:{userId}:{workspaceId}:{deviceId}`, subscribed only by the sessions
 * that reported that deviceId — so a targeted command reaches exactly that
 * device's clients. `delivered` counts the topic's open sessions.
 *
 * Rate limits (NFR-3, tunable via deps): 20 commands/min and 5 opens/min per
 * agent app (bridge appId; plain sessions are keyed by sessionId). Excess
 * returns UI_RATE_LIMITED with a retry hint — never silence.
 */

import { randomUUID } from "crypto"
import type { Db } from "mongodb"
import type {
  UiBrowserCommandOutcome,
  UiCommand,
  UiCommandKind,
  UiCommandResultPayload,
  UiDeviceState,
  UiEnrichedWindow,
  UiPane,
  UiStateReport,
  UiTarget,
  UiWindow,
  UiWindowEnrichment,
  WsHandlerContext,
} from "@teros/shared"
import {
  isRequestResponseCommand,
  UI_BROWSER_COMMAND_TIMEOUT_MS,
  UI_COMMAND_DEFAULT_TARGET,
  UI_MAX_COMMAND_RESULT_BYTES,
  UI_MAX_PENDING_BROWSER_COMMANDS,
  UI_MAX_WINDOWS,
} from "@teros/shared"
import { canAccessWorkspace, canWriteWorkspace } from "../../../auth/workspace-access"
import { COLLECTIONS, collection } from "../../../db"
import type { UiDeviceEntry } from "../../../services/ui-state-manager"
import { UiStateManager } from "../../../services/ui-state-manager"
import type { PubSubService } from "../../../services/pubsub-service"
import type { WsRouter } from "../../../ws-framework/WsRouter"
import { HandlerError } from "../../../ws-framework/WsRouter"

// ── Tunables ─────────────────────────────────────────────────────────────────

/** NFR-3: an agent app is limited to this many commands per minute. */
const DEFAULT_COMMANDS_PER_MINUTE = 20
/** …and this many open-window commands per minute. */
const DEFAULT_OPENS_PER_MINUTE = 5
const RATE_WINDOW_MS = 60_000

const MAX_ID_LEN = 200
const MAX_TYPE_LEN = 64
const MAX_PROPS_KEYS = 64

const COMMAND_KINDS: readonly UiCommandKind[] = [
  "open-window",
  "close-window",
  "update-window-props",
  "focus-window",
  "set-active-desktop",
  "create-desktop",
  "remove-desktop",
  "set-navbar-collapsed",
  "set-theme",
  // Browser commands (F3) — request-response, single-device, single-session.
  "browser.open-url",
  "browser.get-state",
  "browser.click",
  "browser.type",
  "browser.screenshot",
  "browser.control",
  // DBAC-REQ-12 — scroll and key press.
  "browser.scroll",
  "browser.press-key",
]

/** The browser command kinds (validation + dispatch helpers). */
const BROWSER_COMMAND_KINDS: readonly UiCommandKind[] = [
  "browser.open-url",
  "browser.get-state",
  "browser.click",
  "browser.type",
  "browser.screenshot",
  "browser.control",
  "browser.scroll",
  "browser.press-key",
]

/** Valid browser.scroll directions (DBAC-REQ-9). */
const BROWSER_SCROLL_DIRECTIONS: readonly string[] = ["up", "down", "left", "right"]
/** Valid browser.press-key modifiers (DBAC-REQ-8). */
const BROWSER_KEY_MODIFIERS: readonly string[] = ["Alt", "Control", "Meta", "Shift"]

/** Valid browser.control verbs. */
const BROWSER_CONTROL_VERBS: readonly string[] = ["take", "release", "status"]

/** Valid observe modes for browser.click / browser.type. */
const BROWSER_OBSERVE_MODES: readonly string[] = ["snapshot", "summary", "none"]

/** Valid pane sides for open-window (UiPane in shared ui-state.ts). */
const COMMAND_PANES: readonly string[] = ["left", "right", "top", "bottom"]
/** Valid themes for set-theme. */
const COMMAND_THEMES: readonly string[] = ["dark", "light"]

// ── Topics ───────────────────────────────────────────────────────────────────

/** Broadcast commands + every reporting session of the user in the workspace. */
export function uiCommandsTopic(userId: string, workspaceId: string): string {
  return `ui_cmds:${userId}:${workspaceId}`
}

/** Device-scoped commands — subscribed only by that device's reporting sessions. */
export function uiDeviceTopic(userId: string, workspaceId: string, deviceId: string): string {
  return `ui_cmds:${userId}:${workspaceId}:${deviceId}`
}

/** ui_state_changed events (future watchers, REQ-2). */
export function uiStateTopic(workspaceId: string): string {
  return `ui:${workspaceId}`
}

/** Structural slice of PtyManager the enricher needs (fakes in tests). */
export interface UiPtyLike {
  describe(terminalId: string): { title?: string; kind?: string } | null
}


export interface UiDomainDeps {
  db: Db
  /** Null when pubsub is not wired: the mirror still works, delivery degrades to delivered: 0. */
  pubSubService?: PubSubService | null
  /** Default: a fresh manager. Production passes the handler-owned instance. */
  uiStateManager?: UiStateManager
  /** Terminal-session enrichment (PtyManager.describe). Absent in tests. */
  ptyManager?: UiPtyLike | null
  /** NFR-3 tunables. */
  rateLimits?: { commandsPerMinute?: number; opensPerMinute?: number }
  /** F3: browser command answer timeout (default UI_BROWSER_COMMAND_TIMEOUT_MS). */
  browserCommandTimeoutMs?: number
  /** Injectable for tests. */
  newCommandId?: () => string
  now?: () => number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The call came through the MCA bridge (admin_request: synthetic `mca:` session
 * whose userId is the workspace owner; domain_request: ctx.actor set).
 */
function isBridgeCall(ctx: WsHandlerContext): boolean {
  return ctx.actor !== undefined || ctx.sessionId.startsWith("mca:")
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** A non-empty string within `max`, or null. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return null
  return v
}

/** Workspace of the call: explicit param, else the bridge actor's workspace. */
function workspaceIdOf(data: { workspaceId?: unknown }, ctx: WsHandlerContext): string {
  const explicit = typeof data.workspaceId === "string" ? data.workspaceId : ""
  if (explicit) return explicit
  if (ctx.actor?.workspaceId) return ctx.actor.workspaceId
  throw new HandlerError("MISSING_WORKSPACE_ID", "workspaceId is required")
}

/** Read+command gate: workspace WRITE access, fail-closed on unknown workspace. */
async function assertWriteAccess(db: Db, ctx: WsHandlerContext, workspaceId: string): Promise<void> {
  if (!(await canWriteWorkspace(db, ctx.userId, workspaceId))) {
    throw new HandlerError(
      "FORBIDDEN_WORKSPACE_ROLE",
      "Write access to the workspace is required",
    )
  }
}

// ── Read-time semantic enrichment (REQ-3) ────────────────────────────────────

/** Small TTL cache for name lookups — enrichment must not become an N+1. */
const ENRICH_CACHE_TTL_MS = 30_000
const ENRICH_CACHE_MAX = 512

/**
 * Resolves window props into human-readable names at read time (never at
 * report time): chat → agentName + channelTitle; board → projectName;
 * terminal → session titles/kind via PtyManager.describe (already in memory).
 * Batched with $in queries + a small TTL cache.
 */
class UiEnricher {
  private cache = new Map<string, { value: string | null; at: number }>()

  constructor(
    private db: Db,
    private pty: UiPtyLike | null,
    private now: () => number,
  ) {}

  private cached(kind: string, id: string): string | null | undefined {
    const hit = this.cache.get(`${kind}:${id}`)
    if (!hit) return undefined
    if (this.now() - hit.at >= ENRICH_CACHE_TTL_MS) {
      this.cache.delete(`${kind}:${id}`)
      return undefined
    }
    return hit.value
  }

  private remember(kind: string, id: string, value: string | null): void {
    this.cache.set(`${kind}:${id}`, { value, at: this.now() })
    if (this.cache.size > ENRICH_CACHE_MAX) {
      // Map preserves insertion order — drop the oldest until back at the cap.
      let excess = this.cache.size - ENRICH_CACHE_MAX
      for (const key of this.cache.keys()) {
        if (excess-- <= 0) break
        this.cache.delete(key)
      }
    }
  }

  /** Batch-resolve `ids` through `query`, filling the cache; null = not found. */
  private async resolve(
    kind: string,
    ids: string[],
    query: (ids: string[]) => Promise<Map<string, string | null>>,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>()
    const missing: string[] = []
    for (const id of ids) {
      const hit = this.cached(kind, id)
      if (hit === undefined) missing.push(id)
      else out.set(id, hit)
    }
    if (missing.length > 0) {
      const found = await query(missing)
      for (const id of missing) {
        const value = found.get(id) ?? null
        out.set(id, value)
        this.remember(kind, id, value)
      }
    }
    return out
  }

  /** Enrich one device's windows. Unknown ids resolve to null and are omitted. */
  async enrich(windows: Record<string, UiWindow>): Promise<Record<string, UiEnrichedWindow>> {
    const channelIds = new Set<string>()
    const agentIds = new Set<string>()
    const projectIds = new Set<string>()
    for (const w of Object.values(windows)) {
      if (w.type === "chat") {
        const channelId = str(w.props.channelId, MAX_ID_LEN)
        if (channelId) channelIds.add(channelId)
        const agentId = str(w.props.agentId, MAX_ID_LEN)
        if (agentId) agentIds.add(agentId)
      } else if (w.type === "board") {
        const projectId = str(w.props.projectId, MAX_ID_LEN)
        if (projectId) projectIds.add(projectId)
      }
    }

    const [channels, agents, projects] = await Promise.all([
      this.resolve("channel", [...channelIds], async (ids) => {
        const docs = await collection<{ channelId: string; metadata?: { name?: string } }>(
          this.db,
          COLLECTIONS.channels,
        )
          .find({ channelId: { $in: ids } })
          .project({ channelId: 1, "metadata.name": 1 })
          .toArray()
        return new Map(docs.map((d) => [d.channelId, d.metadata?.name ?? null]))
      }),
      this.resolve("agent", [...agentIds], async (ids) => {
        const docs = await collection<{ agentId: string; name?: string }>(
          this.db,
          COLLECTIONS.agents,
        )
          .find({ agentId: { $in: ids } })
          .project({ agentId: 1, name: 1 })
          .toArray()
        return new Map(docs.map((d) => [d.agentId, d.name ?? null]))
      }),
      this.resolve("project", [...projectIds], async (ids) => {
        const docs = await collection<{ projectId: string; name?: string }>(
          this.db,
          COLLECTIONS.projects,
        )
          .find({ projectId: { $in: ids } })
          .project({ projectId: 1, name: 1 })
          .toArray()
        return new Map(docs.map((d) => [d.projectId, d.name ?? null]))
      }),
    ])

    const out: Record<string, UiEnrichedWindow> = {}
    for (const [windowId, w] of Object.entries(windows)) {
      if (w.type === "chat") {
        const enrichment: UiWindowEnrichment = {}
        const agentId = str(w.props.agentId, MAX_ID_LEN)
        const channelId = str(w.props.channelId, MAX_ID_LEN)
        if (agentId) {
          const agentName = agents.get(agentId)
          if (agentName) enrichment.agentName = agentName
        }
        if (channelId) {
          const channelTitle = channels.get(channelId)
          if (channelTitle) enrichment.channelTitle = channelTitle
        }
        out[windowId] = Object.keys(enrichment).length > 0 ? { ...w, enrichment } : { ...w }
      } else if (w.type === "board") {
        const projectId = str(w.props.projectId, MAX_ID_LEN)
        const projectName = projectId ? (projects.get(projectId) ?? null) : null
        out[windowId] = projectName
          ? { ...w, enrichment: { projectName } }
          : { ...w }
      } else if (w.type === "terminal") {
        out[windowId] = { ...w, enrichment: { sessions: this.terminalSessions(w) } }
      } else {
        out[windowId] = { ...w }
      }
    }
    return out
  }

  /** Terminal window props { tabs[] } → live session titles/kind (PtyManager). */
  private terminalSessions(w: UiWindow): { terminalId: string; title: string; kind: string }[] {
    if (!this.pty || !Array.isArray(w.props.tabs)) return []
    const sessions: { terminalId: string; title: string; kind: string }[] = []
    for (const tab of w.props.tabs.slice(0, UI_MAX_WINDOWS)) {
      const terminalId = str(tab, MAX_ID_LEN)
      if (!terminalId) continue
      const described = this.pty.describe(terminalId)
      sessions.push({
        terminalId,
        title: described?.title || terminalId,
        kind: described?.kind || "",
      })
    }
    return sessions
  }
}

// ── Rate limiter (NFR-3) ─────────────────────────────────────────────────────

/** Sliding-window limiter — check() before record(); both prune expired hits. */
class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private windowMs: number,
    private now: () => number,
  ) {}

  private prune(key: string, now: number): void {
    const list = this.hits.get(key)
    if (!list) return
    const cutoff = now - this.windowMs
    let i = 0
    while (i < list.length && list[i] <= cutoff) i++
    if (i > 0) list.splice(0, i)
    if (list.length === 0) this.hits.delete(key)
  }

  check(key: string, limit: number): { allowed: boolean; retryAfterMs: number } {
    const now = this.now()
    this.prune(key, now)
    const list = this.hits.get(key) ?? []
    if (list.length < limit) return { allowed: true, retryAfterMs: 0 }
    return { allowed: false, retryAfterMs: Math.max(1, list[0] + this.windowMs - now) }
  }

  record(key: string): void {
    const now = this.now()
    this.prune(key, now)
    const list = this.hits.get(key)
    if (list) list.push(now)
    else this.hits.set(key, [now])
  }
}

// ── Pending browser commands (F3 request-response) ──────────────────────────

/**
 * One in-flight request-response command: the promise the agent-facing call
 * awaits, plus the bookkeeping to route the client's reply back to it.
 *
 * Delivery model: a browser command goes to ONE session of the target device
 * (the tab lives in one Electron main process — fanning out to every session
 * of the device would double-click). The reply comes back on that same
 * session via `ui.command-result`, keyed by correlationId.
 */
interface PendingBrowserCommand {
  correlationId: string
  command: UiCommandKind
  userId: string
  workspaceId: string
  /** The deviceId the command was delivered to. */
  deviceId: string
  /** The single session the command was sent to. */
  sessionId: string
  createdAt: number
  resolve: (outcome: UiBrowserCommandOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Bounded registry of in-flight browser commands. Answers are matched by
 * correlationId; entries time out (UI_COMMAND_TIMEOUT) so an agent tool call
 * can never hang. A late answer for an expired/unknown id is dropped (the
 * agent already got a timeout — delivering a stale tree afterwards would
 * confuse the conversation).
 */
class BrowserCommandRegistry {
  private pending = new Map<string, PendingBrowserCommand>()

  constructor(
    private timeoutMs: number,
    private now: () => number,
  ) {}

  get size(): number {
    return this.pending.size
  }

  /** Register an in-flight command; returns false at the cap (caller errors). */
  add(entry: Omit<PendingBrowserCommand, "timer">): boolean {
    if (this.pending.size >= UI_MAX_PENDING_BROWSER_COMMANDS) return false
    const timer = setTimeout(() => {
      const hit = this.pending.get(entry.correlationId)
      if (!hit) return
      this.pending.delete(entry.correlationId)
      hit.resolve({
        command: entry.command,
        delivered: true,
        answered: false,
        ok: false,
        code: "UI_COMMAND_TIMEOUT",
        message: `The desktop did not answer ${entry.command} within ${this.timeoutMs / 1000}s — it may be busy, suspended, or an older build without browser support.`,
      })
    }, this.timeoutMs)
    this.pending.set(entry.correlationId, { ...entry, timer })
    return true
  }

  /**
   * Resolve a pending command with the client's answer. Returns the resolved
   * outcome, or null when the correlationId is unknown (late answer after
   * timeout, duplicate reply, or a reply from a different session than the
   * one the command was delivered to — the reply must come from the executor).
   */
  answer(
    correlationId: string,
    sessionId: string,
    payload: { ok: boolean; result?: Record<string, unknown>; code?: string; message?: string },
  ): UiBrowserCommandOutcome | null {
    const hit = this.pending.get(correlationId)
    if (!hit) return null
    if (hit.sessionId !== sessionId) return null
    clearTimeout(hit.timer)
    this.pending.delete(correlationId)
    const outcome: UiBrowserCommandOutcome = {
      command: hit.command,
      delivered: true,
      answered: true,
      ok: payload.ok,
      ...(payload.result !== undefined ? { result: payload.result } : {}),
      ...(payload.code !== undefined ? { code: payload.code } : {}),
      ...(payload.message !== undefined ? { message: payload.message } : {}),
    }
    hit.resolve(outcome)
    return outcome
  }

  /** Drop every pending entry (backend shutdown / tests). */
  clear(): void {
    for (const hit of this.pending.values()) clearTimeout(hit.timer)
    this.pending.clear()
  }
}

// ── Domain ───────────────────────────────────────────────────────────────────

export function register(router: WsRouter, deps: UiDomainDeps): void {
  const { db } = deps
  const pubSubService = deps.pubSubService ?? null
  const now = deps.now ?? (() => Date.now())
  const manager =
    deps.uiStateManager ?? new UiStateManager({ now, sweepIntervalMs: 30_000 })
  const enricher = new UiEnricher(db, deps.ptyManager ?? null, now)
  const commandsPerMinute = deps.rateLimits?.commandsPerMinute ?? DEFAULT_COMMANDS_PER_MINUTE
  const opensPerMinute = deps.rateLimits?.opensPerMinute ?? DEFAULT_OPENS_PER_MINUTE
  const limiter = new RateLimiter(RATE_WINDOW_MS, now)
  const newCommandId = deps.newCommandId ?? (() => randomUUID())
  const browserCommands = new BrowserCommandRegistry(
    deps.browserCommandTimeoutMs ?? UI_BROWSER_COMMAND_TIMEOUT_MS,
    now,
  )

  /** Send `event` on `topic`; returns how many open sessions received it. */
  function deliver(topic: string, event: Record<string, unknown>): number {
    if (!pubSubService) return 0
    let delivered = 0
    for (const session of pubSubService.getTopicSessions(topic)) {
      if (session.ws.readyState === 1) delivered++
    }
    pubSubService.broadcastToTopic(topic, event)
    return delivered
  }

  function broadcastStateChange(report: UiStateReport, entry: UiDeviceEntry): void {
    pubSubService?.broadcastToTopic(uiStateTopic(report.workspaceId), {
      type: "ui_state_changed",
      workspaceId: report.workspaceId,
      userId: entry.userId,
      deviceId: entry.deviceId,
      ...(entry.deviceLabel !== undefined ? { deviceLabel: entry.deviceLabel } : {}),
      ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent } : {}),
      lastSeen: new Date(entry.lastSeen).toISOString(),
      online: true,
    })
  }

  /**
   * ui.report
   * The frontend session's own live snapshot (REQ-1/2). Malformed or oversized
   * reports are rejected with UI_BAD_REPORT and the previous state is kept.
   * The reporting session is auto-subscribed to the user-wide and per-device
   * command topics, so broadcast and targeted delivery both work from the
   * first report on.
   */
  router.register("ui.report", async (ctx: WsHandlerContext, rawData: unknown) => {
    if (isBridgeCall(ctx)) {
      throw new HandlerError("FORBIDDEN", "ui.report is for the user's own frontend session")
    }
    const validation = manager.validateReport(rawData)
    if (!validation.ok) {
      throw new HandlerError("UI_BAD_REPORT", `Invalid UI state report: ${validation.reason}`)
    }
    const report = validation.report
    if (!(await canAccessWorkspace(db, ctx.userId, report.workspaceId))) {
      throw new HandlerError("FORBIDDEN_WORKSPACE", `No access to workspace ${report.workspaceId}`)
    }

    const entry = manager.report(ctx.userId, ctx.sessionId, report)
    pubSubService?.subscribeSession(ctx.sessionId, uiCommandsTopic(ctx.userId, report.workspaceId))
    pubSubService?.subscribeSession(
      ctx.sessionId,
      uiDeviceTopic(ctx.userId, report.workspaceId, report.deviceId),
    )
    broadcastStateChange(report, entry)

    console.log(
      `✅ [ui.report] user=${ctx.userId} workspace=${report.workspaceId} device=${report.deviceId} windows=${Object.keys(report.windows).length}`,
    )
    return { ok: true }
  })

  /** One device entry → UiDeviceState (enrichment resolved at read time). */
  async function toDeviceState(
    entry: UiDeviceEntry & { online: boolean },
  ): Promise<UiDeviceState> {
    return {
      workspaceId: entry.report.workspaceId,
      deviceId: entry.deviceId,
      ...(entry.deviceLabel !== undefined ? { deviceLabel: entry.deviceLabel } : {}),
      ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent } : {}),
      desktops: entry.report.desktops,
      activeDesktopId: entry.report.activeDesktopId,
      windows: await enricher.enrich(entry.report.windows),
      focusedWindowId: entry.report.focusedWindowId,
      windowTypes: entry.report.windowTypes,
      lastSeen: new Date(entry.lastSeen).toISOString(),
      online: entry.online,
    }
  }

  /**
   * ui.get-state
   * Every connected device of the caller's user in the workspace, enriched
   * (REQ-3). Workspace write access — the screen can show sensitive content
   * (terminal-domain precedent D6); read-role callers get an error, never
   * partial data. Through the MCA bridge the caller is the app owner's user.
   */
  router.register("ui.get-state", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { workspaceId?: string }
    const workspaceId = workspaceIdOf(data, ctx)
    await assertWriteAccess(db, ctx, workspaceId)

    const entries = manager.devices(ctx.userId, workspaceId)
    const devices = await Promise.all(entries.map(toDeviceState))
    return { devices }
  })

  /**
   * ui.command
   * Drive the frontend (REQ-4). Broadcast commands (open/close/update-window-
   * props, default target 'all') reach every device; frontend actions
   * (focus-window, set-active-desktop, default 'active') reach only the
   * targeted device. Unknown/offline deviceId → UI_UNKNOWN_DEVICE listing
   * online devices; 'active' with nothing online → delivered: 0 (explicit
   * offline outcome, not an error). Rate-limited per agent app (NFR-3).
   */
  router.register("ui.command", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as {
      workspaceId?: string
      command?: unknown
      target?: unknown
      windowType?: unknown
      props?: unknown
      focus?: unknown
      windowId?: unknown
      desktopId?: unknown
      name?: unknown
      pane?: unknown
      theme?: unknown
      collapsed?: unknown
      // Browser commands (F3)
      tabId?: unknown
      url?: unknown
      screenshot?: unknown
      maxChars?: unknown
      ref?: unknown
      x?: unknown
      y?: unknown
      observe?: unknown
      text?: unknown
      clear?: unknown
      submit?: unknown
      width?: unknown
      quality?: unknown
      verb?: unknown
      // DBAC-REQ-12
      direction?: unknown
      amount?: unknown
      key?: unknown
      modifiers?: unknown
    }
    const workspaceId = workspaceIdOf(data, ctx)
    await assertWriteAccess(db, ctx, workspaceId)

    const kind = data.command
    if (typeof kind !== "string" || !COMMAND_KINDS.includes(kind as UiCommandKind)) {
      throw new HandlerError(
        "UI_BAD_COMMAND",
        `command must be one of: ${COMMAND_KINDS.join(", ")}`,
      )
    }
    const command = kind as UiCommandKind

    let target: UiTarget
    if (data.target === undefined || data.target === null) {
      target = UI_COMMAND_DEFAULT_TARGET[command]
    } else {
      const explicit = str(data.target, MAX_ID_LEN)
      if (!explicit) {
        throw new HandlerError(
          "UI_BAD_COMMAND",
          `target must be 'all', 'active' or a deviceId (1..${MAX_ID_LEN} chars)`,
        )
      }
      target = explicit
    }

    const props =
      data.props === undefined || data.props === null
        ? {}
        : isPlainObject(data.props)
          ? data.props
          : null
    if (data.props !== undefined && data.props !== null && !props) {
      throw new HandlerError("UI_BAD_COMMAND", "props must be an object")
    }
    if (props && Object.keys(props).length > MAX_PROPS_KEYS) {
      throw new HandlerError(
        "UI_BAD_COMMAND",
        `props has too many keys (max ${MAX_PROPS_KEYS})`,
      )
    }

    const windowType =
      data.windowType === undefined ? undefined : (str(data.windowType, MAX_TYPE_LEN) ?? undefined)
    const windowId =
      data.windowId === undefined ? undefined : (str(data.windowId, MAX_ID_LEN) ?? undefined)
    const desktopId =
      data.desktopId === undefined ? undefined : (str(data.desktopId, MAX_ID_LEN) ?? undefined)
    const name =
      data.name === undefined ? undefined : (str(data.name, MAX_ID_LEN) ?? undefined)
    const pane =
      data.pane === undefined
        ? undefined
        : COMMAND_PANES.includes(String(data.pane))
          ? (String(data.pane) as UiPane)
          : undefined
    const theme =
      data.theme === undefined
        ? undefined
        : str(data.theme, 16) === "dark" || str(data.theme, 16) === "light"
          ? (str(data.theme, 16) as "dark" | "light")
          : undefined

    if (command === "open-window") {
      if (!windowType) {
        throw new HandlerError("UI_BAD_COMMAND", "open-window requires windowType")
      }
      if (data.focus !== undefined && typeof data.focus !== "boolean") {
        throw new HandlerError("UI_BAD_COMMAND", "focus must be a boolean")
      }
      if (pane !== undefined && !COMMAND_PANES.includes(pane)) {
        throw new HandlerError(
          "UI_BAD_COMMAND",
          `pane must be one of: ${COMMAND_PANES.join(", ")}`,
        )
      }
    } else if (command === "update-window-props") {
      if (!windowId) throw new HandlerError("UI_BAD_COMMAND", "update-window-props requires windowId")
      if (data.props === undefined || data.props === null || !props || Object.keys(props).length === 0) {
        throw new HandlerError("UI_BAD_COMMAND", "update-window-props requires props")
      }
    } else if (command === "close-window" || command === "focus-window") {
      if (!windowId) throw new HandlerError("UI_BAD_COMMAND", `${command} requires windowId`)
    } else if (command === "remove-desktop") {
      if (!desktopId) throw new HandlerError("UI_BAD_COMMAND", "remove-desktop requires desktopId")
    } else if (command === "set-theme") {
      if (theme !== undefined && !COMMAND_THEMES.includes(theme)) {
        throw new HandlerError("UI_BAD_COMMAND", `theme must be one of: ${COMMAND_THEMES.join(", ")}`)
      }
    } else if (command === "set-navbar-collapsed") {
      if (data.collapsed !== undefined && typeof data.collapsed !== "boolean") {
        throw new HandlerError("UI_BAD_COMMAND", "collapsed must be a boolean")
      }
    } else {
      // set-active-desktop / create-desktop
      if (command === "set-active-desktop" && !desktopId) {
        throw new HandlerError("UI_BAD_COMMAND", "set-active-desktop requires desktopId")
      }
      // create-desktop: name is optional (defaults client-side)
    }

    // Rate limit per agent app (NFR-3): bridge appId, else the session itself.
    const rateKey =
      ctx.actor?.appId ??
      (ctx.sessionId.startsWith("mca:") ? ctx.sessionId.slice(4) : `session:${ctx.sessionId}`)
    const commandsCheck = limiter.check(rateKey, commandsPerMinute)
    if (!commandsCheck.allowed) {
      throw new HandlerError(
        "UI_RATE_LIMITED",
        `Too many UI commands (max ${commandsPerMinute}/min). Retry in ${Math.ceil(commandsCheck.retryAfterMs / 1000)}s`,
      )
    }
    if (command === "open-window") {
      const opensCheck = limiter.check(`open:${rateKey}`, opensPerMinute)
      if (!opensCheck.allowed) {
        throw new HandlerError(
          "UI_RATE_LIMITED",
          `Too many open-window commands (max ${opensPerMinute}/min). Retry in ${Math.ceil(opensCheck.retryAfterMs / 1000)}s`,
        )
      }
    }
    limiter.record(rateKey)
    if (command === "open-window") limiter.record(`open:${rateKey}`)

    // Resolve the target (REQ-4 defaults applied above).
    let resolved: { broadcast: true } | { broadcast: false; deviceId: string }
    if (target === "all") {
      resolved = { broadcast: true }
    } else if (target === "active") {
      const active = manager.activeDevice(ctx.userId, workspaceId)
      if (!active) {
        // Explicit offline outcome — the user has no connected client.
        console.log(`[ui.command] ${command} target=active delivered=0 (no online device)`)
        return { delivered: 0, target }
      }
      resolved = { broadcast: false, deviceId: active.deviceId }
    } else {
      const device = manager
        .devices(ctx.userId, workspaceId)
        .find((d) => d.deviceId === target)
      if (!device || !device.online) {
        const online = manager
          .onlineDevices(ctx.userId, workspaceId)
          .map((d) => (d.deviceLabel ? `${d.deviceId} (${d.deviceLabel})` : d.deviceId))
        throw new HandlerError(
          "UI_UNKNOWN_DEVICE",
          `Device "${target}" is not online. Online devices: ${online.length > 0 ? online.join(", ") : "none"}`,
        )
      }
      resolved = { broadcast: false, deviceId: target }
    }

    // Desktop existence check (clear error, never a silent no-op): commands
    // that reference a desktopId on a SINGLE target device must find it in
    // that device's reported desktops. Broadcast open-window needs it on at
    // least one online device (the rest apply-if-exists, delivery ≠
    // application); broadcast set-active-desktop / remove-desktop keep the
    // per-device apply-if-exists semantics.
    if (desktopId !== undefined && !resolved.broadcast) {
      const device = manager
        .devices(ctx.userId, workspaceId)
        .find((d) => d.deviceId === resolved.deviceId)
      const desktops = device?.report.desktops ?? []
      if (!desktops.some((x) => x.desktopId === desktopId)) {
        const list = desktops.map((x) => (x.name ? `${x.desktopId} (${x.name})` : x.desktopId))
        throw new HandlerError(
          "UI_UNKNOWN_DESKTOP",
          `Device "${resolved.deviceId}" has no desktop "${desktopId}". Its desktops: ${
            list.length > 0 ? list.join(", ") : "none"
          }`,
        )
      }
    }
    if (command === "open-window" && desktopId !== undefined && resolved.broadcast) {
      const online = manager.onlineDevices(ctx.userId, workspaceId)
      if (
        online.length > 0 &&
        !online.some((d) => d.report.desktops.some((x) => x.desktopId === desktopId))
      ) {
        throw new HandlerError(
          "UI_UNKNOWN_DESKTOP",
          `No online device has desktop "${desktopId}". Call ui-state first and use a desktopId from the target device's desktops list.`,
        )
      }
    }

    const commandId = newCommandId()

    // ── Browser commands (F3): request-response, ONE session, wait for reply ──
    if (BROWSER_COMMAND_KINDS.includes(command)) {
      // A browser tab lives in ONE device's Electron main process — 'all' would
      // be a double-click. The default target is 'active' (see
      // UI_COMMAND_DEFAULT_TARGET); an explicit deviceId is fine, 'all' is not.
      if (resolved.broadcast) {
        throw new HandlerError(
          "UI_BAD_COMMAND",
          `${command} must target one device ('active' or a deviceId) — a browser tab lives in a single device`,
        )
      }

      // The tab must exist on the target device (clear error, never a silent
      // no-op — same contract as UI_UNKNOWN_DESKTOP). tabId is the windowId of
      // the browser window in that device's ui-state report.
      const tabId = str(data.tabId, MAX_ID_LEN)
      if (!tabId) {
        throw new HandlerError("UI_BAD_COMMAND", `${command} requires tabId (a browser window's windowId from ui-state)`)
      }
      const device = manager.devices(ctx.userId, workspaceId).find((d) => d.deviceId === resolved.deviceId)
      const windows = device?.report.windows ?? {}
      const tab = windows[tabId]
      if (!tab) {
        const browserTabs = Object.values(windows)
          .filter((w) => w.type === "browser")
          .map((w) => `${w.windowId}${w.title ? ` (${w.title})` : ""}`)
        throw new HandlerError(
          "UI_UNKNOWN_TAB",
          `Device "${resolved.deviceId}" has no browser tab "${tabId}". Its browser tabs: ${
            browserTabs.length > 0 ? browserTabs.join(", ") : "none"
          }`,
        )
      }
      if (tab.type !== "browser") {
        throw new HandlerError(
          "UI_BAD_COMMAND",
          `Window "${tabId}" on device "${resolved.deviceId}" is a "${tab.type}", not a browser tab — browser commands only apply to browser windows`,
        )
      }

      // Per-kind payload validation (fields beyond the shared envelope).
      const envelopeBrowser: Record<string, unknown> = { tabId }
      if (command === "browser.open-url") {
        const url = str(data.url, 2048)
        if (!url) throw new HandlerError("UI_BAD_COMMAND", "browser.open-url requires url")
        envelopeBrowser.url = url
      } else if (command === "browser.get-state") {
        if (data.screenshot !== undefined && typeof data.screenshot !== "boolean") {
          throw new HandlerError("UI_BAD_COMMAND", "screenshot must be a boolean")
        }
        if (data.screenshot === true) envelopeBrowser.screenshot = true
        if (data.maxChars !== undefined) {
          if (typeof data.maxChars !== "number" || !Number.isInteger(data.maxChars) || data.maxChars < 500 || data.maxChars > 100_000) {
            throw new HandlerError("UI_BAD_COMMAND", "maxChars must be an integer between 500 and 100000")
          }
          envelopeBrowser.maxChars = data.maxChars
        }
      } else if (command === "browser.click") {
        const ref = str(data.ref, 64)
        const hasCoords = typeof data.x === "number" && typeof data.y === "number"
        if (!ref && !hasCoords) {
          throw new HandlerError("UI_BAD_COMMAND", "browser.click needs ref (from get-state) or x,y coordinates")
        }
        if (ref) envelopeBrowser.ref = ref
        if (hasCoords) {
          envelopeBrowser.x = data.x
          envelopeBrowser.y = data.y
        }
        if (data.observe !== undefined && !BROWSER_OBSERVE_MODES.includes(String(data.observe))) {
          throw new HandlerError("UI_BAD_COMMAND", `observe must be one of: ${BROWSER_OBSERVE_MODES.join(", ")}`)
        }
        if (data.observe !== undefined) envelopeBrowser.observe = data.observe
      } else if (command === "browser.type") {
        if (typeof data.text !== "string" || data.text.length === 0) {
          throw new HandlerError("UI_BAD_COMMAND", "browser.type requires text")
        }
        if (data.text.length > 5000) {
          throw new HandlerError("UI_BAD_COMMAND", "text is too long (max 5000 chars per call)")
        }
        envelopeBrowser.text = data.text
        const ref = str(data.ref, 64)
        if (ref) envelopeBrowser.ref = ref
        if (data.clear === false) envelopeBrowser.clear = false
        if (data.submit === true) envelopeBrowser.submit = true
        if (data.observe !== undefined) {
          if (!BROWSER_OBSERVE_MODES.includes(String(data.observe))) {
            throw new HandlerError("UI_BAD_COMMAND", `observe must be one of: ${BROWSER_OBSERVE_MODES.join(", ")}`)
          }
          envelopeBrowser.observe = data.observe
        }
      } else if (command === "browser.screenshot") {
        if (data.width !== undefined) {
          if (typeof data.width !== "number" || !Number.isInteger(data.width) || data.width < 320 || data.width > 2560) {
            throw new HandlerError("UI_BAD_COMMAND", "width must be an integer between 320 and 2560")
          }
          envelopeBrowser.width = data.width
        }
        if (data.quality !== undefined) {
          if (typeof data.quality !== "number" || !Number.isInteger(data.quality) || data.quality < 10 || data.quality > 100) {
            throw new HandlerError("UI_BAD_COMMAND", "quality must be an integer between 10 and 100")
          }
          envelopeBrowser.quality = data.quality
        }
      } else if (command === "browser.control") {
        const verb = str(data.verb, 16)
        if (!verb || !BROWSER_CONTROL_VERBS.includes(verb)) {
          throw new HandlerError("UI_BAD_COMMAND", `browser.control requires verb: one of ${BROWSER_CONTROL_VERBS.join(", ")}`)
        }
        envelopeBrowser.verb = verb
      } else if (command === "browser.scroll") {
        // @spec DBAC-REQ-12
        const direction = str(data.direction, 8)
        if (!direction || !BROWSER_SCROLL_DIRECTIONS.includes(direction)) {
          throw new HandlerError("UI_BAD_COMMAND", `browser.scroll requires direction: one of ${BROWSER_SCROLL_DIRECTIONS.join(", ")}`)
        }
        envelopeBrowser.direction = direction
        if (data.amount !== undefined) {
          if (typeof data.amount !== "number" || !Number.isInteger(data.amount) || data.amount < 1 || data.amount > 10_000) {
            throw new HandlerError("UI_BAD_COMMAND", "amount must be an integer between 1 and 10000 (CSS pixels)")
          }
          envelopeBrowser.amount = data.amount
        }
        const ref = str(data.ref, 64)
        if (ref) envelopeBrowser.ref = ref
        if (data.observe !== undefined) {
          if (!BROWSER_OBSERVE_MODES.includes(String(data.observe))) {
            throw new HandlerError("UI_BAD_COMMAND", `observe must be one of: ${BROWSER_OBSERVE_MODES.join(", ")}`)
          }
          envelopeBrowser.observe = data.observe
        }
      } else if (command === "browser.press-key") {
        // @spec DBAC-REQ-12
        const key = str(data.key, 32)
        if (!key) throw new HandlerError("UI_BAD_COMMAND", "browser.press-key requires key (a named key such as Enter, Escape, Tab, ArrowDown, or one character)")
        envelopeBrowser.key = key
        if (data.modifiers !== undefined) {
          if (!Array.isArray(data.modifiers) || data.modifiers.length > 4 || data.modifiers.some((m) => !BROWSER_KEY_MODIFIERS.includes(String(m)))) {
            throw new HandlerError("UI_BAD_COMMAND", `modifiers must be an array of up to 4 of: ${BROWSER_KEY_MODIFIERS.join(", ")}`)
          }
          envelopeBrowser.modifiers = data.modifiers
        }
        const ref = str(data.ref, 64)
        if (ref) envelopeBrowser.ref = ref
        if (data.observe !== undefined) {
          if (!BROWSER_OBSERVE_MODES.includes(String(data.observe))) {
            throw new HandlerError("UI_BAD_COMMAND", `observe must be one of: ${BROWSER_OBSERVE_MODES.join(", ")}`)
          }
          envelopeBrowser.observe = data.observe
        }
      }

      // Single-session delivery: pick ONE session of the device (latest
      // reporter — the SPA's live session). Fanning out to every session of
      // the device would run the command twice (two windows, one executor
      // each, same tab id → double click).
      const sessions = manager.sessionsOfDevice(ctx.userId, workspaceId, resolved.deviceId)
      if (sessions.length === 0) {
        // The device went offline between resolution and delivery.
        console.log(`[ui.command] ${commandId} ${command} delivered=0 (device lost its sessions)`)
        return { delivered: 0, target: resolved.deviceId }
      }
      const sessionId = sessions[sessions.length - 1]
      const session = pubSubService?.getTopicSessions(uiDeviceTopic(ctx.userId, workspaceId, resolved.deviceId))
        .find((s) => s.sessionId === sessionId)
      if (!session || session.ws.readyState !== 1) {
        console.log(`[ui.command] ${commandId} ${command} delivered=0 (session not open)`)
        return { delivered: 0, target: resolved.deviceId }
      }

      const correlationId = newCommandId()
      const envelope: UiCommand = {
        commandId,
        command,
        target: resolved.deviceId,
        ...envelopeBrowser,
      }

      // Register the pending reply BEFORE sending (the client can answer
      // faster than the await below resumes — a same-tick reply must find
      // its entry, not a timeout).
      let busyResolve: ((busy: boolean) => void) | null = null
      const busyPromise = new Promise<boolean>((resolve) => {
        busyResolve = resolve
      })
      const outcomePromise = new Promise<UiBrowserCommandOutcome>((resolve) => {
        const registered = browserCommands.add({
          correlationId,
          command,
          userId: ctx.userId,
          workspaceId,
          deviceId: resolved.deviceId,
          sessionId,
          createdAt: now(),
          resolve,
        })
        if (!registered) {
          // Registry full: resolve BOTH promises — the caller returns the
          // UI_BUSY outcome without ever sending the command.
          resolve({
            command,
            delivered: false,
            answered: false,
            ok: false,
            code: "UI_BUSY",
            message: `Too many in-flight browser commands (${UI_MAX_PENDING_BROWSER_COMMANDS}) — retry shortly`,
          })
          busyResolve?.(true)
        } else {
          busyResolve?.(false)
        }
      })
      if (await busyPromise) {
        const outcome = await outcomePromise
        return { ...outcome, target: resolved.deviceId }
      }

      try {
        session.ws.send(
          JSON.stringify({
            type: "ui_command",
            workspaceId,
            userId: ctx.userId,
            target: resolved.deviceId,
            deviceId: resolved.deviceId,
            command: { ...envelope, correlationId },
          }),
        )
      } catch (err) {
        browserCommands.answer(correlationId, sessionId, {
          ok: false,
          code: "UI_DELIVERY_FAILED",
          message: `Failed to deliver ${command} to device ${resolved.deviceId}: ${err instanceof Error ? err.message : String(err)}`,
        })
        const outcome = await outcomePromise
        return { ...outcome, target: resolved.deviceId }
      }

      const outcome = await outcomePromise
      console.log(
        `✅ [ui.command] ${commandId} ${command} user=${ctx.userId} workspace=${workspaceId} target=${resolved.deviceId} answered=${outcome.answered} ok=${outcome.ok}`,
      )
      return { ...outcome, target: resolved.deviceId }
    }

    const envelope: UiCommand = {
      commandId,
      command,
      target: resolved.broadcast ? "all" : resolved.deviceId,
      ...(windowType !== undefined ? { windowType } : {}),
      ...(props && Object.keys(props).length > 0 ? { props } : {}),
      ...(command === "open-window" ? { focus: data.focus !== false } : {}),
      ...(windowId !== undefined ? { windowId } : {}),
      ...(desktopId !== undefined ? { desktopId } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(pane !== undefined ? { pane } : {}),
      ...(theme !== undefined ? { theme } : {}),
      ...(command === "set-navbar-collapsed" && typeof data.collapsed === "boolean"
        ? { collapsed: data.collapsed }
        : {}),
    }
    const topic = resolved.broadcast
      ? uiCommandsTopic(ctx.userId, workspaceId)
      : uiDeviceTopic(ctx.userId, workspaceId, resolved.deviceId)
    const delivered = deliver(topic, {
      type: "ui_command",
      workspaceId,
      userId: ctx.userId,
      target: envelope.target,
      ...(resolved.broadcast ? {} : { deviceId: resolved.deviceId }),
      command: envelope,
    })

    console.log(
      `✅ [ui.command] ${commandId} ${command} user=${ctx.userId} workspace=${workspaceId} target=${envelope.target} delivered=${delivered}`,
    )
    return { delivered, target: envelope.target }
  })

  /**
   * ui.command-result (F3)
   * The desktop client's answer to ONE correlated browser command. Must come
   * from the SAME session the command was delivered to (the executor's
   * session — a reply from any other session is dropped, including a second
   * window of the same device). Unknown correlationIds (late answers after
   * timeout, duplicates, other users' ids) are dropped silently-for-the-
   * caller ({ ok: true, matched: false }) — the agent already holds its
   * answer or timeout.
   *
   * Frontend sessions only: an MCA bridge call has no executor, so it is
   * rejected outright (a bridge reply could poison another app's pending).
   */
  router.register("ui.command-result", async (ctx: WsHandlerContext, rawData: unknown) => {
    if (isBridgeCall(ctx)) {
      throw new HandlerError("FORBIDDEN", "ui.command-result is for the user's own frontend session")
    }
    const data = (rawData ?? {}) as {
      workspaceId?: unknown
      correlationId?: unknown
      ok?: unknown
      result?: unknown
      code?: unknown
      message?: unknown
    }
    const workspaceId = workspaceIdOf(data, ctx)
    if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError("FORBIDDEN_WORKSPACE", `No access to workspace ${workspaceId}`)
    }

    const correlationId = str(data.correlationId, MAX_ID_LEN)
    if (!correlationId) throw new HandlerError("UI_BAD_RESULT", "correlationId is required")

    if (data.ok !== true && data.ok !== false) {
      throw new HandlerError("UI_BAD_RESULT", "ok must be a boolean")
    }

    let result: Record<string, unknown> | undefined
    if (data.result !== undefined && data.result !== null) {
      if (!isPlainObject(data.result)) {
        throw new HandlerError("UI_BAD_RESULT", "result must be an object")
      }
      const bytes = JSON.stringify(data.result).length
      if (bytes > UI_MAX_COMMAND_RESULT_BYTES) {
        throw new HandlerError(
          "UI_BAD_RESULT",
          `result is too large (${bytes} bytes, max ${UI_MAX_COMMAND_RESULT_BYTES}) — downscale the screenshot or truncate the snapshot`,
        )
      }
      result = data.result
    }

    const code = data.code === undefined ? undefined : str(data.code, 64) ?? undefined
    const message = data.message === undefined ? undefined : str(data.message, 2000) ?? undefined
    if (data.ok === false && !code) {
      throw new HandlerError("UI_BAD_RESULT", "ok:false requires a machine-readable code")
    }

    const outcome = browserCommands.answer(
      correlationId,
      ctx.sessionId,
      { ok: data.ok, ...(result !== undefined ? { result } : {}), ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) },
    )
    if (outcome) {
      console.log(
        `✅ [ui.command-result] ${correlationId} session=${ctx.sessionId} ok=${outcome.ok} code=${outcome.code ?? "-"}`,
      )
    } else {
      console.log(`[ui.command-result] ${correlationId} dropped (unknown/duplicate/wrong session)`)
    }
    return { ok: true, matched: outcome !== null }
  })

  /**
   * ui.subscribe
   * Subscribe the session to the user's command topic — used by a client whose
   * active workspace matches but that has not reported yet (broadcast commands
   * must reach it). Frontend sessions only: agents get their commands delivered
   * by tool responses, not by wake-ups (Q6).
   */
  router.register("ui.subscribe", async (ctx: WsHandlerContext, rawData: unknown) => {
    if (isBridgeCall(ctx)) {
      throw new HandlerError("FORBIDDEN", "ui.subscribe is for the user's own frontend session")
    }
    const data = (rawData ?? {}) as { workspaceId?: string }
    const workspaceId = workspaceIdOf(data, ctx)
    if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError("FORBIDDEN_WORKSPACE", `No access to workspace ${workspaceId}`)
    }
    const topic = uiCommandsTopic(ctx.userId, workspaceId)
    pubSubService?.subscribeSession(ctx.sessionId, topic)
    return { topic }
  })

  /** ui.unsubscribe — always allowed; it only removes the caller's own subscription. */
  router.register("ui.unsubscribe", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { workspaceId?: string }
    const workspaceId = workspaceIdOf(data, ctx)
    pubSubService?.unsubscribeSession(ctx.sessionId, uiCommandsTopic(ctx.userId, workspaceId))
    return { ok: true }
  })
}
