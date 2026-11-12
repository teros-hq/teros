/**
 * PERMB-REQ-4 — one chime per batch: N permission requests arriving within
 * the chime window play the sound once.
 */
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PERMISSION_CHIME_WINDOW_MS, usePermissionSound } from "./usePermissionSound"

vi.mock("react-native", () => ({ Platform: { OS: "web" } }))

class FakeNode {
  connect() {}
  start() {}
  stop() {}
  type = "sine"
  frequency = { setValueAtTime() {} }
  gain = {
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  }
}

describe("usePermissionSound — one chime per batch", () => {
  let created = 0
  beforeEach(() => {
    created = 0
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"))
    ;(globalThis as any).AudioContext = class {
      state = "running"
      currentTime = 0
      destination = {}
      resume() {}
      createOscillator() {
        created += 1
        return new FakeNode()
      }
      createGain() {
        return new FakeNode()
      }
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as any).AudioContext
  })

  it("[PERMB-AC-4] three requests inside the window play the chime once", () => {
    const { result } = renderHook(() => usePermissionSound())
    act(() => {
      result.current.playPermissionSound()
      result.current.playPermissionSound()
      result.current.playPermissionSound()
    })
    // One chime = three oscillators (RE, MI, DO).
    expect(created).toBe(3)
  })

  it("[PERMB-AC-4] a request after the window plays again", () => {
    const { result } = renderHook(() => usePermissionSound())
    act(() => {
      result.current.playPermissionSound()
    })
    vi.setSystemTime(Date.now() + PERMISSION_CHIME_WINDOW_MS + 1)
    act(() => {
      result.current.playPermissionSound()
    })
    expect(created).toBe(6)
  })
})
