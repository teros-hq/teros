/**
 * Closing a terminal by hand: at once (with undo) when nothing would be cut
 * off; a confirmation when a coding agent is mid-turn, a program runs in the
 * foreground, or someone else drives. The undo window really holds the destroy.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TerminalSession } from "../terminalSessions"
import {
  cancelClose,
  closeReason,
  isClosing,
  isShellCommand,
  scheduleClose,
  UNDO_MS,
} from "./closeTerminal"

const s = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId: "t1",
  title: "Shell 1",
  kind: "shell",
  command: "bash",
  pinned: true,
  persistent: true,
  createdBy: "user_me",
  createdAt: "",
  lastActivity: "",
  cols: 80,
  rows: 24,
  agentState: null,
  viewers: 1,
  watchers: [],
  ...extra,
})

describe("closeReason", () => {
  it("an idle shell of mine (or nobody's) closes at once", () => {
    expect(closeReason(s(), "user_me")).toBeNull()
    expect(closeReason(s({ driver: { kind: "none", since: 0 } }), "user_me")).toBeNull()
    expect(
      closeReason(s({ driver: { kind: "human", id: "user_me", since: 0 } }), "user_me"),
    ).toBeNull()
  })

  it("Claude Code at its prompt closes at once; mid-turn or asking, it asks first", () => {
    const claude = { kind: "claude", command: "claude" }
    expect(
      closeReason(s({ ...claude, agentState: { state: "done", at: "" } }), "user_me"),
    ).toBeNull()
    expect(
      closeReason(s({ ...claude, agentState: { state: "working", at: "" } }), "user_me"),
    ).toEqual({
      kind: "working",
      agent: "Claude Code",
    })
    expect(
      closeReason(s({ ...claude, agentState: { state: "blocked", at: "" } }), "user_me")?.kind,
    ).toBe("working")
  })

  it("a program in the foreground asks first", () => {
    expect(closeReason(s({ command: "vim" }), "user_me")).toEqual({
      kind: "program",
      command: "vim",
    })
    expect(closeReason(s({ command: "/usr/bin/zsh" }), "user_me")).toBeNull()
  })

  it("someone else at the wheel asks first", () => {
    expect(
      closeReason(s({ driver: { kind: "agent", id: "a1", name: "Atlas", since: 0 } }), "user_me"),
    ).toEqual({
      kind: "driver",
      name: "Atlas",
      agent: true,
    })
    expect(
      closeReason(
        s({ driver: { kind: "human", id: "user_lu", name: "Lucía", since: 0 } }),
        "user_me",
      )?.kind,
    ).toBe("driver")
  })

  it("an agent the backend could not name is asked about without its generic name", () => {
    expect(
      closeReason(
        s({ driver: { kind: "agent", id: "agent:app_1", name: "Agent", since: 0 } }),
        "user_me",
      ),
    ).toEqual({ kind: "driver", name: "", agent: true })
  })

  it("isShellCommand", () => {
    expect(isShellCommand(null)).toBe(true)
    expect(isShellCommand("-bash")).toBe(true)
    expect(isShellCommand("python3 -m http.server")).toBe(false)
  })
})

describe("undoable close", () => {
  afterEach(() => vi.useRealTimers())

  it("destroys after the undo window, not before", () => {
    vi.useFakeTimers()
    const destroy = vi.fn()
    scheduleClose("tA", destroy)
    expect(isClosing("tA")).toBe(true)
    vi.advanceTimersByTime(UNDO_MS - 1)
    expect(destroy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(destroy).toHaveBeenCalledOnce()
    expect(isClosing("tA")).toBe(false)
  })

  it("undo keeps the terminal", () => {
    vi.useFakeTimers()
    const destroy = vi.fn()
    scheduleClose("tB", destroy)
    expect(cancelClose("tB")).toBe(true)
    vi.advanceTimersByTime(UNDO_MS * 2)
    expect(destroy).not.toHaveBeenCalled()
    expect(cancelClose("tB")).toBe(false)
  })
})
