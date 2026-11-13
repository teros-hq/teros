import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  commandOutput,
  CONTROL_LABELS,
  controlButtons,
  controlNote,
  controlRequestText,
  isOwnText,
  lifecycleLabel,
  needsLoginText,
  noAccessText,
  resolveKey,
  screenChanges,
  screenText,
  sessionLine,
  showSequence,
  statusLine,
  noteHandedBack,
  refusedWriteText,
  releaseControlText,
  reply,
  runTool,
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
  it("names the program and the agent state, or the login screen it shows", () => {
    expect(
      statusLine({
        terminalId: "term_1",
        command: "claude",
        agentState: { state: "blocked", message: "Claude needs your permission to use Bash" },
      }),
    ).toBe("term_1 · running claude · agent blocked (Claude needs your permission to use Bash)")
    expect(statusLine({ terminalId: "term_1", command: "claude", needsAuth: "claude" })).toBe(
      "term_1 · running claude · Claude Code shows its login screen",
    )
  })

  it("[SPACE-AC-19] says which space the session is in, so an agent looking at a screen never has to guess", () => {
    expect(statusLine({ terminalId: "term_1", command: "bash", space: "shared" })).toBe(
      "term_1 · shared terminal (the workspace's machine) · running bash",
    )
    expect(statusLine({ terminalId: "term_1", command: "bash", space: "personal" })).toBe(
      "term_1 · a person's personal terminal · running bash",
    )
    expect(statusLine({ terminalId: "term_1", command: "bash" })).toBe("term_1 · running bash")
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

  it("wokeNote says 'same directory' only when the old directory came back (006)", () => {
    const back = wokeNote("sleeping", {
      agent: null,
      notRestored: null,
      message: "Resumed.",
      cwd: "/workspace/zc/deep",
      sameDir: true,
    })
    expect(back).toContain("in the same directory (/workspace/zc/deep)")
    const moved = wokeNote("sleeping", {
      agent: null,
      notRestored: null,
      message: "Resumed.",
      cwd: "/workspace",
      sameDir: false,
    })
    expect(moved).not.toContain("same directory")
    expect(moved).toContain("back in /workspace: its old directory was not kept")
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

describe("controlNote", () => {
  it("[TW-AC-24] a note the person left when switching Agent on leads, with who left it", () => {
    expect(
      controlNote({
        driver: { kind: "agent", id: "agent_atlas", since: 0 },
        handedBack: { by: { id: "u1", name: "Iria" }, note: "session.test fails on the cache" },
      }),
    ).toBe(
      'Iria switched "Agent" on again: you may type. Their note: "session.test fails on the cache". Look at the screen to see what they did before you go on.\n',
    )
    expect(controlNote({ handedBack: { by: { id: "u1", name: "Iria" }, note: null } })).toBe(
      'Iria switched "Agent" on again: you may type. Look at the screen to see what they did before you go on.\n',
    )
  })

  it("[TW-AC-11] a person typing: don't type, wait or ask for control", () => {
    expect(
      controlNote({
        driver: { kind: "human", id: "u1", name: "Iria", since: Date.UTC(2026, 9, 21, 10, 47) },
      }),
    ).toBe(
      'Iria is typing in this session (since 10:47 UTC): your keys are refused until they have typed nothing for 60 s. Ask for control with terminal-request-control (they get "Allow" / "Keep off"), or wait: terminal-wait returns when control changes.\n',
    )
  })

  it("[TW-AC-24] the labels are the ones the Terminal window shows (en-US), so agents never send people to buttons that don't exist", () => {
    expect(CONTROL_LABELS).toEqual({
      on: "Agent",
      off: "Agent off",
      allow: "Allow",
      keepOff: "Keep off",
    })
    expect(controlButtons()).toBe('"Allow" / "Keep off"')
  })

  it("any tool whose backend call carried the person's note starts its answer with it, once", async () => {
    const handedBack = { by: { id: "u1", name: "Iria" }, note: "use pytest" }
    const ran = await runTool("agent_a", async () => {
      noteHandedBack({ handedBack })
      return reply("The command finished.", { exitCode: 0 })
    })
    expect(ran.content[0].text).toBe(
      'Iria switched "Agent" on again: you may type. Their note: "use pytest". Look at the screen to see what they did before you go on.\nThe command finished.',
    )
    expect(ran.structuredContent).toMatchObject({ handedBack })
    const shown = await runTool("agent_a", async () => {
      noteHandedBack({ handedBack })
      return reply(`${controlNote({ handedBack })}Screen below.`, {})
    })
    expect(shown.content[0].text.match(/switched "Agent" on again/g)).toHaveLength(1)
    const quiet = await runTool("agent_a", async () => reply("Listed.", {}))
    expect(quiet.content[0].text).toBe("Listed.")
  })

  it("a refused write keeps the backend's one next step and adds no stale advice", () => {
    const text = refusedWriteText(
      'Iria is typing in this session. Ask for control with terminal-request-control (they get "Allow" / "Keep off"), or wait: terminal-wait returns when control changes. (Rex\'s keys were not sent.)',
    )
    expect(text).toEndWith("Nothing was typed.")
    expect(text.match(/terminal-request-control/g)).toHaveLength(1)
    expect(text).not.toContain("ask them in chat")
  })

  it("nothing to say when an agent or nobody is typing", () => {
    expect(controlNote({ driver: { kind: "agent", since: 0 } })).toBe("")
    expect(controlNote({})).toBe("")
  })
})

describe("noAccessText", () => {
  it("[TW-AC-10] a session the agent cannot reach: the person switches \"Agent\" on in that session's window", () => {
    const text = noAccessText("term_9")
    expect(text).toContain("term_9")
    expect(text).toContain('"Agent off"')
    expect(text).toContain('switch it to "Agent"')
    expect(text).toContain("that session's Terminal window")
    expect(text).toContain("personal terminal or a shared one")
    expect(text).not.toContain("terminal-request-control")
  })
})

describe("needsLoginText", () => {
  it("[TW-AC-23] Claude Code on its login screen: stop, name the API-key provider and the person's own Terminal", () => {
    const text = needsLoginText("claude", "term_1")
    expect(text).toStartWith("Claude Code shows its login screen")
    expect(text).toContain("Stop here")
    expect(text).toContain("API key of the workspace owner's Anthropic provider")
    expect(text).toContain("Providers")
    expect(text).toContain("their own Terminal and sign in there by themselves")
    expect(text).toContain("Teros never asks for, stores or shares that sign-in")
    expect(text).not.toMatch(/card|share their|\/login/)
  })

  it("another coding agent: stop and tell the user, no Anthropic provider advice", () => {
    const text = needsLoginText("codex", "term_1")
    expect(text).toStartWith("Codex shows its login screen")
    expect(text).toContain("Stop here")
    expect(text).not.toContain("Anthropic")
  })
})

describe("sessionLine", () => {
  const base = {
    terminalId: "term_1",
    title: "Fix login",
    command: "claude",
    agentState: { state: "working" },
  }

  it("[TW-AC-16] an agent's session: opened by an agent, visible to the workspace's members", () => {
    expect(sessionLine({ ...base, openedBy: "agent", agentControl: true })).toBe(
      '- term_1  "Fix login" · claude · agent working · shared terminal (the workspace\'s machine; its members see it), opened by an agent · "Agent" on',
    )
  })

  it("[TW-AC-12] an agent's session a person switched off says so, with who is typing", () => {
    const line = sessionLine({
      ...base,
      openedBy: "agent",
      agentControl: false,
      driver: { kind: "human", id: "u1", name: "Iria", since: 0 },
    })
    expect(line).toContain('"Agent off"')
    expect(line).toContain("Iria is typing")
  })

  it("[SPACE-AC-19] a person's session says which space it is in: their personal terminal, or a shared one", () => {
    const mine = sessionLine({ ...base, openedBy: "person", agentControl: true, space: "personal" })
    expect(mine).toContain("personal terminal of a person (their own machine and logins)")
    expect(mine).not.toContain("may watch")
    const watched = sessionLine({ ...base, openedBy: "person", agentControl: true, space: "personal", watchable: true })
    expect(watched).toContain("personal terminal of a person (their own machine and logins; the workspace may watch it)")
    const shared = sessionLine({ ...base, openedBy: "person", agentControl: true, space: "shared" })
    expect(shared).toContain("shared terminal (the workspace's machine; its members see it), opened by a person")
  })

  it("falls back on createdBy when the backend sends no openedBy, and shows the login screen and sleep", () => {
    const line = sessionLine(
      {
        terminalId: "term_2",
        createdBy: "agent:atlas",
        needsAuth: "claude",
        lifecycle: "frozen",
        watchers: [{ id: "u1", kind: "human", name: "Iria" }],
      },
      Date.parse("2026-10-20T12:00:00Z"),
    )
    expect(line).toContain("opened by an agent")
    expect(line).toContain("Claude Code shows its login screen")
    expect(line).toContain("watched by Iria")
    expect(line).toContain("frozen (idle; wakes when used)")
  })
})

describe("what the MCA publishes agrees with itself", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8")
  it("the health check's VERSION is the manifest's version", () => {
    const manifest = JSON.parse(read("manifest.json"))
    expect(read("src/index.ts")).toContain(`const VERSION = "${manifest.version}"`)
    expect(manifest.changelog[0].version).toBe(manifest.version)
  })
  it("i18n/en.json carries tools.json's descriptions and the manifest's changelog, word for word", () => {
    const en = JSON.parse(read("i18n/en.json"))
    const { tools } = JSON.parse(read("tools.json"))
    const manifest = JSON.parse(read("manifest.json"))
    for (const tool of tools) expect(en.tools[tool.name]?.description).toBe(tool.description)
    expect(Object.keys(en.tools).sort()).toEqual(tools.map((t: { name: string }) => t.name).sort())
    expect(en.description).toBe(manifest.description)
    expect(en.changelog.map((c: { notes: string }) => c.notes)).toEqual(
      manifest.changelog.map((c: { notes: string }) => c.notes),
    )
  })
  it("i18n/es.json translates every tool and every changelog entry", () => {
    const es = JSON.parse(read("i18n/es.json"))
    const { tools } = JSON.parse(read("tools.json"))
    const manifest = JSON.parse(read("manifest.json"))
    for (const tool of tools) expect(es.tools[tool.name]?.description?.length ?? 0).toBeGreaterThan(0)
    expect(Object.keys(es.tools).sort()).toEqual(tools.map((t: { name: string }) => t.name).sort())
    expect(es.changelog).toHaveLength(manifest.changelog.length)
  })
  it("[TW-AC-22] nothing the MCA publishes handles a Claude sign-in or names the tools and labels that are gone", () => {
    const gone =
      /request-sign-in|agentAuth|take the wheel|give back to|give it to|keep it"|request-wheel|release-wheel|tomar el volante|share (my|their|the user's) (claude )?sign-in/i
    for (const file of [
      "tools.json",
      "manifest.json",
      "i18n/en.json",
      "i18n/es.json",
      "README.md",
      "src/index.ts",
      "src/lib.ts",
    ])
      expect(read(file).match(gone), file).toBeNull()
  })
  it("[TW-AC-24] the tools are the ones of the one-window-one-session model", async () => {
    const { tools } = await import("../tools.json")
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      "-health-check",
      "terminal-create",
      "terminal-prompt",
      "terminal-wait",
      "terminal-run",
      "terminal-screen",
      "terminal-read",
      "terminal-write",
      "terminal-send-key",
      "terminal-wait-for",
      "terminal-list",
      "terminal-request-control",
      "terminal-release-control",
      "terminal-show",
      "terminal-destroy",
    ])
  })
  it("[TW-AC-24] the texts of the tools name the labels the window shows", async () => {
    const { tools } = await import("../tools.json")
    const of = (name: string) =>
      tools.find((t: { name: string }) => t.name === name)?.description ?? ""
    expect(of("terminal-request-control")).toContain('"Allow" / "Keep off"')
    expect(of("terminal-release-control")).toContain('"Agent off"')
    expect(of("terminal-list")).toContain('"Agent off"')
    expect(of("terminal-list")).toContain("their personal terminal or a shared one")
    expect(of("terminal-create")).toContain("API key of the workspace owner's Anthropic provider")
    expect(of("terminal-create")).toContain("the workspace's members can see it")
    expect(of("terminal-destroy")).toContain('"End session"')
  })
})

describe("controlRequestText", () => {
  it("every outcome has its own text, told apart by one phrase", () => {
    const phrases = {
      granted: /You have control of \S+: nobody was typing in it/,
      approved: /allowed it: you have control of/,
      denied: /kept it off\. Don't type into/,
      pending: /nobody has answered yet/,
      busy: /already asked for control of/,
      ended: /ended before anyone answered/,
    } as const
    const outcomes = Object.keys(phrases) as Array<keyof typeof phrases>
    for (const outcome of outcomes) {
      const text = controlRequestText(outcome, "term_abc_123", { by: "Iria" })
      expect(outcomes.filter((o) => phrases[o].test(text))).toEqual([outcome])
    }
  })

  it("granted / approved: you may type, go on", () => {
    expect(controlRequestText("granted", "t1")).toContain("You have control of t1")
    expect(controlRequestText("approved", "t1", { by: "Iria" })).toStartWith("Iria allowed it")
  })

  it("denied: don't type; say what you need in chat or open your own session", () => {
    const text = controlRequestText("denied", "t1", { by: "Iria" })
    expect(text).toContain("Don't type into t1")
    expect(text).toContain("terminal-create")
  })

  it("pending: the request is on their screen with the buttons they really see; call again", () => {
    const text = controlRequestText("pending", "t1")
    expect(text).toContain('"Allow" / "Keep off"')
    expect(text).not.toContain("Approve")
    expect(text).toContain("terminal-request-control again")
  })

  it("busy: another agent asked first; nothing was sent, wait or say in chat what you need", () => {
    const text = controlRequestText("busy", "t1", { by: "Atlas" })
    expect(text).toContain("Atlas already asked for control of t1")
    expect(text).toContain("Your request was not sent")
    expect(text).not.toContain("you have control")
  })

  it("released: say how the person types and switches Agent back on, and don't type again", () => {
    const text = releaseControlText({ released: true, terminalId: "t1" })
    expect(text).toContain("You let go of t1")
    expect(text).toContain('"Agent off"')
    expect(text).toContain('back to "Agent"')
    expect(text).toContain("terminal-request-control")
  })

  it("not released: who is typing, nothing changed", () => {
    const text = releaseControlText({
      released: false,
      terminalId: "t1",
      driver: { kind: "human", id: "u1", name: "Iria", since: 0 },
    })
    expect(text).toContain("You weren't the one typing in t1")
    expect(text).toContain("Iria has control")
    expect(
      releaseControlText({
        released: false,
        terminalId: "t1",
        driver: { kind: "agent", id: "agent_rex", name: "", since: 0 },
      }),
    ).toContain("Another agent has control")
    expect(
      releaseControlText({ released: false, terminalId: "t1", driver: { kind: "none", since: 0 } }),
    ).toContain("nobody has control")
  })

  it.each(["terminal-request-control", "terminal-release-control"])(
    "%s is a safe write, not read-only: it never types, so it runs without an approval",
    async (name) => {
      const { tools } = await import("../tools.json")
      const tool = tools.find((t: { name: string }) => t.name === name)
      expect(tool?.annotations?.readOnlyHint).not.toBe(true)
      expect(tool?.annotations?.safeWriteHint).toBe(true)
    },
  )
})

describe("what agents are told about the two spaces", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8")
  it("[SPACE-AC-19] terminal-create says the session an agent opens is a shared terminal, never a personal one", () => {
    const { tools } = JSON.parse(read("tools.json"))
    const create = tools.find((t: { name: string }) => t.name === "terminal-create").description
    expect(create).toContain("It is a shared terminal")
    expect(create).toContain("never in a person's personal terminal")
  })
  it("[SPACE-AC-19] terminal-list says each line carries the space, and that both kinds are closed while Agent is off", () => {
    const { tools } = JSON.parse(read("tools.json"))
    const list = tools.find((t: { name: string }) => t.name === "terminal-list").description
    expect(list).toContain("which space it is in")
    expect(list).toContain("their personal terminal or a shared one")
    expect(list).not.toContain("private to them")
  })
})
