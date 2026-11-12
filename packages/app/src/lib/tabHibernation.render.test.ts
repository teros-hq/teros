import { describe, expect, it } from "vitest"
import {
  HIBERNATE_AFTER_MS,
  type AwakeInput,
  awakeIds,
  exemptIds,
  isAwake,
  nextExpiry,
} from "./tabHibernation"

const base = (over: Partial<AwakeInput> = {}): AwakeInput => ({
  tabIds: ["a", "b", "c"],
  activeId: "a",
  lastActiveAt: {},
  exempt: new Set(),
  now: 1_000_000,
  ...over,
})

describe("tabHibernation", () => {
  it("[TABH-AC-1] a deselected tab is awake until HIBERNATE_AFTER_MS, then asleep; a never-active tab is asleep", () => {
    const t0 = 1_000_000
    const input = (now: number) => base({ lastActiveAt: { b: t0 }, now })
    expect(HIBERNATE_AFTER_MS).toBe(60_000)
    expect(isAwake("b", input(t0 + 59_999))).toBe(true)
    expect(isAwake("b", input(t0 + 60_000))).toBe(false)
    expect(isAwake("c", input(t0))).toBe(false)
    expect(nextExpiry(input(t0 + 1))).toBe(t0 + 60_000)
    expect(nextExpiry(input(t0 + 60_000))).toBeNull()
  })

  it("[TABH-AC-2] the active tab is always awake; reselecting wakes a hibernated tab", () => {
    const old = base({ activeId: "b", lastActiveAt: { b: 0 } })
    expect(isAwake("b", old)).toBe(true)
    expect(awakeIds(old)).toEqual(["b"])
    // b deselected again at now: a fresh grace period starts.
    const again = base({ activeId: "a", lastActiveAt: { b: old.now }, now: old.now + 30_000 })
    expect(isAwake("b", again)).toBe(true)
  })

  it("[TABH-AC-3] exempt tabs stay awake; voice-bound chat and browser are exempt, nothing else", () => {
    const windows = [
      { id: "voice", type: "chat", props: { channelId: "ch1" } },
      { id: "other", type: "chat", props: { channelId: "ch2" } },
      { id: "web", type: "browser", props: {} },
      { id: "term", type: "terminal", props: {} },
    ]
    const live = exemptIds(windows, { channelId: "ch1", presence: "on" })
    expect([...live].sort()).toEqual(["voice", "web"])
    expect([...exemptIds(windows, { channelId: "ch1", presence: "connecting" })].sort()).toEqual([
      "voice",
      "web",
    ])
    expect([...exemptIds(windows, { channelId: "ch1", presence: "off" })]).toEqual(["web"])

    const input = base({ tabIds: windows.map((w) => w.id), activeId: null, exempt: live })
    expect(awakeIds(input)).toEqual(["voice", "web"])
  })
})
