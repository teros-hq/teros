import { render, screen } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../../../tamagui.config"
import type { TerminalSession } from "../../../../windows/TerminalWindow/terminalSessions"

const world = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  sessions: [] as unknown[],
  role: "owner" as string,
  me: "u_me",
}))

vi.mock("../../../../services/terosClientSingleton", () => ({
  getTerosClient: () => ({
    send: async (to: string, action: string, data: unknown) => {
      world.calls.push([to, action, data])
      return { ok: true }
    },
  }),
}))
vi.mock("../../../../windows/TerminalWindow/terminalSessions", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  useTerminalSessions: () => ({ sessions: world.sessions, loaded: true, error: null }),
  showTerminalSession: () => {},
}))
vi.mock("expo-router", () => ({ router: { replace: () => {} } }))
vi.mock("../../../../store/workspaceStore", () => {
  const state = () => ({ activeWorkspaceId: "w1" })
  const useWorkspaceStore = Object.assign((sel: (s: unknown) => unknown) => sel(state()), {
    getState: state,
    subscribe: () => () => {},
  })
  return { useWorkspaceStore }
})
vi.mock("../../../../store/tilingStore", () => ({
  useTilingStore: {
    getState: () => ({ layoutRestoredForWorkspace: "w1", restoreGeneration: 0 }),
    subscribe: () => () => {},
  },
}))
vi.mock("../../../../store/navbarStore", () => ({
  useNavbarStore: (sel: (s: unknown) => unknown) =>
    sel({ workspaces: [{ workspaceId: "w1", role: world.role }] }),
}))
vi.mock("../../../../store/authStore", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { userId: world.me } }),
}))
vi.mock("../../DefaultToolCallRenderer", () => ({ DefaultToolCallRenderer: () => null }))

import { ToolCallAuthorContext } from "../../types"
import { TerminalToolCallRenderer } from "./TerminalRenderer"

const request = { agent: { id: "agent_atlas", name: "Atlas" }, reason: "run the tests", at: 20 }
const session = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId: "t1",
  title: "Shell 1",
  kind: "shell",
  command: "bash",
  pinned: true,
  persistent: true,
  createdBy: "u_me",
  createdAt: "2026-11-10T10:00:00.000Z",
  lastActivity: "2026-11-10T10:00:00.000Z",
  cols: 80,
  rows: 24,
  agentState: null,
  viewers: 0,
  watchers: [],
  driver: { kind: "human", id: "u_me", name: "Me", since: 0 },
  agentControl: false,
  wheelRequest: request,
  ...extra,
})

function renderCall(props: Record<string, unknown> = {}) {
  const all = {
    toolCallId: "c1",
    toolName: "mca_teros_terminal_terminal-request-control",
    status: "running",
    input: { terminalId: "t1" },
    ...props,
  } as unknown as Parameters<typeof TerminalToolCallRenderer>[0]
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <ToolCallAuthorContext.Provider value={{ name: "Atlas Prime", agentId: "agent_atlas", at: 10 }}>
        <TerminalToolCallRenderer {...all} />
      </ToolCallAuthorContext.Provider>
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  world.calls = []
  world.sessions = [session()]
  world.role = "owner"
  world.me = "u_me"
})

describe("a terminal-request-control call in the chat [TW-AC-13]", () => {
  it("the person typing in the session gets Allow and Keep off", () => {
    renderCall()
    const card = screen.getByTestId("control-request")
    expect(card.textContent).toContain("Atlas asks to use Shell 1 · opened by you")
    expect(screen.queryByTestId("control-request-allow")).not.toBeNull()
    expect(screen.queryByTestId("control-request-deny")).not.toBeNull()
  })

  it("nobody types: the person who opened the session gets the buttons", () => {
    world.sessions = [session({ driver: { kind: "none", since: 0 } })]
    renderCall()
    expect(screen.queryByTestId("control-request-allow")).not.toBeNull()
  })

  it("nobody types in a session an agent opened: any member who sees it gets the buttons", () => {
    world.sessions = [session({ driver: { kind: "none", since: 0 }, createdBy: "agent:app_t" })]
    renderCall()
    expect(screen.queryByTestId("control-request-allow")).not.toBeNull()
    expect(screen.getByTestId("control-request-opener").textContent).toBe(" · opened by an agent")
  })

  it("someone else types there: no buttons, even for the person who opened it", () => {
    world.sessions = [
      session({
        space: "shared",
        driver: { kind: "human", id: "u_iria", name: "Iria Souto", since: Date.now() },
      }),
    ]
    renderCall()
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(screen.getByTestId("control-request").textContent).toContain(
      "Iria is typing there: only they can answer.",
    )
  })

  it("nobody types in a session another member opened: no buttons", () => {
    world.sessions = [session({ driver: { kind: "none", since: 0 }, createdBy: "u_iria" })]
    renderCall()
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(screen.getByTestId("control-request-opener").textContent).toBe(
      " · opened by another member",
    )
  })

  it("a read member never gets the buttons", () => {
    world.role = "read"
    renderCall()
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(screen.getByTestId("control-request").textContent).toContain("Someone with write access")
  })

  it("a request of another agent does not show under this agent's call", () => {
    world.sessions = [session({ wheelRequest: { agent: { id: "agent_rook" }, reason: null, at: 20 } })]
    renderCall()
    expect(screen.queryByTestId("control-request")).toBeNull()
  })

  it("after a reload with the request gone, the card says how it ended and has no buttons", () => {
    world.sessions = [session({ wheelRequest: null })]
    renderCall({ status: "completed", structuredContent: { outcome: "denied" } })
    expect(screen.getByTestId("control-request").textContent).toContain("You kept Agent off.")
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
  })

  it("a session the person cannot see shows no card", () => {
    world.sessions = []
    renderCall()
    expect(screen.queryByTestId("control-request")).toBeNull()
  })

  it("the tool's old name gets no card", () => {
    renderCall({ toolName: `mca_teros_terminal_terminal-request-${"wheel"}` })
    expect(screen.queryByTestId("control-request")).toBeNull()
  })
})

describe("Teros handles nobody's Claude login [TW-AC-22]", () => {
  const LOGIN_TOOL = ["terminal", "request", "sign", "in"].join("-")
  it("no tool name, the removed login tool included, draws a login card or asks the backend about one", () => {
    for (const toolName of [
      LOGIN_TOOL,
      `mca_teros_terminal_${LOGIN_TOOL}`,
      "terminal-request-control",
      "terminal-create",
      "terminal-wait",
    ]) {
      const { container, unmount } = renderCall({ toolName, status: "completed" })
      expect(container.querySelector('[data-testid^="sign"]')).toBeNull()
      expect(container.textContent).not.toMatch(/sign.?in|\/login/i)
      unmount()
    }
    expect(world.calls).toEqual([])
  })
})

describe("a blocked terminal call in the chat", () => {
  it("draws the needs-you card for the session it names", () => {
    world.sessions = [
      session({ wheelRequest: null, agentState: { state: "blocked", at: "2026-11-10T10:05:00.000Z" } }),
    ]
    renderCall({
      toolName: "terminal-wait",
      status: "completed",
      structuredContent: {
        reason: "blocked",
        terminalId: "t1",
        screen: "Do you want to proceed?\n❯ 1. Yes\n  2. No",
      },
    })
    expect(screen.getByTestId("terminal-needs-you").textContent).toContain("Shell 1 needs you")
    expect(screen.queryByTestId("terminal-needs-you-option-1")).not.toBeNull()
  })
})
