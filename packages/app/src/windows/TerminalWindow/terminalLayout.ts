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

// ── Follow the agent ─────────────────────────────────────────────────────────

/** Was this session made by a Teros agent (mca.teros.terminal)? */
export function createdByAgent(s: SessionLike): boolean {
  return typeof s.createdBy === "string" && s.createdBy.startsWith("agent:")
}

/**
 * When a Teros agent last did something in this session (0: never seen):
 * it took the wheel (driver), it typed (lastInput), it created the session,
 * or the coding agent it started there changed state.
 */
export function agentStamp(s: SessionLike): number {
  let at = 0
  if (s.lastInput?.kind === "agent" && Number.isFinite(s.lastInput.at)) at = s.lastInput.at
  if (s.driver?.kind === "agent" && Number.isFinite(s.driver.since))
    at = Math.max(at, s.driver.since)
  if (createdByAgent(s)) {
    at = Math.max(at, time(s.createdAt))
    if (s.agentState) at = Math.max(at, time(s.agentState.at))
  }
  return at
}

/**
 * Compare the list with what was seen before: the session the agent touched
 * most recently since then (a new agent session, or a higher stamp), if any.
 * Stamps are only compared with stamps of the same session, so the client's
 * clock never matters.
 */
export function followUpdate(
  seen: ReadonlyMap<string, number>,
  sessions: readonly SessionLike[],
): { seen: Map<string, number>; target: string | null } {
  const next = new Map<string, number>()
  let target: string | null = null
  let best = 0
  for (const s of sessions) {
    const stamp = agentStamp(s)
    next.set(s.terminalId, stamp)
    const before = seen.get(s.terminalId)
    const moved = before === undefined ? stamp > 0 : stamp > before
    if (moved && stamp >= best) {
      best = stamp
      target = s.terminalId
    }
  }
  return { seen: next, target }
}

/** The session the agent touched last, regardless of what was seen (turning following on). */
export function latestAgentSession(sessions: readonly SessionLike[]): string | null {
  let target: string | null = null
  let best = 0
  for (const s of sessions) {
    const stamp = agentStamp(s)
    if (stamp > best) {
      best = stamp
      target = s.terminalId
    }
  }
  return target
}
