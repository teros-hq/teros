/**
 * Live terminal sessions of a workspace — one shared, ref-counted watch per
 * workspace (terminal.watch + `terminal_sessions` events), so the Terminal
 * windows and the attention watcher (toasts, badges) share one subscription.
 *
 * Also a tiny event bus: "show this session" requests (from a toast's Open
 * action) that an open Terminal window picks up.
 */

import { useEffect, useSyncExternalStore } from "react"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { assignFaceColors } from "./crew/crewModel"
import { dedupeSessions, upsertSession } from "./terminalLayout"

export type AgentStateName = "working" | "blocked" | "done" | "idle"

export interface TerminalSession {
  terminalId: string
  ownerWorkspaceId?: string
  title: string
  kind: string
  command: string | null
  pinned: boolean
  persistent: boolean
  createdBy: string
  createdAt: string
  lastActivity: string
  cols: number
  rows: number
  agentState: { state: AgentStateName; message?: string; at: string } | null
  /** How a coding agent in it signs in (chip text), "" for none. */
  auth?: string
  /** A coding agent in it shows its login screen ("claude"). */
  needsAuth?: string | null
  viewers: number
  /** Who is looking at it: identities (crew contract), or names from older backends. */
  watchers: Array<TerminalWatcher | string>
  /** Who typed last (server clock). Newer backends only. */
  lastInput?: { kind: "human" | "agent"; id: string; name?: string; at: number } | null
  /** awake, frozen (host paused) or sleeping (saved, no container): both wake on use. */
  lifecycle?: "awake" | "frozen" | "sleeping"
  /** Who has the wheel (crew contract; absent on older backends: derived from lastInput). */
  driver?: TerminalDriver | null
  /** Two different people typed within 2 s. */
  conflict?: { ids: string[]; at: number } | null
}

/** Who drives a terminal (server clock, ms). */
export interface TerminalDriver {
  kind: "agent" | "human" | "none"
  id?: string
  name?: string
  avatarUrl?: string | null
  since: number
  note?: string | null
}

/** Someone looking at a terminal; typingAt is their last keystroke (server clock, ms). */
export interface TerminalWatcher {
  id: string
  kind: "human" | "agent"
  name: string
  avatarUrl?: string | null
  typingAt?: number | null
}

interface WorkspaceEntry {
  sessions: TerminalSession[]
  loaded: boolean
  error: string | null
  refs: number
  /** Latest watch request: an older response never overwrites a newer one. */
  gen: number
  /** Events received while a watch is in flight (null: the session ended), replayed on its response. */
  pending: Map<string, TerminalSession | null> | null
}

const entries = new Map<string, WorkspaceEntry>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  // Faces get their colours in creation order before anyone draws them.
  for (const e of entries.values()) assignFaceColors(e.sessions.map((s) => s.terminalId))
  version++
  for (const l of listeners) l()
}

function entry(workspaceId: string): WorkspaceEntry {
  let e = entries.get(workspaceId)
  if (!e) {
    e = { sessions: [], loaded: false, error: null, refs: 0, gen: 0, pending: null }
    entries.set(workspaceId, e)
  }
  return e
}

async function watch(workspaceId: string): Promise<void> {
  const client = getTerosClient()
  if (!client) return
  const e = entry(workspaceId)
  const gen = ++e.gen
  e.pending = new Map()
  try {
    const res = (await client.send("terminal", "watch", { workspaceId })) as {
      sessions: TerminalSession[]
    }
    if (entries.get(workspaceId) !== e || gen !== e.gen) return
    let list = dedupeSessions(res.sessions ?? [])
    // Events that raced the response are newer than it.
    for (const [id, session] of e.pending ?? []) {
      list = session ? upsertSession(list, session) : list.filter((s) => s.terminalId !== id)
    }
    e.sessions = list
    e.loaded = true
    e.error = null
  } catch (err) {
    if (entries.get(workspaceId) !== e || gen !== e.gen) return
    e.loaded = true
    e.error = err instanceof Error ? err.message : String(err)
  }
  e.pending = null
  emit()
}

/** The client whose events are wired (a new client after sign-in needs wiring again). */
let wired: unknown = null
function wireEvents(): void {
  const client = getTerosClient()
  if (!client || wired === client) return
  wired = client
  client.on("terminal_sessions", (event: any) => {
    const e = entries.get(event?.workspaceId)
    if (!e || typeof event.terminalId !== "string") return
    const ended = event.reason === "exit" || !event.session
    if (ended) e.sessions = e.sessions.filter((s) => s.terminalId !== event.terminalId)
    else e.sessions = upsertSession(e.sessions, event.session as TerminalSession)
    e.pending?.set(event.terminalId, ended ? null : (event.session as TerminalSession))
    emit()
  })
  // A new connection has no subscriptions: watch every workspace again.
  client.on("authenticated", () => {
    for (const [workspaceId, e] of entries) if (e.refs > 0) void watch(workspaceId)
  })
}

/** Live sessions of a workspace (null workspace → empty). */
export function useTerminalSessions(workspaceId: string | null | undefined): {
  sessions: TerminalSession[]
  loaded: boolean
  error: string | null
} {
  useEffect(() => {
    if (!workspaceId) return
    wireEvents()
    const e = entry(workspaceId)
    e.refs++
    if (e.refs === 1) void watch(workspaceId)
    return () => {
      e.refs--
      if (e.refs === 0) {
        entries.delete(workspaceId)
        getTerosClient()
          ?.send("terminal", "unwatch", { workspaceId })
          .catch(() => {})
      }
    }
  }, [workspaceId])
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
  const e = workspaceId ? entries.get(workspaceId) : undefined
  return { sessions: e?.sessions ?? EMPTY, loaded: e?.loaded ?? false, error: e?.error ?? null }
}

const EMPTY: TerminalSession[] = []

/** Does this session want the user (agent blocked on a question/permission, or a finished turn)? */
export function needsAttention(s: TerminalSession): boolean {
  return s.agentState?.state === "blocked" || s.agentState?.state === "done"
}

/** Label for a session: its title, else what runs in it. */
export function sessionLabel(s: Pick<TerminalSession, "title" | "command" | "kind">): string {
  // A shell where the person started Claude Code is a Claude Code session now.
  if (s.kind === "claude" && (!s.title || /^Shell \d+$/.test(s.title))) return "Claude Code"
  if (s.title) return s.title
  if (s.command && s.command !== "bash") return s.command
  return s.kind === "agent" ? "Agent shell" : "Shell"
}

// ── "Show this session" requests ──────────────────────────────────────────────

const focusListeners = new Set<(terminalId: string) => boolean>()

/** A Terminal window offers to show sessions; return true when it took the request. */
export function onFocusSessionRequest(listener: (terminalId: string) => boolean): () => void {
  focusListeners.add(listener)
  return () => focusListeners.delete(listener)
}

/** Ask an open Terminal window to show a session. False when no window took it. */
export function requestFocusSession(terminalId: string): boolean {
  for (const l of focusListeners) if (l(terminalId)) return true
  return false
}

/**
 * Show a session: in the Terminal window on screen, else in the workspace's
 * existing Terminal window (even one in a background tab, not mounted), else
 * in a new one — never a second window for the same session.
 */
export function showTerminalSession(
  workspaceId: string | null | undefined,
  terminalId: string,
): void {
  if (requestFocusSession(terminalId)) return
  const tiling = useTilingStore.getState()
  const win = Object.values(tiling.windows).find(
    (w) =>
      w.type === "terminal" &&
      (!w.props?.workspaceId || !workspaceId || w.props.workspaceId === workspaceId),
  )
  if (win) {
    tiling.updateWindowProps(win.id, { active: terminalId })
    tiling.focusWindow(win.id)
    return
  }
  tiling.openWindow("terminal", { workspaceId, active: terminalId })
}

export function newTerminalId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
