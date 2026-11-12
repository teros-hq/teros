import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sdk = {
  init: vi.fn(),
  captureException: vi.fn(() => "evt1"),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setTag: vi.fn(),
  addBreadcrumb: vi.fn(),
}
let loads = 0

async function freshModule() {
  vi.resetModules()
  loads = 0
  vi.doMock("@sentry/react-native", () => {
    loads++
    return sdk
  })
  vi.doMock("expo-constants", () => ({ default: { expoConfig: { version: "1.2.3" } } }))
  return import("./sentry")
}

describe("sentry (lazy SDK)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.values(sdk).forEach((f) => f.mockClear())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it("[LOADP-AC-5] without a DSN the SDK is never loaded", async () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "")
    const s = await freshModule()
    s.initSentry()
    s.captureException(new Error("x"))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(loads).toBe(0)
    expect(sdk.init).not.toHaveBeenCalled()
  })

  it("[LOADP-AC-5] with a DSN the SDK loads when idle, and calls made before it are replayed in order", async () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://k@o.ingest.sentry.io/1")
    const s = await freshModule()
    s.initSentry()
    // Before the SDK is here: nothing loaded yet, calls are queued.
    expect(loads).toBe(0)
    s.setUser({ id: "u1" })
    s.captureException(new Error("early"), { a: 1 })
    expect(sdk.captureException).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(loads).toBe(1)
    expect(sdk.init).toHaveBeenCalledTimes(1)
    expect(s.isInitialized()).toBe(true)
    expect(sdk.setUser).toHaveBeenCalledWith({ id: "u1" })
    expect(sdk.captureException).toHaveBeenCalledWith(expect.any(Error), { extra: { a: 1 } })

    // After: direct.
    s.captureMessage("later", "warning", { b: 2 }, { t: "x" })
    expect(sdk.captureMessage).toHaveBeenCalledWith("later", { level: "warning", extra: { b: 2 }, tags: { t: "x" } })
  })

  it("[LOADP-AC-5] an error thrown while the SDK loads is captured by the early listener", async () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://k@o.ingest.sentry.io/1")
    const s = await freshModule()
    s.initSentry()
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), message: "boom" }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sdk.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }))
  })
})
