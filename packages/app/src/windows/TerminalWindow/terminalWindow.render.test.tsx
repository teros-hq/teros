import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { fireEvent, render } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, o?: Record<string, string>) =>
        (o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => o?.[k] ?? ""),
    }),
  }
})

const tiling = vi.hoisted(() => ({
  windows: {} as Record<string, { id: string; type: string; props: Record<string, any> }>,
  focusWindow: vi.fn(),
  floatWindow: vi.fn(() => true),
  openWindow: vi.fn(),
}))
vi.mock("../../store/tilingStore", () => ({ useTilingStore: { getState: () => tiling } }))
vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => null }))

import { terminalWindowDefinition } from "./definition"
import { SessionsList } from "./SessionsList"
import type { TFunction } from "i18next"
import { TerminalCornerPill } from "./TerminalCornerPill"
import { TerminalSpaceCard } from "./TerminalSpaceCard"
import {
  agentReason,
  terminalMenu,
  terminalTabIcon,
  terminalTabMarks,
} from "./terminalChrome"
import { markFinished, useSessionMarks } from "./sessionStatus"
import {
  endsSessionFor,
  floatTerminalSession,
  showTerminalSession,
  type TerminalSession,
} from "./terminalSessions"
import { nextWindowProps, sessionGroups, toolbarOf } from "./terminalWindowModel"

const ME = "u_me"
const session = (extra: Partial<TerminalSession>): TerminalSession => ({
  terminalId: "t1",
  title: "Shell 1",
  kind: "shell",
  command: "bash",
  pinned: true,
  persistent: true,
  createdBy: ME,
  createdAt: "2026-11-10T10:00:00.000Z",
  lastActivity: "2026-11-10T10:00:00.000Z",
  cols: 80,
  rows: 24,
  agentState: null,
  viewers: 0,
  watchers: [],
  driver: { kind: "none", since: 0 },
  agentControl: false,
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
  tiling.focusWindow.mockClear()
  tiling.floatWindow.mockClear()
  tiling.openWindow.mockClear()
})

describe("a Terminal window is one session", () => {
  it("[TW-AC-1] a window opened with no session gets a new session id of its own, every time", () => {
    const first = nextWindowProps({}, "work_a")
    const second = nextWindowProps({}, "work_a")
    expect(first?.terminalId).toMatch(/^t[a-z0-9]+$/)
    expect(second?.terminalId).not.toBe(first?.terminalId)
    expect(first).toMatchObject({ workspaceId: "work_a", pendingCreate: true })
  })

  it("[TW-AC-2] a window that already has its session keeps it: nothing new is created", () => {
    expect(nextWindowProps({ terminalId: "t9", workspaceId: "work_a" }, "work_a")).toBeNull()
  })

  it("[TW-AC-2] the session id is what the layout saves, and the key that identifies the window", () => {
    const props = { workspaceId: "work_a", terminalId: "t9", title: "Deploy", pendingCreate: true }
    const saved = terminalWindowDefinition.serialize?.(props) as Record<string, unknown>
    expect(saved).toEqual({ workspaceId: "work_a", terminalId: "t9", title: "Deploy" })
    expect(terminalWindowDefinition.deserialize?.(saved)).toEqual({
      workspaceId: "work_a",
      terminalId: "t9",
      title: "Deploy",
    })
    expect(terminalWindowDefinition.getKey?.(props)).toBe("t9")
    expect(terminalWindowDefinition.getKey?.({})).toBeUndefined()
    expect(terminalWindowDefinition.getTitle(props)).toBe("Deploy")
  })

  it("[TW-AC-2] a layout saved by the old single window opens on the session it showed", () => {
    expect(
      terminalWindowDefinition.deserialize?.({
        workspaceId: "work_a",
        active: "t_old",
        railSide: "left",
      }),
    ).toEqual({ workspaceId: "work_a", terminalId: "t_old" })
    expect(
      terminalWindowDefinition.deserialize?.({ workspaceId: "work_a", sessionId: "t_older" }),
    ).toMatchObject({ terminalId: "t_older" })
  })

  it("[TW-AC-3] showing a session focuses the window that already has it", () => {
    tiling.windows = {
      w1: { id: "w1", type: "terminal", props: { terminalId: "t1" } },
      w2: { id: "w2", type: "terminal", props: { terminalId: "t2" } },
      w3: { id: "w3", type: "chat", props: { terminalId: "t3" } },
    }
    showTerminalSession("work_a", "t2")
    expect(tiling.focusWindow).toHaveBeenCalledWith("w2")
    expect(tiling.openWindow).not.toHaveBeenCalled()
  })

  it("[TW-AC-3] showing a session with no window opens a new window on it, never reusing another one", () => {
    tiling.windows = { w1: { id: "w1", type: "terminal", props: { terminalId: "t1" } } }
    showTerminalSession("work_a", "t7")
    expect(tiling.focusWindow).not.toHaveBeenCalled()
    expect(tiling.openWindow).toHaveBeenCalledWith(
      "terminal",
      { workspaceId: "work_a", terminalId: "t7" },
      { inNewTab: true },
    )
  })

  it("[FLOAT-AC-17] floating a session that has a window floats that same window, wherever it is", () => {
    tiling.windows = {
      w1: { id: "w1", type: "terminal", props: { terminalId: "t1" } },
      w2: { id: "w2", type: "terminal", props: { terminalId: "t2" } },
    }
    floatTerminalSession("work_a", "t2")
    expect(tiling.floatWindow).toHaveBeenCalledWith("w2")
    expect(tiling.openWindow).not.toHaveBeenCalled()
    expect(tiling.focusWindow).not.toHaveBeenCalled()
  })

  it("[FLOAT-AC-17] floating a session with no window opens its window floating, in no pane", () => {
    tiling.windows = { w1: { id: "w1", type: "terminal", props: { terminalId: "t1" } } }
    floatTerminalSession("work_a", "t7")
    expect(tiling.floatWindow).not.toHaveBeenCalled()
    expect(tiling.openWindow).toHaveBeenCalledWith(
      "terminal",
      { workspaceId: "work_a", terminalId: "t7" },
      { float: true, inNewTab: true },
    )
  })

  it("[TW-AC-8] there is no Terminal-only token file: the window takes its colours from the app", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const files = readdirSync(here, { recursive: true }).map(String)
    expect(files.filter((f) => /tokens|crew|floating/i.test(f))).toEqual([])
    const sources = files
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.|terminalBundle/.test(f))
      .map((f) => readFileSync(join(here, f), "utf8"))
    expect(sources.filter((source) => /#[0-9a-fA-F]{6}\b/.test(source)).length).toBe(1)
  })
})

const t = ((key: string, o?: Record<string, string>) =>
  (o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => o?.[k] ?? "")) as unknown as TFunction
const actions = () => ({
  goToSession: vi.fn(),
  rename: vi.fn(),
  openNew: vi.fn(),
  openToSide: vi.fn(),
  end: vi.fn(),
})
const menuOf = (s: TerminalSession, a = actions(), extra: Record<string, unknown> = {}) =>
  terminalMenu(s, toolbarOf(s, ME), t, a, { me: ME, mac: true, sideSpace: "personal", ...extra })
const pillOf = (s: TerminalSession, now?: number) => {
  const spies = { onToggleAgent: vi.fn(), onSpace: vi.fn(), onReason: vi.fn() }
  const state = toolbarOf(s, ME, "write", now)
  const view = ui(
    <TerminalCornerPill
      state={state}
      reason={agentReason(s, state, t, { me: ME, now })}
      offShortcut="⌘⇧K"
      {...spies}
    />,
  )
  return {
    ...spies,
    view,
    pill: view.getByTestId("terminal-pill"),
    space: view.getByTestId("terminal-space"),
    agent: view.getByTestId("terminal-agent"),
    toggle: view.getByTestId("terminal-agent-toggle"),
  }
}
const cardOf = (s: TerminalSession) => {
  const spies = { onLetWatch: vi.fn(), onNewShared: vi.fn(), onClose: vi.fn() }
  const view = ui(
    <TerminalSpaceCard session={s} state={toolbarOf(s, ME)} me={ME} top={50} {...spies} />,
  )
  return { ...spies, view }
}
const entry = (s: TerminalSession, id: string, a = actions(), extra: Record<string, unknown> = {}) =>
  menuOf(s, a, extra).find((e) => e.id === id)

describe("the Terminal draws no bar; over the terminal there is only the corner pill", () => {
  it("[TW-AC-25] the window has no toolbar of its own: no such file, and the content imports none", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    expect(readdirSync(here).filter((f) => /toolbar/i.test(f))).toEqual([])
    const content = readFileSync(join(here, "TerminalWindowContent.tsx"), "utf8")
    expect(content).not.toMatch(/Toolbar"/)
    expect(content).toMatch(/<TerminalCornerPill/)
  })

  it("[TW-AC-25] the pill holds exactly two controls, the space and the Agent switch, in that order, and the switch is the Browser's", () => {
    const { pill, toggle } = pillOf(session({}))
    const controls = Array.from(pill.querySelectorAll('[role="button"], [role="switch"]'))
    expect(controls.map((el) => el.getAttribute("data-testid"))).toEqual([
      "terminal-space",
      "terminal-agent-toggle",
    ])
    expect(toggle.textContent).toBe("Agent off")
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "TerminalCornerPill.tsx"),
      "utf8",
    )
    expect(source).toMatch(/import \{ ConsentToggle \} from "\.\.\/BrowserWindow\/BrowserToolbar"/)
  })

  it("[TW-AC-25] at rest the pill is quiet; the pointer or the keyboard wake it, and it goes quiet again", () => {
    const { pill, toggle } = pillOf(session({}))
    expect(pill.getAttribute("data-quiet")).toBe("true")
    fireEvent.mouseEnter(pill)
    expect(pill.getAttribute("data-quiet")).toBe("false")
    fireEvent.mouseLeave(pill)
    expect(pill.getAttribute("data-quiet")).toBe("true")
    fireEvent.focus(toggle)
    expect(pill.getAttribute("data-quiet")).toBe("false")
    fireEvent.blur(toggle)
    expect(pill.getAttribute("data-quiet")).toBe("true")
  })

  it("[TW-AC-25] at rest only a plain personal space and Agent off are dimmed; Agent on, Shared, watched and view only keep full strength", () => {
    const strength = (s: TerminalSession) => {
      const p = pillOf(s)
      const of = (el: HTMLElement) => Number((el.parentElement as HTMLElement).style.opacity || 1)
      const out = {
        space: of(p.space),
        agent: Number(p.agent.style.opacity || 1),
        surface: Number(p.view.getByTestId("terminal-pill-surface").style.opacity || 1),
      }
      p.view.unmount()
      return out
    }
    expect(strength(session({}))).toEqual({ space: 0.82, agent: 0.55, surface: 0.62 })
    expect(strength(session({ agentControl: true }))).toMatchObject({ agent: 1, surface: 0.97 })
    expect(strength(session({ space: "shared" })).space).toBe(1)
    expect(strength(session({ watchable: true })).space).toBe(1)
    expect(strength(session({ createdBy: "u_quinn", watchable: true })).space).toBe(1)
  })

  it("[TW-AC-25] the space chip opens the card; a personal terminal's card offers to let the workspace watch and a shared terminal, the others only explain", () => {
    const p = pillOf(session({}))
    fireEvent.click(p.space)
    expect(p.onSpace).toHaveBeenCalledTimes(1)
    p.view.unmount()
    const mine = cardOf(session({}))
    fireEvent.click(mine.view.getByTestId("terminal-space-card-watch"))
    expect(mine.onLetWatch).toHaveBeenCalledTimes(1)
    fireEvent.click(mine.view.getByTestId("terminal-space-card-shared"))
    expect(mine.onNewShared).toHaveBeenCalledTimes(1)
    mine.view.unmount()
    const watched = cardOf(session({ watchable: true }))
    expect(watched.view.getByTestId("terminal-space-card-watch").textContent).toContain(
      "Stop letting them watch",
    )
    watched.view.unmount()
    const shared = cardOf(
      session({ space: "shared", watchers: [{ id: "u_quinn", kind: "human", name: "Quinn QA" }] }),
    )
    expect(shared.view.getByTestId("terminal-space-card-text").textContent).toContain("workspace")
    expect(shared.view.getByTestId("terminal-space-card-here").textContent).toContain("Quinn")
    expect(shared.view.queryByTestId("terminal-space-card-watch")).toBeNull()
    expect(shared.view.queryByTestId("terminal-space-card-shared")).toBeNull()
    shared.view.unmount()
    const theirs = cardOf(session({ createdBy: "u_quinn", watchable: true }))
    expect(theirs.view.getByTestId("terminal-space-card-text").textContent).toContain(
      "cannot type",
    )
    expect(theirs.view.queryByTestId("terminal-space-card-watch")).toBeNull()
  })

  it("[TW-AC-25] a personal terminal with Agent off is quiet: no icon of its own, no marks, no ring", () => {
    const mine = session({})
    const state = toolbarOf(mine, ME)
    expect(terminalTabIcon(mine, state, t)).toBeNull()
    expect(terminalTabMarks(mine, state, ME, t)).toEqual([])
    expect(state.consent).toBe(false)
  })

  it("[TW-AC-25] with Agent on the tab's icon is the agent glyph in the accent colour, and the window asks for the ring", () => {
    const on = session({ agentControl: true })
    const state = toolbarOf(on, ME)
    expect(terminalTabIcon(on, state, t)).toMatchObject({ icon: "robot", tone: "accent" })
    expect(terminalTabIcon(on, state, t)?.tooltip).toContain("Agent on")
    expect(state.consent).toBe(true)
  })

  it("[TW-AC-25] while an agent types the icon is that agent's face, pulsing, and the tooltip names it", () => {
    const typing = session({
      agentControl: true,
      driver: {
        kind: "agent",
        id: "agent:ada",
        name: "Ada Lovelace",
        avatarUrl: "/a.png",
        since: 1,
      },
    })
    expect(terminalTabIcon(typing, toolbarOf(typing, ME), t)).toEqual({
      face: { id: "agent:ada", name: "Ada", imageUrl: "/a.png", agent: true },
      pulse: true,
      tooltip: "Ada is typing",
    })
  })

  it("[TW-AC-25] a shared terminal is marked on its tab with the people in it besides me; alone, with the shared glyph", () => {
    const busy = session({
      space: "shared",
      watchers: [
        { id: ME, kind: "human", name: "Me" },
        { id: "u_quinn", kind: "human", name: "Quinn QA" },
        { id: "agent:ada", kind: "agent", name: "Ada" },
        "u_legacy",
      ],
    })
    const [mark] = terminalTabMarks(busy, toolbarOf(busy, ME), ME, t)
    expect(mark).toMatchObject({ id: "shared", icon: "users" })
    expect(mark.faces?.map((f) => f.id)).toEqual(["u_quinn", "agent:ada", "u_legacy"])
    expect(mark.label).toContain("Quinn")
    const alone = session({ space: "shared" })
    expect(terminalTabMarks(alone, toolbarOf(alone, ME), ME, t)).toEqual([
      { id: "shared", icon: "users", faces: [], label: "Shared" },
    ])
  })

  it("[TW-AC-25] a personal terminal others may watch carries an eye with how many are watching; one I only watch, an eye that says view only", () => {
    const watched = session({
      watchable: true,
      watchers: [
        { id: ME, kind: "human", name: "Me" },
        { id: "u_quinn", kind: "human", name: "Quinn" },
      ],
    })
    expect(terminalTabMarks(watched, toolbarOf(watched, ME), ME, t)).toMatchObject([
      { id: "watched", icon: "eye", count: 1 },
    ])
    const theirs = session({ createdBy: "u_quinn", watchable: true })
    const [mark] = terminalTabMarks(theirs, toolbarOf(theirs, ME), ME, t)
    expect(mark).toMatchObject({ id: "view-only", icon: "eye" })
    expect(mark.label).toContain("not type")
  })
})

describe("the Terminal's section of the window menus", () => {
  it("[TW-AC-25] my personal terminal offers, in order: go to session, rename, the three new terminals, then End session apart; nothing the pill already offers", () => {
    const entries = menuOf(session({}))
    expect(entries.map((e) => e.id)).toEqual([
      "go-session",
      "rename",
      "new-personal",
      "new-shared",
      "new-side",
      "end",
    ])
    expect(entries.at(-1)).toMatchObject({ danger: true, separated: true, label: "End session" })
    expect(entry(session({}), "go-session")?.shortcut).toBe("⌘⇧O")
    expect(menuOf(session({}), actions(), { mac: false })[0].shortcut).toBe("Ctrl+Shift+Alt+O")
    for (const s of [session({ agentControl: true }), session({ watchable: true })])
      expect(menuOf(s).filter((e) => e.id === "agent" || e.id === "watch")).toEqual([])
  })

  it("[TW-AC-25] the pill's chip says the space, and what is true of it", () => {
    const said = (s: TerminalSession) => {
      const p = pillOf(s)
      const text = p.space.textContent
      p.view.unmount()
      return text
    }
    expect(said(session({}))).toBe("Personal")
    expect(said(session({ space: "shared" }))).toBe("Shared")
    expect(said(session({ watchable: true }))).toBe("Personal · others can watch")
    expect(said(session({ createdBy: "u_quinn", watchable: true }))).toBe("Personal · view only")
    expect(said(session({ createdBy: "agent:app_1", openedBy: "agent", space: "shared" }))).toBe(
      "Shared · agent session",
    )
  })

  it("[TW-AC-25] each entry does its one thing", () => {
    const a = actions()
    const press = (id: string) => entry(session({}), id, a)?.onPress()
    press("go-session")
    press("rename")
    press("new-personal")
    press("new-shared")
    press("new-side")
    press("end")
    expect(a.goToSession).toHaveBeenCalledTimes(1)
    expect(a.rename).toHaveBeenCalledTimes(1)
    expect(a.openNew.mock.calls).toEqual([["personal"], ["shared"]])
    expect(a.openToSide).toHaveBeenCalledTimes(1)
    expect(a.end).toHaveBeenCalledTimes(1)
  })

  it("[TW-AC-25] a terminal I only watch offers no rename, no watch and no End session", () => {
    const theirs = session({ createdBy: "u_quinn", watchable: true })
    expect(menuOf(theirs).map((e) => e.id)).toEqual([
      "go-session",
      "new-personal",
      "new-shared",
      "new-side",
    ])
  })
})

describe("the quick switcher", () => {
  const rows = [
    session({ terminalId: "t_mine", title: "Shell 1" }),
    session({ terminalId: "t_deploy", title: "Deploy", space: "shared" }),
    session({ terminalId: "t_build", title: "Build and test", space: "shared" }),
  ]
  const list = (extra: Record<string, unknown> = {}) =>
    ui(
      <SessionsList
        groups={sessionGroups(rows, ME, new Set())}
        currentId="t_mine"
        me={ME}
        onPick={() => {}}
        onNew={() => {}}
        onClose={() => {}}
        {...extra}
      />,
    )

  it("[TW-AC-25] typing narrows the list to the sessions and new-terminal rows that match", () => {
    const { getByTestId, queryByTestId } = list()
    fireEvent.change(getByTestId("terminal-sessions-search"), { target: { value: "dep" } })
    expect(queryByTestId("terminal-sessions-row-t_deploy")).toBeTruthy()
    expect(queryByTestId("terminal-sessions-row-t_mine")).toBeNull()
    expect(queryByTestId("terminal-sessions-new")).toBeNull()
    fireEvent.change(getByTestId("terminal-sessions-search"), { target: { value: "zzz" } })
    expect(getByTestId("terminal-sessions").textContent).toContain("No session matches")
  })

  it("[TW-AC-25] Enter goes to the highlighted row; the arrows move the highlight; Escape closes", () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    const { getByTestId } = list({ onPick, onClose })
    const search = getByTestId("terminal-sessions-search")
    expect(getByTestId("terminal-sessions-row-t_mine").getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(search, { key: "ArrowDown" })
    expect(getByTestId("terminal-sessions-row-t_deploy").getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(search, { key: "Enter" })
    expect(onPick).toHaveBeenCalledWith("t_deploy")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[TW-AC-25] Enter on a new-terminal row asks for that terminal; each session row carries the marks of its tab", () => {
    const onNew = vi.fn()
    const { getByTestId } = list({ onNew })
    const search = getByTestId("terminal-sessions-search")
    fireEvent.change(search, { target: { value: "new shared" } })
    fireEvent.keyDown(search, { key: "Enter" })
    expect(onNew).toHaveBeenCalledWith("shared")
    fireEvent.change(search, { target: { value: "" } })
    expect(
      getByTestId("terminal-sessions-row-t_deploy").querySelector(
        '[data-testid="window-mark-shared"]',
      ),
    ).toBeTruthy()
    expect(
      getByTestId("terminal-sessions-row-t_mine").querySelector('[data-testid="window-marks"]'),
    ).toBeNull()
  })
})

describe("a session leaving my list", () => {
  it("[TW-AC-15] when I stop letting the workspace watch my session it stays in my list; for the others it goes", () => {
    const mine = session({ terminalId: "t1", createdBy: ME })
    const unshared = { reason: "unwatchable", session: null }
    expect(endsSessionFor(unshared, mine, ME)).toBe(false)
    expect(endsSessionFor(unshared, mine, "u_quinn")).toBe(true)
    expect(endsSessionFor({ reason: "exit", session: null }, mine, ME)).toBe(true)
    expect(endsSessionFor({ reason: "title", session: mine }, mine, ME)).toBe(false)
  })
})

describe("the sessions list", () => {
  const sessions = [
    session({ terminalId: "t_mine", title: "Shell 1" }),
    session({ terminalId: "t_shared_mine", title: "Deploy", watchable: true }),
    session({
      terminalId: "t_agent",
      title: "Build",
      createdBy: "agent:app_1",
      openedBy: "agent",
      agentControl: true,
    }),
    session({ terminalId: "t_theirs", title: "Quinn's", createdBy: "u_quinn", watchable: true }),
  ]

  it("[TW-AC-4] groups my sessions, the agents' and the ones others let me watch, and marks those with a window", () => {
    const groups = sessionGroups(sessions, ME, new Set(["t_mine"]))
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.session.terminalId)])).toEqual([
      ["mine", ["t_mine", "t_shared_mine"]],
      ["agents", ["t_agent"]],
      ["watching", ["t_theirs"]],
    ])
    expect(groups[0].rows.map((r) => r.open)).toEqual([true, false])
  })

  it("[TW-AC-4] picking a row asks for that session; the current one is marked", () => {
    const onPick = vi.fn()
    const { getByTestId } = ui(
      <SessionsList
        groups={sessionGroups(sessions, ME, new Set(["t_mine"]))}
        currentId="t_mine"
        onPick={onPick}
        onNew={() => {}}
        onClose={() => {}}
      />,
    )
    expect(getByTestId("terminal-sessions-row-t_mine").getAttribute("aria-current")).toBe("true")
    fireEvent.click(getByTestId("terminal-sessions-row-t_agent"))
    expect(onPick).toHaveBeenCalledWith("t_agent")
  })

  it("[FLOAT-AC-16] each row of the list carries the same status mark as that session's tab", () => {
    useSessionMarks.setState({ finished: {} })
    markFinished("t_done", true)
    const at = "2026-11-10T10:05:00.000Z"
    const rows = [
      session({ terminalId: "t_work", agentState: { state: "working", at } }),
      session({ terminalId: "t_block", agentState: { state: "blocked", at } }),
      session({ terminalId: "t_done", agentState: { state: "done", at } }),
      session({ terminalId: "t_quiet" }),
      session({
        terminalId: "t_asked",
        wheelRequest: { agent: { id: "agent:ada", name: "Ada" }, reason: null, at: 1 },
      }),
    ]
    const { getByTestId } = ui(
      <SessionsList
        groups={sessionGroups(rows, ME, new Set())}
        currentId={null}
        me={ME}
        onPick={() => {}}
        onNew={() => {}}
        onClose={() => {}}
      />,
    )
    const mark = (id: string, kind: string) =>
      getByTestId(`terminal-sessions-row-${id}`).querySelector(
        `[data-testid="window-status-${kind}"]`,
      )
    expect(mark("t_work", "working")).toBeTruthy()
    expect(mark("t_block", "needs-you")).toBeTruthy()
    expect(mark("t_asked", "needs-you")).toBeTruthy()
    expect(mark("t_done", "finished")).toBeTruthy()
    expect(
      getByTestId("terminal-sessions-row-t_quiet").querySelector('[data-testid^="window-status-"]'),
    ).toBeNull()
  })

  it("[TW-AC-1] the list's New terminal asks for a new window", () => {
    const onNew = vi.fn()
    const { getByTestId } = ui(
      <SessionsList
        groups={[]}
        currentId={null}
        onPick={() => {}}
        onNew={onNew}
        onClose={() => {}}
      />,
    )
    fireEvent.click(getByTestId("terminal-sessions-new"))
    expect(onNew).toHaveBeenCalled()
  })
})

describe("the toolbar", () => {
  it("[TW-AC-9] my own session starts with Agent off and I may switch it", () => {
    expect(toolbarOf(session({}), ME)).toMatchObject({
      consent: false,
      canToggle: true,
      space: "personal",
      mine: true,
      viewOnly: false,
    })
  })

  it("[TW-AC-9] an agent's session shows Agent on, and is view-only while the agent types", () => {
    const s = session({
      createdBy: "agent:app_1",
      openedBy: "agent",
      agentControl: true,
      driver: { kind: "agent", id: "a1", name: "Rex Dev", since: 1 },
    })
    expect(toolbarOf(s, ME)).toMatchObject({
      consent: true,
      canToggle: true,
      space: "shared",
      agentOpened: true,
      viewOnly: true,
      typist: { kind: "agent", name: "Rex" },
    })
  })

  it("[TW-AC-12] in a personal session someone lets me watch, I never switch the flag", () => {
    const theirs = session({ createdBy: "u_quinn", watchable: true })
    expect(toolbarOf(theirs, ME).canToggle).toBe(false)
    expect(
      toolbarOf({ ...theirs, driver: { kind: "human", id: ME, since: 1 } }, ME).canToggle,
    ).toBe(false)
  })

  it("[TW-AC-9] the pill's switch says the state and one click sends the opposite value; its tooltip carries the shortcut while it is on", () => {
    const off = pillOf(session({}))
    expect(off.toggle.textContent).toBe("Agent off")
    expect(off.agent.getAttribute("title")).not.toContain("⌘⇧K")
    fireEvent.click(off.toggle)
    expect(off.onToggleAgent).toHaveBeenLastCalledWith(true)
    off.view.unmount()
    const on = pillOf(session({ agentControl: true }))
    expect(on.toggle.textContent).toBe("Agent")
    expect(on.agent.getAttribute("title")).toContain("⌘⇧K")
    fireEvent.click(on.toggle)
    expect(on.onToggleAgent).toHaveBeenLastCalledWith(false)
  })

  it("[TW-AC-15] a session the workspace may watch is marked at all times; a personal one says Personal and nothing else", () => {
    const watched = session({ watchable: true })
    expect(terminalTabMarks(watched, toolbarOf(watched, ME), ME, t).map((m) => m.id)).toEqual([
      "watched",
    ])
    const said = pillOf(watched)
    expect(said.space.textContent).toContain("others can watch")
    said.view.unmount()
    expect(pillOf(session({})).space.textContent).toBe("Personal")
  })

  it("[TW-AC-12] someone who may not switch the flag gets a disabled switch that says why, on hover and on a press", () => {
    const theirs = pillOf(session({ createdBy: "u_quinn", watchable: true }))
    expect(theirs.toggle.getAttribute("aria-disabled")).toBe("true")
    expect(theirs.agent.getAttribute("title")).toBe("Only its person switches Agent here")
    fireEvent.click(theirs.toggle)
    expect(theirs.onToggleAgent).not.toHaveBeenCalled()
    fireEvent.click(theirs.agent)
    expect(theirs.onReason).toHaveBeenCalledWith("Only its person switches Agent here")
  })

  it("[TW-AC-12] in a shared terminal a colleague who typed within the minute keeps the switch: it is disabled and names them", () => {
    const NOW = 1_800_000_000_000
    const shared = session({
      space: "shared",
      driver: { kind: "human", id: "u_quinn", name: "Quinn QA", since: NOW - 5 * 60_000 },
      lastInput: { kind: "human", id: "u_quinn", at: NOW - 10_000 },
    })
    const busy = pillOf(shared, NOW)
    expect(busy.toggle.getAttribute("aria-disabled")).toBe("true")
    expect(busy.agent.getAttribute("title")).toBe("Quinn typed here in the last minute")
    busy.view.unmount()
    const free = pillOf(shared, NOW + 61_000)
    expect(free.toggle.getAttribute("aria-disabled")).not.toBe("true")
    expect(free.agent.getAttribute("title")).toContain("Agent off")
  })
})
