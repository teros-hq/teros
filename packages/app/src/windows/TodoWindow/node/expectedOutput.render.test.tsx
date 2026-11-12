/**
 * To Do — expected output in the Output tab (docs/specs/todo/autoplay/spec.md):
 *   - the definition editor and its read-only summary (TODOAP-AC-19);
 *   - Fill in: the form output as the working surface (TODOAP-AC-21).
 * The todo-list tool path (callTodo) and the client are mocked; the mock keeps
 * the writes so the store's refresh reads them back.
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/node/expectedOutput
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
    if (tool === "update-node" && n && "expectedOutput" in input) n.expectedOutput = input.expectedOutput
    if (tool === "set-output" && n) {
      n.output = input.output
      n.hasOutput = !!input.output
    }
    return {}
  }
  return { client, state, calls, callTodo }
})

vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))
vi.mock("../data/todoApi", () => ({
  callTodo: (...a: [string, string, Record<string, unknown>]) => h.callTodo(...a),
  TodoError: class extends Error {},
}))

const WS = "ws1"
const APP = "app1"

function detail(id: string, extra: Partial<NodeDetail> = {}): NodeDetail {
  return {
    nodeId: id, parentId: null, text: "Factura Q3", description: "", instructions: "", kind: "task", state: "working",
    blockedReason: null, allowedTransitions: [], progress: null, reportedProgress: null, input: null, output: null,
    hasInput: false, hasOutput: false, plannedFor: null, dayOrder: null, plannedTime: null,
    assignee: { kind: "user", id: "u1" }, assignedAt: null, completed: false, collapsed: false, position: 0, log: [],
    createdAt: 0, updatedAt: 0, ...extra,
  }
}

async function openOutputTab(nodeId: string) {
  const { TodoNodeWindowContent } = await import("./TodoNodeWindowContent")
  const r = renderWithTamagui(<TodoNodeWindowContent workspaceId={WS} appId={APP} nodeId={nodeId} />)
  const tab = await waitFor(() => r.getByRole("tab", { name: /Output/ }))
  fireEvent.click(tab)
  return r
}

const updates = () => h.calls.filter((c) => c.tool === "update-node").map((c) => c.input.expectedOutput)

beforeEach(() => {
  h.calls.length = 0
  h.state.nodes = {}
})

describe("expected output definition", () => {
  it("[TODOAP-AC-19] without output: format chips, then description, file type pills and the field editor; each save writes update-node { expectedOutput }", async () => {
    h.state.nodes = { n1: detail("n1") as unknown as Record<string, unknown> }
    const r = await openOutputTab("n1")
    const chips = await waitFor(() => r.getByTestId("todo-output-format"))
    expect(chips.textContent).toBe("MarkdownFormFile")
    // Nothing selected while undefined: no description, no Clear.
    expect(r.queryByTestId("todo-expected-description")).toBeNull()
    expect(r.queryByText("Clear")).toBeNull()

    // File → saves at once; the file type pills appear.
    fireEvent.click(r.getByText("File"))
    await waitFor(() => expect(updates()).toEqual([{ format: "file" }]))
    expect(r.getByTestId("todo-expected-filetype").textContent).toBe("PDFDOCXXLSXCSVPNGJPGJSONMDTXTHTMLOther")
    fireEvent.click(r.getByText("PDF"))
    await waitFor(() => expect(updates().at(-1)).toEqual({ format: "file", fileType: "pdf" }))

    // The description saves on blur.
    const desc = r.getByTestId("todo-expected-description") as HTMLInputElement
    expect(desc.placeholder).toBe("Invoice as PDF with tax id, base, VAT and total")
    fireEvent.change(desc, { target: { value: "Invoice with tax id" } })
    fireEvent.blur(desc)
    await waitFor(() =>
      expect(updates().at(-1)).toEqual({ format: "file", fileType: "pdf", description: "Invoice with tax id" }),
    )

    // Form → the field editor: name, type, required; add / remove rows.
    fireEvent.click(r.getByText("Form"))
    await waitFor(() => expect(updates().at(-1)).toEqual({ format: "form", description: "Invoice with tax id" }))
    expect(r.queryByTestId("todo-expected-filetype")).toBeNull()
    fireEvent.click(r.getByText("Add field"))
    fireEvent.click(r.getByText("Add field"))
    const names = r.getAllByTestId("todo-expected-field-name") as HTMLInputElement[]
    expect(names).toHaveLength(2)
    fireEvent.change(names[0], { target: { value: "Tax id" } })
    fireEvent.change(names[1], { target: { value: "Total" } })
    fireEvent.blur(names[1])
    await waitFor(() =>
      expect(updates().at(-1)).toEqual({
        format: "form",
        description: "Invoice with tax id",
        fields: [
          { id: "tax_id", label: "Tax id", type: "text" },
          { id: "total", label: "Total", type: "text" },
        ],
      }),
    )
    // Type → Number, Required on the first row.
    fireEvent.click(r.getAllByTestId("todo-expected-field-type")[1])
    fireEvent.click(await waitFor(() => r.getByRole("menuitem", { name: "Number" })))
    fireEvent.click(r.getAllByText("Required")[0])
    await waitFor(() =>
      expect(updates().at(-1)).toEqual({
        format: "form",
        description: "Invoice with tax id",
        fields: [
          { id: "tax_id", label: "Tax id", type: "text", required: true },
          { id: "total", label: "Total", type: "number" },
        ],
      }),
    )
    fireEvent.click(r.getByRole("button", { name: "Remove field Total" }))
    await waitFor(() => expect((updates().at(-1) as { fields: unknown[] }).fields).toHaveLength(1))

    // Clear → null.
    fireEvent.click(r.getByText("Clear"))
    await waitFor(() => expect(updates().at(-1)).toBeNull())
    expect(r.queryByTestId("todo-expected-description")).toBeNull()
  })

  it("[TODOAP-AC-19] with an output: a read-only one-line summary in the header, no editor", async () => {
    // Today at 15:29 — stamp() renders clock time only for today's timestamps,
    // so a fixed date would rot to "yesterday" the day after it was written.
    const today = new Date()
    const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 15, 29).getTime()
    const log = [{ timestamp: at, text: "Output delivered · markdown" }]
    h.state.nodes = {
      file: detail("file", {
        expectedOutput: { format: "file", fileType: "pdf", description: "Invoice with tax id" },
        output: { format: "markdown", markdown: "# Done" },
        hasOutput: true,
        outputUpdatedAt: at,
        // A value-only save logs nothing: outputUpdatedAt wins over an older log entry.
        log: [{ timestamp: at - 3 * 3600_000, text: "Output delivered · markdown" }],
      }) as unknown as Record<string, unknown>,
      form: detail("form", {
        state: "review",
        log,
        expectedOutput: {
          format: "form",
          fields: [
            { id: "a", label: "A", type: "text" },
            { id: "b", label: "B", type: "text" },
            { id: "c", label: "C", type: "checkbox" },
          ],
        },
        output: { format: "markdown", markdown: "# Done" },
        hasOutput: true,
      }) as unknown as Record<string, unknown>,
    }
    const f = await openOutputTab("file")
    await waitFor(() => expect(f.getByTestId("todo-expected-summary").textContent).toBe("Expected: file · PDF · Invoice with tax id"))
    expect(f.queryByTestId("todo-expected")).toBeNull()
    // One line: the definition replaces the generic "markdown" label; still being worked on → saved, not delivered.
    expect(f.queryByText("markdown")).toBeNull()
    expect(f.getByText(/^in progress · saved /).textContent).toContain("15:29")
    expect(f.queryByText(/^delivered /)).toBeNull()
    f.unmount()

    const g = await openOutputTab("form")
    await waitFor(() => expect(g.getByTestId("todo-expected-summary").textContent).toBe("Expected: form · 3 fields"))
    expect(g.queryByTestId("todo-output-format")).toBeNull()
    // An older node without outputUpdatedAt falls back to the last "Output delivered" entry.
    expect(g.getByText(/^delivered /).textContent).toContain("15:29")
  })
})

describe("fill in the expected form", () => {
  const fields = [
    { id: "signed", label: "Contract signed", type: "checkbox" },
    { id: "paid", label: "Deposit paid", type: "checkbox" },
    { id: "notes", label: "Notes", type: "text" },
    { id: "plan", label: "Plan", type: "select", required: true, options: [{ value: "basic", label: "Basic" }, { value: "pro", label: "Pro" }] },
  ]
  const setOutputs = () => h.calls.filter((c) => c.tool === "set-output").map((c) => c.input.output)

  it("[TODOAP-AC-21] Fill in creates the form output, fields render as inputs, typing saves the full fields + values, ticking moves done/total, the state is unchanged", async () => {
    h.state.nodes = {
      n1: detail("n1", { expectedOutput: { format: "form", fields: fields as never } }) as unknown as Record<string, unknown>,
    }
    const r = await openOutputTab("n1")
    fireEvent.click(await waitFor(() => r.getByText("Fill in")))
    await waitFor(() => expect(setOutputs()).toEqual([{ format: "form", fields, values: {} }]))

    // Every field as its input.
    const form = await waitFor(() => r.getByTestId("todo-form-fill"))
    expect(r.getAllByRole("checkbox")).toHaveLength(2)
    expect(r.getByTestId("todo-form-field-notes").querySelector("input")).toBeTruthy()
    expect(r.getAllByRole("radio").map((x) => x.textContent)).toEqual(["Basic", "Pro"])
    expect(form.textContent).toContain("Contract signed")
    const tab = r.getByRole("tab", { name: /Output/ })
    expect(tab.textContent).toBe("Output0/2")

    // Typing saves (debounced) with the full fields + values.
    fireEvent.change(r.getByTestId("todo-form-field-notes").querySelector("input")!, { target: { value: "Signed in person" } })
    await waitFor(() => expect(setOutputs().at(-1)).toEqual({ format: "form", fields, values: { signed: false, paid: false, notes: "Signed in person" } }), { timeout: 2000 })

    // Ticking a checkbox moves the counter at once, then saves.
    fireEvent.click(r.getAllByRole("checkbox")[0])
    expect(tab.textContent).toBe("Output1/2")
    fireEvent.click(r.getByText("Pro"))
    await waitFor(
      () => expect(setOutputs().at(-1)).toEqual({ format: "form", fields, values: { signed: true, paid: false, notes: "Signed in person", plan: "pro" } }),
      { timeout: 2000 },
    )
    expect(tab.textContent).toBe("Output1/2")

    // Filling never changes the task state.
    expect(h.calls.some((c) => c.tool === "set-state" || c.tool === "toggle-complete")).toBe(false)
    expect(h.state.nodes.n1.state).toBe("working")
  })
})
