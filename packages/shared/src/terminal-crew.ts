/**
 * Terminal crew — who drives a shared terminal session and who watches it.
 *
 * Carried by every session the backend describes (terminal.list,
 * terminal.watch, `terminal_sessions` events, the /ws/terminal `attached` and
 * `state` frames). The driver is a lease: a person takes the wheel
 * (terminal.takeWheel — or by typing, when nobody or another person holds it:
 * viewing an agent-driven terminal is read-only) and gives it back to the
 * agent (terminal.giveBack, with an optional note the agent reads once); an
 * agent's write only takes it when nobody — or an idle person — holds it.
 */

/** Who holds the wheel of a session. */
export interface TerminalDriver {
  kind: "agent" | "human" | "none"
  /** userId for a person; the Teros agentId (or `agent:<appId>` when unknown) for an agent. */
  id?: string
  name?: string
  avatarUrl?: string | null
  /** Since when (ms epoch). */
  since: number
  /** The note a person left when giving the wheel back to the agent. */
  note?: string | null
}

/** Someone looking at a session: a person with it open, or an agent waiting on it (or its copilot). */
export interface TerminalWatcher {
  id: string
  kind: "human" | "agent"
  name: string
  avatarUrl?: string | null
  /** Last keystroke of this person (ms epoch), null when they have not typed. */
  typingAt?: number | null
}

/** Two different people typed into the same session within TERMINAL_CONFLICT_WINDOW_MS. */
export interface TerminalConflict {
  ids: string[]
  /** When it started (ms epoch). */
  at: number
}

/** What a person said when giving the wheel back: delivered once to the agent's next wait/read. */
export interface TerminalHandedBack {
  by: { id: string; name: string }
  note: string | null
}

/** The crew fields of a session (SessionInfo carries them besides its other fields). */
export interface TerminalCrew {
  driver: TerminalDriver
  watchers: TerminalWatcher[]
  conflict: TerminalConflict | null
  /** Live viewer connections (kept from before watchers were identities). */
  viewers: number
}

/** `terminal_sessions` event reasons added with the crew. */
export type TerminalCrewReason = "driver" | "watchers" | "conflict"

/** A person idle this long at the wheel can be taken over by an agent's write. */
export const TERMINAL_DRIVER_IDLE_MS = 60_000
/** Two people typing within this window of each other are in conflict. */
export const TERMINAL_CONFLICT_WINDOW_MS = 2_000
