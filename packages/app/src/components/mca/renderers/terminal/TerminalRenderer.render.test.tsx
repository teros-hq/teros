import { describe, expect, it } from "vitest"
import {
  answeredAfterReload,
  chatControlCard,
  controlOutcomeOf,
  controlRequestOf,
  needsYouOf,
} from "./needsYou"

describe("controlRequestOf: which tool call gets the request card", () => {
  it("a terminal-request-control call, whatever prefixes its name, for the session it names", () => {
    for (const toolName of ["terminal-request-control", "mca_teros_terminal_terminal-request-control"])
      expect(controlRequestOf({ toolName, status: "completed", input: { terminalId: "t1" } })).toBe("t1")
    expect(controlRequestOf({ toolName: "terminal-request-control", status: "running", input: { terminalId: "t1" } })).toBe("t1")
  })
  it("not a failed call, not one without a session, and no other tool", () => {
    expect(controlRequestOf({ toolName: "terminal-request-control", status: "failed", input: { terminalId: "t1" } })).toBeNull()
    expect(controlRequestOf({ toolName: "terminal-request-control", status: "completed", input: {} })).toBeNull()
    for (const toolName of ["terminal-release-control", "terminal-write", "terminal-request-control-x"])
      expect(controlRequestOf({ toolName, status: "completed", input: { terminalId: "t1" } })).toBeNull()
  })
})

describe("chatControlCard: what the chat's request card shows under one terminal-request-control call", () => {
  const request = { agent: { id: "agent_atlas", name: "Atlas" }, reason: null, at: 1 }
  const atlas = { kind: "agent" as const, id: "agent_atlas" }
  it("while the request is live: the request, with its buttons", () => {
    expect(chatControlCard({ request, driver: { kind: "none" }, outcome: null, seen: null })).toEqual({
      show: true,
      answeredAs: null,
      seen: { agentId: "agent_atlas", ended: null },
    })
  })
  it("once it is gone, the outcome is fixed when it ended and never changes with who types later", () => {
    const ended = chatControlCard({ request: null, driver: atlas, outcome: null, seen: { agentId: "agent_atlas", ended: null } })
    expect(ended).toMatchObject({ show: true, answeredAs: "approved", seen: { ended: "approved" } })
    const later = chatControlCard({ request: null, driver: { kind: "none" }, outcome: null, seen: ended.seen })
    expect(later.answeredAs).toBe("approved")
  })
  it("a busy call (another agent asked first) shows no card, live or not", () => {
    expect(chatControlCard({ request, driver: { kind: "none" }, outcome: "busy", seen: null }).show).toBe(false)
  })
  it("after a reload, with no live request, it falls back to the tool's own outcome", () => {
    expect(chatControlCard({ request: null, driver: { kind: "none" }, outcome: "denied", seen: null })).toMatchObject({
      show: true,
      answeredAs: "denied",
    })
    expect(chatControlCard({ request: null, driver: { kind: "none" }, outcome: "pending", seen: null })).toMatchObject({
      show: true,
      answeredAs: null,
    })
    expect(chatControlCard({ request: null, driver: { kind: "none" }, outcome: null, seen: null }).show).toBe(false)
  })
  const rook = { agent: { id: "agent_rook", name: "Rook" }, reason: null, at: 50 }
  const atlasCall = { agentId: "agent_atlas", at: 10 }
  it("an answered card stays answered when another agent asks later on the same session", () => {
    const card = chatControlCard({
      request: rook,
      driver: atlas,
      outcome: null,
      seen: { agentId: "agent_atlas", ended: "approved" },
      call: atlasCall,
    })
    expect(card).toMatchObject({ show: true, answeredAs: "approved", seen: { agentId: "agent_atlas", ended: "approved" } })
  })
  it("after a reload, the call's own final outcome isn't replaced by a later request", () => {
    for (const outcome of ["approved", "denied", "granted"] as const)
      expect(chatControlCard({ request: rook, driver: { kind: "none" }, outcome, seen: null, call: atlasCall }).answeredAs).toBe(
        outcome === "denied" ? "denied" : "approved",
      )
  })
  it("a live request shows only on its own agent's card, and only if it was made after that call", () => {
    expect(chatControlCard({ request: rook, driver: { kind: "none" }, outcome: null, seen: null, call: atlasCall }).show).toBe(false)
    const older = { ...request, at: 5 }
    expect(chatControlCard({ request: older, driver: { kind: "none" }, outcome: null, seen: null, call: atlasCall }).show).toBe(false)
    const own = { ...request, at: 12 }
    expect(chatControlCard({ request: own, driver: { kind: "none" }, outcome: "pending", seen: null, call: atlasCall })).toMatchObject({
      show: true,
      answeredAs: null,
      seen: { agentId: "agent_atlas", ended: null },
    })
  })
})

describe("the request card after a reload: rebuilt from the tool's own result", () => {
  it("reads the outcome from the structured result, else from the text the backend stores", () => {
    expect(controlOutcomeOf({ structuredContent: { terminalId: "t1", outcome: "denied" } })).toBe("denied")
    expect(
      controlOutcomeOf({
        output: "Dev allowed it: you have control of t1. Look at the screen, then go on (terminal-prompt, terminal-run, terminal-write).",
      }),
    ).toBe("approved")
    expect(
      controlOutcomeOf({
        output: "You have control of t1: nobody was typing in it. Go on (terminal-prompt, terminal-run, terminal-write).",
      }),
    ).toBe("granted")
    expect(
      controlOutcomeOf({ output: "Dev kept it off. Don't type into t1; tell them in chat what you need, or open your own session with terminal-create." }),
    ).toBe("denied")
    expect(
      controlOutcomeOf({
        output: "Your request is on their screen (\"Allow\" / \"Keep off\" in the chat and in that session's Terminal window); nobody has answered yet.",
      }),
    ).toBe("pending")
    expect(controlOutcomeOf({ output: "Rex already asked for control of t1 and is waiting for the person's answer." })).toBe("busy")
    expect(controlOutcomeOf({ output: "Session t1 ended before anyone answered." })).toBe("ended")
    expect(controlOutcomeOf({ output: "something else" })).toBeNull()
    expect(controlOutcomeOf({ structuredContent: { outcome: "shared" } })).toBeNull()
  })

  it("with the request gone, a past outcome shows how it ended; a busy or unknown one shows nothing", () => {
    expect(answeredAfterReload("approved")).toBe("approved")
    expect(answeredAfterReload("granted")).toBe("approved")
    expect(answeredAfterReload("denied")).toBe("denied")
    expect(answeredAfterReload("pending")).toBe("answered")
    expect(answeredAfterReload("busy")).toBeNull()
    expect(answeredAfterReload("ended")).toBeNull()
    expect(answeredAfterReload(null)).toBeNull()
  })
})

const screen = [
  "Bash command",
  "  rm -rf build",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No",
].join("\n")

describe("needsYouOf: the chat's needs-you card under a terminal tool call", () => {
  it("reads the MCA's structured result first", () => {
    const need = needsYouOf({
      status: "completed",
      output: "Claude Code is waiting for an answer.",
      input: { terminalId: "t1" },
      structuredContent: { reason: "blocked", question: "Claude needs your permission", terminalId: "t1", screen },
    })
    expect(need).toEqual({ terminalId: "t1", screen, hint: "Claude needs your permission" })
  })

  it("falls back to the plain text the backend stores today: the blocked sentence and the screen block", () => {
    const output =
      'Claude Code is waiting for an answer: "Claude needs your permission". Read the options on the screen, then answer with terminal-send-key.\n' +
      `--- screen (80x24) ---\n${screen}\n--- end of screen ---`
    const need = needsYouOf({ status: "completed", output, input: { terminalId: "t1" } })
    expect(need).toEqual({ terminalId: "t1", screen, hint: "Claude needs your permission" })
  })

  it("a finished turn or a running wait asks for nobody", () => {
    expect(
      needsYouOf({ status: "completed", output: "Claude Code finished its turn (after 3.0 s).", input: { terminalId: "t1" } }),
    ).toBeNull()
    expect(needsYouOf({ status: "running", output: "", input: { terminalId: "t1" } })).toBeNull()
  })
})
