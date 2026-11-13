import { fireEvent, render, within } from "@testing-library/react"
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
  openWindow: vi.fn(),
}))
vi.mock("../../store/tilingStore", () => ({ useTilingStore: { getState: () => tiling } }))
vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => null }))

import {
  markSharedNoticeSeen,
  othersIn,
  sharedNoticeSeen,
} from "../../components/sharing/sharedSpace"
import { SharedSpaceNotice } from "../../components/sharing/SharedSpaceNotice"
import { SpaceBadge } from "../../components/sharing/SpaceBadge"
import { SpaceChoice } from "../../components/sharing/SpaceChoice"
import { terminalWindowDefinition } from "./definition"
import { SessionsList } from "./SessionsList"
import type { TFunction } from "i18next"
import { TerminalCornerPill } from "./TerminalCornerPill"
import { TerminalSpaceCard } from "./TerminalSpaceCard"
import { agentReason, terminalMenu, terminalTabMarks } from "./terminalChrome"
import { endsSessionFor, type TerminalSession } from "./terminalSessions"
import {
  needsSpaceChoice,
  nextWindowProps,
  sessionGroups,
  toolbarOf,
} from "./terminalWindowModel"

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

const t = ((key: string, o?: Record<string, string>) =>
  (o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => o?.[k] ?? "")) as unknown as TFunction
const actions = () => ({
  goToSession: vi.fn(),
  rename: vi.fn(),
  openNew: vi.fn(),
  openToSide: vi.fn(),
  end: vi.fn(),
})
const said = (s: TerminalSession, a = actions()) => {
  const state = toolbarOf(s, ME)
  const view = ui(
    <TerminalCornerPill
      state={state}
      reason={agentReason(s, state, t, { me: ME })}
      onToggleAgent={() => {}}
      onSpace={() => {}}
    />,
  )
  const caption = view.getByTestId("terminal-space").textContent ?? ""
  const agentDisabled = view.getByTestId("terminal-agent-toggle").getAttribute("aria-disabled")
  view.unmount()
  return {
    caption,
    agentDisabled: agentDisabled === "true",
    marks: terminalTabMarks(s, state, ME, t),
    menu: terminalMenu(s, state, t, a, { me: ME, mac: true, sideSpace: "personal" }),
  }
}
const card = (s: TerminalSession) => {
  const onLetWatch = vi.fn()
  const view = ui(
    <TerminalSpaceCard
      session={s}
      state={toolbarOf(s, ME)}
      me={ME}
      top={50}
      onLetWatch={onLetWatch}
      onNewShared={() => {}}
      onClose={() => {}}
    />,
  )
  return { view, onLetWatch }
}

beforeEach(() => {
  tiling.windows = {}
  tiling.openWindow.mockClear()
})

describe("what I may do in a terminal comes from its space", () => {
  it("[SPACE-AC-20] my personal terminal is mine alone: I type, switch Agent and may let the workspace watch", () => {
    expect(toolbarOf(session({}), ME)).toMatchObject({
      space: "personal",
      mine: true,
      watching: false,
      watchable: false,
      canLetWatch: true,
      canToggle: true,
      viewOnly: false,
    })
  })

  it("[SPACE-AC-20] a shared terminal someone else opened is as much mine: I type and switch Agent, and there is nothing to let watch", () => {
    const shared = session({ createdBy: "u_quinn", space: "shared" })
    expect(toolbarOf(shared, ME)).toMatchObject({
      space: "shared",
      mine: false,
      watching: false,
      canLetWatch: false,
      canToggle: true,
      viewOnly: false,
    })
  })

  it("[SPACE-AC-20] while someone else types in a shared terminal only they switch Agent; a minute after their last key anyone does", () => {
    const NOW = 1_800_000_000_000
    const shared = session({
      createdBy: ME,
      space: "shared",
      driver: { kind: "human", id: "u_quinn", name: "Quinn", since: NOW - 5 * 60_000 },
      lastInput: { kind: "human", id: "u_quinn", at: NOW - 10_000 },
    })
    expect(toolbarOf(shared, ME, "write", NOW).canToggle).toBe(false)
    expect(toolbarOf(shared, ME, "write", NOW + 60_000).canToggle).toBe(true)
    expect(
      toolbarOf({ ...shared, driver: { kind: "human", id: ME, since: NOW } }, ME, "write", NOW)
        .canToggle,
    ).toBe(true)
    const justTook = { ...shared, lastInput: null, driver: { ...shared.driver!, since: NOW - 1_000 } }
    expect(toolbarOf(justTook, ME, "write", NOW).canToggle).toBe(false)
  })


  it("[SPACE-AC-20] a colleague who typed within the minute keeps the switch even after I take the keyboard", () => {
    const NOW = 1_800_000_000_000
    const shared = session({
      space: "shared",
      driver: { kind: "human", id: ME, since: NOW - 1_000 },
      watchers: [{ id: "u_quinn", kind: "human", name: "Quinn", typingAt: NOW - 5_000 }],
    })
    expect(toolbarOf(shared, ME, "write", NOW).canToggle).toBe(false)
    expect(toolbarOf(shared, ME, "write", NOW + 61_000).canToggle).toBe(true)
    const onlyMe = {
      ...shared,
      watchers: [{ id: ME, kind: "human" as const, name: "Me", typingAt: NOW }],
    }
    expect(toolbarOf(onlyMe, ME, "write", NOW).canToggle).toBe(true)
  })

  it("[SPACE-AC-21] the tab's mark says what is true of this terminal: watched, or only watching; mine alone says nothing", () => {
    expect(said(session({})).marks).toEqual([])
    const watched = said(session({ watchable: true })).marks
    expect(watched.map((m) => m.id)).toEqual(["watched"])
    expect(watched[0].label).toContain("the workspace can watch it")
    const theirs = said(session({ createdBy: "u_quinn", watchable: true })).marks
    expect(theirs.map((m) => m.id)).toEqual(["view-only"])
    expect(theirs[0].label).toContain("you can watch it, not type in it")
  })

  it("[SPACE-AC-20] a personal terminal someone lets me watch is view only: no typing, no switch, nothing to manage", () => {
    const theirs = session({ createdBy: "u_quinn", watchable: true })
    expect(toolbarOf(theirs, ME)).toMatchObject({
      space: "personal",
      mine: false,
      watching: true,
      canLetWatch: false,
      canToggle: false,
      canManage: false,
      viewOnly: true,
    })
    expect(
      toolbarOf({ ...theirs, driver: { kind: "human", id: ME, since: 1 } }, ME).canToggle,
    ).toBe(false)
  })

  it("[SPACE-AC-20] a session with no space on record is personal when a person opened it and shared when an agent did", () => {
    expect(toolbarOf(session({ space: undefined }), ME).space).toBe("personal")
    expect(
      toolbarOf(session({ space: undefined, createdBy: "agent:app_1", openedBy: "agent" }), ME),
    ).toMatchObject({ space: "shared", agentOpened: true, canLetWatch: false })
  })
})

describe("the window says which space it is in, with the same badge everywhere", () => {
  it("[SPACE-AC-21] the badge reads Personal with a lock, Shared with people", () => {
    const personal = ui(<SpaceBadge space="personal" testID="b" />)
    expect(personal.getByTestId("b").textContent).toContain("Personal")
    expect(personal.getByTestId("b").getAttribute("data-space")).toBe("personal")
    personal.unmount()
    const shared = ui(<SpaceBadge space="shared" testID="b" />)
    expect(shared.getByTestId("b").textContent).toContain("Shared")
    expect(shared.getByTestId("b").getAttribute("data-space")).toBe("shared")
  })

  it("[SPACE-AC-21] the Terminal says its space at all times: on its corner pill in both spaces, and on the tab when it is not mine alone", () => {
    expect(said(session({})).caption).toBe("Personal")
    const shared = said(session({ space: "shared" }))
    expect(shared.caption).toBe("Shared")
    expect(shared.marks.map((m) => m.id)).toEqual(["shared"])
    const agents = said(session({ createdBy: "agent:app_1", openedBy: "agent", space: "shared" }))
    expect(agents.caption).toContain("Shared")
    expect(agents.marks.map((m) => m.id)).toEqual(["shared"])
  })

  it("[SPACE-AC-21] a personal terminal the workspace may watch says so, and only its person can stop it", () => {
    const mine = said(session({ watchable: true }))
    expect(mine.caption).toContain("others can watch")
    expect(mine.menu.find((e) => e.id === "watch")).toBeUndefined()
    const own = card(session({ watchable: true }))
    const stop = own.view.getByTestId("terminal-space-card-watch")
    expect(stop.textContent).toContain("Stop letting them watch")
    fireEvent.click(stop)
    expect(own.onLetWatch).toHaveBeenCalledTimes(1)
    own.view.unmount()
    const theirs = said(session({ createdBy: "u_quinn", watchable: true }))
    expect(theirs.caption).toContain("view only")
    const watched = card(session({ createdBy: "u_quinn", watchable: true }))
    expect(watched.view.queryByTestId("terminal-space-card-watch")).toBeNull()
  })

  it("[SPACE-AC-21] someone who only watches gets a disabled Agent switch", () => {
    const theirs = said(session({ createdBy: "u_quinn", watchable: true }))
    expect(theirs.agentDisabled).toBe(true)
    expect(theirs.menu.find((e) => e.id === "agent")).toBeUndefined()
  })
})

describe("the sessions list", () => {
  const sessions = [
    session({ terminalId: "t_mine" }),
    session({ terminalId: "t_ours", space: "shared" }),
    session({ terminalId: "t_theirs_shared", space: "shared", createdBy: "u_quinn" }),
    session({ terminalId: "t_agent", createdBy: "agent:app_1", openedBy: "agent", space: "shared" }),
    session({ terminalId: "t_watched", createdBy: "u_quinn", watchable: true }),
  ]

  it("[SPACE-AC-22] groups my personal terminals, the shared ones, the agents' and the ones I may watch", () => {
    const groups = sessionGroups(sessions, ME, new Set(["t_mine"]))
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.session.terminalId)])).toEqual([
      ["mine", ["t_mine"]],
      ["shared", ["t_ours", "t_theirs_shared"]],
      ["agents", ["t_agent"]],
      ["watching", ["t_watched"]],
    ])
  })

  it("[SPACE-AC-22] offers a new personal terminal and a new shared one, side by side", () => {
    const onNew = vi.fn()
    const { getByTestId } = ui(
      <SessionsList
        groups={sessionGroups(sessions, ME, new Set())}
        currentId={null}
        me={ME}
        onPick={() => {}}
        onNew={onNew}
        onClose={() => {}}
      />,
    )
    fireEvent.click(getByTestId("terminal-sessions-new"))
    fireEvent.click(getByTestId("terminal-sessions-new-shared"))
    expect(onNew.mock.calls).toEqual([["personal"], ["shared"]])
    expect(getByTestId("terminal-sessions-new").textContent).toContain("New personal terminal")
    expect(getByTestId("terminal-sessions-new-shared").textContent).toContain("New shared terminal")
  })

  it("[SPACE-AC-15] when someone stops letting me watch, the session leaves my list; my own stays", () => {
    expect(endsSessionFor({ reason: "unwatchable" }, { createdBy: "u_quinn" }, ME)).toBe(true)
    expect(endsSessionFor({ reason: "unwatchable" }, { createdBy: ME }, ME)).toBe(false)
  })
})

describe("opening a terminal: mine or the workspace's", () => {
  it("[SPACE-AC-23] a new window carries the space it was asked for, personal when nothing was said", () => {
    expect(nextWindowProps({}, "work_a")).toMatchObject({ space: "personal", pendingCreate: true })
    expect(nextWindowProps({}, "work_a", "shared")).toMatchObject({
      space: "shared",
      pendingCreate: true,
    })
    expect(nextWindowProps({ terminalId: "t9" }, "work_a", "shared")).toBeNull()
  })

  it("[SPACE-AC-23] a window opened with no session asks which space only when the workspace has other members", () => {
    expect(needsSpaceChoice({}, 2)).toBe(true)
    expect(needsSpaceChoice({}, 0)).toBe(false)
    expect(needsSpaceChoice({}, null)).toBe(false)
    expect(needsSpaceChoice({ space: "shared" }, 2)).toBe(false)
    expect(needsSpaceChoice({ terminalId: "t1" }, 2)).toBe(false)
  })

  it("[SPACE-AC-23] the space is not what the layout saves: a reloaded window shows its session, whatever its space", () => {
    const saved = terminalWindowDefinition.serialize?.({
      workspaceId: "work_a",
      terminalId: "t1",
      space: "shared",
      pendingCreate: true,
    })
    expect(saved).not.toHaveProperty("space")
    expect(saved).not.toHaveProperty("pendingCreate")
  })

  it("[SPACE-AC-23] the choice is the app-settings one: Personal preselected, Shared one click away", () => {
    const onPick = vi.fn()
    const { getByTestId } = ui(<SpaceChoice kind="terminal" workspaceName="Dev Team" onPick={onPick} />)
    expect(getByTestId("space-choice-personal").getAttribute("aria-checked")).toBe("true")
    expect(getByTestId("space-choice-shared").getAttribute("aria-checked")).toBe("false")
    expect(getByTestId("space-choice-shared").textContent).toContain("Dev Team")
    fireEvent.click(getByTestId("space-choice-open"))
    fireEvent.click(within(getByTestId("space-choice-shared")).getByRole("button"))
    expect(getByTestId("space-choice-shared").getAttribute("aria-checked")).toBe("true")
    fireEvent.click(getByTestId("space-choice-open"))
    expect(onPick.mock.calls).toEqual([["personal"], ["shared"]])
  })

  it("[SPACE-AC-23] other members are the active members besides the owner: the workspace hides their ids, so they are counted", () => {
    expect(othersIn({ members: [] })).toBe(0)
    expect(othersIn({})).toBe(0)
    expect(othersIn({ members: [{ role: "write", status: "active" }] })).toBe(1)
    expect(othersIn({ members: [{ role: "read" }, { role: "admin", status: "active" }] })).toBe(2)
    expect(othersIn({ members: [{ role: "write", status: "pending" }] })).toBe(0)
  })

})

describe("a shared terminal warns once", () => {
  const store = () => {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
  }

  it("[SPACE-AC-24] the warning is remembered per person, workspace and kind of thing", () => {
    const s = store()
    expect(sharedNoticeSeen("terminal", "work_a", ME, s)).toBe(false)
    markSharedNoticeSeen("terminal", "work_a", ME, s)
    expect(sharedNoticeSeen("terminal", "work_a", ME, s)).toBe(true)
    expect(sharedNoticeSeen("terminal", "work_b", ME, s)).toBe(false)
    expect(sharedNoticeSeen("terminal", "work_a", "u_quinn", s)).toBe(false)
    expect(sharedNoticeSeen("browser", "work_a", ME, s)).toBe(false)
  })

  it("[SPACE-AC-24] it says in plain words that what you sign in to there is everybody's, and goes away when read", () => {
    const onDismiss = vi.fn()
    const { getByTestId } = ui(
      <SharedSpaceNotice kind="terminal" workspaceName="Dev Team" onDismiss={onDismiss} />,
    )
    const text = getByTestId("shared-space-notice").textContent ?? ""
    expect(text).toContain("Dev Team")
    expect(text).toContain("sign in")
    expect(text).toContain("everybody")
    fireEvent.click(getByTestId("shared-space-notice-ok"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
