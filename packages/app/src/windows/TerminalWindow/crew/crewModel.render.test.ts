/**
 * The crew model: who sits in the seat (contract first, lastInput fallback),
 * needs-you and conflict, the face's expression, stable colours.
 */
import { describe, expect, it } from "vitest"
import type { TerminalSession } from "../terminalSessions"
import {
  assignFaceColors,
  describeSeat,
  elapsed,
  FACE_PALETTE,
  faceColors,
  faceState,
  isUnnamedAgent,
  normalizeWatchers,
  PERSON_PALETTE,
  personColor,
  resolveDriver,
  seatColor,
} from "./crewModel"

const NOW = 1_800_000_000_000

const s = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId: "t1",
  title: "Tests",
  kind: "claude",
  command: "claude",
  pinned: true,
  persistent: true,
  createdBy: "user_me",
  createdAt: new Date(NOW - 600_000).toISOString(),
  lastActivity: new Date(NOW - 600_000).toISOString(),
  cols: 120,
  rows: 36,
  agentState: null,
  viewers: 1,
  watchers: [],
  ...extra,
})

describe("resolveDriver", () => {
  it("takes the contract's driver as is", () => {
    const driver = { kind: "agent" as const, id: "agent:a1", name: "Atlas", since: NOW - 5000 }
    expect(resolveDriver(s({ driver }), NOW)).toBe(driver)
  })

  it("falls back to whoever typed in the last 30 s", () => {
    const d = resolveDriver(
      s({ lastInput: { kind: "human", id: "user_lu", name: "Lucía", at: NOW - 10_000 } }),
      NOW,
    )
    expect(d).toMatchObject({ kind: "human", id: "user_lu", name: "Lucía", since: NOW - 10_000 })
  })

  it("nobody once the keystroke is older than 30 s", () => {
    const d = resolveDriver(
      s({ lastInput: { kind: "human", id: "user_lu", at: NOW - 31_000 } }),
      NOW,
    )
    expect(d.kind).toBe("none")
  })

  it("an agent running the coding agent it started stays at the wheel", () => {
    const d = resolveDriver(
      s({
        createdBy: "agent:a1",
        agentState: { state: "working", at: new Date(NOW).toISOString() },
        lastInput: { kind: "agent", id: "agent:a1", name: "Atlas", at: NOW - 120_000 },
      }),
      NOW,
    )
    expect(d).toMatchObject({ kind: "agent", id: "agent:a1", name: "Atlas" })
  })
})

describe("describeSeat", () => {
  it("agent drives: live while its coding agent works", () => {
    const v = describeSeat(
      s({
        driver: { kind: "agent", id: "agent:a1", name: "Atlas", since: NOW - 100_000 },
        agentState: { state: "working", at: "" },
      }),
      "user_me",
      NOW,
    )
    expect(v).toMatchObject({ seat: "agent", live: true, mine: false })
  })

  it("I drive: mine, and I am not listed as a watcher", () => {
    const v = describeSeat(
      s({
        driver: { kind: "human", id: "user_me", name: "Iria", since: NOW - 1000 },
        watchers: [
          { id: "user_me", kind: "human", name: "Iria", typingAt: NOW - 500 },
          { id: "user_dani", kind: "human", name: "Dani" },
        ],
      }),
      "user_me",
      NOW,
    )
    expect(v.seat).toBe("human")
    expect(v.mine).toBe(true)
    expect(v.live).toBe(true)
    expect(v.watchers.map((w) => w.id)).toEqual(["user_dani"])
  })

  it("an agent blocked on a question: the seat is empty and amber", () => {
    const v = describeSeat(
      s({
        driver: { kind: "agent", id: "agent:a1", name: "Atlas", since: NOW - 1000 },
        agentState: { state: "blocked", message: "permission", at: "" },
      }),
      "user_me",
      NOW,
    )
    expect(v.seat).toBe("need")
    expect(v.driver.name).toBe("Atlas")
  })

  it("a person driving a blocked Claude Code keeps the seat (they answer it)", () => {
    const v = describeSeat(
      s({
        driver: { kind: "human", id: "user_lu", name: "Lucía", since: NOW - 1000 },
        agentState: { state: "blocked", at: "" },
      }),
      "user_me",
      NOW,
    )
    expect(v.seat).toBe("human")
  })

  it("two people typing: clash with both identities, fresh only", () => {
    const base = {
      driver: { kind: "human" as const, id: "user_lu", name: "Lucía", since: NOW - 1000 },
      watchers: [{ id: "user_me", kind: "human" as const, name: "Iria" }],
    }
    const v = describeSeat(
      s({ ...base, conflict: { ids: ["user_me", "user_lu"], at: NOW - 1000 } }),
      "user_me",
      NOW,
    )
    expect(v.seat).toBe("clash")
    expect(v.clash.map((p) => p.name)).toEqual(["Iria", "Lucía"])
    const old = describeSeat(
      s({ ...base, conflict: { ids: ["user_me", "user_lu"], at: NOW - 60_000 } }),
      "user_me",
      NOW,
    )
    expect(old.seat).toBe("human")
  })

  it("nobody: no ring, not live", () => {
    expect(describeSeat(s(), "user_me", NOW)).toMatchObject({ seat: "none", live: false })
  })
})

describe("normalizeWatchers", () => {
  it("accepts names from older backends and identities, once each", () => {
    expect(
      normalizeWatchers(["Dani", "", { id: "u1", kind: "human", name: "Lucía" }, "Dani"]),
    ).toEqual([
      { id: "name:Dani", kind: "human", name: "Dani" },
      { id: "u1", kind: "human", name: "Lucía" },
    ])
  })
})

describe("faceState", () => {
  it("asleep and frozen win over the agent's state", () => {
    expect(
      faceState(s({ lifecycle: "sleeping", agentState: { state: "working", at: "" } }), NOW),
    ).toBe("sleep")
    expect(faceState(s({ lifecycle: "frozen" }), NOW)).toBe("frozen")
  })
  it("maps the coding agent's state", () => {
    expect(faceState(s({ agentState: { state: "blocked", at: "" } }), NOW)).toBe("need")
    expect(faceState(s({ agentState: { state: "done", at: "" } }), NOW)).toBe("done")
  })
  it("a shell works while someone types, else rests", () => {
    expect(
      faceState(s({ kind: "shell", lastInput: { kind: "human", id: "u", at: NOW - 2000 } }), NOW),
    ).toBe("work")
    expect(faceState(s({ kind: "shell" }), NOW)).toBe("idle")
  })
})

describe("colours", () => {
  it("a person keeps one colour, never violet/amber/red", () => {
    expect(personColor("user_lu")).toEqual(personColor("user_lu"))
    for (const c of PERSON_PALETTE) expect(["#8B5CF6", "#F2A93B", "#E5534B"]).not.toContain(c.ring)
  })
  it("seat colours: agent violet, needs-you amber, conflict red", () => {
    expect(seatColor({ seat: "agent", driver: { kind: "agent", since: 0 } }).ring).toBe("#8B5CF6")
    expect(seatColor({ seat: "need", driver: { kind: "none", since: 0 } }).ring).toBe("#F2A93B")
    expect(seatColor({ seat: "clash", driver: { kind: "none", since: 0 } }).ring).toBe("#E5534B")
  })
})

describe("face colours", () => {
  it("neighbours never share a colour while the palette lasts", () => {
    const ids = Array.from({ length: FACE_PALETTE.length }, (_, i) => `tcol${i}`)
    assignFaceColors(ids)
    expect(new Set(ids.map((id) => faceColors(id).join())).size).toBe(ids.length)
  })
  it("a terminal keeps its colour when others come and go", () => {
    assignFaceColors(["tkeep1", "tkeep2"])
    const before = faceColors("tkeep2")
    assignFaceColors(["tkeep0", "tkeep2", "tkeep3"])
    expect(faceColors("tkeep2")).toEqual(before)
  })
})

describe("isUnnamedAgent", () => {
  it("the backend's generic agent (no agent behind the call) has no name", () => {
    expect(isUnnamedAgent({ id: "agent:app_1", name: "Agent" })).toBe(true)
    expect(isUnnamedAgent({ id: "agent_4d65", name: "Atlas" })).toBe(false)
    expect(isUnnamedAgent({ id: "agent_4d65", name: "Agent" })).toBe(false)
    expect(isUnnamedAgent({ id: "agent:app_1", name: "" })).toBe(true)
  })
})

describe("elapsed", () => {
  it("m:ss and h:mm:ss", () => {
    expect(elapsed(NOW - 134_000, NOW)).toBe("2:14")
    expect(elapsed(NOW - 3_723_000, NOW)).toBe("1:02:03")
    expect(elapsed(NOW + 5000, NOW)).toBe("0:00")
  })
})
