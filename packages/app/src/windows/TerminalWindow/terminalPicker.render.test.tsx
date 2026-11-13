import { fireEvent, render } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const t = (key: string, o?: Record<string, string>) =>
    (o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => o?.[k] ?? "")
  return { ...actual, useTranslation: () => ({ t }) }
})

const client = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => client }))

const tiling = vi.hoisted(() => ({
  windows: {} as Record<string, { id: string; type: string; props: Record<string, any> }>,
  focusWindow: vi.fn(),
  openWindow: vi.fn(),
  closeWindow: vi.fn(),
  updateWindowProps: vi.fn(),
}))
vi.mock("../../store/tilingStore", () => ({ useTilingStore: { getState: () => tiling } }))

import { terminalWindowDefinition } from "./definition"
import { SessionsList } from "./SessionsList"
import { TerminalPicker } from "./TerminalPicker"
import { showTerminalSession, type TerminalSession } from "./terminalSessions"
import { nextWindowProps, opensOnPicker, sessionGroups } from "./terminalWindowModel"

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

const rows = [
  session({ terminalId: "t_one", title: "Shell 1" }),
  session({ terminalId: "t_two", title: "Deploy" }),
]

const picker = (onEnd = vi.fn()) =>
  render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <TerminalPicker
        windowId="w_pick"
        workspaceId="work_a"
        groups={sessionGroups(rows, ME, new Set(["t_two"]))}
        me={ME}
        onEnd={onEnd}
      />
    </TamaguiProvider>,
  )

beforeEach(() => {
  tiling.windows = {
    w_pick: { id: "w_pick", type: "terminal", props: {} },
    w_two: { id: "w_two", type: "terminal", props: { terminalId: "t_two" } },
  }
  for (const fn of [
    tiling.focusWindow,
    tiling.openWindow,
    tiling.closeWindow,
    tiling.updateWindowProps,
    client.send,
  ])
    fn.mockReset()
})

describe("a Terminal opened without a session", () => {
  it("[TW-AC-28] every generic way to open the app (launcher, the strip's +, the apps list, the phone's new tab) passes no session, and that opens on the picker", () => {
    expect(opensOnPicker({})).toBe(true)
    expect(opensOnPicker({ workspaceId: "work_a" })).toBe(true)
    expect(opensOnPicker({ workspaceId: "work_a", title: "Terminal" })).toBe(true)
    expect(terminalWindowDefinition.isLauncher).toBe(true)
    expect(terminalWindowDefinition.getKey?.({})).toBeUndefined()
    expect(terminalWindowDefinition.getTitle({})).toBe("Terminal")
  })

  it("[TW-AC-28] a path that already knows its target skips the picker: a session to show, a new terminal asked from a terminal, a preset or a folder", () => {
    expect(opensOnPicker({ terminalId: "t9" })).toBe(false)
    expect(opensOnPicker(nextWindowProps({}, "work_a") ?? {})).toBe(false)
    expect(opensOnPicker({ preset: "claude" })).toBe(false)
    expect(opensOnPicker({ initialCwd: "/workspace/app" })).toBe(false)
    tiling.windows = {}
    showTerminalSession("work_a", "t7")
    const props = tiling.openWindow.mock.calls[0][1] as Record<string, unknown>
    expect(opensOnPicker(props)).toBe(false)
  })

  it("[TW-AC-28] the picker is the Go to session list with New terminal first and highlighted, the sessions after it, and nothing is created by showing it", () => {
    const { getByTestId } = picker()
    const list = getByTestId("terminal-sessions")
    expect(document.activeElement).toBe(getByTestId("terminal-sessions-search"))
    expect(getByTestId("terminal-sessions-new").getAttribute("aria-selected")).toBe("true")
    const order = Array.from(list.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => /^terminal-sessions-(new|row-t_\w+)$/.test(id))
    expect(order).toEqual([
      "terminal-sessions-new",
      "terminal-sessions-row-t_one",
      "terminal-sessions-row-t_two",
    ])
    expect(getByTestId("terminal-sessions-row-t_one-end")).toBeTruthy()
    expect(tiling.updateWindowProps).not.toHaveBeenCalled()
    expect(client.send).not.toHaveBeenCalled()
  })

  it("[TW-AC-28] the picker is drawn as the Terminal's start page, like the Browser's new tab: icon, title, one line, the big centred field and the rows in a box under it", () => {
    const { getByTestId, queryByTestId } = picker()
    const page = getByTestId("terminal-start")
    expect(page.textContent).toContain("Terminal")
    expect(page.textContent).toContain("Open a new terminal or go back to a session")
    expect(page.querySelector(".ph-terminal")).toBeTruthy()
    const field = getByTestId("terminal-sessions-search") as HTMLInputElement
    expect(field.getAttribute("placeholder")).toBe("Go to session…")
    expect(field.style.height).toBe("56px")
    expect(field.style.flexShrink).toBe("0")
    expect(field.style.textAlign).toBe("center")
    expect(field.style.borderTopLeftRadius).toBe("16px")
    const box = getByTestId("terminal-sessions")
    expect(box.style.borderTopLeftRadius).toBe("12px")
    expect(page.contains(box)).toBe(true)
    expect(queryByTestId("terminal-sessions-scrim")).toBeNull()
  })

  it("[TW-AC-28] the arrows move the highlight down the rows and back, as in the Browser's list", () => {
    const { getByTestId } = picker()
    const field = getByTestId("terminal-sessions-search")
    const rowIds = Array.from(getByTestId("terminal-sessions").querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => /^terminal-sessions-(new|new-shared|row-t_\w+)$/.test(id))
    const selected = () =>
      rowIds.filter((id) => getByTestId(id).getAttribute("aria-selected") === "true")
    expect(selected()).toEqual([rowIds[0]])
    fireEvent.keyDown(field, { key: "ArrowDown" })
    expect(selected()).toEqual([rowIds[1]])
    fireEvent.keyDown(field, { key: "ArrowUp" })
    expect(selected()).toEqual(["terminal-sessions-new"])
    fireEvent.keyDown(field, { key: "ArrowUp" })
    expect(selected()).toEqual([rowIds[rowIds.length - 1]])
  })

  it("[TW-AC-25] inside a terminal the same list is still the popover: sessions first, with its scrim", () => {
    const { getByTestId } = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <SessionsList
          groups={sessionGroups(rows, ME, new Set())}
          currentId="t_one"
          me={ME}
          onPick={() => {}}
          onNew={() => {}}
          onClose={() => {}}
        />
      </TamaguiProvider>,
    )
    expect(getByTestId("terminal-sessions-scrim")).toBeTruthy()
    expect(getByTestId("terminal-sessions-row-t_one").getAttribute("aria-selected")).toBe("true")
    expect((getByTestId("terminal-sessions-search") as HTMLInputElement).style.height).toBe("40px")
  })

  it("[TW-AC-28] Enter opens a new terminal in this window", () => {
    const { getByTestId } = picker()
    fireEvent.keyDown(getByTestId("terminal-sessions-search"), { key: "Enter" })
    expect(tiling.updateWindowProps).toHaveBeenCalledTimes(1)
    const [windowId, props] = tiling.updateWindowProps.mock.calls[0]
    expect(windowId).toBe("w_pick")
    expect(props).toMatchObject({ workspaceId: "work_a", pendingCreate: true })
    expect(props.terminalId).toMatch(/^t[a-z0-9]+$/)
    expect(tiling.closeWindow).not.toHaveBeenCalled()
  })

  it("[TW-AC-28] Escape closes the empty window and creates nothing", () => {
    picker()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(tiling.closeWindow).toHaveBeenCalledWith("w_pick")
    expect(tiling.updateWindowProps).not.toHaveBeenCalled()
    expect(client.send).not.toHaveBeenCalled()
  })

  it("[SPACE-AC-23] the picker offers both spaces, personal first and highlighted; the shared row opens a shared terminal in this window", () => {
    const { getByTestId } = picker()
    expect(getByTestId("terminal-sessions-new").getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(getByTestId("terminal-sessions-search"), { key: "Enter" })
    expect(tiling.updateWindowProps.mock.calls[0][1]).toMatchObject({ space: "personal" })
    fireEvent.click(getByTestId("terminal-sessions-new-shared"))
    expect(tiling.updateWindowProps.mock.calls[1][0]).toBe("w_pick")
    expect(tiling.updateWindowProps.mock.calls[1][1]).toMatchObject({
      space: "shared",
      pendingCreate: true,
    })
  })

  it("[SPACE-AC-26] with a personal Bash the picker's shared row is disabled and says what it takes", () => {
    const { getByTestId } = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <TerminalPicker
          windowId="w_pick"
          workspaceId="work_a"
          groups={[]}
          me={ME}
          sharedOffer={{ kind: "personal-bash", mine: true }}
          onEnd={() => {}}
        />
      </TamaguiProvider>,
    )
    const shared = getByTestId("terminal-sessions-new-shared")
    expect(shared.textContent).toContain("Needs the Bash app to be shared")
    fireEvent.click(shared)
    expect(tiling.updateWindowProps).not.toHaveBeenCalled()
  })

  it("[SPACE-AC-23] a window opened for a space already knows its target and skips the picker", () => {
    expect(opensOnPicker({ space: "shared" })).toBe(false)
    expect(opensOnPicker({ space: "personal" })).toBe(false)
  })

  it("[FLOAT-AC-16] in the picker each session row carries its status mark", () => {
    const working = session({
      terminalId: "t_work",
      title: "Claude",
      command: "claude",
      agentState: { state: "working", at: "2026-11-10T10:05:00.000Z" },
    })
    const { getByTestId } = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <TerminalPicker
          windowId="w_pick"
          workspaceId="work_a"
          groups={sessionGroups([working], ME, new Set())}
          me={ME}
          onEnd={() => {}}
        />
      </TamaguiProvider>,
    )
    expect(getByTestId("terminal-sessions-new").getAttribute("aria-selected")).toBe("true")
    expect(
      getByTestId("terminal-start").contains(getByTestId("terminal-sessions-row-t_work")),
    ).toBe(true)
    expect(
      getByTestId("terminal-sessions-row-t_work").querySelector('[data-testid^="window-status-"]'),
    ).toBeTruthy()
  })

  it("[TW-AC-28] picking a session no window shows attaches this window to it", () => {
    const { getByTestId } = picker()
    fireEvent.click(getByTestId("terminal-sessions-row-t_one"))
    expect(tiling.updateWindowProps).toHaveBeenCalledWith("w_pick", { terminalId: "t_one" })
    expect(tiling.closeWindow).not.toHaveBeenCalled()
  })

  it("[TW-AC-28] picking a session another window shows goes to that window and closes this one", () => {
    const { getByTestId } = picker()
    fireEvent.click(getByTestId("terminal-sessions-row-t_two"))
    expect(tiling.focusWindow).toHaveBeenCalledWith("w_two")
    expect(tiling.closeWindow).toHaveBeenCalledWith("w_pick")
    expect(tiling.updateWindowProps).not.toHaveBeenCalled()
  })

  it("[TW-AC-28] a session can be ended from the picker without leaving it", () => {
    const onEnd = vi.fn()
    const { getByTestId } = picker(onEnd)
    fireEvent.click(getByTestId("terminal-sessions-row-t_one-end"))
    expect(onEnd).toHaveBeenCalledWith(rows[0])
    expect(tiling.closeWindow).not.toHaveBeenCalled()
  })
})
