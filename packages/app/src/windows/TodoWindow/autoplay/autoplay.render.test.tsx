/**
 * To Do autoplay — window side (docs/specs/todo/autoplay/spec.md):
 *   - the Autoplay chip + runner panel (TODOAP-AC-13);
 *   - the chip in the window header of both views, toggling the panel (TODOAP-AC-25);
 *   - the conversation icon in tree/day rows and the detail header chip
 *     (TODOAP-AC-14);
 *   - two kinds of working: the animated dot only while `running` (TODOAP-AC-26);
 *   - the runner's "Also picks up" scope menu (TODOAP-AC-32).
 * The todo-list tool path (callTodo) and the client are mocked.
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/autoplay
 */
import { act, fireEvent, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { DayTask, NodeDetail, TreeNode } from "../model/types"

// ─── Mocks ──────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const handlers = new Map<string, Set<(m: unknown) => void>>()
  const state = {
    runners: [] as Array<Record<string, unknown>>,
    runningCount: 0,
    nodes: {} as Record<string, unknown>,
    tree: [] as unknown[],
    calls: [] as Array<{ tool: string; input: Record<string, unknown> }>,
  }
  const client = {
    on: (ev: string, fn: (m: unknown) => void) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set())
      handlers.get(ev)!.add(fn)
    },
    off: (ev: string, fn: (m: unknown) => void) => handlers.get(ev)?.delete(fn),
    app: { subscribeTodo: async () => ({ userId: "u1" }) },
    workspace: {
      listMembers: async () => ({
        members: [
          { type: "agent", id: "atlas", name: "Atlas" },
          { type: "agent", id: "iria", name: "Iria" },
          { type: "agent", id: "nora", name: "Nora" },
        ],
      }),
    },
  }
  const emit = (ev: string, msg: unknown) => handlers.get(ev)?.forEach((fn) => fn(msg))
  const callTodo = async (_appId: string, tool: string, input: Record<string, unknown>) => {
    state.calls.push({ tool, input })
    if (tool === "get-autoplay") return { runners: state.runners, runningCount: state.runningCount }
    if (tool === "stop-autoplay") return { globalPlaying: false, aborted: state.runningCount }
    if (tool === "get-node") return { node: state.nodes[input.nodeId as string] }
    if (tool === "get-tree") return { tree: state.tree }
    return {}
  }
  return { client, emit, state, callTodo }
})

vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))
vi.mock("../data/todoApi", () => ({
  callTodo: (...a: [string, string, Record<string, unknown>]) => h.callTodo(...a),
  TodoError: class extends Error {},
}))

const WS = "ws1"
const APP = "app1"
const WHOLE = { scopeNodeId: null, scopePath: null, pickUnassigned: false, scopeMissing: false }

beforeEach(() => {
  h.state.runners = [
    { agentId: "atlas", name: "Atlas", slots: 2, playEnabled: true, activeSlots: 0, ...WHOLE },
    { agentId: "iria", name: "Iria", slots: 1, playEnabled: false, activeSlots: 0, ...WHOLE },
  ]
  h.state.runningCount = 0
  h.state.calls = []
})

// ─── TODOAP-AC-13: chip + panel ────────────────────────────────────────────────────

describe("autoplay panel", () => {
  it("[TODOAP-AC-13] chip counts playing runners, the panel lists status lines and applies todo_autoplay_changed live", async () => {
    const { AutoplayChip, AutoplayPanelHost } = await import("./AutoplayPanel")
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <>
        <AutoplayChip appId={APP} workspaceId={WS} windowId="w1" />
        <AutoplayPanelHost appId={APP} workspaceId={WS} windowId="w1" onError={() => {}} />
      </>,
    )
    const chip = getByTestId("todo-autoplay-chip")
    await waitFor(() => expect(chip.textContent).toBe("Autoplay · 1"))
    expect(queryByTestId("todo-autoplay-panel")).toBeNull()

    fireEvent.click(chip)
    const panel = await waitFor(() => getByTestId("todo-autoplay-panel"))
    expect(getByTestId("todo-autoplay-runner-atlas").textContent).toContain("Atlas")
    expect(getByTestId("todo-autoplay-status-atlas").textContent).toBe("Waiting for tasks")
    expect(getByTestId("todo-autoplay-status-iria").textContent).toBe("Paused")
    expect(getByTestId("todo-autoplay-runner-atlas").textContent).toContain("0/2 in progress")
    expect(panel.textContent).toContain(
      "Teros wakes each runner when one of its tasks is pending and planned for today or earlier, honouring slots. Agents move tasks to Review; you move them to Done. Limit of 5 auto-wakes per task.",
    )

    // A live event (no reload): Atlas picks up a task, Iria gets play on.
    act(() => {
      h.emit("todo_autoplay_changed", { workspaceId: WS, agentId: "atlas", slots: 2, playEnabled: true, activeSlots: 1 })
      h.emit("todo_autoplay_changed", { workspaceId: WS, agentId: "iria", slots: 1, playEnabled: true, activeSlots: 0 })
    })
    expect(getByTestId("todo-autoplay-status-atlas").textContent).toBe("Working")
    expect(getByTestId("todo-autoplay-runner-atlas").textContent).toContain("1/2 in progress")
    expect(getByTestId("todo-autoplay-status-iria").textContent).toBe("Waiting for tasks")
    expect(chip.textContent).toBe("Autoplay · 2")

    // An event of another workspace is ignored.
    act(() => h.emit("todo_autoplay_changed", { workspaceId: "other", agentId: "atlas", slots: 2, playEnabled: false, activeSlots: 0 }))
    expect(getByTestId("todo-autoplay-status-atlas").textContent).toBe("Working")

    // A removal elsewhere drops the row.
    act(() => h.emit("todo_autoplay_changed", { workspaceId: WS, agentId: "iria", slots: 0, playEnabled: false, activeSlots: 0, removed: true }))
    expect(queryByTestId("todo-autoplay-runner-iria")).toBeNull()
  })

  it("[TODOAP-AC-13] play is disabled at 0 slots", async () => {
    const { AutoplayPanel } = await import("./AutoplayPanel")
    const onSetPlay = vi.fn()
    const { getByTestId } = renderWithTamagui(
      <AutoplayPanel
        runners={[{ agentId: "nora", name: "Nora", slots: 0, playEnabled: false, activeSlots: 0, ...WHOLE }]}
        globalPlaying={true}
        runningCount={0}
        agents={[]}
        onSetSlots={() => {}}
        onSetPlay={onSetPlay}
        onSetGlobalPlay={() => {}}
        onStopAutoplay={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(getByTestId("todo-autoplay-play-nora"))
    expect(onSetPlay).not.toHaveBeenCalled()
  })
})

// ─── TODOAP-AC-41: global play/pause, separate from the runner config ──────

describe("global play/pause", () => {
  /** Alice disabled + Nira enabled (Pablo's case): the global row reads both levels. */
  const ALICE = { agentId: "alice", name: "Alice", slots: 2, playEnabled: false, activeSlots: 0, ...WHOLE }
  const NIRA = { agentId: "nira", name: "Nira", slots: 2, playEnabled: true, activeSlots: 0, ...WHOLE }

  it("[TODOAP-AC-41] the panel has the global Play/Pause section above the runner configuration; the state line reads both levels", async () => {
    const { AutoplayPanel } = await import("./AutoplayPanel")
    const { getByTestId, getByText } = renderWithTamagui(
      <AutoplayPanel
        runners={[ALICE, NIRA]}
        globalPlaying={true}
        runningCount={0}
        agents={[]}
        onSetSlots={() => {}}
        onSetPlay={() => {}}
        onSetGlobalPlay={() => {}}
        onStopAutoplay={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    )
    // The two sections: the global row, then the CONFIG header before the cards.
    expect(getByTestId("todo-autoplay-global")).toBeTruthy()
    expect(getByTestId("todo-autoplay-global-state").textContent).toBe("Playing · 1 enabled")
    expect(getByText("Autoplay configuration")).toBeTruthy()
    // At a glance: Alice paused (disabled), Nira waiting (enabled + playing).
    expect(getByTestId("todo-autoplay-status-alice").textContent).toBe("Paused")
    expect(getByTestId("todo-autoplay-status-nira").textContent).toBe("Waiting for tasks")
  })

  it("[TODOAP-AC-41] an enabled runner shows Paused · global while the workspace is paused; the live event flips it back; the chip follows the global state", async () => {
    const { AutoplayChip, AutoplayPanelHost } = await import("./AutoplayPanel")
    const { useAutoplayStore } = await import("./autoplayStore")
    // Two runners seeded through the mocked get-autoplay: Alice disabled, Nira enabled.
    h.state.runners = [ALICE, NIRA]
    useAutoplayStore.getState().setOpen("w41:" + APP, true)
    const { getByTestId } = renderWithTamagui(
      <>
        <AutoplayChip appId={APP} workspaceId={WS} windowId="w41" />
        <AutoplayPanelHost appId={APP} workspaceId={WS} windowId="w41" onError={() => {}} />
      </>,
    )
    await waitFor(() => expect(getByTestId("todo-autoplay-global-state").textContent).toBe("Playing · 1 enabled"))

    // Pause globally (the event set-global-play broadcasts): the state line
    // flips, an enabled runner reads Paused · global, a disabled one stays
    // Paused — and the count is unchanged (the config is untouched).
    act(() => {
      h.emit("todo_autoplay_changed", { workspaceId: WS, globalPlaying: false })
    })
    expect(getByTestId("todo-autoplay-global-state").textContent).toBe("Paused")
    expect(getByTestId("todo-autoplay-status-nira").textContent).toBe("Paused · global")
    expect(getByTestId("todo-autoplay-status-alice").textContent).toBe("Paused")
    expect(getByTestId("todo-autoplay-chip").textContent).toBe("Autoplay · 1")

    // Play again: Nira goes back to waiting, Alice stays paused (disabled).
    act(() => {
      h.emit("todo_autoplay_changed", { workspaceId: WS, globalPlaying: true })
    })
    expect(getByTestId("todo-autoplay-global-state").textContent).toBe("Playing · 1 enabled")
    expect(getByTestId("todo-autoplay-status-nira").textContent).toBe("Waiting for tasks")
    expect(getByTestId("todo-autoplay-status-alice").textContent).toBe("Paused")
  })

  it("[TODOAP-AC-41] the global toggle press sends set-global-play with the next state", async () => {
    const { AutoplayPanel } = await import("./AutoplayPanel")
    const onSetGlobalPlay = vi.fn()
    const { getByTestId } = renderWithTamagui(
      <AutoplayPanel
        runners={[ALICE, NIRA]}
        globalPlaying={false}
        runningCount={0}
        agents={[]}
        onSetSlots={() => {}}
        onSetPlay={() => {}}
        onSetGlobalPlay={onSetGlobalPlay}
        onStopAutoplay={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(getByTestId("todo-autoplay-global-toggle"))
    expect(onSetGlobalPlay).toHaveBeenCalledWith(true)
  })
})

// ─── TODOAP-AC-42: the transport row — play/pause swap + conditional STOP ──

describe("global stop", () => {
  /** Alice disabled + Nira enabled (Pablo's case). */
  const ALICE = { agentId: "alice", name: "Alice", slots: 2, playEnabled: false, activeSlots: 0, ...WHOLE }
  const NIRA = { agentId: "nira", name: "Nira", slots: 2, playEnabled: true, activeSlots: 0, ...WHOLE }

  it("[TODOAP-AC-42] the STOP square is hidden with nothing in flight and appears with runningCount > 0; the press calls onStopAutoplay", async () => {
    const { AutoplayPanel } = await import("./AutoplayPanel")
    const onStopAutoplay = vi.fn()
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <AutoplayPanel
        runners={[ALICE, NIRA]}
        globalPlaying={true}
        runningCount={0}
        agents={[]}
        onSetSlots={() => {}}
        onSetPlay={() => {}}
        onSetGlobalPlay={() => {}}
        onStopAutoplay={onStopAutoplay}
        onAdd={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    )
    // Nothing in flight → no STOP control at all.
    expect(queryByTestId("todo-autoplay-stop")).toBeNull()

    // Two turns in flight → the STOP square appears and pressing it stops.
    const again = renderWithTamagui(
      <AutoplayPanel
        runners={[ALICE, NIRA]}
        globalPlaying={true}
        runningCount={2}
        agents={[]}
        onSetSlots={() => {}}
        onSetPlay={() => {}}
        onSetGlobalPlay={() => {}}
        onStopAutoplay={onStopAutoplay}
        onAdd={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    )
    expect(again.getByTestId("todo-autoplay-stop")).toBeTruthy()
    fireEvent.click(again.getByTestId("todo-autoplay-stop"))
    expect(onStopAutoplay).toHaveBeenCalledTimes(1)
  })

  it("[TODOAP-AC-42] the store stopAutoplay flips the panel live through the optimistic write", async () => {
    const { AutoplayPanelHost } = await import("./AutoplayPanel")
    const { useAutoplayStore, stopAutoplay } = await import("./autoplayStore")
    // Playing with one turn in flight: the STOP square is there.
    h.state.runners = [ALICE, NIRA]
    h.state.runningCount = 1
    useAutoplayStore.getState().setOpen("w42:" + APP, true)
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <AutoplayPanelHost appId={APP} workspaceId={WS} windowId="w42" onError={() => {}} />,
    )
    await waitFor(() => expect(getByTestId("todo-autoplay-stop")).toBeTruthy())
    expect(getByTestId("todo-autoplay-global-state").textContent).toBe("Playing · 1 enabled")

    // The stop: paused at once, the STOP square gone (nothing in flight now).
    await act(async () => {
      await stopAutoplay(APP)
    })
    expect(getByTestId("todo-autoplay-global-state").textContent).toBe("Paused")
    expect(queryByTestId("todo-autoplay-stop")).toBeNull()
    expect(getByTestId("todo-autoplay-status-nira").textContent).toBe("Paused · global")
  })
})

// ─── TODOAP-AC-32: runner scope, one "Also picks up" menu ───────────────────────

describe("runner scope", () => {
  const group = (nodeId: string, text: string, parentId: string | null, position = 0) =>
    ({ ...node({ nodeId, text, parentId, position }), kind: "group", state: null }) as TreeNode
  const ANY = "Today · any branch"

  it("[TODOAP-AC-32] the runner row reads Also picks up: Nothing (also on a missing scope with pickup off), Today · any branch, Today · the path, or Branch deleted", async () => {
    const { AutoplayPanel } = await import("./AutoplayPanel")
    const base = { slots: 1, playEnabled: false, activeSlots: 0 }
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <AutoplayPanel
        runners={[
          { agentId: "atlas", name: "Atlas", ...base, ...WHOLE },
          { agentId: "iria", name: "Iria", ...base, ...WHOLE, pickUnassigned: true },
          { agentId: "nora", name: "Nora", ...base, ...WHOLE, scopeNodeId: "g2", scopePath: "Teros › Lanzamiento", pickUnassigned: true },
          { agentId: "zed", name: "Zed", ...base, ...WHOLE, scopeNodeId: "gone", scopeMissing: true, pickUnassigned: true },
          { agentId: "off", name: "Off", ...base, ...WHOLE, scopeNodeId: "gone", scopeMissing: true, pickUnassigned: false },
        ]}
        globalPlaying={true}
        runningCount={0}
        agents={[]}
        onSetSlots={() => {}}
        onSetPlay={() => {}}
        onSetGlobalPlay={() => {}}
        onStopAutoplay={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    )
    // One control: the label and the chip; the old checkbox is gone.
    expect(getByTestId("todo-autoplay-scope-atlas").textContent).toBe("Also picks up:Nothing")
    expect(queryByTestId("todo-autoplay-pick-atlas")).toBeNull()
    expect(getByTestId("todo-autoplay-scope-label-iria").textContent).toBe(ANY)
    expect(getByTestId("todo-autoplay-scope-label-nora").textContent).toBe("Today · Teros › Lanzamiento")
    expect(getByTestId("todo-autoplay-scope-label-zed").textContent).toBe("Branch deleted")
    expect(getByTestId("todo-autoplay-scope-label-off").textContent).toBe("Nothing")
  })

  it("[TODOAP-AC-32] the menu lists Nothing, PLANNED FOR TODAY and the ONLY IN groups; each choice calls set-agent-scope (Nothing on a missing scope sends null); todo_autoplay_changed updates the label", async () => {
    const { useTodoStore } = await import("../data/todoStore")
    const { AutoplayPanelHost } = await import("./AutoplayPanel")
    const { useAutoplayStore } = await import("./autoplayStore")
    const app = "app-ac32"
    useTodoStore.getState().patch(app, () => ({
      nodes: [
        group("g1", "Teros", null),
        group("g2", "Lanzamiento", "g1"),
        node({ nodeId: "t1", text: "A task", parentId: "g2" }),
        group("g3", "Hexagon", null, 1),
        group("g4", "Admin", "g3"),
      ],
    }))
    useAutoplayStore.getState().setOpen("w32:" + app, true)
    const { getByTestId, getAllByRole, queryByRole } = renderWithTamagui(
      <AutoplayPanelHost appId={app} workspaceId={WS} windowId="w32" onError={() => {}} />,
    )
    const label = () => getByTestId("todo-autoplay-scope-label-atlas").textContent
    const chip = () => getByTestId("todo-autoplay-scope-atlas").querySelector('[role="button"]')!
    const scopeCalls = () => h.state.calls.filter((c) => c.tool === "set-agent-scope").map((c) => c.input)
    await waitFor(() => expect(label()).toBe("Nothing"))

    // The menu: Nothing, the PLANNED FOR TODAY item, then the groups in tree order with their path; tasks are left out.
    fireEvent.click(chip())
    const menu = getByTestId("todo-autoplay-scope-atlas").querySelector('[role="menu"]')!
    expect(menu.textContent).toBe(
      "Nothing · only tasks assigned to Atlas" +
        "Planned for today" +
        "Unassigned tasks, any branch" +
        "Planned for today, only in" +
        "Teros" +
        "Teros › Lanzamiento" +
        "Hexagon" +
        "Hexagon › Admin",
    )
    expect(getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Nothing · only tasks assigned to Atlas",
      "Unassigned tasks, any branch",
      "Teros",
      "Teros › Lanzamiento",
      "Hexagon",
      "Hexagon › Admin",
    ])
    expect(getAllByRole("menuitem")[0].getAttribute("aria-checked")).toBe("true")

    // A group → { group, true }.
    fireEvent.click(getAllByRole("menuitem")[3])
    await waitFor(() => expect(scopeCalls()).toHaveLength(1))
    expect(scopeCalls()[0]).toEqual({ agentId: "atlas", scopeNodeId: "g2", pickUnassigned: true })
    expect(queryByRole("menu")).toBeNull()
    expect(label()).toBe("Today · Teros › Lanzamiento")

    // Nothing → { current scope, false }.
    fireEvent.click(chip())
    expect(getAllByRole("menuitem")[3].getAttribute("aria-checked")).toBe("true")
    fireEvent.click(getAllByRole("menuitem")[0])
    await waitFor(() => expect(scopeCalls()).toHaveLength(2))
    expect(scopeCalls()[1]).toEqual({ agentId: "atlas", scopeNodeId: "g2", pickUnassigned: false })
    expect(label()).toBe("Nothing")

    // Any branch → { null, true }.
    fireEvent.click(chip())
    fireEvent.click(getAllByRole("menuitem")[1])
    await waitFor(() => expect(scopeCalls()).toHaveLength(3))
    expect(scopeCalls()[2]).toEqual({ agentId: "atlas", scopeNodeId: null, pickUnassigned: true })
    expect(label()).toBe(ANY)

    // A change made elsewhere arrives live.
    const changed = (scope: Record<string, unknown>) =>
      act(() =>
        h.emit("todo_autoplay_changed", {
          type: "todo_autoplay_changed", workspaceId: WS, agentId: "atlas", slots: 2, playEnabled: true, activeSlots: 0, ...scope,
        }),
      )
    changed({ scopeNodeId: "g1", scopePath: "Teros", pickUnassigned: true, scopeMissing: false })
    expect(label()).toBe("Today · Teros")
    changed({ scopeNodeId: "g1", scopePath: "Teros", pickUnassigned: false, scopeMissing: false })
    expect(label()).toBe("Nothing")
    changed({ scopeNodeId: "g1", scopePath: null, pickUnassigned: true, scopeMissing: true })
    expect(label()).toBe("Branch deleted")

    // Nothing on a missing scope clears it: the deleted group is never sent back.
    fireEvent.click(chip())
    fireEvent.click(getAllByRole("menuitem")[0])
    await waitFor(() => expect(scopeCalls()).toHaveLength(4))
    expect(scopeCalls()[3]).toEqual({ agentId: "atlas", scopeNodeId: null, pickUnassigned: false })
    expect(label()).toBe("Nothing")
  })
})

// ─── TODOAP-AC-25: chip in the window header, both views ──────────────────────────

describe("autoplay chip in the window header", () => {
  /** The chip is the last item of the row that holds the Tree | By day switch. */
  function chipEndsSwitchRow(container: HTMLElement): boolean {
    const chip = container.querySelector('[data-testid="todo-autoplay-chip"]')!
    const tab = Array.from(container.querySelectorAll('[role="tab"], [role="radio"], [role="button"]')).find((el) => el.textContent === "Tree")
    if (!chip || !tab) return false
    let row: Element | null = chip.parentElement
    while (row && !row.contains(tab)) row = row.parentElement
    if (!row) return false
    // Walk from the chip up to the row's direct child: it must be the row's last child.
    let item: Element = chip
    while (item.parentElement !== row) item = item.parentElement!
    return row.lastElementChild === item
  }

  it("[TODOAP-AC-25] chip at the right end of the view-switch row in the tree and the day view; press opens the panel, a second press closes it", async () => {
    const { TodoWindowContent } = await import("../TodoWindowContent")
    const { container, getByTestId, queryByTestId, getByText } = renderWithTamagui(
      <TodoWindowContent workspaceId={WS} appId={APP} windowId="w-ac25" />,
    )
    // Tree view (the default).
    const chip = await waitFor(() => getByTestId("todo-autoplay-chip"))
    await waitFor(() => expect(chip.textContent).toBe("Autoplay · 1"))
    expect(chipEndsSwitchRow(container)).toBe(true)
    expect(queryByTestId("todo-autoplay-panel")).toBeNull()
    fireEvent.click(chip)
    await waitFor(() => expect(getByTestId("todo-autoplay-panel")).toBeTruthy())
    fireEvent.click(getByTestId("todo-autoplay-chip"))
    await waitFor(() => expect(queryByTestId("todo-autoplay-panel")).toBeNull())

    // Day view: same chip, same place, same toggle.
    fireEvent.click(getByText("By day"))
    await waitFor(() => expect(getByTestId("todo-autoplay-chip").textContent).toBe("Autoplay · 1"))
    expect(chipEndsSwitchRow(container)).toBe(true)
    fireEvent.click(getByTestId("todo-autoplay-chip"))
    await waitFor(() => expect(getByTestId("todo-autoplay-panel")).toBeTruthy())
    fireEvent.click(getByTestId("todo-autoplay-chip"))
    await waitFor(() => expect(queryByTestId("todo-autoplay-panel")).toBeNull())
  })
})

// ─── TODOAP-AC-14: conversation icon ───────────────────────────────────────────────

function node(extra: Partial<TreeNode> = {}): TreeNode {
  return {
    nodeId: "n1", parentId: null, position: 0, text: "Factura Q3", description: "", kind: "task", state: "working",
    blockedReason: null, completed: false, collapsed: false, progress: null, reportedProgress: null, hasInput: false,
    hasOutput: false, plannedFor: null, dayOrder: null, plannedTime: null, assignee: { kind: "agent", id: "atlas" },
    childCount: 0, completedChildren: 0, ...extra,
  }
}

const atlas = { kind: "agent" as const, id: "atlas", name: "Atlas" }

/** The conversation icon must come right after the avatar slot (aria-label = assignee name). */
function iconAfterAvatar(container: HTMLElement): boolean {
  const icon = container.querySelector('[data-testid="todo-row-conversation"]')!
  const avatar = container.querySelector('[aria-label="Atlas"]')!
  return !!(avatar.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING) && avatar.nextElementSibling === icon
}

describe("conversation icon", () => {
  const rowProps = {
    counts: { blocked: 0, review: 0, right: null },
    selected: false,
    focused: false,
    celebrating: false,
    dimmed: false,
    flashing: false,
    phone: false,
    onToggle: () => {},
    onFocus: () => {},
    onAdd: () => {},
    assignee: atlas,
    onOpenTerminal: () => {},
  }

  it("[TODOAP-AC-14] tree row: icon right of the avatar when the task has a conversation, opens it without selecting the row", async () => {
    const { TreeRow } = await import("../tree/TreeRow")
    const onPress = vi.fn()
    const onOpen = vi.fn()
    const n = node({ channelId: "ch_1" })
    const { container, getByTestId } = renderWithTamagui(
      <TreeRow row={{ node: n, depth: 1, hasKids: false, closed: false }} {...rowProps} onPress={onPress} onOpenConversation={onOpen} />,
    )
    expect(iconAfterAvatar(container)).toBe(true)
    fireEvent.click(getByTestId("todo-row-conversation"))
    expect(onOpen).toHaveBeenCalledWith("ch_1")
    expect(onPress).not.toHaveBeenCalled()
  })

  it("[TODOAP-AC-14] tree row: no icon without a conversation", async () => {
    const { TreeRow } = await import("../tree/TreeRow")
    const { queryByTestId } = renderWithTamagui(
      <TreeRow row={{ node: node(), depth: 1, hasKids: false, closed: false }} {...rowProps} onPress={() => {}} onOpenConversation={() => {}} />,
    )
    expect(queryByTestId("todo-row-conversation")).toBeNull()
  })

  it("[TODOAP-AC-14] day row: icon right of the avatar with a conversation, none without", async () => {
    const { DayRow } = await import("../day/DayRow")
    const task = (extra: Partial<DayTask> = {}): DayTask => ({
      nodeId: "n1", parentId: null, text: "Factura Q3", state: "working", blockedReason: null, progress: null,
      reportedProgress: null, plannedFor: "2026-10-27", dayOrder: 0, plannedTime: null, hasOutput: false,
      assignee: { kind: "agent", id: "atlas" }, path: ["Admin"], ...extra,
    })
    const props = { kind: "day" as const, right: "Admin", actionLabel: "x", selected: false, dimmed: false, flashing: false, phone: false, assignee: atlas, onPress: () => {}, onAction: () => {}, onOpenTerminal: () => {} }
    const withIcon = renderWithTamagui(<DayRow task={task({ channelId: "ch_1" })} {...props} onOpenConversation={() => {}} />)
    expect(iconAfterAvatar(withIcon.container)).toBe(true)
    withIcon.unmount()
    const without = renderWithTamagui(<DayRow task={task()} {...props} onOpenConversation={() => {}} />)
    expect(without.queryByTestId("todo-row-conversation")).toBeNull()
  })

  it("[CCR-AC] day row: the runner terminal beats the conversation bubble, click opens it without selecting the row", async () => {
    const { DayRow } = await import("../day/DayRow")
    const task = (extra: Partial<DayTask> = {}): DayTask => ({
      nodeId: "n1", parentId: null, text: "Fix bug", state: "working", blockedReason: null, progress: null,
      reportedProgress: null, plannedFor: "2026-10-27", dayOrder: 0, plannedTime: null, hasOutput: false,
      assignee: { kind: "agent", id: "atlas" }, path: ["Admin"], ...extra,
    })
    const props = { kind: "day" as const, right: "Admin", actionLabel: "x", selected: false, dimmed: false, flashing: false, phone: false, assignee: atlas, onPress: vi.fn(), onAction: () => {}, onOpenTerminal: vi.fn(), onOpenConversation: () => {} }
    const runner = { kind: "claude-code" as const, terminalId: "t_1", sessionId: "sess-1", startedAt: 1, status: "live" as const }
    // terminal wins over channelId
    const both = renderWithTamagui(<DayRow task={task({ channelId: "ch_1", runner })} {...props} />)
    expect(both.getByTestId("todo-row-terminal")).toBeTruthy()
    expect(both.queryByTestId("todo-row-conversation")).toBeNull()
    fireEvent.click(both.getByTestId("todo-row-terminal"))
    expect(props.onOpenTerminal).toHaveBeenCalledWith("n1")
    expect(props.onPress).not.toHaveBeenCalled()
    both.unmount()
    // sleeping dims, gone recreates — the icon is still there, the label changes
    const sleeping = renderWithTamagui(<DayRow task={task({ runner: { ...runner, status: "sleeping" } })} {...props} />)
    expect(sleeping.getByTestId("todo-row-terminal")).toBeTruthy()
    sleeping.unmount()
    const gone = renderWithTamagui(<DayRow task={task({ runner: { ...runner, status: "gone" } })} {...props} />)
    expect(gone.getByTestId("todo-row-terminal")).toBeTruthy()
    gone.unmount()
  })

  it("[CCR-AC] tree row: terminal icon with a runner, none without", async () => {
    const { TreeRow } = await import("../tree/TreeRow")
    const onOpenTerminal = vi.fn()
    const n = node({ runner: { kind: "claude-code", terminalId: "t_1", sessionId: "s", startedAt: 1, status: "live" } as DayTask["runner"] })
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <TreeRow row={{ node: n, depth: 1, hasKids: false, closed: false }} {...rowProps} onPress={() => {}} onOpenConversation={() => {}} onOpenTerminal={onOpenTerminal} />,
    )
    expect(getByTestId("todo-row-terminal")).toBeTruthy()
    fireEvent.click(getByTestId("todo-row-terminal"))
    expect(onOpenTerminal).toHaveBeenCalledWith(n.nodeId)
    expect(queryByTestId("todo-row-conversation")).toBeNull()
  })

  it("[TODOAP-AC-14] detail header: Conversation chip with a conversation, Start for a pending agent task", async () => {
    const { TodoNodeWindowContent } = await import("../node/TodoNodeWindowContent")
    const detail = (id: string, extra: Partial<NodeDetail>): NodeDetail => ({
      nodeId: id, parentId: null, text: "Factura Q3", description: "", instructions: "", kind: "task", state: "working",
      blockedReason: null, allowedTransitions: [], progress: null, reportedProgress: null, input: null, output: null,
      hasInput: false, hasOutput: false, plannedFor: null, dayOrder: null, plannedTime: null,
      assignee: { kind: "agent", id: "atlas" }, assignedAt: null, completed: false, collapsed: false, position: 0, log: [],
      createdAt: 0, updatedAt: 0, ...extra,
    })
    h.state.nodes = {
      linked: detail("linked", { channelId: "ch_1", running: true }),
      pending: detail("pending", { state: "pending" }),
    }
    const linked = renderWithTamagui(<TodoNodeWindowContent workspaceId={WS} appId={APP} nodeId="linked" />)
    await waitFor(() => expect(linked.getByTestId("todo-detail-conversation").textContent).toBe("Conversation"))
    expect(linked.queryByText("Start")).toBeNull()
    linked.unmount()

    const pending = renderWithTamagui(<TodoNodeWindowContent workspaceId={WS} appId={APP} nodeId="pending" />)
    await waitFor(() => expect(pending.getByText("Start")).toBeTruthy())
    expect(pending.queryByTestId("todo-detail-conversation")).toBeNull()
  })
})

// ─── TODOAP-AC-26: two kinds of working ────────────────────────────────────────────

describe("two kinds of working", () => {
  const animated = (root: ParentNode) => root.querySelectorAll('[data-testid="todo-dot-running"]').length

  it("[TODOAP-AC-26] tree row: working + running renders the animated dot, working without running a static dot; a todo_node_changed flipping running switches it live", async () => {
    const { TodoWindowContent } = await import("../TodoWindowContent")
    h.state.tree = [node({ nodeId: "w-run", text: "Running task", running: true }), node({ nodeId: "w-idle", text: "Idle task", position: 1 })]
    const { container, getByText } = renderWithTamagui(<TodoWindowContent workspaceId={WS} appId="app-ac26" windowId="w-ac26" />)
    await waitFor(() => expect(getByText("Idle task")).toBeTruthy())
    const row = (text: string) => container.querySelector(`[data-tdid="${text}"]`) as HTMLElement
    expect(animated(row("w-run"))).toBe(1)
    expect(animated(row("w-idle"))).toBe(0)
    expect(row("w-idle").querySelector('[data-tdx="dot"]')).not.toBeNull()

    // The agent turn ends on one task and starts on the other: no reload.
    h.state.tree = [node({ nodeId: "w-run", text: "Running task" }), node({ nodeId: "w-idle", text: "Idle task", position: 1, running: true })]
    act(() => h.emit("todo_node_changed", { workspaceId: WS, nodeId: "w-run" }))
    await waitFor(() => expect(animated(row("w-idle"))).toBe(1))
    expect(animated(row("w-run"))).toBe(0)
    h.state.tree = []
  })

  it("[TODOAP-AC-26] day row: animated dot only while running", async () => {
    const { DayRow } = await import("../day/DayRow")
    const task = (extra: Partial<DayTask> = {}): DayTask => ({
      nodeId: "n1", parentId: null, text: "Factura Q3", state: "working", blockedReason: null, progress: null,
      reportedProgress: null, plannedFor: "2026-10-27", dayOrder: 0, plannedTime: null, hasOutput: false,
      assignee: { kind: "agent", id: "atlas" }, path: ["Admin"], ...extra,
    })
    const props = { kind: "day" as const, right: "Admin", actionLabel: "x", selected: false, dimmed: false, flashing: false, phone: false, assignee: atlas, onPress: () => {}, onAction: () => {}, onOpenConversation: () => {}, onOpenTerminal: () => {} }
    const run = renderWithTamagui(<DayRow task={task({ running: true })} {...props} />)
    expect(animated(run.container)).toBe(1)
    run.unmount()
    const idle = renderWithTamagui(<DayRow task={task()} {...props} />)
    expect(animated(idle.container)).toBe(0)
    expect(idle.container.querySelector('[data-tdx="dot"]')).not.toBeNull()
  })

  it("[TODOAP-AC-26] detail state chip: animated while running, static otherwise, switched live by todo_node_changed", async () => {
    const { TodoNodeWindowContent } = await import("../node/TodoNodeWindowContent")
    const detail = (extra: Partial<NodeDetail>): NodeDetail => ({
      nodeId: "d26", parentId: null, text: "Factura Q3", description: "", instructions: "", kind: "task", state: "working",
      blockedReason: null, allowedTransitions: [], progress: null, reportedProgress: null, input: null, output: null,
      hasInput: false, hasOutput: false, plannedFor: null, dayOrder: null, plannedTime: null,
      assignee: { kind: "agent", id: "atlas" }, assignedAt: null, completed: false, collapsed: false, position: 0, log: [],
      createdAt: 0, updatedAt: 0, ...extra,
    })
    h.state.nodes = { d26: detail({ channelId: "ch_1" }) }
    const { container, getByLabelText } = renderWithTamagui(<TodoNodeWindowContent workspaceId={WS} appId="app-ac26d" nodeId="d26" />)
    const chip = () => getByLabelText("State: In progress")
    await waitFor(() => expect(chip()).toBeTruthy())
    expect(animated(container)).toBe(0)
    expect(chip().querySelector('[data-tdx="dot"]')).not.toBeNull()

    h.state.nodes = { d26: detail({ channelId: "ch_1", running: true }) }
    act(() => h.emit("todo_node_changed", { workspaceId: WS, nodeId: "d26" }))
    await waitFor(() => expect(animated(chip())).toBe(1))
  })
})
