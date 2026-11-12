/**
 * Terminal window pure helpers: one entry per session id (list, tabs, panes)
 * and the follow-the-agent decision. Duplicate sessions in the window came
 * from lists and layouts that could hold one id twice; following must react
 * only to news, never to what happened before the window opened.
 */
import { describe, expect, it } from "vitest"
import {
  agentStamp,
  dedupeSessions,
  followUpdate,
  latestAgentSession,
  type SessionLike,
  upsertSession,
} from "./terminalLayout"

const s = (id: string, extra: Partial<SessionLike> = {}): SessionLike => ({
  terminalId: id,
  createdAt: "2026-10-20T10:00:00.000Z",
  createdBy: "user_1",
  persistent: true,
  ...extra,
})

describe("dedupeSessions", () => {
  it("keeps one entry per terminalId, oldest first", () => {
    const list = dedupeSessions([
      s("b", { createdAt: "2026-10-20T10:00:02.000Z" }),
      s("a", { createdAt: "2026-10-20T10:00:01.000Z" }),
      s("b", { createdAt: "2026-10-20T10:00:02.000Z" }),
    ])
    expect(list.map((x) => x.terminalId)).toEqual(["a", "b"])
  })

  it("prefers the persistent (tmux) entry over a legacy one with the same id", () => {
    const list = dedupeSessions([
      s("a", { persistent: true, lastActivity: "2026-10-20T10:00:00.000Z" }),
      s("a", { persistent: false, lastActivity: "2026-10-20T11:00:00.000Z" }),
    ])
    expect(list).toHaveLength(1)
    expect(list[0].persistent).toBe(true)
  })

  it("then the most recently active", () => {
    const list = dedupeSessions([
      s("a", { lastActivity: "2026-10-20T10:00:00.000Z" }),
      s("a", { lastActivity: "2026-10-20T10:05:00.000Z" }),
    ])
    expect(list[0].lastActivity).toBe("2026-10-20T10:05:00.000Z")
  })

  it("drops entries without an id", () => {
    expect(dedupeSessions([s(""), s("a")] as SessionLike[]).map((x) => x.terminalId)).toEqual(["a"])
  })
})

describe("upsertSession", () => {
  it("replaces an existing entry instead of appending (create event racing the list)", () => {
    const first = s("a", { persistent: false })
    const complete = s("a", { persistent: true })
    const list = upsertSession(upsertSession([], first), complete)
    expect(list).toHaveLength(1)
    expect(list[0].persistent).toBe(true)
  })
})

describe("follow the agent", () => {
  it("an agent taking the wheel (crew contract) is news, even without createdBy agent:", () => {
    const before = followUpdate(new Map(), [s("a"), s("b")]).seen
    const { target } = followUpdate(before, [
      s("a"),
      s("b", { createdBy: "user_1", driver: { kind: "agent", since: 1_800_000_000_000 } }),
    ])
    expect(target).toBe("b")
    expect(agentStamp(s("c", { driver: { kind: "human", since: 5 } }))).toBe(0)
  })

  const agentMade = (id: string, at: string, extra: Partial<SessionLike> = {}) =>
    s(id, { createdBy: "agent:agent_1", createdAt: at, ...extra })

  it("a person's session without agent input has no agent stamp", () => {
    expect(agentStamp(s("a"))).toBe(0)
    expect(agentStamp(s("a", { lastInput: { kind: "human", id: "user_1", at: 5 } }))).toBe(0)
  })

  it("agent input counts in anyone's session", () => {
    expect(agentStamp(s("a", { lastInput: { kind: "agent", id: "agent_1", at: 42 } }))).toBe(42)
  })

  it("the first list is a baseline, not news", () => {
    const { target, seen } = followUpdate(new Map(), [])
    expect(target).toBeNull()
    expect(seen.size).toBe(0)
  })

  it("follows a session the agent creates", () => {
    const before = [s("mine")]
    const base = followUpdate(new Map(), before).seen
    const { target } = followUpdate(base, [...before, agentMade("t1", "2026-10-20T10:01:00.000Z")])
    expect(target).toBe("t1")
  })

  it("follows the agent typing into an existing session, and only once per keystroke batch", () => {
    const quiet = [s("a"), s("b")]
    const base = followUpdate(new Map(), quiet).seen
    const typed = [s("a"), s("b", { lastInput: { kind: "agent", id: "agent_1", at: 1000 } })]
    const step = followUpdate(base, typed)
    expect(step.target).toBe("b")
    expect(followUpdate(step.seen, typed).target).toBeNull()
  })

  it("ignores a person typing, and old agent activity seen at baseline", () => {
    const old = [s("a", { lastInput: { kind: "agent", id: "agent_1", at: 500 } })]
    const base = followUpdate(new Map(), old).seen
    const human = [s("a", { lastInput: { kind: "human", id: "user_1", at: 900 } })]
    expect(followUpdate(base, human).target).toBeNull()
  })

  it("an agent-made coding session changing state counts (e.g. Claude Code waiting for you)", () => {
    const made = agentMade("c", "2026-10-20T10:00:00.000Z")
    const base = followUpdate(new Map(), [made]).seen
    const blocked = { ...made, agentState: { state: "blocked", at: "2026-10-20T10:03:00.000Z" } }
    expect(followUpdate(base, [blocked]).target).toBe("c")
  })

  it("picks the most recent when several moved", () => {
    const base = followUpdate(new Map(), [s("a"), s("b")]).seen
    const both = [
      s("a", { lastInput: { kind: "agent", id: "x", at: 2000 } }),
      s("b", { lastInput: { kind: "agent", id: "x", at: 1000 } }),
    ]
    expect(followUpdate(base, both).target).toBe("a")
  })

  it("latestAgentSession: where the agent worked last (turning following on)", () => {
    expect(latestAgentSession([s("a")])).toBeNull()
    expect(
      latestAgentSession([
        agentMade("old", "2026-10-20T09:00:00.000Z"),
        agentMade("new", "2026-10-20T10:00:00.000Z"),
        s("mine"),
      ]),
    ).toBe("new")
  })
})
