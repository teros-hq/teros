import { useEffect, useSyncExternalStore } from "react"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useAuthStore } from "../../store/authStore"
import { useTilingStore } from "../../store/tilingStore"
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
  auth?: string
  needsAuth?: string | null
  viewers: number
  watchers: Array<TerminalWatcher | string>
  lastInput?: { kind: "human" | "agent"; id: string; name?: string; at: number } | null
  lifecycle?: "awake" | "frozen" | "sleeping"
  driver?: TerminalDriver | null
  conflict?: { ids: string[]; at: number } | null
  wheelRequest?: TerminalWheelRequest | null
  priorAgent?: TerminalWheelRequest["agent"] | null
  agentControl?: boolean
  space?: "personal" | "shared"
  watchable?: boolean
  openedBy?: "person" | "agent"
}

export interface TerminalWheelRequest {
  agent: { id: string; name?: string; avatarUrl?: string | null }
  reason: string | null
  at: number
  openerAnswers?: boolean
}

export interface TerminalDriver {
  kind: "agent" | "human" | "none"
  id?: string
  name?: string
  avatarUrl?: string | null
  since: number
  note?: string | null
}

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
  gen: number
  pending: Map<string, TerminalSession | null> | null
}

const entries = new Map<string, WorkspaceEntry>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
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

type RevealListener = (workspaceId: string, session: TerminalSession) => void
const revealListeners = new Set<RevealListener>()

export function onSessionRevealed(listener: RevealListener): () => void {
  revealListeners.add(listener)
  return () => revealListeners.delete(listener)
}

export function endsSessionFor(
  event: { reason?: string; session?: unknown },
  known: Pick<TerminalSession, "createdBy"> | undefined,
  me: string | undefined,
): boolean {
  if (event.reason === "unwatchable") return !known || known.createdBy !== me
  return event.reason === "exit" || !event.session
}

let wired: unknown = null
function wireEvents(): void {
  const client = getTerosClient()
  if (!client || wired === client) return
  wired = client
  client.on("terminal_sessions", (event: any) => {
    const e = entries.get(event?.workspaceId)
    if (!e || typeof event.terminalId !== "string") return
    const known = e.sessions.find((s) => s.terminalId === event.terminalId)
    if (
      event.reason === "unwatchable" &&
      !endsSessionFor(event, known, useAuthStore.getState().user?.userId)
    )
      return
    const ended = event.reason === "exit" || !event.session
    if (ended) e.sessions = e.sessions.filter((s) => s.terminalId !== event.terminalId)
    else e.sessions = upsertSession(e.sessions, event.session as TerminalSession)
    e.pending?.set(event.terminalId, ended ? null : (event.session as TerminalSession))
    emit()
    if (event.reason === "reveal" && !ended)
      for (const l of revealListeners) l(event.workspaceId, event.session as TerminalSession)
  })
  client.on("authenticated", () => {
    for (const [workspaceId, e] of entries) if (e.refs > 0) void watch(workspaceId)
  })
}

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

export function needsAttention(s: TerminalSession): boolean {
  return s.agentState?.state === "blocked" || s.agentState?.state === "done"
}

export function sessionLabel(s: Pick<TerminalSession, "title" | "command" | "kind">): string {
  if (s.kind === "claude" && (!s.title || /^Shell \d+$/.test(s.title))) return "Claude Code"
  if (s.title) return s.title
  if (s.command && s.command !== "bash") return s.command
  return s.kind === "agent" ? "Agent shell" : "Shell"
}

interface WindowLike {
  id: string
  type: string
  props?: Record<string, any>
}

export function windowOfSession(
  windows: Record<string, WindowLike>,
  terminalId: string,
): WindowLike | undefined {
  return Object.values(windows).find(
    (w) => w.type === "terminal" && w.props?.terminalId === terminalId,
  )
}

export function goToWindow(windowId: string): void {
  const tiling = useTilingStore.getState()
  const target = tiling.windows[windowId]
  if (!target) return
  const floating = Boolean(tiling.floats?.[windowId])
  const desktop = target.desktopIndex
  if (!floating && typeof desktop === "number" && desktop !== tiling.activeDesktopIndex)
    tiling.switchToDesktop(desktop)
  tiling.focusWindow(windowId)
}

export function showTerminalSession(
  workspaceId: string | null | undefined,
  terminalId: string,
): void {
  const tiling = useTilingStore.getState()
  const open = windowOfSession(tiling.windows, terminalId)
  if (open) {
    goToWindow(open.id)
    return
  }
  tiling.openWindow(
    "terminal",
    { ...(workspaceId ? { workspaceId } : {}), terminalId },
    { inNewTab: true },
  )
}

export function newTerminalId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function floatTerminalSession(
  workspaceId: string | null | undefined,
  terminalId: string,
): void {
  const tiling = useTilingStore.getState()
  const open = windowOfSession(tiling.windows, terminalId)
  if (open) {
    if (!tiling.floatWindow(open.id)) goToWindow(open.id)
    return
  }
  tiling.openWindow(
    "terminal",
    { ...(workspaceId ? { workspaceId } : {}), terminalId },
    { float: true, inNewTab: true },
  )
}
