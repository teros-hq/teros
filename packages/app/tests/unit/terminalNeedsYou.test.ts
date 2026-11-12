import { describe, expect, it } from "vitest"
import {
  parseTerminalQuestion,
  shortOptionLabel,
} from "../../src/components/mca/renderers/terminal/needsYou"

const t = (_k: string, fallback: string) => fallback

const PERMISSION = `
● Bash(rm -rf node_modules/.cache && yarn install)
╭──────────────────────────────────────────────────────────────╮
│ Bash command                                                 │
│                                                              │
│   rm -rf node_modules/.cache && yarn install                 │
│   Clear the cache and reinstall                              │
│                                                              │
│ Do you want to proceed?                                      │
│ ❯ 1. Yes                                                     │
│   2. Yes, and don't ask again for rm commands in             │
│   /workspace/teros-api                                       │
│   3. No, and tell Claude what to do differently (esc)        │
╰──────────────────────────────────────────────────────────────╯
`

describe("parseTerminalQuestion", () => {
  it("reads Claude Code's permission dialog", () => {
    const q = parseTerminalQuestion(PERMISSION)
    expect(q.question).toBe("Do you want to proceed?")
    expect(q.detail).toBe("rm -rf node_modules/.cache && yarn install")
    expect(q.options.map((o) => o.key)).toEqual(["1", "2", "3"])
    expect(q.options[0]).toMatchObject({ label: "Yes", selected: true })
    expect(q.options[1].label).toBe(
      "Yes, and don't ask again for rm commands in /workspace/teros-api",
    )
    expect(q.options[2].selected).toBe(false)
  })

  it("reads an unboxed menu", () => {
    const q = parseTerminalQuestion(
      [
        "Make auto mode your default permission mode?",
        "",
        " ❯ 1. Yes, make it default",
        "   2. Not now",
      ].join("\n"),
    )
    expect(q.question).toBe("Make auto mode your default permission mode?")
    expect(q.options.map((o) => o.label)).toEqual(["Yes, make it default", "Not now"])
  })

  it("ignores numbered output that is not a menu from 1", () => {
    const q = parseTerminalQuestion(
      ["Steps:", "3. build", "4. test"].join("\n"),
      "Continue? (selected: Yes)",
    )
    expect(q.options).toEqual([])
    expect(q.question).toBe("Continue?")
  })

  it("survives no screen", () => {
    expect(parseTerminalQuestion(null)).toEqual({ question: null, detail: null, options: [] })
  })
})

describe("shortOptionLabel", () => {
  it("shortens Claude Code's usual options", () => {
    expect(shortOptionLabel("Yes", t)).toBe("Yes")
    expect(shortOptionLabel("Yes, and don't ask again for rm commands in /x", t)).toBe("Always")
    expect(shortOptionLabel("No, and tell Claude what to do differently (esc)", t)).toBe("No…")
    expect(shortOptionLabel("A very long option label that goes on and on", t)).toHaveLength(26)
  })
})
