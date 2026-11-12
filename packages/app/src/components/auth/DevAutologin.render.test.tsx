/**
 * Dev auto-login on the sign-in screen (local development only).
 *
 *   1. Production backend (wss://be.teros.ai): the sign-in form renders on the
 *      first frame and NO probe request is made — prod behaviour unchanged.
 *   2. Local backend that advertises dev auto-login: no form; the dev frame is
 *      sent, the normal auth_success is stored and the app goes to "/".
 *   3. Local backend without it (probe 404): the form renders as usual.
 *   4. probeDevAutologin / isLocalBackendUrl edge cases.
 *
 *   cd packages/app && npx vitest run src/components/auth/DevAutologin.render.test.tsx
 */
import "../../i18n"
import { act, render } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import { isLocalBackendUrl, probeDevAutologin } from "../../lib/dev-autologin"
import { useAuthStore } from "../../store/authStore"

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(data?: unknown) => void>>()
  return {
    listeners,
    replace: vi.fn(),
    push: vi.fn(),
    client: {
      connected: true,
      isConnected: vi.fn(() => true),
      isConnectedOrConnecting: vi.fn(() => true),
      connect: vi.fn(),
      setSessionToken: vi.fn(),
      authenticateDev: vi.fn(async () => {}),
      on: (event: string, fn: (data?: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)?.add(fn)
      },
      off: (event: string, fn: (data?: unknown) => void) => listeners.get(event)?.delete(fn),
    },
    emit: (event: string, data?: unknown) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(data)
    },
  }
})

vi.mock("expo-router", () => ({
  useRouter: () => ({ replace: h.replace, push: h.push }),
}))
vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))
vi.mock("./useSocialAuth", () => ({
  useSocialAuth: () => ({ google: vi.fn(), github: vi.fn(), microsoft: vi.fn() }),
}))

import Login from "../../../app/(auth)/login/index"

const fetchMock = vi.fn()
const originalWsUrl = process.env.EXPO_PUBLIC_WS_URL

async function renderLogin() {
  let utils!: ReturnType<typeof render>
  await act(async () => {
    utils = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <Login />
      </TamaguiProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return utils
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
  h.replace.mockReset()
  h.client.authenticateDev.mockClear()
  h.client.setSessionToken.mockClear()
  h.listeners.clear()
  useAuthStore.setState({
    user: null,
    sessionToken: null,
    isAuthenticated: false,
    isHydrated: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env.EXPO_PUBLIC_WS_URL = originalWsUrl
})

describe("sign-in screen × dev auto-login", () => {
  it("production backend: the form renders immediately and nothing is probed", async () => {
    process.env.EXPO_PUBLIC_WS_URL = "wss://be.teros.ai/ws"
    const { queryByTestId } = await renderLogin()
    expect(queryByTestId("login-card")).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.client.authenticateDev).not.toHaveBeenCalled()
  })

  it("local dev backend: no form, dev frame sent, session stored, straight into the app", async () => {
    process.env.EXPO_PUBLIC_WS_URL = "ws://localhost:10501/ws"
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ devAutologin: true, user: "cli1@test.com" }),
    })

    const { queryByTestId } = await renderLogin()
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:10501/api/dev-autologin",
      expect.anything(),
    )
    expect(h.client.authenticateDev).toHaveBeenCalledTimes(1)
    expect(queryByTestId("login-card")).toBeNull()

    await act(async () => {
      h.emit("authenticated", {
        type: "auth_success",
        userId: "user_dev",
        sessionToken: "tok_dev",
        role: "super",
        user: { profile: { email: "cli1@test.com", displayName: "CLI One" }, accessGranted: true },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().user?.email).toBe("cli1@test.com")
    expect(h.client.setSessionToken).toHaveBeenCalledWith("tok_dev")
    expect(h.replace).toHaveBeenCalledWith("/")
  })

  it("local backend without dev auto-login (404): the form renders as usual", async () => {
    process.env.EXPO_PUBLIC_WS_URL = "ws://localhost:10501/ws"
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })
    const { queryByTestId } = await renderLogin()
    expect(queryByTestId("login-card")).not.toBeNull()
    expect(h.client.authenticateDev).not.toHaveBeenCalled()
  })

  it("dev auth refused by the server: falls back to the form", async () => {
    process.env.EXPO_PUBLIC_WS_URL = "ws://localhost:10501/ws"
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ devAutologin: true }) })
    const { queryByTestId } = await renderLogin()
    await act(async () => {
      h.emit("auth_error", "Unknown auth method: dev")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(queryByTestId("login-card")).not.toBeNull()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })
})

describe("probeDevAutologin / isLocalBackendUrl", () => {
  it("only localhost / LAN backends count as local", () => {
    for (const url of [
      "ws://localhost:10501/ws",
      "ws://127.0.0.1:3000/ws",
      "ws://192.168.1.5:3000/ws",
      "ws://[::1]:3000/ws",
    ]) {
      expect(isLocalBackendUrl(url)).toBe(true)
    }
    for (const url of [
      "wss://be.teros.ai/ws",
      "wss://localhost.teros.ai/ws",
      "wss://example.com/ws",
      "",
      undefined,
    ]) {
      expect(isLocalBackendUrl(url)).toBe(false)
    }
  })

  it("is false for a non-local URL without fetching, and on errors / malformed bodies", async () => {
    const f = vi.fn()
    expect(await probeDevAutologin("wss://be.teros.ai/ws", f as never)).toBe(false)
    expect(f).not.toHaveBeenCalled()

    f.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    expect(await probeDevAutologin("ws://localhost:1/ws", f as never)).toBe(false)
    f.mockResolvedValueOnce({ ok: true, json: async () => ({ devAutologin: "yes" }) })
    expect(await probeDevAutologin("ws://localhost:1/ws", f as never)).toBe(false)
    f.mockResolvedValueOnce({ ok: true, json: async () => ({ devAutologin: true }) })
    expect(await probeDevAutologin("ws://localhost:1/ws", f as never)).toBe(true)
  })
})
