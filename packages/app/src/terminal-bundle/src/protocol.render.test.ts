import { describe, expect, it } from "vitest"
import { terminalHtml } from "../../windows/TerminalWindow/terminalBundle"
import { DEFAULT_LABELS, isAsleep, isViewOnly, paneStateForError } from "./protocol"

describe("paneStateForError", () => {
  it.each(["FORBIDDEN_TERMINAL", "FORBIDDEN_WORKSPACE", "FORBIDDEN_WORKSPACE_ROLE", "FORBIDDEN"])(
    "%s is no access",
    (code) => {
      expect(paneStateForError(code)).toBe("denied")
    },
  )

  it.each(["TERMINAL_WAKE_FAILED", "TERMINAL_HOST_UNAVAILABLE", "INTERNAL", ""])(
    "%s is a failure to retry, never 'no access'",
    (code) => {
      expect(paneStateForError(code)).toBe("failed")
    },
  )

  it("the built page styles the failed state like the other end states", () => {
    expect(terminalHtml).toContain("#state.failed span::before")
  })

  it("the failure text says what happened, doesn't talk about access, and claims no cause it can't know", () => {
    expect(DEFAULT_LABELS.failed).toContain("couldn't wake up")
    expect(DEFAULT_LABELS.failed).not.toMatch(/access/i)
    expect(DEFAULT_LABELS.failed).not.toMatch(/machine/i)
  })
})

describe("watching someone's personal terminal", () => {
  it("[SPACE-AC-18] the refusal of a watcher's keys is not an error state: the session stays on screen", () => {
    expect(isViewOnly("TERMINAL_VIEW_ONLY")).toBe(true)
    expect(isViewOnly("WHEEL_HELD")).toBe(false)
    expect(isViewOnly("FORBIDDEN_TERMINAL")).toBe(false)
  })

  it("[SPACE-AC-18] the page says it is view only, in its own words and in the built page", () => {
    expect(DEFAULT_LABELS.watchOnly).toMatch(/view only/i)
    expect(terminalHtml).toContain("TERMINAL_VIEW_ONLY")
    expect(terminalHtml).toContain(DEFAULT_LABELS.watchOnly.split(" — ")[0])
  })
})

describe("a sleeping terminal someone only watches", () => {
  it("[SPACE-AC-15] the page says it is asleep and that only its person wakes it, instead of a failure", () => {
    expect(isAsleep("TERMINAL_ASLEEP")).toBe(true)
    expect(isAsleep("TERMINAL_WAKE_FAILED")).toBe(false)
    expect(DEFAULT_LABELS.asleep).toMatch(/asleep/i)
    expect(DEFAULT_LABELS.asleep).toMatch(/only its person/i)
    expect(terminalHtml).toContain("TERMINAL_ASLEEP")
  })
})
