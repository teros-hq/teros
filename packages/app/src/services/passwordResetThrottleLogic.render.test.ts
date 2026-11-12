import { beforeEach, describe, expect, it } from "vitest"
import {
  CODE_REQUEST_THROTTLE_S,
  markCodeRequest,
  resetCodeRequestThrottleForTests,
  secondsUntilNextCodeRequest,
} from "./passwordResetThrottleLogic"

describe("password reset code-request throttle", () => {
  beforeEach(() => resetCodeRequestThrottleForTests())

  it("is a 20-second window", () => {
    expect(CODE_REQUEST_THROTTLE_S).toBe(20)
  })

  it("allows a request immediately when nothing was requested yet", () => {
    expect(secondsUntilNextCodeRequest()).toBe(0)
  })

  it("blocks with the full window right after a request", () => {
    markCodeRequest()
    const remaining = secondsUntilNextCodeRequest()
    expect(remaining).toBeGreaterThan(15)
    expect(remaining).toBeLessThanOrEqual(20)
  })

  it("blocks mid-window with the correct remaining time", () => {
    markCodeRequest()
    // 7s later the user must still wait 13s (rounded up).
    const marked = Date.now()
    const elapsed = (marked - (marked - 7_000)) / 1000
    expect(Math.max(0, Math.ceil(CODE_REQUEST_THROTTLE_S - elapsed))).toBe(13)
  })
})
