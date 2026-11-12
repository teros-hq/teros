/**
 * The general notices' terminals: which sessions need the person (blocked
 * only, writable workspaces, once each, oldest first) and the screen question
 * read once per block.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TerminalSession } from "../../windows/TerminalWindow/terminalSessions"
import {
  cachedScreenQuestion,
  canReadScreen,
  fallbackQuestion,
  loadScreenQuestion,
  resetScreenQuestions,
} from "./screenQuestion"
import {
  isBlocked,
  needKey,
  selectTerminalNeeds,
  useTerminalNeedsStore,
  writableWorkspaceIds,
} from "./terminalNeeds"

const s = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId: "t1",
  ownerWorkspaceId: "w1",
  title: "Tests",
  kind: "claude",
  command: "claude",
  pinned: true,
  persistent: true,
  createdBy: "u1",
  createdAt: "2026-10-21T10:00:00.000Z",
  lastActivity: "2026-10-21T10:00:00.000Z",
  cols: 120,
  rows: 30,
  agentState: {
    state: "blocked",
    message: "Claude needs your permission to use Bash",
    at: "2026-10-21T10:05:00.000Z",
  },
  viewers: 0,
  watchers: [],
  ...extra,
})

const ws = (workspaceId: string, role: "owner" | "admin" | "write" | "read" = "owner") => ({
  workspaceId,
  name: `Name ${workspaceId}`,
  role,
})

const SCREEN = [
  "╭──────────────────────────────────────────╮",
  "│ Bash command                             │",
  "│   npm test                               │",
  "│ Do you want to proceed?                  │",
  "│ ❯ 1. Yes                                 │",
  "│   2. Yes, and don't ask again for npm    │",
  "│   3. No, and tell Claude what to do (esc)│",
  "╰──────────────────────────────────────────╯",
]

describe("selectTerminalNeeds", () => {
  it("keeps blocked sessions only (a finished turn is not a notice)", () => {
    const feeds = {
      w1: [
        s({ terminalId: "a" }),
        s({ terminalId: "b", agentState: { state: "done", at: "2026-10-21T10:06:00.000Z" } }),
        s({ terminalId: "c", agentState: { state: "working", at: "2026-10-21T10:06:00.000Z" } }),
        s({ terminalId: "d", agentState: null }),
      ],
    }
    const needs = selectTerminalNeeds(feeds, [ws("w1")])
    expect(needs.map((n) => n.session.terminalId)).toEqual(["a"])
    expect(needs[0]).toMatchObject({ workspaceId: "w1", workspaceName: "Name w1" })
  })

  it("covers every writable workspace and skips read-only ones", () => {
    const feeds = {
      w1: [s({ terminalId: "a", ownerWorkspaceId: "w1" })],
      w2: [s({ terminalId: "b", ownerWorkspaceId: "w2" })],
      w3: [s({ terminalId: "c", ownerWorkspaceId: "w3" })],
    }
    const needs = selectTerminalNeeds(feeds, [ws("w1"), ws("w2", "write"), ws("w3", "read")])
    expect(needs.map((n) => [n.workspaceId, n.session.terminalId])).toEqual([
      ["w1", "a"],
      ["w2", "b"],
    ])
  })

  it("ignores feeds of workspaces the person no longer has", () => {
    expect(selectTerminalNeeds({ gone: [s({ ownerWorkspaceId: "gone" })] }, [ws("w1")])).toEqual([])
  })

  it("lists each terminal once, in its owner workspace", () => {
    const feeds = {
      w1: [s({ terminalId: "a", ownerWorkspaceId: "w2" })],
      w2: [s({ terminalId: "a", ownerWorkspaceId: "w2" })],
    }
    const needs = selectTerminalNeeds(feeds, [ws("w1"), ws("w2")])
    expect(needs).toHaveLength(1)
    expect(needs[0].workspaceId).toBe("w2")
  })

  it("puts the longest-waiting first", () => {
    const at = (iso: string) => ({ state: "blocked" as const, at: iso })
    const feeds = {
      w1: [
        s({ terminalId: "late", agentState: at("2026-10-21T10:09:00.000Z") }),
        s({ terminalId: "early", agentState: at("2026-10-21T10:01:00.000Z") }),
      ],
      w2: [
        s({
          terminalId: "mid",
          ownerWorkspaceId: "w2",
          agentState: at("2026-10-21T10:05:00.000Z"),
        }),
      ],
    }
    const needs = selectTerminalNeeds(feeds, [ws("w1"), ws("w2")])
    expect(needs.map((n) => n.session.terminalId)).toEqual(["early", "mid", "late"])
  })
})

describe("helpers", () => {
  it("writableWorkspaceIds drops read-only workspaces", () => {
    expect(writableWorkspaceIds([ws("a"), ws("b", "read"), ws("c", "admin")])).toEqual(["a", "c"])
  })

  it("isBlocked / needKey: a new block is a new question", () => {
    expect(isBlocked(s())).toBe(true)
    expect(isBlocked(s({ agentState: null }))).toBe(false)
    const first = s()
    const again = s({ agentState: { state: "blocked", at: "2026-10-21T10:07:00.000Z" } })
    expect(needKey(first)).not.toBe(needKey(again))
    const watched: TerminalSession = { ...first, viewers: 3 }
    expect(needKey(first)).toBe(needKey(watched))
  })

  it("the store keeps one feed per workspace and drops it", () => {
    const list = [s()]
    useTerminalNeedsStore.getState().setFeed("w1", list)
    const before = useTerminalNeedsStore.getState().feeds
    useTerminalNeedsStore.getState().setFeed("w1", list)
    expect(useTerminalNeedsStore.getState().feeds).toBe(before)
    useTerminalNeedsStore.getState().dropFeed("w1")
    expect(useTerminalNeedsStore.getState().feeds).toEqual({})
  })
})

describe("screen question", () => {
  afterEach(() => resetScreenQuestions())

  it("reads an awake blocked session's screen once per block", async () => {
    const fetch = vi.fn(async () => ({ screen: { lines: SCREEN }, question: null }))
    const session = s()
    await loadScreenQuestion(session, fetch, 0)
    await loadScreenQuestion({ ...session, viewers: 2 }, fetch, 0)
    expect(fetch).toHaveBeenCalledTimes(1)
    const q = cachedScreenQuestion(session)
    expect(q?.question).toBe("Do you want to proceed?")
    expect(q?.detail).toBe("npm test")
    expect(q?.options.map((o) => o.key)).toEqual(["1", "2", "3"])

    // The next block is a new question.
    const next = s({ agentState: { state: "blocked", at: "2026-10-21T10:09:00.000Z" } })
    expect(cachedScreenQuestion(next)).toBeUndefined()
    await loadScreenQuestion(next, fetch, 0)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("looks once more when the dialog was not drawn yet", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ screen: { lines: ["$ claude", "thinking…"] } })
      .mockResolvedValueOnce({ screen: { lines: SCREEN } })
    await loadScreenQuestion(s(), fetch, 0)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(cachedScreenQuestion(s())?.options).toHaveLength(3)
  })

  it("never wakes a sleeping or frozen session, nor reads a non-blocked one", async () => {
    const fetch = vi.fn(async () => ({ screen: { lines: SCREEN } }))
    await loadScreenQuestion(s({ lifecycle: "sleeping" }), fetch, 0)
    await loadScreenQuestion(s({ lifecycle: "frozen" }), fetch, 0)
    await loadScreenQuestion(s({ agentState: { state: "working", at: "x" } }), fetch, 0)
    expect(fetch).not.toHaveBeenCalled()
    expect(canReadScreen(s({ lifecycle: "awake" }))).toBe(true)
  })

  it("falls back to the hook's message without options", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("TERMINAL_NOT_FOUND")
    })
    await loadScreenQuestion(s(), fetch, 0)
    expect(cachedScreenQuestion(s())).toBeUndefined()
    expect(fallbackQuestion(s())).toEqual({
      question: "Claude needs your permission to use Bash",
      detail: null,
      options: [],
    })
  })
})
