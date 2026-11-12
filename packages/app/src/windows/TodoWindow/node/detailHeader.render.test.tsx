/**
 * To Do — the detail header as one chip strip and the actions in a bar fixed
 * at the bottom (docs/specs/todo/detail-header.md, TODODH-AC-1..3).
 * The todo-list tool path (callTodo) and the client are mocked.
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/node/detailHeader
 */
import { fireEvent, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { NodeDetail, NodeState } from "../model/types"
import { barActions } from "./ActionBar"

const h = vi.hoisted(() => {
  const state = {
    nodes: {} as Record<string, Record<string, unknown>>,
    tree: [] as Array<Record<string, unknown>>,
  }
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
  const opened: Array<{ type: string; props: Record<string, unknown> }> = []
  const client = {
    on: () => {},
    off: () => {},
    app: { subscribeTodo: async () => ({ userId: "u1" }) },
    workspace: { listMembers: async () => ({ members: [] }) },
  }
  const callTodo = async (_appId: string, tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input })
    const n = state.nodes[input.nodeId as string]
    if (tool === "get-node") return { node: n }
    if (tool === "get-tree") return { tree: state.tree }
    if (tool === "set-state" && n) n.state = input.state
    if (tool === "set-archived" && n) {
      n.archived = input.archived
      n.archivedAt = input.archived ? Date.now() : null
    }
    return {}
  }
  return { client, state, calls, callTodo, opened }
})

vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))
vi.mock("../data/todoApi", () => ({
  callTodo: (...a: [string, string, Record<string, unknown>]) => h.callTodo(...a),
  TodoError: class extends Error {},
}))

function task(id: string, extra: Partial<NodeDetail> = {}): NodeDetail {
  return {
    nodeId: id, parentId: null, text: "Landing de precios", description: "", instructions: "", kind: "task", state: "review",
    blockedReason: null, allowedTransitions: [], progress: null, reportedProgress: null, input: null,
    output: { format: "markdown", markdown: "# Done" }, hasInput: false, hasOutput: true, plannedFor: null, dayOrder: null,
    plannedTime: null, assignee: { kind: "user", id: "u1" }, assignedAt: null, completed: false, collapsed: false, position: 0,
    log: [], createdAt: 0, updatedAt: 0, ...extra,
  }
}

async function open(nodeId: string) {
  const { TodoNodeWindowContent } = await import("./TodoNodeWindowContent")
  const r = renderWithTamagui(<TodoNodeWindowContent workspaceId="ws1" appId="app1" nodeId={nodeId} />)
  await waitFor(() => expect(r.getByRole("heading")).toBeTruthy())
  return r
}

const strip = (root: ParentNode) => root.querySelector('[data-tdx~="strip"]') as HTMLElement
const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
const barLabels = (r: Awaited<ReturnType<typeof open>>) =>
  within(r.getByTestId("todo-action-bar"))
    .getAllByRole("button")
    .map((b) => b.textContent)

beforeEach(() => {
  h.calls.length = 0
  h.state.nodes = {}
  h.state.tree = []
})

describe("detail header", () => {
  it("[TODODH-AC-1] a review task shows path, title, strip, tabs in order; no Accept / Send back above the tabs; chips without uppercase labels, field names in their accessibility labels; the conversation chip is in the strip", async () => {
    h.state.nodes = { n1: task("n1", { channelId: "ch_1" }) as unknown as Record<string, unknown> }
    const r = await open("n1")
    const path = r.getByLabelText("Location")
    const title = r.getByRole("heading")
    const s = strip(r.container)
    const tabs = r.getByRole("tablist")
    expect(s).toBeTruthy()
    expect(before(path, title) && before(title, s) && before(s, tabs)).toBe(true)

    // Accept / Send back exist only after the tabs (the bottom bar).
    for (const label of ["Accept", "Send back"]) {
      const els = r.getAllByText(label)
      expect(els.length).toBeGreaterThan(0)
      for (const el of els) expect(before(tabs, el)).toBe(true)
    }

    // No field labels in the chips, upper or any case; the names stay in the accessibility labels.
    const text = s.textContent ?? ""
    for (const k of ["STATE", "ASSIGNED", "PROGRESS", "DAY", "State", "Assigned", "Progress", "Day"]) expect(text).not.toContain(k)
    expect(within(s).getByLabelText("State: In review")).toBeTruthy()
    expect(within(s).getByLabelText(/^Assigned: /)).toBeTruthy()
    expect(within(s).getByLabelText("Progress: 0%")).toBeTruthy()
    expect(within(s).getByLabelText(/^Day: /)).toBeTruthy()

    // The conversation chip is the strip's last chip.
    const conv = within(s).getByTestId("todo-detail-conversation")
    expect(conv.textContent).toContain("Conversation")
    const chips = within(s).getAllByRole("button")
    expect(chips.at(-1)).toBe(conv)

    // Without a channelId there is no conversation chip.
    r.unmount()
    h.state.nodes = { n2: task("n2") as unknown as Record<string, unknown> }
    const r2 = await open("n2")
    expect(within(strip(r2.container)).queryByTestId("todo-detail-conversation")).toBeNull()
  })

  describe("strip width", () => {
    let pane = 760
    const ROW = 520
    const isStrip = (el: Element) => (el.getAttribute("data-tdx") ?? "").split(" ").includes("strip")
    const saved = {
      cw: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
      sw: Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth"),
    }
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get(this: HTMLElement) {
          return isStrip(this) ? pane : 0
        },
      })
      Object.defineProperty(Element.prototype, "scrollWidth", {
        configurable: true,
        get(this: Element) {
          return isStrip(this) ? ROW : 0
        },
      })
    })
    afterEach(() => {
      if (saved.cw) Object.defineProperty(HTMLElement.prototype, "clientWidth", saved.cw)
      if (saved.sw) Object.defineProperty(Element.prototype, "scrollWidth", saved.sw)
    })

    it("[TODODH-AC-2] at a 360 px pane the strip is a horizontal scroll container with the fade; at 760 px it is not scrollable", async () => {
      h.state.nodes = { n1: task("n1", { channelId: "ch_1" }) as unknown as Record<string, unknown> }
      pane = 360
      const narrow = await open("n1")
      const s = strip(narrow.container)
      await waitFor(() => expect(s.getAttribute("data-overflow")).toBe("1"))
      expect(s.getAttribute("data-tdx")?.split(" ")).toContain("sfade")
      expect(s.getAttribute("role")).toBe("group")
      expect(s.getAttribute("tabindex")).toBe("0")
      // Scrolled to the end: the fade goes, the overflow stays.
      s.scrollLeft = ROW - pane
      fireEvent.scroll(s)
      await waitFor(() => expect(s.getAttribute("data-tdx")?.split(" ")).not.toContain("sfade"))
      expect(s.getAttribute("data-overflow")).toBe("1")
      narrow.unmount()

      pane = 760
      const wide = await open("n1")
      const w = strip(wide.container)
      await waitFor(() => expect(w.getAttribute("data-overflow")).toBe("0"))
      expect(w.getAttribute("data-tdx")?.split(" ")).not.toContain("sfade")
    })
  })

  it("[TODODH-AC-3] the bottom bar shows each state's actions; Start on an agent task (pending, or working without a conversation) calls start-node; the blocked box has no Back to planning of its own; Accept sets done; Send back opens the note box; a group has no bar", async () => {
    // Per state, as TODODH-REQ-3 lists them: secondaries to the left, the primary last (right end).
    const expected: Array<[NodeState, Partial<NodeDetail>, string[], string | null]> = [
      ["planning", {}, ["Cancel task", "Mark as pending"], "planning_pending"],
      ["pending", {}, ["Complete", "Back to planning", "Cancel task", "Start"], "pending_working"],
      ["working", {}, ["Complete", "Block", "Park", "Cancel task", "Send to review"], "working_review"],
      ["blocked", { blockedReason: "Need the VAT id" }, ["Back to planning", "Cancel task"], null],
      ["review", {}, ["Send back", "Cancel task", "Accept"], "review_done"],
      ["done", {}, ["Reopen"], "done_working"],
    ]
    for (const [state, extra, labels, primary] of expected) {
      const id = `s-${state}`
      h.state.nodes = { [id]: task(id, { state, output: null, hasOutput: false, ...extra }) as unknown as Record<string, unknown> }
      const r = await open(id)
      expect(barLabels(r), state).toEqual(labels)
      // The blocked box has no Back to planning of its own: the bar owns it.
      if (state === "blocked") expect(r.getAllByText("Back to planning")).toHaveLength(1)
      expect(barActions({ kind: "task", state, assignee: { kind: "user", id: "u1" } })?.primary?.verb ?? null, state).toBe(primary)
      r.unmount()
    }

    // Start on an agent-assigned pending task calls start-node; on a human task it sets working.
    h.state.nodes = { a: task("a", { state: "pending", assignee: { kind: "agent", id: "atlas" } }) as unknown as Record<string, unknown> }
    const agent = await open("a")
    fireEvent.click(within(agent.getByTestId("todo-action-bar")).getByText("Start"))
    await waitFor(() => expect(h.calls.some((c) => c.tool === "start-node" && c.input.nodeId === "a")).toBe(true))
    expect(h.calls.some((c) => c.tool === "set-state")).toBe(false)
    agent.unmount()
    h.state.nodes = { u: task("u", { state: "pending" }) as unknown as Record<string, unknown> }
    const human = await open("u")
    fireEvent.click(within(human.getByTestId("todo-action-bar")).getByText("Start"))
    await waitFor(() => expect(h.calls.some((c) => c.tool === "set-state" && c.input.state === "working")).toBe(true))
    human.unmount()

    // Working, agent-assigned, no conversation yet: Start is a secondary that calls start-node; with a conversation it is gone.
    h.calls.length = 0
    h.state.nodes = { wa: task("wa", { state: "working", output: null, hasOutput: false, assignee: { kind: "agent", id: "atlas" } }) as unknown as Record<string, unknown> }
    const workingAgent = await open("wa")
    expect(barLabels(workingAgent)).toEqual(["Complete", "Block", "Park", "Start", "Cancel task", "Send to review"])
    fireEvent.click(within(workingAgent.getByTestId("todo-action-bar")).getByText("Start"))
    await waitFor(() => expect(h.calls.some((c) => c.tool === "start-node" && c.input.nodeId === "wa")).toBe(true))
    expect(h.calls.some((c) => c.tool === "set-state")).toBe(false)
    workingAgent.unmount()
    h.state.nodes = { wc: task("wc", { state: "working", output: null, hasOutput: false, channelId: "ch_1", assignee: { kind: "agent", id: "atlas" } }) as unknown as Record<string, unknown> }
    const workingLinked = await open("wc")
    expect(barLabels(workingLinked)).toEqual(["Complete", "Block", "Park", "Cancel task", "Send to review"])
    workingLinked.unmount()

    // Block opens the block-reason flow (the state chip's menu); nothing is sent yet.
    h.calls.length = 0
    h.state.nodes = { w: task("w", { state: "working" }) as unknown as Record<string, unknown> }
    const working = await open("w")
    fireEvent.click(within(working.getByTestId("todo-action-bar")).getByText("Block"))
    await waitFor(() => expect(working.getByLabelText("What’s missing to continue?")).toBeTruthy())
    expect(h.calls.filter((c) => c.tool === "set-state")).toEqual([])
    working.unmount()

    // Review: Send back opens the note box (Accept and Send back step aside); Accept sets done.
    h.calls.length = 0
    h.state.nodes = { r: task("r") as unknown as Record<string, unknown> }
    const review = await open("r")
    fireEvent.click(within(review.getByTestId("todo-action-bar")).getByText("Send back"))
    expect(review.getByText("Why are you sending it back?")).toBeTruthy()
    expect(review.queryByTestId("todo-action-bar")).toBeNull()
    fireEvent.click(review.getByText("Cancel"))
    fireEvent.click(within(review.getByTestId("todo-action-bar")).getByText("Accept"))
    await waitFor(() => expect(h.calls.filter((c) => c.tool === "set-state").map((c) => c.input)).toEqual([{ nodeId: "r", state: "done" }]))
    review.unmount()

    // A group renders no bar.
    h.state.nodes = { g: task("g", { kind: "group", state: null, output: null, hasOutput: false }) as unknown as Record<string, unknown> }
    const group = await open("g")
    expect(group.queryByTestId("todo-action-bar")).toBeNull()
    expect(barActions({ kind: "group", state: null, assignee: null })).toBeNull()
  })

  describe("archive (TODODH)", () => {
    const archiveBtn = (r: Awaited<ReturnType<typeof open>>) => r.getByLabelText("Archive Landing de precios")
    const unarchiveBtn = (r: Awaited<ReturnType<typeof open>>) => r.getByLabelText("Unarchive Landing de precios")

    it("the header carries an archive action; clicking calls set-archived and the badge + dimmed title show immediately (optimistic)", async () => {
      h.state.nodes = { n1: task("n1") as unknown as Record<string, unknown> }
      const r = await open("n1")
      // No badge while active.
      expect(r.queryByLabelText("Archived")).toBeNull()
      fireEvent.click(archiveBtn(r))
      // Optimistic: the set-archived call is on its way and the badge shows.
      await waitFor(() => expect(h.calls.some((c) => c.tool === "set-archived" && c.input.archived === true)).toBe(true))
      expect(r.getByLabelText("Archived")).toBeTruthy()
      // Once the mocked backend settles, the action flips to Unarchive.
      await waitFor(() => expect(unarchiveBtn(r)).toBeTruthy())
      // The detail stays readable: tabs and log still render.
      expect(r.getByRole("tablist")).toBeTruthy()
      r.unmount()
    })

    it("unarchive from an archived detail calls set-archived false and the badge goes away", async () => {
      h.state.nodes = { n1: task("n1", { archived: true, archivedAt: 1 }) as unknown as Record<string, unknown> }
      const r = await open("n1")
      expect(r.getByLabelText("Archived")).toBeTruthy()
      fireEvent.click(unarchiveBtn(r))
      await waitFor(() => expect(h.calls.some((c) => c.tool === "set-archived" && c.input.archived === false)).toBe(true))
      await waitFor(() => expect(r.queryByLabelText("Archived")).toBeNull())
      r.unmount()
    })

    it("a leaf archives straight away — no prompt", async () => {
      h.state.nodes = { p: task("p") as unknown as Record<string, unknown> }
      const r = await open("p")
      fireEvent.click(archiveBtn(r))
      await waitFor(() => expect(h.calls.some((c) => c.tool === "set-archived" && c.input.nodeId === "p")).toBe(true))
      expect(r.queryByRole("alert")).toBeNull()
      r.unmount()
    })

    it("archiving a node with non-archived children asks first: cancel sends nothing, confirm archives", async () => {
      // The index (get-tree) carries the child; the detail's kids come from it.
      h.state.tree = [
        {
          nodeId: "p", parentId: null, text: "Landing de precios", kind: "task", state: "working", completed: false,
          collapsed: false, position: 0, progress: null, reportedProgress: null, hasInput: false, hasOutput: false,
          plannedFor: null, dayOrder: null, plannedTime: null, assignee: null, blockedReason: null, description: "",
          childCount: 1, completedChildren: 0,
          children: [
            {
              nodeId: "c1", parentId: "p", text: "Child task", kind: "task", state: "pending", completed: false,
              collapsed: false, position: 0, progress: null, reportedProgress: null, hasInput: false, hasOutput: false,
              plannedFor: null, dayOrder: null, plannedTime: null, assignee: null, blockedReason: null, description: "",
              childCount: 0, completedChildren: 0,
            },
          ],
        },
      ]
      h.state.nodes = { p: task("p") as unknown as Record<string, unknown> }
      const r = await open("p")
      fireEvent.click(archiveBtn(r))
      // The prompt opens; nothing is sent yet.
      const alert = await waitFor(() => r.getByRole("alert"))
      expect(alert.textContent).toContain("non-archived child task")
      expect(h.calls.some((c) => c.tool === "set-archived")).toBe(false)
      // Cancel closes it, still nothing sent.
      fireEvent.click(r.getByText("Cancel"))
      expect(r.queryByRole("alert")).toBeNull()
      expect(h.calls.some((c) => c.tool === "set-archived")).toBe(false)
      // Archive again and confirm: set-archived true goes through. The button
      // is queried by role — the dialog's title also contains "Archive".
      fireEvent.click(archiveBtn(r))
      fireEvent.click(await waitFor(() => within(r.getByRole("alert")).getByRole("button", { name: "Archive" })))
      await waitFor(() => expect(h.calls.some((c) => c.tool === "set-archived" && c.input.archived === true)).toBe(true))
      r.unmount()
    })
  })
})
