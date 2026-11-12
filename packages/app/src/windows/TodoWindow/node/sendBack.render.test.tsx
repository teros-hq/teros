/**
 * To Do — sending a review task back asks for a note
 * (docs/specs/todo/autoplay/spec.md, TODOAP-REQ-21 / TODOAP-AC-29).
 * The todo-list tool path (callTodo) and the client are mocked.
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/node/sendBack
 */
import { fireEvent, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { NodeDetail } from "../model/types"

const h = vi.hoisted(() => {
  const state = { nodes: {} as Record<string, Record<string, unknown>> }
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
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
    if (tool === "get-tree") return { tree: [] }
    if (tool === "set-state" && n) n.state = input.state
    return {}
  }
  return { client, state, calls, callTodo }
})

vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))
vi.mock("../data/todoApi", () => ({
  callTodo: (...a: [string, string, Record<string, unknown>]) => h.callTodo(...a),
  TodoError: class extends Error {},
}))

function review(id: string): NodeDetail {
  return {
    nodeId: id, parentId: null, text: "Landing de precios", description: "", instructions: "", kind: "task", state: "review",
    blockedReason: null, allowedTransitions: [], progress: null, reportedProgress: null, input: null,
    output: { format: "markdown", markdown: "# Done" }, hasInput: false, hasOutput: true, plannedFor: null, dayOrder: null,
    plannedTime: null, assignee: { kind: "user", id: "u1" }, assignedAt: null, completed: false, collapsed: false, position: 0,
    log: [], createdAt: 0, updatedAt: 0,
  }
}

async function openOutputTab(nodeId: string) {
  const { TodoNodeWindowContent } = await import("./TodoNodeWindowContent")
  const r = renderWithTamagui(<TodoNodeWindowContent workspaceId="ws1" appId="app1" nodeId={nodeId} />)
  fireEvent.click(await waitFor(() => r.getByRole("tab", { name: /Output/ })))
  return r
}

const setStates = () => h.calls.filter((c) => c.tool === "set-state").map((c) => c.input)
const PLACEHOLDER = "What is missing or wrong, so the agent can fix it"

beforeEach(() => {
  h.calls.length = 0
  h.state.nodes = { n1: review("n1") as unknown as Record<string, unknown> }
})

describe("send back from review", () => {
  it("[TODOAP-AC-29] Send back opens the note box (primary disabled, no call); submit sends set-state working + reply; Cancel closes with no call; the state chip's In progress opens the same box", async () => {
    const r = await openOutputTab("n1")
    // The action bar at the bottom of the window (TODODH-REQ-3) holds the only Send back.
    fireEvent.click(await waitFor(() => r.getByText("Send back")))
    expect(r.getByText("Why are you sending it back?")).toBeTruthy()
    expect(r.getByPlaceholderText(PLACEHOLDER)).toBeTruthy()
    // The box is the only decision on screen: no Accept / Send back in the action bar.
    expect(r.queryByText("Accept")).toBeNull()
    expect(r.queryByText("Send back")).toBeNull()
    const submit = r.getByText("Send back with a note").closest("[role=button]")!
    expect(submit.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(submit)
    expect(setStates()).toEqual([])

    // Cancel closes, nothing sent.
    fireEvent.click(r.getByText("Cancel"))
    expect(r.queryByText("Why are you sending it back?")).toBeNull()
    expect(setStates()).toEqual([])
    // Cancel brings the bar's Accept and Send back back.
    expect(r.getAllByText("Accept")).toHaveLength(1)
    expect(r.getAllByText("Send back")).toHaveLength(1)

    // The state chip: In progress on a review task opens the same box.
    fireEvent.click(r.getByRole("button", { name: /^State:/i }))
    fireEvent.click(await waitFor(() => r.getByRole("menuitem", { name: /In progress/ })))
    expect(r.getByText("Why are you sending it back?")).toBeTruthy()
    expect(r.queryByText("Accept")).toBeNull()
    expect(setStates()).toEqual([])

    // A note enables the primary; submitting sends it as the reply and closes the box.
    fireEvent.change(r.getByPlaceholderText(PLACEHOLDER), { target: { value: "  The VAT line is missing  " } })
    const enabled = r.getByText("Send back with a note").closest("[role=button]")!
    expect(enabled.getAttribute("aria-disabled")).not.toBe("true")
    fireEvent.click(enabled)
    await waitFor(() => expect(setStates()).toEqual([{ nodeId: "n1", state: "working", reply: "The VAT line is missing" }]))
    await waitFor(() => expect(r.queryByText("Why are you sending it back?")).toBeNull())
  })
})
