/**
 * Day view — "Completadas abajo" setting (Pablo, 31-oct night):
 *   - DEFAULT (OFF): done tasks interleave in the plan, as always — the
 *     rows keep their drag handles and the dayOrder;
 *   - ON (the ⋮ menu in the plan header → "Completed at the bottom"): the
 *     plan lists only OPEN tasks in their dayOrder; done tasks sink to a
 *     "Completed" fold at the very bottom, collapsed by default,
 *     expandable; done rows carry no drag handle (the fold owns their
 *     place);
 *   - the setting lives in the plan header's ⋮ dropdown (not a chip — the
 *     header stays clean); the row toggles it and the menu stays open so a
 *     second tap un-marks it; the check shows the state live;
 *   - both the setting and the fold state persist per user (localStorage
 *     `teros-todo-day-done-sink` / `teros-todo-day-done-fold`);
 *   - the day summary (StateBar) always counts done tasks: it summarizes the
 *     whole day.
 * The todo-list tool path (callTodo) and the client are mocked.
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/day
 */
import { fireEvent, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { DayView } from "./DayView"
import type { DayData, DayTask } from "../model/types"

// ─── Mocks ──────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const handlers = new Map<string, Set<(m: unknown) => void>>()
  const state = {
    day: null as DayData | null,
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
        members: [{ type: "agent", id: "atlas", name: "Atlas" }],
      }),
    },
  }
  const emit = (ev: string, msg: unknown) => handlers.get(ev)?.forEach((fn) => fn(msg))
  const callTodo = async (_appId: string, tool: string, input: Record<string, unknown>) => {
    state.calls.push({ tool, input })
    if (tool === "get-day") return state.day ?? { day: input.day, today: input.today, tasks: [], overdue: [], unplanned: [] }
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
const APP = "app-day-done"
const SINK_KEY = "teros-todo-day-done-sink"
const FOLD_KEY = "teros-todo-day-done-fold"

const task = (nodeId: string, text: string, extra: Partial<DayTask> = {}): DayTask => ({
  nodeId,
  parentId: null,
  text,
  state: "pending",
  blockedReason: null,
  progress: null,
  reportedProgress: null,
  plannedFor: "2026-10-31",
  dayOrder: 0,
  plannedTime: null,
  hasOutput: false,
  assignee: null,
  path: ["Admin"],
  ...extra,
})

/** A day whose plan interleaves open and done tasks by dayOrder. */
const mixedDay = (): DayData => ({
  day: "2026-10-31",
  today: "2026-10-31",
  tasks: [
    task("t1", "Open first", { dayOrder: 0, state: "working" }),
    task("t2", "Done in the middle", { dayOrder: 1, state: "done" }),
    task("t3", "Open second", { dayOrder: 2, state: "pending" }),
    task("t4", "Done last", { dayOrder: 3, state: "done" }),
  ],
  overdue: [],
  unplanned: [],
})

beforeEach(() => {
  h.state.day = null
  h.state.calls = []
  globalThis.localStorage?.removeItem(SINK_KEY)
  globalThis.localStorage?.removeItem(FOLD_KEY)
})

const mount = () =>
  renderWithTamagui(<DayView appId={APP} workspaceId={WS} phone={false} narrow={false} onError={() => {}} />)

/** The plan-header ⋮ button ("View options" a11y label) and the menu's
 *  "Completed at the bottom" row. The Modal portals to document.body, so
 *  the queries go through the render result (baseElement), not container. */
const menuBtn = (r: { getByLabelText: (t: string) => HTMLElement }) => r.getByLabelText("View options")
const sinkRow = (r: { getByTestId: (t: string) => HTMLElement }) => r.getByTestId("day-view-menu-done-sink")
const menuPanel = (r: { getByTestId: (t: string) => HTMLElement }) => r.getByTestId("day-view-menu")
const backdrop = (r: { getByTestId: (t: string) => HTMLElement }) => r.getByTestId("day-view-menu-backdrop")

/** Open the ⋮ menu (returns nothing; the menu row queries do the rest). */
const openMenu = (r: { getByLabelText: (t: string) => HTMLElement }) => {
  fireEvent.click(menuBtn(r))
}

// ─── Default (OFF): done interleaved ───────────────────────────────────────

describe("day view: default — done interleaved", () => {
  it("the plan interleaves done and open tasks in dayOrder, handles on every row, no Completed fold", async () => {
    h.state.day = mixedDay()
    const { container, getByText, getByLabelText, queryByText, queryByTestId } = mount()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())

    // All four tasks in the plan, in dayOrder — done interleaved (the
    // default is the motivation view).
    const list = container.querySelector('[data-tdx~="dlist"]') as HTMLElement
    const rows = Array.from(list.querySelectorAll("[data-tdid]")).map((r) => (r as HTMLElement).dataset.tdid)
    expect(rows).toEqual(["t1", "t2", "t3", "t4"])
    expect(getByText("Done in the middle")).toBeTruthy()
    expect(getByText("Done last")).toBeTruthy()

    // Every row keeps its drag handle — done included.
    const handle = (id: string) =>
      container.querySelector(`[data-tdid="${id}"]`)?.querySelector('[data-tdx~="hd"]')
    expect(handle("t2")).toBeTruthy()
    expect(handle("t4")).toBeTruthy()

    // No Completed fold while the setting is off.
    expect(queryByText("Completed")).toBeNull()
    // The ⋮ button is visible in the plan header; the menu is closed.
    expect(menuBtn({ getByLabelText })).toBeTruthy()
    expect(queryByTestId("day-view-menu")).toBeNull()
  })
})

// ─── Setting ON: completed sink to the bottom ───────────────────────────────

describe("day view: setting ON — completed at the bottom", () => {
  const mountOn = () => {
    globalThis.localStorage?.setItem(SINK_KEY, "1")
    return mount()
  }

  it("plan lists only open tasks in dayOrder; done tasks never interleave", async () => {
    h.state.day = mixedDay()
    const { container, getByText, queryByText } = mountOn()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())

    const list = container.querySelector('[data-tdx~="dlist"]') as HTMLElement
    const rows = Array.from(list.querySelectorAll("[data-tdid]")).map((r) => (r as HTMLElement).dataset.tdid)
    expect(rows).toEqual(["t1", "t3"])
    expect(queryByText("Done in the middle")).toBeNull()
    expect(queryByText("Done last")).toBeNull()
  })

  it("done tasks sit in a Completed fold at the very bottom, collapsed by default", async () => {
    h.state.day = mixedDay()
    const { getByText, getAllByText, queryByText } = mountOn()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())

    expect(getByText("Completed")).toBeTruthy()
    expect(getAllByText("2 done").length).toBeGreaterThanOrEqual(1)
    expect(queryByText("Done in the middle")).toBeNull()
  })

  it("the fold is the last section — after the Unplanned tray", async () => {
    h.state.day = { ...mixedDay(), unplanned: [task("u1", "Unplanned thing", { plannedFor: null, dayOrder: null })] }
    const { container, getByText } = mountOn()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())

    const labels = Array.from(container.querySelectorAll("div,span")).map((e) => e.textContent)
    const at = (needle: string) => labels.findIndex((x) => x === needle)
    expect(at("Unplanned")).toBeGreaterThanOrEqual(0)
    expect(at("Completed")).toBeGreaterThan(at("Unplanned"))
  })

  it("expanding the fold shows the done rows; collapsing hides them again", async () => {
    h.state.day = mixedDay()
    const { getByText, queryByText } = mountOn()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())

    fireEvent.click(getByText("Completed"))
    await waitFor(() => expect(getByText("Done in the middle")).toBeTruthy())
    expect(getByText("Done last")).toBeTruthy()

    fireEvent.click(getByText("Completed"))
    await waitFor(() => expect(queryByText("Done in the middle")).toBeNull())
  })

  it("done rows carry no drag handle — the fold owns their place", async () => {
    h.state.day = mixedDay()
    const { container, getByText } = mountOn()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())

    const handle = (id: string) =>
      container.querySelector(`[data-tdid="${id}"]`)?.querySelector('[data-tdx~="hd"]')
    expect(handle("t1")).toBeTruthy()
    expect(handle("t3")).toBeTruthy()

    fireEvent.click(getByText("Completed"))
    await waitFor(() => expect(getByText("Done last")).toBeTruthy())
    expect(handle("t2")).toBeNull()
    expect(handle("t4")).toBeNull()
  })

  it("everything planned done: the plan says so instead of pretending the day is empty", async () => {
    h.state.day = {
      ...mixedDay(),
      tasks: [task("t2", "Done in the middle", { dayOrder: 0, state: "done" })],
    }
    const { getByText, queryByText } = mountOn()
    await waitFor(() => expect(getByText("Everything planned is done.")).toBeTruthy())
    expect(queryByText("Done in the middle")).toBeNull()
    expect(getByText("Completed")).toBeTruthy()
  })
})

// ─── The ⋮ menu: opens, toggles live, stays open, closes ────────────────────

describe("the ⋮ settings menu", () => {
  it("opening ⋮ shows the menu; the row toggles the setting live and STAYS OPEN (check appears/disappears); clicking again restores the interleaved plan", async () => {
    h.state.day = mixedDay()
    const { container, getByText, getByLabelText, getByTestId, queryByText } = mount()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())
    expect(getByText("Done in the middle")).toBeTruthy() // interleaved

    // Open the ⋮ menu — the row is there, unchecked.
    openMenu({ getByLabelText })
    expect(menuPanel({ getByTestId })).toBeTruthy()
    const row = sinkRow({ getByTestId })
    expect(row.textContent).toContain("Completed at the bottom")
    expect(row.querySelector('[data-testid="day-view-menu-check"]')).toBeNull() // OFF: no check

    // ON: done sink to the fold — the menu STAYS OPEN and the check appears.
    fireEvent.click(row)
    await waitFor(() => expect(queryByText("Done in the middle")).toBeNull())
    expect(getByText("Completed")).toBeTruthy()
    expect(menuPanel({ getByTestId })).toBeTruthy() // still open
    expect(sinkRow({ getByTestId }).querySelector('[data-testid="day-view-menu-check"]')).toBeTruthy()
    expect(globalThis.localStorage?.getItem(SINK_KEY)).toBe("1")
    const list = container.querySelector('[data-tdx~="dlist"]') as HTMLElement
    const rows = Array.from(list.querySelectorAll("[data-tdid]")).map((r) => (r as HTMLElement).dataset.tdid)
    expect(rows).toEqual(["t1", "t3"])

    // OFF: a second tap on the same row (menu still open) un-marks it —
    // done return to their dayOrder slots in the plan.
    fireEvent.click(sinkRow({ getByTestId }))
    await waitFor(() => expect(getByText("Done in the middle")).toBeTruthy())
    expect(queryByText("Completed")).toBeNull()
    expect(sinkRow({ getByTestId }).querySelector('[data-testid="day-view-menu-check"]')).toBeNull()
    const rows2 = Array.from((container.querySelector('[data-tdx~="dlist"]') as HTMLElement).querySelectorAll("[data-tdid]")).map((r) => (r as HTMLElement).dataset.tdid)
    expect(rows2).toEqual(["t1", "t2", "t3", "t4"])
    expect(globalThis.localStorage?.getItem(SINK_KEY)).toBe("0")
  })

  it("clicking the backdrop closes the menu; the setting keeps its value", async () => {
    h.state.day = mixedDay()
    const { getByText, getByLabelText, getByTestId, queryByTestId } = mount()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())

    openMenu({ getByLabelText })
    expect(menuPanel({ getByTestId })).toBeTruthy()
    fireEvent.click(backdrop({ getByTestId }))
    await waitFor(() => expect(queryByTestId("day-view-menu")).toBeNull())
    expect(getByText("Done in the middle")).toBeTruthy() // setting untouched (OFF)
    expect(globalThis.localStorage?.getItem(SINK_KEY)).toBeNull()
  })

  it("the setting persists: a fresh view starts with done sunk", async () => {
    h.state.day = mixedDay()
    const first = mount()
    await waitFor(() => expect(first.getByText("Open first")).toBeTruthy())
    openMenu(first)
    fireEvent.click(sinkRow(first))
    await waitFor(() => expect(first.queryByText("Done in the middle")).toBeNull())
    first.unmount()

    const second = mount()
    await waitFor(() => expect(second.getByText("Open first")).toBeTruthy())
    await waitFor(() => expect(second.queryByText("Done in the middle")).toBeNull())
    expect(second.getByText("Completed")).toBeTruthy()
    second.unmount()
  })
})

// ─── The day summary always counts done ─────────────────────────────────────

describe("day summary", () => {
  it("the day summary still counts done tasks in both modes (it summarizes the whole day)", async () => {
    h.state.day = mixedDay()
    const { getByText, getAllByText } = mount()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())
    expect(getAllByText("2 done").length).toBeGreaterThanOrEqual(1) // StateBar legend
    expect(getByText("2/4")).toBeTruthy() // plan header count
  })
})

// ─── Persistence of the fold state ──────────────────────────────────────────

describe("completed fold: persistence", () => {
  it("expanding the fold persists; a fresh view starts expanded", async () => {
    globalThis.localStorage?.setItem(SINK_KEY, "1")
    h.state.day = mixedDay()
    const first = mount()
    await waitFor(() => expect(first.getByText("Open first")).toBeTruthy())
    expect(globalThis.localStorage?.getItem(FOLD_KEY)).toBeNull() // nothing written until toggled

    fireEvent.click(first.getByText("Completed"))
    await waitFor(() => expect(first.getByText("Done last")).toBeTruthy())
    expect(globalThis.localStorage?.getItem(FOLD_KEY)).toBe("1")
    first.unmount()

    // A fresh mount (same user, e.g. window reopened) starts expanded.
    const second = mount()
    await waitFor(() => expect(second.getByText("Open first")).toBeTruthy())
    await waitFor(() => expect(second.getByText("Done in the middle")).toBeTruthy())

    // Collapsing again persists the closed state.
    fireEvent.click(second.getByText("Completed"))
    await waitFor(() => expect(second.queryByText("Done in the middle")).toBeNull())
    expect(globalThis.localStorage?.getItem(FOLD_KEY)).toBe("0")
    second.unmount()
  })
})

// ─── Archive: archived tasks never appear ──────────────────────────────────

describe("day view: archived tasks never appear", () => {
  it("an archived task in a (stale) day payload is dropped from the plan, overdue and unplanned lists", async () => {
    h.state.day = {
      day: "2026-10-31",
      today: "2026-10-31",
      tasks: [
        task("t1", "Open first", { dayOrder: 0, state: "working" }),
        task("t2", "Archived in the plan", { dayOrder: 1, archived: true }),
      ],
      overdue: [task("t3", "Archived overdue", { state: "pending", plannedFor: "2026-10-30", archived: true }), task("t4", "Real overdue", { state: "pending", plannedFor: "2026-10-30" })],
      unplanned: [task("t5", "Archived unplanned", { plannedFor: null, archived: true }), task("t6", "Real unplanned", { plannedFor: null })],
    }
    const { container, getByText, queryByText } = mount()
    await waitFor(() => expect(getByText("Open first")).toBeTruthy())

    const list = container.querySelector('[data-tdx~="dlist"]') as HTMLElement
    const rows = Array.from(list.querySelectorAll("[data-tdid]")).map((r) => (r as HTMLElement).dataset.tdid)
    expect(rows).toEqual(["t1"])
    expect(queryByText("Archived in the plan")).toBeNull()
    expect(getByText("Real overdue")).toBeTruthy()
    expect(queryByText("Archived overdue")).toBeNull()
    // The unplanned tray is a collapsed fold: open it to check its rows.
    fireEvent.click(getByText("Unplanned"))
    expect(await waitFor(() => getByText("Real unplanned"))).toBeTruthy()
    expect(queryByText("Archived unplanned")).toBeNull()
  })
})
