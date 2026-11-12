/**
 * The crew model: who sits in a terminal's seat, how its face looks, and the
 * colours of the people around it. Pure (no React, no client), unit-tested.
 *
 * The backend's crew contract sends `driver`, `watchers` (identities) and
 * `conflict`. Older backends don't: the seat is then derived from `lastInput`
 * (the spec's own rule: an explicit driver, else whoever typed in the last
 * 30 s, else nobody) and from a Teros agent working in a session it made.
 */

import type { TerminalDriver, TerminalSession, TerminalWatcher } from "../terminalSessions"

/** What the seat shows. */
export type SeatState = "agent" | "human" | "none" | "need" | "clash"

/** The face's expression. */
export type FaceState = "work" | "need" | "done" | "idle" | "sleep" | "frozen"

export interface CrewPerson {
  id: string
  kind: "agent" | "human"
  name: string
  avatarUrl?: string | null
}

export interface SeatView {
  seat: SeatState
  /** Who drives (for "need": the agent that waits, if known). */
  driver: TerminalDriver
  /** The driver is me. */
  mine: boolean
  /** The driver is typing / working right now: the ring breathes. */
  live: boolean
  /** The two people of a conflict (seat "clash"). */
  clash: CrewPerson[]
  /** Who looks at it, without the driver. */
  watchers: TerminalWatcher[]
}

/** Without an explicit driver, a keystroke keeps someone in the seat this long. */
export const SEAT_HOLD_MS = 30_000
/** The ring breathes this long after the driver's last keystroke. */
export const LIVE_MS = 8_000
/** A conflict shows this long after it happened (the backend clears it too). */
export const CONFLICT_MS = 10_000

const NOBODY: TerminalDriver = { kind: "none", since: 0 }

function isAgentId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith("agent:")
}

/** Watchers as identities, whatever the backend sent (names from older ones). */
export function normalizeWatchers(
  list: TerminalSession["watchers"] | undefined,
): TerminalWatcher[] {
  const out: TerminalWatcher[] = []
  const seen = new Set<string>()
  for (const w of list ?? []) {
    const v: TerminalWatcher | null =
      typeof w === "string"
        ? w
          ? { id: `name:${w}`, kind: "human", name: w }
          : null
        : w && typeof w.id === "string"
          ? w
          : null
    if (!v || seen.has(v.id)) continue
    seen.add(v.id)
    out.push(v)
  }
  return out
}

/** The driver: the contract's, else derived from lastInput / the agent that made the session. */
export function resolveDriver(s: TerminalSession, now: number): TerminalDriver {
  if (s.driver) return s.driver
  const li = s.lastInput
  if (li && now - li.at < SEAT_HOLD_MS) {
    return { kind: li.kind, id: li.id, name: li.name, since: li.at }
  }
  // A Teros agent running a coding agent it started: it is at the wheel while that works.
  if (isAgentId(s.createdBy) && s.agentState && s.agentState.state !== "idle") {
    return {
      kind: "agent",
      id: s.createdBy,
      name: li?.kind === "agent" ? li.name : undefined,
      since: Date.parse(s.createdAt) || 0,
    }
  }
  return NOBODY
}

export function describeSeat(s: TerminalSession, me: string | undefined, now: number): SeatView {
  const driver = resolveDriver(s, now)
  const all = normalizeWatchers(s.watchers)
  const watchers = all.filter((w) => !(driver.id && w.id === driver.id))
  const mine = driver.kind === "human" && !!me && driver.id === me

  if (s.conflict && s.conflict.ids.length >= 2 && now - s.conflict.at < CONFLICT_MS) {
    const clash = s.conflict.ids.slice(0, 2).map((id): CrewPerson => {
      const w = all.find((x) => x.id === id)
      if (w) return { id, kind: w.kind, name: w.name, avatarUrl: w.avatarUrl }
      if (driver.id === id)
        return { id, kind: "human", name: driver.name ?? "?", avatarUrl: driver.avatarUrl }
      return { id, kind: "human", name: s.lastInput?.id === id ? (s.lastInput.name ?? "?") : "?" }
    })
    return { seat: "clash", driver, mine, live: false, clash, watchers }
  }

  if (s.agentState?.state === "blocked" && driver.kind !== "human") {
    return { seat: "need", driver, mine: false, live: false, clash: [], watchers }
  }

  if (driver.kind === "none") {
    return { seat: "none", driver, mine: false, live: false, clash: [], watchers }
  }

  const typedAt = Math.max(
    s.lastInput && s.lastInput.id === driver.id ? s.lastInput.at : 0,
    all.find((w) => w.id === driver.id)?.typingAt ?? 0,
  )
  const live =
    now - typedAt < LIVE_MS || (driver.kind === "agent" && s.agentState?.state === "working")
  return { seat: driver.kind, driver, mine, live, clash: [], watchers }
}

/** The face's expression: asleep/frozen first, then the coding agent's state, then activity. */
export function faceState(s: TerminalSession, now: number): FaceState {
  if (s.lifecycle === "sleeping") return "sleep"
  if (s.lifecycle === "frozen") return "frozen"
  switch (s.agentState?.state) {
    case "blocked":
      return "need"
    case "working":
      return "work"
    case "done":
      return "done"
    case "idle":
      return "idle"
  }
  if (s.lastInput && now - s.lastInput.at < SEAT_HOLD_MS) return "work"
  const act = Date.parse(s.lastActivity)
  return Number.isFinite(act) && now - act < 10_000 ? "work" : "idle"
}

// ── Colours ──────────────────────────────────────────────────────────────────

/** Fixed seat colours (spec "Color por conductor"). */
export const SEAT_COLORS = {
  agent: { ring: "#8B5CF6", text: "#C9B2FF" },
  none: { ring: "#3A3546", text: "#8D879A" },
  need: { ring: "#F2A93B", text: "#FFD593" },
  clash: { ring: "#E5534B", text: "#FFB4AE" },
} as const

/**
 * People: 8 colours by a hash of their id, never violet (agents), amber
 * (needs you) or red (conflict). Ring on dark + a lighter text tint.
 */
export const PERSON_PALETTE: ReadonlyArray<{ ring: string; text: string }> = [
  { ring: "#F0784F", text: "#FFB59A" },
  { ring: "#14B8A6", text: "#7FE3D3" },
  { ring: "#3B82F6", text: "#9DBEFF" },
  { ring: "#EC4899", text: "#F9A8D4" },
  { ring: "#22C55E", text: "#93E9B3" },
  { ring: "#06B6D4", text: "#8BE3F2" },
  { ring: "#84CC16", text: "#C4EB85" },
  { ring: "#C08A4E", text: "#E8C59C" },
]

/** Squircle gradients of terminal faces (top-left → bottom-right). */
export const FACE_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["#FFB38A", "#D9541E"],
  ["#FFD27A", "#D98A0B"],
  ["#9CC3FF", "#3366D6"],
  ["#8FD8B5", "#1F8A5B"],
  ["#F9A8D4", "#C2387E"],
  ["#7FE3D3", "#0E8F80"],
  ["#D9F99D", "#4D7C0F"],
  ["#FCA5A5", "#C2413B"],
]
/** Frozen faces lose their colour. */
export const FROZEN_FACE: readonly [string, string] = ["#B9B3C6", "#5E576E"]

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function personColor(id: string | undefined): { ring: string; text: string } {
  return PERSON_PALETTE[hashString(id ?? "") % PERSON_PALETTE.length]
}

/**
 * Colour slot of each terminal seen so far. Terminals get colours in creation
 * order, starting at their hash and skipping colours already on screen, so
 * neighbours differ; a terminal keeps its colour for the app's lifetime.
 */
const faceSlots = new Map<string, number>()

/** Give the workspace's terminals (oldest first) their colours. */
export function assignFaceColors(terminalIds: readonly string[]): void {
  const n = FACE_PALETTE.length
  const used = new Set<number>()
  for (const id of terminalIds) {
    const slot = faceSlots.get(id)
    if (slot !== undefined) used.add(slot)
  }
  for (const id of terminalIds) {
    if (faceSlots.has(id)) continue
    let slot = hashString(id) % n
    for (let k = 0; k < n && used.has(slot); k++) slot = (slot + 1) % n
    faceSlots.set(id, slot)
    used.add(slot)
  }
}

export function faceColors(terminalId: string): readonly [string, string] {
  const slot = faceSlots.get(terminalId) ?? hashString(terminalId) % FACE_PALETTE.length
  return FACE_PALETTE[slot]
}

/** Ring and text colour of a seat. */
export function seatColor(view: Pick<SeatView, "seat" | "driver">): { ring: string; text: string } {
  if (view.seat === "human") return personColor(view.driver.id)
  return SEAT_COLORS[view.seat]
}

export function initials(name: string | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].charAt(0).toUpperCase()
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase()
}

/**
 * The backend names an agent it could not identify (no agent behind the
 * call, e.g. a tool run from the UI) "Agent" with an `agent:<appId>` id: the
 * UI says "the agent" in the person's language instead.
 */
export function isUnnamedAgent(
  p: { id?: string; name?: string | null } | null | undefined,
): boolean {
  if (!p) return false
  const name = (p.name ?? "").trim()
  return name === "" || (name === "Agent" && (p.id ?? "").startsWith("agent:"))
}

/** First name for running text ("Lucía conduce"). */
export function firstName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? ""
}

/** "2:14", "1:02:03": elapsed since a server timestamp. */
export function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}
