/**
 * The wheel of a shared terminal (services/terminal/driver-lease.ts): who
 * drives, when an agent may take over, two people typing at once, and the
 * give-back note the agent reads once.
 */

import { describe, expect, it } from "bun:test"
import {
  type CrewIdentity,
  DriverLease,
  LeaseError,
  parseLeaseSnapshot,
} from "../../src/services/terminal/driver-lease"

const atlas: CrewIdentity = { kind: "agent", id: "agent_atlas", name: "Atlas", avatarUrl: "/a.png" }
const iria: CrewIdentity = { kind: "human", id: "user_iria", name: "Iria", avatarUrl: "/i.png" }
const lucia: CrewIdentity = { kind: "human", id: "user_lucia", name: "Lucía" }

function lease(start = 1_000_000) {
  const clock = { t: start }
  const l = new DriverLease(() => clock.t)
  l.agentControl = true
  return { l, clock, tick: (ms: number) => (clock.t += ms) }
}

describe("DriverLease", () => {
  it("starts with nobody at the wheel; an agent write takes it", () => {
    const { l } = lease()
    expect(l.driver.kind).toBe("none")
    expect(l.agentMay(atlas)).toBeNull()
    expect(l.agentInput(atlas)).toEqual(["driver"])
    expect(l.driver).toMatchObject({
      kind: "agent",
      id: "agent_atlas",
      name: "Atlas",
      avatarUrl: "/a.png",
    })
    // The same agent writing again is no news.
    expect(l.agentInput(atlas)).toEqual([])
  })

  it("a person typing becomes the driver; the agent that drove becomes the copilot", () => {
    const { l } = lease()
    l.agentInput(atlas)
    expect(l.humanInput(iria)).toEqual(["watchers", "driver"])
    expect(l.driver).toMatchObject({ kind: "human", id: "user_iria", name: "Iria" })
    expect(l.priorAgent?.id).toBe("agent_atlas")
  })

  it("refuses an agent write while a person drives, with a clear message", () => {
    const { l, tick } = lease()
    l.takeWheel(iria)
    tick(59_000)
    const held = l.agentMay(atlas)
    expect(held?.holder.id).toBe("user_iria")
    expect(held?.message).toStartWith("Iria is typing in this session. Ask for control with terminal-request-control")
    expect(held?.message).toContain('they get "Allow" / "Keep off"')
    expect(held?.message).not.toContain("Approve")
  })

  it("an agent's pending request goes once that agent drives anyway (given back, or it took a free wheel)", () => {
    const { l } = lease()
    l.agentInput(atlas)
    l.takeWheel(iria)
    l.askWheel(atlas, "already mine")
    expect(l.giveBack(iria, null)).toContain("request")
    expect(l.request).toBeNull()
    const other = lease().l
    other.askWheel(atlas, "x")
    expect(other.agentInput(atlas)).toContain("request")
    expect(other.request).toBeNull()
  })

  it("an answer says which agent it answers: one meant for another agent's request is refused and changes nothing", () => {
    const rook: CrewIdentity = { kind: "agent", id: "agent_rook", name: "Rook" }
    const { l } = lease()
    l.takeWheel(iria)
    l.askWheel(rook, "run the tests")
    let refused: unknown = null
    try {
      l.answerWheel(true, "agent_atlas")
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(LeaseError)
    expect((refused as LeaseError).code).toBe("STALE_WHEEL_REQUEST")
    expect((refused as LeaseError).message).toContain("Rook")
    expect(l.request?.agent.id).toBe("agent_rook")
    expect(l.driver).toMatchObject({ kind: "human", id: "user_iria" })
    expect(l.answerWheel(true, "agent_rook").agent.id).toBe("agent_rook")
    expect(l.driver).toMatchObject({ kind: "agent", id: "agent_rook" })
  })

  it("a request nobody answers ends after 10 minutes: no busy for other agents, and a late answer finds no request", () => {
    const { l, tick } = lease()
    l.takeWheel(iria)
    l.askWheel(atlas, "x")
    tick(10 * 60_000 - 1)
    expect(l.request?.agent.id).toBe("agent_atlas")
    expect(l.expireRequest()).toBe(false)
    tick(1)
    expect(l.request).toBeNull()
    expect(() => l.answerWheel(true)).toThrow(LeaseError)
    expect(l.driver).toMatchObject({ kind: "human", id: "user_iria" })
    expect(l.expireRequest()).toBe(true)
    expect(l.expireRequest()).toBe(false)
  })

  it("giving back a wheel no agent drove before frees it and leaves no note for any agent", () => {
    const { l } = lease()
    l.takeWheel(iria)
    l.giveBack(iria, "for whoever")
    expect(l.driver.kind).toBe("none")
    expect(l.handedBack).toBeNull()
    expect(l.takeHandedBack("agent_atlas")).toBeNull()
  })

  it("a person's session nobody drives: the refusal names the buttons the person really sees", () => {
    const { l } = lease()
    l.agentControl = false
    const held = l.agentMay(atlas, true)
    expect(held?.message).toContain('ask the person to switch "Agent off" to "Agent"')
    expect(held?.message).toContain("Agent off")
    expect(held?.message).not.toContain("Approve")
  })

  it("lets an agent take over from a person idle for more than 60 s", () => {
    const { l, tick } = lease()
    l.takeWheel(iria)
    tick(30_000)
    l.humanInput(iria) // typing resets the idle clock
    tick(60_000)
    expect(l.agentMay(atlas)).not.toBeNull()
    tick(1)
    expect(l.agentMay(atlas)).toBeNull()
    expect(l.agentInput(atlas)).toEqual(["driver"])
    expect(l.driver.kind).toBe("agent")
  })

  it("two people typing within 2 s: conflict, the driver stays who it was", () => {
    const { l, tick } = lease()
    l.humanInput(iria)
    tick(1_500)
    expect(l.humanInput(lucia)).toEqual(["watchers", "conflict"])
    expect(l.conflict).toEqual({ ids: ["user_iria", "user_lucia"], at: l.driver.since + 1_500 })
    expect(l.driver.id).toBe("user_iria")
    // More keys from both: same conflict, no new event.
    tick(500)
    expect(l.humanInput(iria)).toEqual([])
    expect(l.humanInput(lucia)).toEqual([])
  })

  it("no conflict when the other person stopped more than 2 s ago: the new typist drives", () => {
    const { l, tick } = lease()
    l.humanInput(iria)
    tick(2_001)
    expect(l.humanInput(lucia)).toEqual(["watchers", "driver"])
    expect(l.conflict).toBeNull()
    expect(l.driver.id).toBe("user_lucia")
  })

  it("a conflict nobody resolves ends after 10 s without double typing", () => {
    const { l, tick } = lease()
    l.humanInput(iria)
    l.humanInput(lucia)
    tick(9_999)
    expect(l.expire()).toBe(false)
    tick(1)
    expect(l.expire()).toBe(true)
    expect(l.conflict).toBeNull()
  })

  it("yield hands the wheel to the other person and ends the conflict", () => {
    const { l } = lease()
    l.humanInput(iria)
    l.humanInput(lucia)
    expect(l.yieldTo(iria, { kind: "human", id: "user_lucia" })).toEqual(["conflict", "driver"])
    expect(l.driver).toMatchObject({ kind: "human", id: "user_lucia", name: "Lucía" })
    expect(l.conflict).toBeNull()
    expect(() => l.yieldTo(iria, lucia)).toThrow(LeaseError)
  })

  it("give back: the wheel returns to the agent with the note, delivered once", () => {
    const { l, tick } = lease()
    l.agentInput(atlas)
    l.takeWheel(iria)
    tick(5_000)
    expect(l.giveBack(iria, "  session.test fails on the cache  ")).toEqual(["driver"])
    expect(l.driver).toMatchObject({
      kind: "agent",
      id: "agent_atlas",
      note: "session.test fails on the cache",
    })
    expect(l.takeHandedBack("agent_other")).toBeNull()
    expect(l.takeHandedBack("agent_atlas")).toEqual({
      by: { id: "user_iria", name: "Iria" },
      note: "session.test fails on the cache",
    })
    expect(l.takeHandedBack("agent_atlas")).toBeNull()
  })

  it("give back with no agent before: nobody drives; only the driver may give it back", () => {
    const { l } = lease()
    l.takeWheel(iria)
    expect(() => l.giveBack(lucia, null)).toThrow("Iria is typing in this session, not you")
    l.giveBack(iria, "")
    expect(l.driver).toMatchObject({ kind: "none" })
    expect(l.takeHandedBack("agent_x")).toBeNull()
  })

  it("survives a restart through its snapshot (idle counted from since)", () => {
    const { l, tick } = lease()
    l.agentInput(atlas)
    l.takeWheel(iria)
    const raw = JSON.stringify(l.snapshot())
    const { l: back, clock } = lease(l.driver.since)
    back.restore(parseLeaseSnapshot(raw))
    expect(back.driver).toMatchObject({ kind: "human", id: "user_iria" })
    expect(back.priorAgent?.id).toBe("agent_atlas")
    expect(back.agentMay(atlas)).not.toBeNull()
    clock.t += 60_001
    expect(back.agentMay(atlas)).toBeNull()
    expect(parseLeaseSnapshot("{broken")).toBeNull()
    tick(0)
  })
})

describe("a session saved before the Agent flag existed", () => {
  it("[TW-AC-9] comes back with Agent on when an agent was the one typing, off otherwise", () => {
    const withAgent = new DriverLease(() => 1_000)
    withAgent.restore({
      driver: { kind: "agent", id: "agent_atlas", name: "Atlas", since: 500 },
      priorAgent: null,
      handedBack: null,
    })
    expect(withAgent.agentControl).toBe(true)
    const withPerson = new DriverLease(() => 1_000)
    withPerson.restore({
      driver: { kind: "human", id: "user_iria", name: "Iria", since: 500 },
      priorAgent: null,
      handedBack: null,
    })
    expect(withPerson.agentControl).toBe(false)
  })
})
