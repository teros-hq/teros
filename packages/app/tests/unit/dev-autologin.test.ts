/**
 * Auto-login, client side: signing out switches it off until the page is
 * loaded anew (spec ALOGIN).
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  _resetAutologinSuppressionForTests,
  isAutologinSuppressed,
  isLocalBackendUrl,
  suppressAutologinAfterSignOut,
} from "../../src/lib/dev-autologin"

describe("auto-login after sign-out", () => {
  afterEach(() => _resetAutologinSuppressionForTests())

  it("[ALOGIN-AC-7] once sign-out is recorded the backend is no longer one to auto-login against", () => {
    const candidate = () => isLocalBackendUrl("ws://localhost:10001/ws") && !isAutologinSuppressed()
    expect(candidate()).toBe(true)
    suppressAutologinAfterSignOut()
    expect(candidate()).toBe(false)
  })
})
