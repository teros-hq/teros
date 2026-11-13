import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import type { TerminalSession } from "../../windows/TerminalWindow/terminalSessions"

const world = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  opened: [] as Array<[unknown, string, unknown]>,
  role: "write" as string,
}))

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, o?: Record<string, unknown>) =>
        String(o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(o?.[k] ?? "")),
    }),
  }
})
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => ({
    send: async (to: string, action: string, data: unknown) => {
      world.calls.push([to, action, data])
      return { ok: true }
    },
  }),
}))
vi.mock("./openTerminalNeed", () => ({
  openTerminalNeed: async (workspaceId: unknown, terminalId: string, mode?: unknown) => {
    world.opened.push([workspaceId, terminalId, mode ?? "tab"])
  },
}))
vi.mock("./screenQuestion", () => ({
  useScreenQuestion: () => null,
  fallbackQuestion: () => ({ question: "Proceed?", detail: null, options: [] }),
}))
vi.mock("../../store/authStore", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { userId: "u_me" } }),
}))
vi.mock("../../store/navbarStore", () => ({
  useNavbarStore: (sel: (s: unknown) => unknown) =>
    sel({ workspaces: [{ workspaceId: "w2", name: "Acme", role: world.role }] }),
}))
vi.mock("../mca/renderers/terminal/NeedsYouCard", () => ({
  NeedsYouCard: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="blocked-card">{terminalId}</div>
  ),
}))

import { TerminalNeedCard } from "./TerminalNeedCard"
import type { TerminalNeed } from "./terminalNeeds"

const session = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId: "t1",
  ownerWorkspaceId: "w2",
  title: "Build",
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
  driver: { kind: "none", since: 0 },
  agentControl: false,
  space: "personal",
  wheelRequest: { agent: { id: "agent:ada", name: "Ada" }, reason: "run the tests", at: 1 },
  ...extra,
})

const need = (kind: TerminalNeed["kind"], extra: Partial<TerminalSession> = {}): TerminalNeed => ({
  workspaceId: "w2",
  workspaceName: "Acme",
  kind,
  session: session(extra),
})

function show(n: TerminalNeed, onOpen?: () => void) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <TerminalNeedCard need={n} onOpen={onOpen} />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  world.calls = []
  world.opened = []
  world.role = "write"
})

describe("a pending notice of a terminal", () => {
  it("[FLOAT-AC-21] a blocked session is the needs-you card, as before", () => {
    show(need("blocked", { agentState: { state: "blocked", at: "x" }, wheelRequest: null }))
    expect(screen.getByTestId("blocked-card").textContent).toBe("t1")
    expect(screen.queryByTestId("control-request")).toBeNull()
  })

  it("[FLOAT-AC-21] a request to use a session says who asks, for which session, in which workspace, and why", () => {
    show(need("request"))
    const card = screen.getByTestId("control-request")
    expect(card.textContent).toContain("Ada asks to use Build")
    expect(card.textContent).toContain("run the tests")
    expect(screen.getByTestId("control-request-meta").textContent).toBe("Acme")
    expect(screen.getByTestId("control-request-opener").textContent).toBe(" · opened by you")
  })

  it("[FLOAT-AC-21] it is answered in place: Allow and Keep off send the answer for that request", async () => {
    show(need("request"))
    fireEvent.click(screen.getByTestId("control-request-allow"))
    await waitFor(() => expect(world.calls).toHaveLength(1))
    expect(world.calls[0]).toEqual([
      "terminal",
      "answerWheel",
      { terminalId: "t1", approve: true, agentId: "agent:ada" },
    ])
  })

  it("[FLOAT-AC-21] the same rule for who may answer: a colleague who is typing there answers, I can only look", () => {
    const now = Date.now()
    show(
      need("request", {
        space: "shared",
        createdBy: "u_iria",
        driver: { kind: "human", id: "u_iria", name: "Iria Q", since: now },
        lastInput: { kind: "human", id: "u_iria", at: now },
      }),
    )
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(screen.getByTestId("control-request").textContent).toContain("Iria is typing there")
    expect(screen.getByTestId("control-request-float")).toBeTruthy()
  })

  it("[FLOAT-AC-21] it opens the session floating or in its tab, in its own workspace, and tells the notice", async () => {
    const onOpen = vi.fn()
    show(need("request"), onOpen)
    fireEvent.click(screen.getByTestId("control-request-float"))
    fireEvent.click(screen.getByTestId("control-request-goto"))
    await waitFor(() => expect(world.opened).toHaveLength(2))
    expect(world.opened).toEqual([
      ["w2", "t1", "float"],
      ["w2", "t1", "tab"],
    ])
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
