/**
 * WEBCFG — resolution order of the backend URLs on web and native.
 * Runs under jsdom (render harness) so `window` exists; native is simulated
 * by stubbing `window` away.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { backendUrl, wsUrl } from "./runtime"

const BUILD_BACKEND = "http://build.example:10001"
const BUILD_WS = "ws://build.example:10001/ws"

function withWindow(
  location: { protocol: string; host: string } | undefined,
  config?: Window["__TEROS_CONFIG__"],
) {
  vi.stubGlobal("window", location ? { location, __TEROS_CONFIG__: config } : undefined)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("WEBCFG runtime config", () => {
  it("[WEBCFG-AC-1] injected config wins over the build-time variables", () => {
    vi.stubEnv("EXPO_PUBLIC_BACKEND_URL", BUILD_BACKEND)
    vi.stubEnv("EXPO_PUBLIC_WS_URL", BUILD_WS)
    withWindow(
      { protocol: "https:", host: "app.example" },
      { backendUrl: "https://b.example", wsUrl: "wss://b.example/ws" },
    )
    expect(backendUrl()).toBe("https://b.example")
    expect(wsUrl()).toBe("wss://b.example/ws")
  })

  it("[WEBCFG-AC-2] empty injected values fall through to the build-time variables", () => {
    vi.stubEnv("EXPO_PUBLIC_BACKEND_URL", BUILD_BACKEND)
    vi.stubEnv("EXPO_PUBLIC_WS_URL", BUILD_WS)
    withWindow({ protocol: "https:", host: "app.example" }, { backendUrl: "", wsUrl: "" })
    expect(backendUrl()).toBe(BUILD_BACKEND)
    expect(wsUrl()).toBe(BUILD_WS)
  })

  it("[WEBCFG-AC-3] with nothing configured the web derives same-origin URLs", () => {
    vi.stubEnv("EXPO_PUBLIC_BACKEND_URL", "")
    vi.stubEnv("EXPO_PUBLIC_WS_URL", "")
    withWindow({ protocol: "https:", host: "app.example" })
    expect(backendUrl()).toBe("")
    expect(wsUrl()).toBe("wss://app.example/ws")
    withWindow({ protocol: "http:", host: "localhost:10002" })
    expect(wsUrl()).toBe("ws://localhost:10002/ws")
  })

  it("[WEBCFG-AC-4] off web with nothing configured there is no WebSocket URL", () => {
    vi.stubEnv("EXPO_PUBLIC_BACKEND_URL", "")
    vi.stubEnv("EXPO_PUBLIC_WS_URL", "")
    withWindow(undefined)
    expect(backendUrl()).toBe("")
    expect(wsUrl()).toBeUndefined()
  })

  it("[WEBCFG-AC-5] values are resolved on every call", () => {
    vi.stubEnv("EXPO_PUBLIC_BACKEND_URL", "")
    vi.stubEnv("EXPO_PUBLIC_WS_URL", "")
    const win: {
      location: { protocol: string; host: string }
      __TEROS_CONFIG__?: Window["__TEROS_CONFIG__"]
    } = {
      location: { protocol: "http:", host: "localhost:10002" },
    }
    vi.stubGlobal("window", win)
    expect(backendUrl()).toBe("")
    win.__TEROS_CONFIG__ = {
      backendUrl: "http://localhost:10001",
      wsUrl: "ws://localhost:10001/ws",
    }
    expect(backendUrl()).toBe("http://localhost:10001")
    expect(wsUrl()).toBe("ws://localhost:10001/ws")
  })
})
