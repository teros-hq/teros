/**
 * Pure helpers of the Terminal window: one entry per session id everywhere
 * (list, rail, pane), and "which session is the Teros agent driving" for the
 * implicit follow-the-agent. No React, no client: unit-tested on their own.
 */

/** The fields these helpers read from a session list entry. */
export interface SessionLike {
  terminalId: string
  persistent?: boolean
  createdAt?: string
  createdBy?: string
  lastActivity?: string
  agentState?: { state: string; at?: string } | null
  /** Who typed last (server clock, ms). Optional: older backends don't send it. */
  lastInput?: { kind: "human" | "agent"; id?: string; at: number } | null
  /** Who has the wheel (crew contract): an agent taking it is news. */
  driver?: { kind: "agent" | "human" | "none"; since: number } | null
  title?: string
}

export function defaultTitle(preset: "shell" | "claude", sessions: readonly SessionLike[]): string {
  const base = preset === "claude" ? "Claude Code" : "Shell"
  const pattern = new RegExp(`^${base}(?: (\\d+))?$`)
  let highest = 0
  for (const s of sessions) {
    const m = pattern.exec(s.title ?? "")
    if (m) highest = Math.max(highest, m[1] ? Number(m[1]) : 1)
  }
  if (preset === "claude" && highest === 0) return base
  return `${base} ${highest + 1}`
}

function time(iso: string | undefined): number {
  const n = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(n) ? n : 0
}

/**
 * One entry per terminalId, oldest first. When a list carries the same id
 * twice (a create event racing the watch response, a legacy entry next to its
 * tmux-backed one), the persistent entry wins, then the most recently active.
 */
export function dedupeSessions<S extends SessionLike>(list: readonly S[]): S[] {
  const byId = new Map<string, S>()
  for (const s of list) {
    if (!s || typeof s.terminalId !== "string" || !s.terminalId) continue
    const prev = byId.get(s.terminalId)
    if (!prev || better(s, prev)) byId.set(s.terminalId, s)
  }
  return [...byId.values()].sort(
    (a, b) =>
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
      a.terminalId.localeCompare(b.terminalId),
  )
}

function better(a: SessionLike, b: SessionLike): boolean {
  if ((a.persistent === true) !== (b.persistent === true)) return a.persistent === true
  return time(a.lastActivity) >= time(b.lastActivity)
}

/** Insert or replace one session (by id) in a deduped list. */
export function upsertSession<S extends SessionLike>(list: readonly S[], session: S): S[] {
  const i = list.findIndex((s) => s.terminalId === session.terminalId)
  if (i === -1) return dedupeSessions([...list, session])
  return list.map((s, j) => (j === i ? session : s))
}

export function isTouchPress(
  ev: { pointerType?: string; type?: string; touches?: unknown } | null | undefined,
): boolean {
  if (!ev) return false
  if (ev.pointerType) return ev.pointerType === "touch" || ev.pointerType === "pen"
  return !!ev.touches || (typeof ev.type === "string" && ev.type.startsWith("touch"))
}
