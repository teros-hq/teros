import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

type Reply = (action: string) => Promise<unknown>
const client = vi.hoisted(() => {
  const state = {
    calls: [] as Array<[string, string, unknown]>,
    reply: (async () => undefined) as Reply,
  }
  return {
    state,
    send: (to: string, action: string, data: unknown) => {
      state.calls.push([to, action, data])
      return state.reply(action)
    },
  }
})
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => client,
}))

import { AgentAuthCard } from "./AgentAuthCard"

const status = {
  agent: "claude",
  mode: null,
  label: null,
  teros: { available: false },
  shared: false,
}

const unknown = (action: string) =>
  Object.assign(new Error(`Unknown action: terminal.${action}`), { code: "UNKNOWN_ACTION" })

let unhandled: unknown[]
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason)
}

function renderCard() {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <AgentAuthCard
        agent="claude"
        workspaceId="ws_1"
        appId="app_1"
        reason="first-session"
        onDone={() => {}}
        onClose={() => {}}
      />
    </TamaguiProvider>,
  )
}

const settle = () => new Promise((r) => setTimeout(r, 30))

beforeEach(() => {
  unhandled = []
  process.on("unhandledRejection", onUnhandled)
  vi.spyOn(window, "open").mockReturnValue(null)
  client.state.calls = []
})

afterEach(() => {
  process.off("unhandledRejection", onUnhandled)
  vi.restoreAllMocks()
})

describe("AgentAuthCard — sign-in against a backend that cannot serve it", () => {
  it("shows a failed state poll inline and closes without an unhandled rejection", async () => {
    client.state.reply = async (action) => {
      if (action === "agentAuthStatus") return status
      if (action === "agentAuthLoginStart") return { loginId: "login_1", phase: "starting" }
      throw unknown(action)
    }
    const view = renderCard()
    fireEvent.click(await screen.findByTestId("agent-auth-login-start"))

    const error = await screen.findByTestId("agent-auth-login-error", {}, { timeout: 3000 })
    expect(error.textContent).toBe(
      "This server's backend is older than the app and can't do this yet. Restart or redeploy the backend, then try again.",
    )
    expect(screen.getByTestId("agent-auth-login-start")).toBeTruthy()

    view.unmount()
    await settle()
    expect(unhandled).toEqual([])
  })

  it("closes while a sign-in is pending without an unhandled rejection when cancel fails", async () => {
    client.state.reply = async (action) => {
      if (action === "agentAuthStatus") return status
      if (action === "agentAuthLoginStart") return { loginId: "login_2", phase: "starting" }
      if (action === "agentAuthLoginState") return { loginId: "login_2", phase: "starting" }
      throw unknown(action)
    }
    const view = renderCard()
    fireEvent.click(await screen.findByTestId("agent-auth-login-start"))
    await screen.findByTestId("agent-auth-login-progress")

    view.unmount()
    await waitFor(() =>
      expect(client.state.calls).toContainEqual([
        "terminal",
        "agentAuthLoginCancel",
        { loginId: "login_2" },
      ]),
    )
    await settle()
    expect(unhandled).toEqual([])
  })
})
