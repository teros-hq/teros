import { act, render } from "@testing-library/react"
import { Platform } from "react-native"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TerminalSession } from "./terminalSessions"

interface Shown {
  title: string
  type?: string
  action?: { label: string; onPress: () => void }
  secondary?: { label: string; onPress: () => void }
}

const world = vi.hoisted(() => ({
  sessions: [] as unknown[],
  loaded: true,
  listeners: new Set<() => void>(),
  toasts: [] as unknown[],
  reveal: null as null | ((workspaceId: string, session: unknown) => void),
  role: "write" as string,
  hidden: 0,
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
vi.mock("../../components/Toast", () => ({
  useToast: () => ({
    show: (title: string, options: Record<string, unknown>) =>
      world.toasts.push({ title, ...options }),
    hide: () => {
      world.hidden += 1
    },
  }),
}))
vi.mock("../../store/workspaceStore", () => ({
  useWorkspaceStore: (sel: (s: unknown) => unknown) => sel({ activeWorkspaceId: "w1" }),
}))
vi.mock("../../store/navbarStore", () => ({
  useNavbarStore: (sel: (s: unknown) => unknown) =>
    sel({ workspaces: [{ workspaceId: "w1", name: "Acme", role: world.role }] }),
}))
vi.mock("../../store/authStore", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { userId: "u_me" } }),
}))
vi.mock("./terminalSessions", async (importOriginal) => {
  const React = await import("react")
  return {
    ...((await importOriginal()) as Record<string, unknown>),
    useTerminalSessions: () => {
      const [, tick] = React.useState(0)
      React.useEffect(() => {
        const l = () => tick((n: number) => n + 1)
        world.listeners.add(l)
        return () => {
          world.listeners.delete(l)
        }
      }, [])
      return { sessions: world.sessions, loaded: world.loaded, error: null }
    },
    onSessionRevealed: (l: (workspaceId: string, session: unknown) => void) => {
      world.reveal = l
      return () => {
        world.reveal = null
      }
    },
  }
})

import { type WindowTypeDefinition, windowRegistry } from "../../services/windowRegistry"
import { useTilingStore } from "../../store/tilingStore"
import { useWindowTabMetaStore } from "../../store/windowTabMetaStore"
import { useSessionMarks } from "./sessionStatus"
import { TerminalAttention } from "./TerminalAttention"

const definition: WindowTypeDefinition = {
  type: "terminal",
  audience: "user",
  displayName: "Terminal",
  icon: (() => null) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  noPreview: true,
  getTitle: () => "Terminal",
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition["component"],
  serialize: (props) => props,
  deserialize: (data) => data,
}
const OTHER = "__attention_other__"

const session = (terminalId: string, extra: Partial<TerminalSession> = {}): TerminalSession => ({
  terminalId,
  ownerWorkspaceId: "w1",
  title: `Shell ${terminalId}`,
  kind: "claude",
  command: "claude",
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
  agentControl: true,
  space: "personal",
  ...extra,
})
let clock = 0
const state = (name: "working" | "blocked" | "done" | "idle") => ({
  state: name,
  at: `2026-11-10T10:00:${String(++clock).padStart(2, "0")}.000Z`,
})

const s = () => useTilingStore.getState()
const status = (windowId: string) => useWindowTabMetaStore.getState().status[windowId]
const toasts = () => world.toasts as Shown[]
const windowOf = (terminalId: string) =>
  Object.values(s().windows).find((w) => w.props.terminalId === terminalId)!.id
const openTerminal = (terminalId: string) =>
  s().openWindow("terminal", { workspaceId: "w1", terminalId }, { inNewTab: true })!

function feed(sessions: TerminalSession[]) {
  act(() => {
    world.sessions = sessions
    for (const l of Array.from(world.listeners)) l()
  })
}

beforeEach(() => {
  windowRegistry.register(definition)
  windowRegistry.register({ ...definition, type: OTHER })
  useTilingStore.setState({ windows: {}, floats: {}, nextId: 1, activeDesktopIndex: 0 })
  useWindowTabMetaStore.setState({ meta: {}, status: {} })
  useSessionMarks.setState({ finished: {} })
  s().resetDesktops()
  s().setCompactShell(false)
  world.sessions = []
  world.loaded = true
  world.toasts = []
  world.hidden = 0
  world.role = "write"
  world.listeners.clear()
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
})
afterEach(() => {
  windowRegistry.unregister("terminal")
  windowRegistry.unregister(OTHER)
  vi.restoreAllMocks()
})

describe("a terminal calls the person", () => {
  it("[FLOAT-AC-16] every Terminal window carries its session's status, in a pane or floating, and loses it when the session goes quiet", () => {
    const a = openTerminal("a")
    const b = openTerminal("b")
    const c = openTerminal("c")
    act(() => {
      s().floatWindow(b)
    })
    render(<TerminalAttention />)
    feed([
      session("a", { agentState: state("working") }),
      session("b", { agentState: state("blocked") }),
      session("c"),
    ])
    expect(status(a)).toBe("working")
    expect(status(b)).toBe("needs-you")
    expect(status(c)).toBeUndefined()
    expect(s().windows[b].hasNotification).toBe(false)
    feed([session("a"), session("b", { agentState: state("working") }), session("c")])
    expect(status(a)).toBeUndefined()
    expect(status(b)).toBe("working")
  })

  it("[FLOAT-AC-17] an agent that gets blocked toasts with Float first and Open second, and neither has happened yet", () => {
    openTerminal("a")
    const other = s().openWindow(OTHER, {}, { inNewTab: true })!
    render(<TerminalAttention />)
    feed([session("a", { agentState: state("working") })])
    expect(toasts()).toEqual([])
    feed([session("a", { agentState: state("blocked") })])
    expect(toasts()).toHaveLength(1)
    const toast = toasts()[0]
    expect(toast.title).toBe("Shell a needs you")
    expect(toast.type).toBe("warning")
    expect(toast.action?.label).toBe("Float")
    expect(toast.secondary?.label).toBe("Open")
    expect(s().floats).toEqual({})
    expect(s().desktops[0].layout).toMatchObject({ activeWindowId: other })
    act(() => toast.action?.onPress())
    expect(world.hidden).toBe(1)
    expect(s().floats[windowOf("a")]).toMatchObject({ minimized: false })
    expect(s().desktops[0].layout).toMatchObject({ activeWindowId: other, windowIds: [other] })
  })

  it("[FLOAT-AC-17] the toast's Open takes the person to the session's tab instead", () => {
    const a = openTerminal("a")
    const other = s().openWindow(OTHER, {}, { inNewTab: true })!
    render(<TerminalAttention />)
    feed([session("a", { agentState: state("working") })])
    feed([session("a", { agentState: state("blocked") })])
    act(() => toasts()[0].secondary?.onPress())
    expect(s().floats).toEqual({})
    expect(s().desktops[0].layout).toMatchObject({ activeWindowId: a, windowIds: [a, other] })
  })

  it("[FLOAT-AC-17] a session with no window at all floats without any pane getting a tab", () => {
    const other = s().openWindow(OTHER, {}, { inNewTab: true })!
    render(<TerminalAttention />)
    feed([session("a", { agentState: state("working") })])
    feed([session("a", { agentState: state("blocked") })])
    act(() => toasts()[0].action?.onPress())
    const floated = windowOf("a")
    expect(s().floats[floated]).toBeDefined()
    expect(s().desktops[0].layout).toMatchObject({ windowIds: [other] })
    expect(status(floated)).toBe("needs-you")
  })

  it("[FLOAT-AC-19] a session that is a visible float gets no toast: its frame is already in front of the person", () => {
    const a = openTerminal("a")
    s().openWindow(OTHER, {}, { inNewTab: true })
    act(() => {
      s().floatWindow(a)
    })
    render(<TerminalAttention />)
    feed([session("a", { agentState: state("working") })])
    feed([session("a", { agentState: state("blocked") })])
    expect(toasts()).toEqual([])
    expect(status(a)).toBe("needs-you")
  })

  it("[FLOAT-AC-18] a session that is a bubble marks itself and toasts, and stays a bubble until the person acts", () => {
    const a = openTerminal("a")
    s().openWindow(OTHER, {}, { inNewTab: true })
    act(() => {
      s().floatWindow(a)
      s().minimizeFloat(a, true)
    })
    render(<TerminalAttention />)
    feed([session("a", { agentState: state("working") })])
    feed([session("a", { agentState: state("blocked") })])
    expect(status(a)).toBe("needs-you")
    expect(s().floats[a].minimized).toBe(true)
    expect(toasts()).toHaveLength(1)
    act(() => toasts()[0].action?.onPress())
    expect(s().floats[a].minimized).toBe(false)
  })

  it("[FLOAT-AC-17] a finished turn toasts with Open first and Float second, and marks the window until the person looks", () => {
    const a = openTerminal("a")
    const other = s().openWindow(OTHER, {}, { inNewTab: true })!
    render(<TerminalAttention />)
    feed([session("a", { agentState: state("working") })])
    feed([session("a", { agentState: state("done") })])
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].title).toBe("Shell a finished")
    expect(toasts()[0].action?.label).toBe("Open")
    expect(toasts()[0].secondary?.label).toBe("Float")
    expect(status(a)).toBe("finished")
    act(() => s().focusWindow(a))
    expect(status(a)).toBeUndefined()
    act(() => s().focusWindow(other))
    expect(status(a)).toBeUndefined()
  })

  it("[FLOAT-AC-16] a turn that finishes in front of the person is neither a toast nor a mark; old news on load neither", () => {
    const a = openTerminal("a")
    render(<TerminalAttention />)
    feed([session("a", { agentState: state("done") })])
    expect(status(a)).toBeUndefined()
    feed([session("a", { agentState: state("working") })])
    feed([session("a", { agentState: state("done") })])
    expect(toasts()).toEqual([])
    expect(status(a)).toBeUndefined()
  })

  it("[FLOAT-AC-17] an agent asking to use a session toasts once per request, and marks the window", () => {
    const a = openTerminal("a")
    s().openWindow(OTHER, {}, { inNewTab: true })
    const request = { agent: { id: "agent:ada", name: "Ada" }, reason: "run the tests", at: 5 }
    render(<TerminalAttention />)
    feed([session("a")])
    feed([session("a", { wheelRequest: request })])
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].title).toBe("Ada asks to use Shell a")
    expect(toasts()[0].action?.label).toBe("Float")
    expect(status(a)).toBe("needs-you")
    feed([session("a", { wheelRequest: request, viewers: 2 })])
    expect(toasts()).toHaveLength(1)
    feed([session("a", { wheelRequest: null })])
    expect(status(a)).toBeUndefined()
  })

  it("[FLOAT-AC-20] a colleague's personal session I only watch never toasts me", () => {
    openTerminal("a")
    s().openWindow(OTHER, {}, { inNewTab: true })
    render(<TerminalAttention />)
    const theirs = { createdBy: "u_other", watchable: true }
    feed([session("a", { ...theirs, agentState: state("working") })])
    feed([session("a", { ...theirs, agentState: state("blocked") })])
    expect(toasts()).toEqual([])
    feed([session("a", { ...theirs, agentState: state("working") })])
    feed([session("a", { ...theirs, agentState: state("done") })])
    expect(toasts()).toEqual([])
    expect(status(windowOf("a"))).toBeUndefined()
  })

  it("[FLOAT-AC-1] where nothing can float (native), the toast only offers Open", () => {
    openTerminal("a")
    s().openWindow(OTHER, {}, { inNewTab: true })
    const os = Platform.OS
    try {
      ;(Platform as { OS: string }).OS = "ios"
      render(<TerminalAttention />)
      feed([session("a", { agentState: state("working") })])
      feed([session("a", { agentState: state("blocked") })])
      expect(toasts()).toHaveLength(1)
      expect(toasts()[0].action?.label).toBe("Open")
      expect(toasts()[0].secondary).toBeUndefined()
    } finally {
      ;(Platform as { OS: string }).OS = os
    }
  })

  it("[FLOAT-AC-17] an agent that wants to show a session toasts with Float first; nothing opens by itself", () => {
    s().openWindow(OTHER, {}, { inNewTab: true })
    render(<TerminalAttention />)
    const shown = session("z", { driver: { kind: "agent", id: "agent:ada", name: "Ada", since: 0 } })
    act(() => world.reveal?.("w1", shown))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].title).toBe("Ada is working in Shell z")
    expect(toasts()[0].action?.label).toBe("Float")
    expect(toasts()[0].secondary?.label).toBe("Open")
    expect(Object.values(s().windows).some((w) => w.props.terminalId === "z")).toBe(false)
    act(() => toasts()[0].action?.onPress())
    expect(s().floats[windowOf("z")]).toBeDefined()
  })
})
