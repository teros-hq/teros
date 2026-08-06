/**
 * useAutoRefresh (P1/N1/N2): the tick must advance on the interval AND on
 * manual bump, and the interval must be cleaned up on unmount — a leaked
 * timer would keep refetching admin queries after the window closes.
 */

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAutoRefresh } from "./useAutoRefresh"

describe("useAutoRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("advances the tick every interval", () => {
    const { result } = renderHook(() => useAutoRefresh(1_000))
    expect(result.current.tick).toBe(0)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(result.current.tick).toBe(1)
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(result.current.tick).toBe(3)
  })

  it("bump() advances the same clock (manual refresh reloads everything)", () => {
    const { result } = renderHook(() => useAutoRefresh(60_000))
    act(() => {
      result.current.bump()
    })
    expect(result.current.tick).toBe(1)
  })

  it("clears the interval on unmount (no refetch after the window closes)", () => {
    const { unmount } = renderHook(() => useAutoRefresh(1_000))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    // The timer must be GONE — a leaked interval would keep firing admin
    // queries after the window closes (asserting tick would not catch it:
    // setState on an unmounted hook is invisible to result.current).
    expect(vi.getTimerCount()).toBe(0)
  })
})
