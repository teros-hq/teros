/**
 * mca.teros.terminal helpers: key names an LLM uses, the compact screen text
 * it reads, the changed-rows view and a shell command's own output.
 */

import { describe, expect, it } from "bun:test"
import {
  agentAuthNote,
  commandOutput,
  isOwnText,
  lifecycleLabel,
  resolveKey,
  screenChanges,
  screenText,
  showSequence,
  statusLine,
  wheelNote,
  wokeNote,
} from "../src/lib"

describe("resolveKey", () => {
  it("named keys, aliases and case", () => {
    expect(resolveKey("enter")).toBe("\r")
    expect(resolveKey("Return")).toBe("\r")
    expect(resolveKey("ESC")).toBe("\x1b")
    expect(resolveKey("shift-tab")).toBe("\x1b[Z")
    expect(resolveKey("backtab")).toBe("\x1b[Z")
    expect(resolveKey("page down")).toBe("\x1b[6~")
    expect(resolveKey("f5")).toBe("\x1b[15~")
  })

  it("ctrl-<letter> in every spelling", () => {
    expect(resolveKey("ctrl-c")).toBe("\x03")
    expect(resolveKey("Ctrl+C")).toBe("\x03")
    expect(resolveKey("C-r")).toBe("\x12")
    expect(resolveKey("^D")).toBe("\x04")
    expect(resolveKey("ctrl-[")).toBe("\x1b")
  })

  it("alt-<key> is ESC + the key, case kept", () => {
    expect(resolveKey("alt-b")).toBe("\x1bb")
    expect(resolveKey("alt-B")).toBe("\x1bB")
    expect(resolveKey("alt-enter")).toBe("\x1b\r")
  })

  it("single characters pass through; unknown names are refused with the list", () => {
    expect(resolveKey("1")).toBe("1")
    expect(resolveKey("y")).toBe("y")
    expect(() => resolveKey("hyper-x")).toThrow(/Unsupported key "hyper-x".*shift-tab/)
  })

  it("showSequence renders control bytes", () => {
    expect(showSequence("\x1b[A\x03")).toBe("\\x1b[A\\x03")
  })
})

describe("screenText", () => {
  it("drops trailing blank rows (not the cursor's), collapses blank runs, trims spaces", () => {
    const lines = ["", "● FAKE_MODEL_OK: 42   ", "", "", "", "❯ ", "", "", ""]
    expect(screenText({ lines, cursor: { x: 2, y: 5, visible: true } })).toBe(
      "● FAKE_MODEL_OK: 42\n\n❯",
    )
  })
})

describe("screenChanges", () => {
  it("lists only changed rows with their numbers; null without a previous screen", () => {
    expect(screenChanges(undefined, ["a"])).toBeNull()
    expect(screenChanges(["a", "b", "c"], ["a", "B", "c", "d"])).toBe(" 1│B\n 3│d")
    expect(screenChanges(["a  "], ["a"])).toBe("")
  })
})

describe("commandOutput", () => {
  it("drops the echoed command line and the final prompt", () => {
    const log = "root@x:/workspace# echo hi && ls\nhi\nfile.txt\nroot@x:/workspace# "
    expect(commandOutput(log, "echo hi && ls")).toEqual({ text: "hi\nfile.txt", dropped: 0 })
  })

  it("keeps the last 300 lines of a long output and says how many were dropped", () => {
    const body = Array.from({ length: 310 }, (_, i) => `line ${i}`)
    const out = commandOutput(["$ seq", ...body, "$ "].join("\n"), "seq")
    expect(out.dropped).toBe(10)
    expect(out.text.split("\n")[0]).toBe("[10 earlier lines not shown]")
    expect(out.text.endsWith("line 309")).toBe(true)
  })
})

describe("statusLine", () => {
  it("names the program and the agent state, or the sign-in it needs", () => {
    expect(
      statusLine({
        terminalId: "term_1",
        command: "claude",
        agentState: { state: "blocked", message: "Claude needs your permission to use Bash" },
      }),
    ).toBe("term_1 · running claude · agent blocked (Claude needs your permission to use Bash)")
    expect(statusLine({ terminalId: "term_1", command: "claude", needsAuth: "claude" })).toBe(
      "term_1 · running claude · Claude Code needs to sign in",
    )
  })
})

describe("isOwnText", () => {
  const sent = "Review the diff.\nDo you want to proceed with the refactor?"
  it("the agent's own prompt echoed on screen is not a question", () => {
    expect(isOwnText("❯ Do you want to proceed with the refactor?", sent)).toBe(true)
  })
  it("a real question (or the hook's words) is", () => {
    expect(isOwnText("Do you want to proceed? (selected: 1. Yes)", "fix the build")).toBe(false)
    expect(
      isOwnText("Claude needs your permission — Do you want to proceed with the refactor?", sent),
    ).toBe(false)
  })
})

describe("sleep: what the tools say about frozen and sleeping sessions", () => {
  it("wokeNote: nothing for an awake session; frozen and asleep say they were woken", () => {
    expect(wokeNote(null)).toBe("")
    expect(wokeNote(undefined)).toBe("")
    expect(wokeNote("frozen")).toBe("The session was frozen (idle); it was woken first. ")
    const note = wokeNote("sleeping", {
      agent: null,
      notRestored: "npm run dev",
      message: 'Resumed after sleep. "npm run dev" was running and was not restarted.',
    })
    expect(note).toContain("The session was asleep; it was woken first")
    expect(note).toContain('"npm run dev" was running and was not restarted')
  })

  it("lifecycleLabel: frozen / asleep for N, nothing when awake", () => {
    const now = Date.parse("2026-10-20T12:00:00Z")
    expect(lifecycleLabel({ lifecycle: "awake" }, now)).toBe("")
    expect(lifecycleLabel({}, now)).toBe("")
    expect(lifecycleLabel({ lifecycle: "frozen" }, now)).toBe("frozen (idle; wakes when used)")
    expect(lifecycleLabel({ lifecycle: "sleeping", sleptAt: "2026-10-20T11:30:00Z" }, now)).toBe(
      "asleep for 30 min (wakes when used)",
    )
    expect(lifecycleLabel({ lifecycle: "sleeping", sleptAt: "2026-10-20T06:00:00Z" }, now)).toBe(
      "asleep for 6 h (wakes when used)",
    )
    expect(lifecycleLabel({ lifecycle: "sleeping", sleptAt: "2026-10-16T12:00:00Z" }, now)).toBe(
      "asleep for 4 days (wakes when used)",
    )
  })
})

describe("wheelNote", () => {
  it("a give-back note leads, with who gave it back", () => {
    expect(
      wheelNote({
        driver: { kind: "agent", id: "agent_atlas", since: 0 },
        handedBack: { by: { id: "u1", name: "Iria" }, note: "session.test fails on the cache" },
      }),
    ).toBe(
      'Iria gave you the wheel back. Their note: "session.test fails on the cache". Look at the screen to see what they did before you go on.\n',
    )
  })

  it("a person at the wheel: don't type, wait or ask", () => {
    expect(
      wheelNote({
        driver: { kind: "human", id: "u1", name: "Iria", since: Date.UTC(2026, 9, 21, 10, 47) },
      }),
    ).toBe(
      "Iria has the wheel (since 10:47 UTC): don't type into this session; wait (terminal-wait returns when they give it back) or ask them in chat.\n",
    )
  })

  it("nothing to say when an agent or nobody drives", () => {
    expect(wheelNote({ driver: { kind: "agent", since: 0 } })).toBe("")
    expect(wheelNote({})).toBe("")
  })
})

describe("agentAuthNote", () => {
  const claude = { agent: "claude", signedIn: true, mode: "subscription", shared: true } as const

  it("nothing when the backend did not say", () => {
    expect(agentAuthNote(undefined)).toBe("")
    expect(agentAuthNote(null)).toBe("")
  })

  it("shared: names how it signs in, no next step", () => {
    const note = agentAuthNote(claude)
    expect(note).toBe(
      "Claude Code signs in with the user's own Claude account (Pro/Max subscription), shared with this workspace's agents.",
    )
    expect(note).not.toContain("Next:")
  })

  it("signed in but not shared: ask to turn sharing on, never for the secret", () => {
    const note = agentAuthNote({ ...claude, shared: false })
    expect(note).toContain('"Share with this workspace\'s agents"')
    expect(note).toContain("Next:")
    expect(note).toContain("Never ask for or type the credential")
  })

  it("no sign-in: the Terminal window steps, Claude's options only for Claude Code", () => {
    const note = agentAuthNote({ agent: "claude", signedIn: false, mode: null, shared: false })
    expect(note).toContain("Sign in with Claude (Pro/Max), API key or Use Teros")
    expect(note).toContain("Never ask for or type the credential")
    const codex = agentAuthNote({ agent: "codex", signedIn: false, mode: null, shared: false })
    expect(codex).toContain("Codex")
    expect(codex).not.toContain("Sign in with Claude")
  })
})
