import { beforeEach, describe, expect, it } from "vitest"
import { markFinished, sessionStatus, useSessionMarks } from "./sessionStatus"
import type { TerminalSession } from "./terminalSessions"

const ME = "u_me"
const session = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId: "t1",
  ownerWorkspaceId: "w1",
  title: "Shell 1",
  kind: "claude",
  command: "claude",
  pinned: true,
  persistent: true,
  createdBy: ME,
  createdAt: "2026-11-10T10:00:00.000Z",
  lastActivity: "2026-11-10T10:00:00.000Z",
  cols: 80,
  rows: 24,
  agentState: null,
  viewers: 0,
  watchers: [],
  driver: { kind: "none", since: 0 },
  agentControl: true,
  space: "personal",
  ...extra,
})
const state = (name: "working" | "blocked" | "done" | "idle", at = "2026-11-10T10:05:00.000Z") => ({
  state: name,
  at,
})
const request = { agent: { id: "agent:ada", name: "Ada" }, reason: "run the tests", at: 1 }

beforeEach(() => {
  useSessionMarks.setState({ finished: {} })
})

describe("the status a terminal session publishes", () => {
  it("[FLOAT-AC-16] working, blocked and quiet map to working, needs-you and nothing", () => {
    expect(sessionStatus(session({ agentState: state("working") }), ME)).toBe("working")
    expect(sessionStatus(session({ agentState: state("blocked") }), ME)).toBe("needs-you")
    expect(sessionStatus(session({ agentState: state("idle") }), ME)).toBeNull()
    expect(sessionStatus(session(), ME)).toBeNull()
  })

  it("[FLOAT-AC-16] a pending request to use the session needs the person, even while the agent works", () => {
    expect(sessionStatus(session({ wheelRequest: request }), ME)).toBe("needs-you")
    expect(
      sessionStatus(session({ wheelRequest: request, agentState: state("working") }), ME),
    ).toBe("needs-you")
  })

  it("[FLOAT-AC-16] a finished turn is marked only until the person has seen it", () => {
    const done = session({ agentState: state("done") })
    expect(sessionStatus(done, ME)).toBeNull()
    markFinished("t1", true)
    expect(sessionStatus(done, ME)).toBe("finished")
    markFinished("t1", false)
    expect(sessionStatus(done, ME)).toBeNull()
    markFinished("t1", true)
    expect(sessionStatus(session({ agentState: state("working") }), ME)).toBe("working")
  })

  it("[FLOAT-AC-20] a colleague's personal session I only watch never says it needs me", () => {
    const theirs = session({ createdBy: "u_other", watchable: true })
    expect(sessionStatus({ ...theirs, agentState: state("blocked") }, ME)).toBeNull()
    expect(sessionStatus({ ...theirs, wheelRequest: request }, ME)).toBeNull()
    expect(sessionStatus({ ...theirs, agentState: state("working") }, ME)).toBe("working")
  })

  it("[FLOAT-AC-16] a shared terminal needs any write member, and no read member", () => {
    const shared = session({ createdBy: "u_other", space: "shared", agentState: state("blocked") })
    expect(sessionStatus(shared, ME, "write")).toBe("needs-you")
    expect(sessionStatus(shared, ME, "read")).toBeNull()
  })
})
