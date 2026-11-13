import { act, fireEvent, render, renderHook } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const t = (key: string, o?: Record<string, string>) =>
    (o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => o?.[k] ?? "")
  return { ...actual, useTranslation: () => ({ t }) }
})

const toast = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }))
vi.mock("../../components/Toast", () => ({ useToast: () => toast }))

const client = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => client }))

const tiling = vi.hoisted(() => ({
  windows: {} as Record<string, { id: string; type: string; props: Record<string, any> }>,
  focusWindow: vi.fn(),
  openWindow: vi.fn(),
  closeWindow: vi.fn(),
}))
vi.mock("../../store/tilingStore", () => ({ useTilingStore: { getState: () => tiling } }))

import type { TFunction } from "i18next"
import { cancelClose, closeOutcome, isBusy, isClosing, UNDO_MS } from "./closeTerminal"
import { SessionsList } from "./SessionsList"
import { terminalCloseGuard, terminalClosed } from "./terminalChrome"
import type { TerminalSession } from "./terminalSessions"
import { sessionGroups } from "./terminalWindowModel"
import { useEndSession } from "./useEndSession"

const t = ((key: string, o?: Record<string, string>) =>
  (o?.defaultValue ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_m, k: string) => o?.[k] ?? "",
  )) as unknown as TFunction
const context = (shownElsewhere = false) => ({
  me: "u_me",
  shownElsewhere,
  end: vi.fn(),
  note: vi.fn(),
})

const ME = "u_me"
const session = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId: "t1",
  title: "Shell 1",
  kind: "shell",
  command: "bash",
  pinned: true,
  persistent: true,
  createdBy: ME,
  createdAt: "",
  lastActivity: "",
  cols: 80,
  rows: 24,
  agentState: null,
  viewers: 0,
  watchers: [],
  driver: { kind: "none", since: 0 },
  agentControl: false,
  space: "personal",
  watchable: false,
  openedBy: "person",
  ...extra,
})

const ui = (node: React.ReactElement) =>
  render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {node}
    </TamaguiProvider>,
  )

beforeEach(() => {
  tiling.windows = {}
  for (const fn of [tiling.focusWindow, tiling.openWindow, tiling.closeWindow]) fn.mockReset()
  toast.show.mockReset()
  toast.error.mockReset()
  client.send.mockReset()
  client.send.mockResolvedValue({ ok: true })
})
afterEach(() => {
  cancelClose("t1")
  vi.useRealTimers()
})

describe("closing a Terminal window", () => {
  it("[TW-AC-5] an idle shell only I use is not asked about, and closing its window ends it", () => {
    const c = context()
    expect(closeOutcome(session(), ME)).toBe("end")
    expect(terminalCloseGuard(session(), t, c)).toBeNull()
    terminalClosed(session(), t, c)
    expect(c.end).toHaveBeenCalledTimes(1)
    expect(c.note).not.toHaveBeenCalled()
  })

  it("[TW-AC-5] anything in the foreground, a working agent, an agent typing or an unknown foreground counts as running", () => {
    expect(isBusy(session())).toBe(false)
    expect(isBusy(session({ command: "zsh" }))).toBe(false)
    expect(isBusy(session({ command: "claude", kind: "claude" }))).toBe(true)
    expect(isBusy(session({ command: "npm" }))).toBe(true)
    expect(isBusy(session({ command: null }))).toBe(true)
    expect(isBusy(session({ agentState: { state: "working", at: "" } }))).toBe(true)
    expect(isBusy(session({ driver: { kind: "agent", id: "agent:a", since: 0 } }))).toBe(true)
  })

  it("[TW-AC-5] with something running the window's guard asks in generic words, names no process, and End is what ends it", () => {
    const c = context()
    const question = terminalCloseGuard(session({ command: "npm" }), t, c)
    expect(question).toMatchObject({
      message: "Shell 1 has something running. Ending it stops it.",
      confirmLabel: "End",
      keepLabel: "Keep running",
    })
    expect(question?.message).not.toContain("npm")
    expect(question?.onKeep).toBeUndefined()
    expect(c.end).not.toHaveBeenCalled()
    question?.onConfirm()
    expect(c.end).toHaveBeenCalledTimes(1)
  })

  it("[TW-AC-5] a session others see or use is never asked about and never ends on close: the toast says it keeps running", () => {
    for (const other of [
      session({ space: "shared" }),
      session({ space: "shared", command: "claude" }),
      session({ watchable: true }),
      session({ watchable: true, command: "npm" }),
      session({ createdBy: "agent:app_1", openedBy: "agent", space: "shared" }),
      session({ createdBy: "u_other", space: "shared" }),
    ]) {
      const c = context()
      expect(terminalCloseGuard(other, t, c)).toBeNull()
      terminalClosed(other, t, c)
      expect(c.end).not.toHaveBeenCalled()
      expect(c.note).toHaveBeenCalledWith("Shell 1 keeps running for the workspace")
    }
  })

  it("[SPACE-AC-27] my own personal session ends on close only while nobody else may watch it; a view of someone else's closes and says nothing", () => {
    expect(closeOutcome(session(), ME)).toBe("end")
    expect(closeOutcome(session({ watchable: true }), ME)).toBe("keep")
    expect(closeOutcome(session({ space: "shared" }), ME)).toBe("keep")
    const theirs = session({ createdBy: "u_other", watchable: true, command: "npm" })
    expect(closeOutcome(theirs, ME)).toBe("view")
    const c = context()
    expect(terminalCloseGuard(theirs, t, c)).toBeNull()
    terminalClosed(theirs, t, c)
    expect(c.end).not.toHaveBeenCalled()
    expect(c.note).not.toHaveBeenCalled()
  })

  it("[TW-AC-5] a session another window also shows just loses this window: nothing asked, ended or said", () => {
    const c = context(true)
    expect(terminalCloseGuard(session({ command: "npm" }), t, c)).toBeNull()
    terminalClosed(session(), t, c)
    terminalClosed(session({ space: "shared" }), t, c)
    expect(c.end).not.toHaveBeenCalled()
    expect(c.note).not.toHaveBeenCalled()
  })
})

describe("ending a session", () => {
  const end = (target: TerminalSession) => {
    const { result } = renderHook(() => useEndSession("work_a"))
    act(() => result.current(target))
  }

  it("[TW-AC-5] ends on the server with the undo window, closes the window that shows it and says so with Undo", () => {
    tiling.windows = { w1: { id: "w1", type: "terminal", props: { terminalId: "t1" } } }
    end(session())
    expect(client.send).toHaveBeenCalledWith("terminal", "destroy", {
      terminalId: "t1",
      undoMs: UNDO_MS,
    })
    expect(tiling.closeWindow).toHaveBeenCalledWith("w1")
    expect(toast.show).toHaveBeenCalledWith(
      "Shell 1 ended",
      expect.objectContaining({
        duration: UNDO_MS,
        action: expect.objectContaining({ label: "Undo" }),
      }),
    )
    expect(isClosing("t1")).toBe(true)
  })

  it("[TW-AC-5] Undo cancels the end on the server and brings the session back in a window", async () => {
    end(session())
    client.send.mockResolvedValueOnce({ ok: true, cancelled: true })
    const undo = toast.show.mock.calls[0][1].action.onPress as () => void
    await act(async () => {
      undo()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(client.send).toHaveBeenLastCalledWith("terminal", "cancelClose", { terminalId: "t1" })
    expect(tiling.openWindow).toHaveBeenCalledWith(
      "terminal",
      { workspaceId: "work_a", terminalId: "t1" },
      { inNewTab: true },
    )
    expect(isClosing("t1")).toBe(false)
  })

  it("[TW-AC-5] an end the server refuses says it could not end the session, and the session is listed again", async () => {
    client.send.mockRejectedValueOnce(new Error("ACCESS_DENIED"))
    const { result } = renderHook(() => useEndSession("work_a"))
    await act(async () => {
      result.current(session())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(toast.error).toHaveBeenCalledWith("Could not end the session", "ACCESS_DENIED")
    expect(isClosing("t1")).toBe(false)
  })
})

describe("ending from the sessions list", () => {
  const rows = [
    session({ terminalId: "t_idle", title: "Shell 1" }),
    session({ terminalId: "t_busy", title: "Build", command: "npm" }),
    session({
      terminalId: "t_agent",
      title: "Agent",
      createdBy: "agent:app_1",
      openedBy: "agent",
      space: "shared",
    }),
  ]

  it("[SPACE-AC-27] with nothing said, the list offers the end control on the sessions I may manage and on no other", () => {
    const all = [
      ...rows,
      session({ terminalId: "t_team", title: "Team", space: "shared", createdBy: "u_other" }),
      session({ terminalId: "t_theirs", title: "Theirs", createdBy: "u_other", watchable: true }),
    ]
    const { queryByTestId } = ui(
      <SessionsList
        groups={sessionGroups(all, ME, new Set())}
        currentId={null}
        me={ME}
        role="write"
        onPick={() => {}}
        onNew={() => {}}
        onEnd={() => {}}
        onClose={() => {}}
      />,
    )
    for (const id of ["t_idle", "t_busy", "t_agent", "t_team"])
      expect(queryByTestId(`terminal-sessions-row-${id}-end`)).toBeTruthy()
    expect(queryByTestId("terminal-sessions-row-t_theirs")).toBeTruthy()
    expect(queryByTestId("terminal-sessions-row-t_theirs-end")).toBeNull()
  })
  const list = (extra: Record<string, unknown> = {}) =>
    ui(
      <SessionsList
        groups={sessionGroups(rows, ME, new Set())}
        currentId={null}
        me={ME}
        onPick={() => {}}
        onNew={() => {}}
        onClose={() => {}}
        {...extra}
      />,
    )

  it("[TW-AC-4] each row I may end has an end control that ends it without picking the row; rows I may not end have none", () => {
    const onEnd = vi.fn()
    const onPick = vi.fn()
    const { getByTestId, queryByTestId } = list({
      onEnd,
      onPick,
      mayEnd: (s: TerminalSession) => s.terminalId !== "t_agent",
    })
    expect(queryByTestId("terminal-sessions-row-t_agent-end")).toBeNull()
    const control = getByTestId("terminal-sessions-row-t_idle-end")
    expect(control.getAttribute("aria-label")).toBe("End Shell 1")
    fireEvent.click(control)
    expect(onEnd).toHaveBeenCalledWith(rows[0])
    expect(onPick).not.toHaveBeenCalled()
  })

  it("[FLOAT-AC-16] a row keeps its status mark beside the end control", () => {
    const working = session({
      terminalId: "t_work",
      title: "Claude",
      command: "claude",
      agentState: { state: "working", at: "2026-11-10T10:05:00.000Z" },
    })
    const { getByTestId } = ui(
      <SessionsList
        groups={sessionGroups([working], ME, new Set())}
        currentId={null}
        me={ME}
        onPick={() => {}}
        onNew={() => {}}
        onEnd={() => {}}
        onClose={() => {}}
      />,
    )
    expect(
      getByTestId("terminal-sessions-row-t_work").querySelector('[data-testid^="window-status-"]'),
    ).toBeTruthy()
    expect(getByTestId("terminal-sessions-row-t_work-end")).toBeTruthy()
  })

  it("[TW-AC-4] without a way to end, no row offers it", () => {
    const { queryByTestId } = list()
    expect(queryByTestId("terminal-sessions-row-t_idle-end")).toBeNull()
  })

  it("[TW-AC-4] a session with something running takes a second click: the control first turns into End", () => {
    const onEnd = vi.fn()
    const { getByTestId } = list({ onEnd })
    fireEvent.click(getByTestId("terminal-sessions-row-t_busy-end"))
    expect(onEnd).not.toHaveBeenCalled()
    const armed = getByTestId("terminal-sessions-row-t_busy-end")
    expect(armed.textContent).toBe("End")
    expect(armed.getAttribute("aria-label")).toBe("Click again to end the session")
    fireEvent.click(armed)
    expect(onEnd).toHaveBeenCalledWith(rows[1])
  })

  it("[TW-AC-4] a session that is ending leaves the list at once and comes back if the end is undone", () => {
    const { result } = renderHook(() => useEndSession("work_a"))
    const { queryByTestId } = list({ onEnd: () => {} })
    act(() => result.current(rows[0]))
    expect(queryByTestId("terminal-sessions-row-t_idle")).toBeNull()
    act(() => {
      cancelClose("t_idle")
    })
    expect(queryByTestId("terminal-sessions-row-t_idle")).toBeTruthy()
  })
})
