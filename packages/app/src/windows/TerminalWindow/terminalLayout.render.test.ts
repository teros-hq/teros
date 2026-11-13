import { describe, expect, it } from "vitest"
import {
  dedupeSessions,
  defaultTitle,
  isTouchPress,
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

describe("defaultTitle — a new session never repeats a title (009)", () => {
  const titled = (...titles: string[]) => titles.map((title, i) => s(`t${i}`, { title }))

  it("takes the number after the highest, not the count (Shell 3 was closed)", () => {
    expect(defaultTitle("shell", titled("Shell 1", "Shell 2", "Shell 4"))).toBe("Shell 5")
    expect(defaultTitle("shell", [])).toBe("Shell 1")
  })

  it("numbers Claude Code sessions after the first", () => {
    expect(defaultTitle("claude", [])).toBe("Claude Code")
    expect(defaultTitle("claude", titled("Claude Code"))).toBe("Claude Code 2")
    expect(defaultTitle("claude", titled("Claude Code", "Claude Code 2", "Shell 1"))).toBe(
      "Claude Code 3",
    )
  })
})

describe("isTouchPress — the extra-keys bar sends its key on a touch, not only on a click (020)", () => {
  it.each([
    ["a touch pointer", { pointerType: "touch" }],
    ["a pen", { pointerType: "pen" }],
    ["a touch event", { type: "touchstart", touches: [{}] }],
  ])("%s is a touch", (_label, ev) => {
    expect(isTouchPress(ev)).toBe(true)
  })

  it.each([
    ["a mouse pointer", { pointerType: "mouse" }],
    ["a mouse event", { type: "mousedown" }],
    ["nothing", undefined],
  ])("%s is not", (_label, ev) => {
    expect(isTouchPress(ev)).toBe(false)
  })
})
