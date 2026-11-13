import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../../../tamagui.config"
import type { TerminalSession } from "../../../../windows/TerminalWindow/terminalSessions"

const world = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  failing: new Set<string>(),
  sessions: [] as unknown[],
  loaded: true,
  show: [] as Array<[unknown, string]>,
  float: [] as Array<[unknown, string]>,
  replaced: [] as string[],
  active: "w1" as string | null,
}))

vi.mock("../../../../services/terosClientSingleton", () => ({
  getTerosClient: () => ({
    send: async (to: string, action: string, data: unknown) => {
      world.calls.push([to, action, data])
      if (world.failing.has(action)) throw new Error(`${action} refused`)
      return { ok: true }
    },
  }),
}))
vi.mock("../../../../windows/TerminalWindow/terminalSessions", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  useTerminalSessions: () => ({ sessions: world.sessions, loaded: world.loaded, error: null }),
  floatTerminalSession: (workspaceId: unknown, terminalId: string) => {
    world.float.push([workspaceId, terminalId])
  },
  showTerminalSession: (workspaceId: unknown, terminalId: string) => {
    world.show.push([workspaceId, terminalId])
  },
}))
vi.mock("expo-router", () => ({
  router: { replace: (to: string) => world.replaced.push(to) },
}))
vi.mock("../../../../store/workspaceStore", () => {
  const state = () => ({ activeWorkspaceId: world.active })
  const useWorkspaceStore = Object.assign((sel: (s: unknown) => unknown) => sel(state()), {
    getState: state,
    subscribe: () => () => {},
  })
  return { useWorkspaceStore }
})
vi.mock("../../../../store/tilingStore", () => ({
  useTilingStore: {
    getState: () => ({ layoutRestoredForWorkspace: world.active, restoreGeneration: 0 }),
    subscribe: () => () => {},
  },
}))
vi.mock("../../../../store/authStore", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { userId: "u_me" } }),
}))

import { NeedsYouCard } from "./NeedsYouCard"

const session = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId: "t1",
  title: "Tests",
  kind: "shell",
  command: "bash",
  pinned: true,
  persistent: true,
  createdBy: "u_me",
  createdAt: "2026-11-10T10:00:00.000Z",
  lastActivity: "2026-11-10T10:00:00.000Z",
  cols: 80,
  rows: 24,
  agentState: { state: "blocked", at: "2026-11-10T10:05:00.000Z" },
  viewers: 0,
  watchers: [],
  driver: { kind: "agent", id: "agent_atlas", name: "Atlas Prime", since: 0 },
  agentControl: true,
  ...extra,
})

const question = {
  question: "Do you want to proceed?",
  detail: "npm test",
  options: [
    { key: "1", label: "Yes", selected: true },
    { key: "2", label: "No, and tell Claude what to do (esc)", selected: false },
  ],
}

function renderCard(props: Partial<Parameters<typeof NeedsYouCard>[0]> = {}) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <NeedsYouCard terminalId="t1" question={question} {...props} />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  world.calls = []
  world.failing = new Set()
  world.sessions = [session()]
  world.loaded = true
  world.show = []
  world.float = []
  world.replaced = []
  world.active = "w1"
})

describe("the needs-you card", () => {
  it("says which session needs the person and which agent waits, without any wheel", () => {
    renderCard()
    const card = screen.getByTestId("terminal-needs-you")
    expect(card.textContent).toContain("Tests needs you · Atlas is waiting")
    expect(card.textContent).not.toMatch(/wheel/i)
  })

  it("with no agent known, the title is just the session", () => {
    world.sessions = [session({ driver: { kind: "none", since: 0 } })]
    renderCard()
    const card = screen.getByTestId("terminal-needs-you")
    expect(card.textContent).toContain("Tests needs you")
    expect(card.textContent).not.toContain("is waiting")
  })

  it("shows a terminal icon from the design system, not a face", () => {
    renderCard()
    const icon = screen.getByTestId("terminal-needs-you-icon")
    expect(icon.querySelector("i.ph-terminal-window")).not.toBeNull()
  })

  it("a notice names its workspace and who is typing there", () => {
    renderCard({ workspaceId: "w1", workspaceName: "Acme" })
    expect(screen.getByTestId("terminal-needs-you-meta").textContent).toBe(
      "Acme · Atlas is typing",
    )
  })

  it("a notice where nobody types names only the workspace", () => {
    world.sessions = [session({ driver: { kind: "none", since: 0 } })]
    renderCard({ workspaceId: "w1", workspaceName: "Acme" })
    expect(screen.getByTestId("terminal-needs-you-meta").textContent).toBe("Acme")
  })

  it("in a chat there is no meta line", () => {
    renderCard()
    expect(screen.queryByTestId("terminal-needs-you-meta")).toBeNull()
  })

  it("answering switches Agent off for that session first, then types the key as the person", async () => {
    renderCard()
    fireEvent.click(screen.getByTestId("terminal-needs-you-option-1"))
    await waitFor(() => expect(world.calls).toHaveLength(2))
    expect(world.calls).toEqual([
      ["terminal", "takeWheel", { terminalId: "t1" }],
      ["terminal", "write", { terminalId: "t1", data: "1", sendEnter: false }],
    ])
    expect(screen.getByTestId("terminal-needs-you").textContent).toContain("You answered 1 · Yes")
  })

  it("a refused switch does not stop the answer", async () => {
    world.failing.add("takeWheel")
    renderCard()
    fireEvent.click(screen.getByTestId("terminal-needs-you-option-2"))
    await waitFor(() =>
      expect(world.calls).toContainEqual([
        "terminal",
        "write",
        { terminalId: "t1", data: "2", sendEnter: false },
      ]),
    )
    expect(screen.queryByTestId("terminal-needs-you-error")).toBeNull()
  })

  it("a refused key shows the error in the danger tone and the options come back", async () => {
    world.failing.add("write")
    renderCard()
    fireEvent.click(screen.getByTestId("terminal-needs-you-option-1"))
    const error = await screen.findByTestId("terminal-needs-you-error")
    expect(error.textContent).toBe("write refused")
    expect((screen.getByTestId("terminal-needs-you-option-1") as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it("once the session stops waiting, the options go quiet and the card says Answered", () => {
    world.sessions = [session({ agentState: { state: "working", at: "x" } })]
    renderCard()
    expect(screen.getByTestId("terminal-needs-you-option-1").getAttribute("aria-disabled")).toBe(
      "true",
    )
    expect(screen.getByTestId("terminal-needs-you").textContent).toContain("Answered")
  })
})

describe("Show the terminal [TW-AC-3]", () => {
  it("[FLOAT-AC-17] the card offers the session floating first, then in its tab", () => {
    renderCard()
    const buttons = screen
      .getByTestId("terminal-needs-you")
      .querySelectorAll('[data-testid="terminal-needs-you-float"],[data-testid="terminal-needs-you-goto"]')
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual(["Float", "Show the terminal"])
  })

  it("[FLOAT-AC-17] Float opens that session floating and tells the notice it sits in; no tab is shown", async () => {
    const onOpen = vi.fn()
    renderCard({ onOpen })
    fireEvent.click(screen.getByTestId("terminal-needs-you-float"))
    await waitFor(() => expect(world.float).toEqual([["w1", "t1"]]))
    expect(world.show).toEqual([])
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("shows that session of that workspace, and tells the notice it sits in", async () => {
    const onOpen = vi.fn()
    renderCard({ onOpen })
    fireEvent.click(screen.getByTestId("terminal-needs-you-goto"))
    await waitFor(() => expect(world.show).toEqual([["w1", "t1"]]))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(world.replaced).toEqual([])
  })

  it("a session that has ended has no button", () => {
    world.sessions = []
    renderCard()
    expect(screen.queryByTestId("terminal-needs-you-goto")).toBeNull()
    expect(screen.queryByTestId("terminal-needs-you-float")).toBeNull()
    expect(screen.getByTestId("terminal-needs-you").textContent).toContain("The session has ended")
  })
})
