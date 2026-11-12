import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const voice = { channelId: null as string | null, presence: "off" as string }
vi.mock("../../contexts/VoiceSessionContext", () => ({ useVoiceSession: () => voice }))

import { HIBERNATE_AFTER_MS } from "../../lib/tabHibernation"
import { useAwakeTabs } from "./useAwakeTabs"

const windows = [
  { id: "chat1", type: "chat", props: { channelId: "ch1" } },
  { id: "chat2", type: "chat", props: { channelId: "ch2" } },
  { id: "web", type: "browser", props: {} },
]

describe("useAwakeTabs", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    voice.channelId = null
    voice.presence = "off"
  })
  afterEach(() => vi.useRealTimers())

  it("[TABH-AC-4] mounts only awake tabs: active + exempt after the grace period, never-active tabs from the start", () => {
    const { result, rerender } = renderHook(({ active }) => useAwakeTabs(windows, active), {
      initialProps: { active: "chat1" },
    })
    // Restored layout: only the active tab and the exempt browser are mounted.
    expect(windows.map((w) => result.current(w.id))).toEqual([true, false, true])

    // Switching keeps the previous tab mounted during the grace period…
    rerender({ active: "chat2" })
    expect(windows.map((w) => result.current(w.id))).toEqual([true, true, true])

    // …and unmounts it once the period has passed (the pane re-renders by itself).
    act(() => {
      vi.advanceTimersByTime(HIBERNATE_AFTER_MS + 5)
    })
    expect(windows.map((w) => result.current(w.id))).toEqual([false, true, true])
  })

  it("[TABH-AC-3] a chat bound to a live voice session never hibernates", () => {
    voice.channelId = "ch1"
    voice.presence = "on"
    const { result, rerender } = renderHook(({ active }) => useAwakeTabs(windows, active), {
      initialProps: { active: "chat1" },
    })
    rerender({ active: "chat2" })
    act(() => {
      vi.advanceTimersByTime(HIBERNATE_AFTER_MS * 2)
    })
    expect(result.current("chat1")).toBe(true)
  })
})
