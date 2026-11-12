/**
 * The wheel of a shared terminal session: who drives it (an agent, a person or
 * nobody), who typed lately, and whether two people are typing at once.
 *
 * Rules (the Terminal crew contract, packages/shared/src/terminal-crew.ts):
 * - A person typing becomes the driver — unless another person typed within
 *   the conflict window: then it is a conflict and the driver stays who it
 *   was, until one of them yields (or both stop for CONFLICT_CLEAR_MS).
 * - An agent's write takes the wheel only from an agent, from nobody, or from
 *   a person idle for more than the idle window; otherwise it is refused.
 * - While an agent holds the wheel, a person's keys are refused (viewing is
 *   read-only): they take it with takeWheel — the explicit button — and
 *   typing then drives as usual.
 * - A person takes the wheel explicitly (takeWheel): an agent that drove
 *   becomes the copilot; giving the wheel back returns it to that agent with
 *   an optional note, which the agent reads once.
 *
 * Pure state with an injected clock: PtyManager owns one per session and
 * announces what changed.
 */

import type { TerminalConflict, TerminalDriver, TerminalHandedBack } from "@teros/shared"

/** A person or an agent, as shown on the seat. */
export interface CrewIdentity {
  kind: "human" | "agent"
  id: string
  name?: string
  avatarUrl?: string | null
}

export interface DriverLeaseOptions {
  /** A person idle this long at the wheel can be taken over by an agent (default 60 s). */
  idleTakeoverMs?: number
  /** Two people typing within this window of each other are in conflict (default 2 s). */
  conflictWindowMs?: number
  /** A conflict nobody resolved ends when neither typed for this long (default 10 s). */
  conflictClearMs?: number
}

/** What a change touched (terminal_sessions reasons). */
export type LeaseChange = "driver" | "conflict" | "watchers"

/** What survives a backend restart and a sleep (tmux option / SleepRecord). */
export interface LeaseSnapshot {
  driver: TerminalDriver
  priorAgent: CrewIdentity | null
  handedBack: (TerminalHandedBack & { to: string | null }) | null
}

/** Refusal of an agent write: who holds the wheel. */
export interface WheelHeld {
  holder: TerminalDriver
  message: string
}

export class LeaseError extends Error {
  constructor(
    readonly code: "NOT_DRIVER" | "NO_CONFLICT" | "INVALID_TARGET",
    message: string,
  ) {
    super(message)
  }
}

export class DriverLease {
  driver: TerminalDriver
  /** The agent that drove before a person took the wheel: it gets it back. */
  priorAgent: CrewIdentity | null = null
  /** A give-back note not yet read by its agent. */
  handedBack: LeaseSnapshot["handedBack"] = null
  conflict: TerminalConflict | null = null
  /** Last time each person typed. */
  private readonly typing = new Map<string, { at: number; who: CrewIdentity }>()
  /** Last input (or takeover) of the current driver. */
  private driverActiveAt: number
  /** Last time the conflict was fed (both typing): it clears after conflictClearMs. */
  private conflictFedAt = 0
  readonly idleTakeoverMs: number
  readonly conflictWindowMs: number
  readonly conflictClearMs: number

  constructor(
    private readonly now: () => number = Date.now,
    opts: DriverLeaseOptions = {},
  ) {
    this.idleTakeoverMs = opts.idleTakeoverMs ?? 60_000
    this.conflictWindowMs = opts.conflictWindowMs ?? 2_000
    this.conflictClearMs = opts.conflictClearMs ?? 10_000
    const t = now()
    this.driver = { kind: "none", since: t }
    this.driverActiveAt = t
  }

  /** When each person last typed (watchers' typingAt). */
  typingAt(userId: string): number | null {
    return this.typing.get(userId)?.at ?? null
  }

  /** People who typed, newest first. */
  typists(): Array<{ at: number; who: CrewIdentity }> {
    return [...this.typing.values()].sort((a, b) => b.at - a.at)
  }

  /** A person typed. */
  humanInput(who: CrewIdentity): LeaseChange[] {
    const t = this.now()
    const changes: LeaseChange[] = []
    const prev = this.typing.get(who.id)?.at
    this.typing.set(who.id, { at: t, who })
    // Started typing (or typed after a pause): the seat's ring breathes.
    if (prev === undefined || t - prev > this.conflictWindowMs) changes.push("watchers")

    const d = this.driver
    if (d.kind === "human" && d.id !== who.id) {
      const other = this.typing.get(d.id ?? "")?.at
      if (other !== undefined && t - other <= this.conflictWindowMs) {
        this.conflictFedAt = t
        const ids = [d.id as string, who.id]
        if (!this.conflict || !sameIds(this.conflict.ids, ids)) {
          this.conflict = { ids, at: t }
          changes.push("conflict")
        }
        return changes
      }
    }
    // The other one went quiet: whoever keeps typing drives; an open conflict
    // stays on screen until expire() (nobody typing over anyone for a while).
    if (d.kind !== "human" || d.id !== who.id) {
      if (d.kind === "agent") this.priorAgent = identityOf(d)
      this.driver = humanDriver(who, t)
      changes.push("driver")
    }
    this.driverActiveAt = t
    return changes
  }

  /** May this agent write now? Null when it may, else who holds the wheel. */
  agentMay(agent: CrewIdentity): WheelHeld | null {
    const d = this.driver
    if (d.kind !== "human") return null
    if (this.now() - this.driverActiveAt > this.idleTakeoverMs) return null
    const name = d.name || "Someone"
    return {
      holder: { ...d },
      message: `${name} has the wheel; wait or ask them in chat. (${agent.name || "The agent"}'s keys were not sent.)`,
    }
  }

  /** An agent wrote (after agentMay said yes). */
  agentInput(agent: CrewIdentity): LeaseChange[] {
    const t = this.now()
    const d = this.driver
    this.driverActiveAt = t
    if (d.kind === "agent" && d.id === agent.id) return []
    this.driver = {
      kind: "agent",
      id: agent.id,
      name: agent.name,
      avatarUrl: agent.avatarUrl ?? null,
      since: t,
      note: null,
    }
    this.priorAgent = null
    const changes: LeaseChange[] = ["driver"]
    if (this.conflict) {
      this.conflict = null
      changes.push("conflict")
    }
    return changes
  }

  /** A person takes the wheel: the agent that drove becomes the copilot. */
  takeWheel(who: CrewIdentity): LeaseChange[] {
    const t = this.now()
    const changes: LeaseChange[] = []
    if (this.conflict) {
      this.conflict = null
      changes.push("conflict")
    }
    this.driverActiveAt = t
    const d = this.driver
    if (d.kind === "human" && d.id === who.id) return changes
    if (d.kind === "agent") this.priorAgent = identityOf(d)
    this.driver = humanDriver(who, t)
    changes.push("driver")
    return changes
  }

  /**
   * The person at the wheel gives it back: to the agent that drove before
   * (with the note, read once by that agent), or to nobody.
   */
  giveBack(who: CrewIdentity, note: string | null): LeaseChange[] {
    const t = this.now()
    const d = this.driver
    if (d.kind === "agent" || (d.kind === "human" && d.id !== who.id)) {
      throw new LeaseError(
        "NOT_DRIVER",
        d.kind === "agent"
          ? `${d.name || "The agent"} already has the wheel`
          : `${d.name || "Someone else"} has the wheel, not you`,
      )
    }
    const to = this.priorAgent
    const text = note?.trim() ? note.trim().slice(0, 2000) : null
    this.driver = to
      ? {
          kind: "agent",
          id: to.id,
          name: to.name,
          avatarUrl: to.avatarUrl ?? null,
          since: t,
          note: text,
        }
      : { kind: "none", since: t, note: text }
    this.driverActiveAt = t
    this.handedBack = {
      by: { id: who.id, name: who.name || who.id },
      note: text,
      to: to?.id ?? null,
    }
    this.priorAgent = null
    const changes: LeaseChange[] = ["driver"]
    if (this.conflict) {
      this.conflict = null
      changes.push("conflict")
    }
    return changes
  }

  /** In a conflict, cede the wheel to the other person. */
  yieldTo(who: CrewIdentity, to: CrewIdentity): LeaseChange[] {
    const c = this.conflict
    const d = this.driver
    const involved = c?.ids.includes(who.id) || (d.kind === "human" && d.id === who.id)
    if (!involved) throw new LeaseError("NO_CONFLICT", "You are not in a conflict on this terminal")
    if (to.id === who.id || (c && !c.ids.includes(to.id))) {
      throw new LeaseError("INVALID_TARGET", "Yield to the other person typing in this terminal")
    }
    const t = this.now()
    const changes: LeaseChange[] = []
    if (c) {
      this.conflict = null
      changes.push("conflict")
    }
    if (!(d.kind === "human" && d.id === to.id)) {
      const known = this.typing.get(to.id)?.who
      this.driver = humanDriver({ ...known, ...to, name: to.name ?? known?.name }, t)
      changes.push("driver")
    }
    this.driverActiveAt = t
    // The one who yields is no longer "typing" (no new conflict from their last keys).
    this.typing.delete(who.id)
    return changes
  }

  /** The give-back note for this agent, once. */
  takeHandedBack(agentId: string): TerminalHandedBack | null {
    const h = this.handedBack
    if (!h || (h.to && h.to !== agentId)) return null
    this.handedBack = null
    return { by: h.by, note: h.note }
  }

  /** End a conflict nobody fed for conflictClearMs. True when it ended. */
  expire(): boolean {
    if (!this.conflict) return false
    if (this.now() - this.conflictFedAt < this.conflictClearMs) return false
    this.conflict = null
    return true
  }

  /** When expire() may end the current conflict (ms epoch), null without one. */
  conflictEndsAt(): number | null {
    return this.conflict ? this.conflictFedAt + this.conflictClearMs : null
  }

  snapshot(): LeaseSnapshot {
    return { driver: { ...this.driver }, priorAgent: this.priorAgent, handedBack: this.handedBack }
  }

  /** Bring back a snapshot (restart, wake). Idle time counts from the driver's `since`. */
  restore(s: LeaseSnapshot | null): void {
    if (!s?.driver || !["agent", "human", "none"].includes(s.driver.kind)) return
    this.driver = { ...s.driver, since: Number(s.driver.since) || this.now() }
    this.driverActiveAt = this.driver.since
    this.priorAgent = s.priorAgent ?? null
    this.handedBack = s.handedBack ?? null
  }
}

/** Parse a persisted snapshot (tmux option, sleep record), null when absent or broken. */
export function parseLeaseSnapshot(raw: string | null | undefined): LeaseSnapshot | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as LeaseSnapshot
    return s && typeof s === "object" && s.driver ? s : null
  } catch {
    return null
  }
}

function humanDriver(who: CrewIdentity, since: number): TerminalDriver {
  return {
    kind: "human",
    id: who.id,
    name: who.name,
    avatarUrl: who.avatarUrl ?? null,
    since,
    note: null,
  }
}

function identityOf(d: TerminalDriver): CrewIdentity {
  return { kind: "agent", id: d.id ?? "agent", name: d.name, avatarUrl: d.avatarUrl ?? null }
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}
