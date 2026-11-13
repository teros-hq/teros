import { act, fireEvent, render } from "@testing-library/react"
import type { TFunction } from "i18next"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const t = (key: string, o?: Record<string, string>) =>
    (o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(o?.[k] ?? ""))
  return { ...actual, useTranslation: () => ({ t }) }
})
vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => null }))

import { type WindowTypeDefinition, windowRegistry } from "../../services/windowRegistry"
import { useTilingStore } from "../../store/tilingStore"
import { SessionsList } from "./SessionsList"
import { TerminalPicker } from "./TerminalPicker"
import {
  floatTerminalSession,
  goToWindow,
  showTerminalSession,
  type TerminalSession,
} from "./terminalSessions"
import { sessionGroups, sessionsElsewhere } from "./terminalWindowModel"

const t = ((key: string, o?: Record<string, string>) =>
  (o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    String(o?.[k] ?? ""),
  )) as unknown as TFunction

const ME = "u_me"
const session = (terminalId: string, title: string): TerminalSession => ({
  terminalId,
  title,
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
})
const sessions = [session("t1", "Shell 1"), session("t2", "Shell 2")]

const definition: WindowTypeDefinition = {
  type: "terminal",
  audience: "user",
  displayName: "Terminal",
  icon: (() => null) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  noPreview: true,
  getKey: (props) => (props as { terminalId?: string }).terminalId,
  getTitle: () => "Terminal",
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition["component"],
  serialize: (props) => props,
  deserialize: (data) => data,
}

const s = () => useTilingStore.getState()
const open = (props: Record<string, unknown>) =>
  s().openWindow("terminal", props, { inNewTab: true }) as string
const activePaneWindow = () => {
  const desktop = s().desktops[s().activeDesktopIndex]
  const find = (node: any): string | null =>
    !node
      ? null
      : node.type === "container"
        ? node.id === desktop.activeContainerId
          ? node.activeWindowId
          : null
        : (find(node.first) ?? find(node.second))
  return find(desktop.layout)
}
const elsewhere = () =>
  sessionsElsewhere(s().windows, s().floats, s().desktops, s().activeDesktopIndex, t)
const groups = () =>
  sessionGroups(
    sessions,
    ME,
    new Set(
      Object.values(s().windows)
        .map((w) => w.props?.terminalId as string)
        .filter(Boolean),
    ),
    elsewhere(),
  )
const ui = (node: React.ReactElement) =>
  render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {node}
    </TamaguiProvider>,
  )

let first = ""
let second = ""
beforeEach(() => {
  if (windowRegistry.has("terminal")) windowRegistry.unregister("terminal")
  windowRegistry.register(definition)
  useTilingStore.setState({ windows: {}, floats: {}, nextId: 1 })
  s().resetDesktops()
  s().setCompactShell(false)
  first = open({ terminalId: "t1" })
  second = open({ terminalId: "t2" })
  act(() => {
    s().addDesktop()
    s().switchToDesktop(1)
  })
})
afterEach(() => {
  windowRegistry.unregister("terminal")
})

describe("a session whose window is on another desktop", () => {
  it("[TW-AC-29] showing it switches to that desktop and brings its tab to the front", () => {
    expect(s().activeDesktopIndex).toBe(1)
    act(() => showTerminalSession("work_a", "t1"))
    expect(s().activeDesktopIndex).toBe(0)
    expect(activePaneWindow()).toBe(first)
    expect(Object.keys(s().windows)).toHaveLength(2)
  })

  it("[TW-AC-29] a window on the desktop I am on is focused without leaving it", () => {
    const here = open({ terminalId: "t3" })
    const other = open({ terminalId: "t4" })
    expect(activePaneWindow()).toBe(other)
    act(() => goToWindow(here))
    expect(s().activeDesktopIndex).toBe(1)
    expect(activePaneWindow()).toBe(here)
  })

  it("[TW-AC-29] a floating window comes with me, so showing it raises it where I am", () => {
    act(() => {
      s().switchToDesktop(0)
      s().floatWindow(first)
      s().switchToDesktop(1)
    })
    expect(s().floats[first]).toBeTruthy()
    act(() => showTerminalSession("work_a", "t1"))
    expect(s().activeDesktopIndex).toBe(1)
    expect(s().floats[first]).toBeTruthy()
    act(() => floatTerminalSession("work_a", "t2"))
    expect(s().floats[second]).toBeTruthy()
    expect(s().activeDesktopIndex).toBe(1)
  })

  it("[TW-AC-29] picking it on the start page goes to its desktop and closes the start page behind", () => {
    const pickerWindow = open({})
    const { getByTestId } = ui(
      <TerminalPicker
        windowId={pickerWindow}
        workspaceId="work_a"
        groups={groups()}
        me={ME}
        onEnd={() => {}}
      />,
    )
    fireEvent.click(getByTestId("terminal-sessions-row-t2"))
    expect(s().activeDesktopIndex).toBe(0)
    expect(activePaneWindow()).toBe(second)
    expect(s().windows[pickerWindow]).toBeUndefined()
    expect(Object.values(s().windows).filter((w) => w.desktopIndex === 1)).toHaveLength(0)
  })

  it("[TW-AC-29] a row says which desktop its window is on only when that is not the one I am on", () => {
    open({ terminalId: "t3" })
    const all = [...sessions, session("t3", "Shell 3")]
    const { getByTestId } = ui(
      <SessionsList
        groups={sessionGroups(all, ME, new Set(["t1", "t2", "t3"]), elsewhere())}
        currentId={null}
        me={ME}
        onPick={() => {}}
        onNew={() => {}}
        onClose={() => {}}
      />,
    )
    expect(getByTestId("terminal-sessions-row-t1").textContent).toContain("on Desktop 1")
    expect(getByTestId("terminal-sessions-row-t2").textContent).toContain("on Desktop 1")
    expect(getByTestId("terminal-sessions-row-t3").textContent).toContain("In a window")
    expect(getByTestId("terminal-sessions-row-t3").textContent).not.toContain("Desktop")
  })

  it("[TW-AC-29] a desktop with a name is called by it, and a floating window is never elsewhere", () => {
    act(() => {
      useTilingStore.setState({
        desktops: s().desktops.map((d, i) => (i === 0 ? { ...d, name: "Deploys" } : d)),
      })
    })
    expect(elsewhere().get("t1")).toBe("Deploys")
    act(() => {
      s().switchToDesktop(0)
      s().floatWindow(first)
      s().switchToDesktop(1)
    })
    expect(elsewhere().has("t1")).toBe(false)
    expect(elsewhere().get("t2")).toBe("Deploys")
  })
})
