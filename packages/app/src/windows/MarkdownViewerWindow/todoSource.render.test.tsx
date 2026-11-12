/**
 * The Markdown viewer's To Do source (docs/specs/todo/output-window.md,
 * TODOOV-AC-6..8). The todo-list tool path (callTodo) and the client are
 * mocked; the tiling store is the real one.
 *
 *   cd packages/app && npx vitest run src/windows/MarkdownViewerWindow
 */
import { act, fireEvent, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { type WindowTypeDefinition, windowRegistry } from "../../services/windowRegistry"
import { type ContainerNode, type LayoutNode, useTilingStore } from "../../store/tilingStore"
import { useWindowTabMetaStore } from "../../store/windowTabMetaStore"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import type { NodeDetail, NodeIO } from "../TodoWindow/model/types"
import { markdownViewerWindowDefinition } from "./definition"

const h = vi.hoisted(() => {
  const state = { nodes: {} as Record<string, Record<string, unknown>>, share: null as null | { shareId: string; publicUrl: string } }
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
  const handlers: Record<string, Array<() => void>> = {}
  const client = {
    on: (ev: string, fn: () => void) => {
      ;(handlers[ev] ??= []).push(fn)
    },
    off: () => {},
    app: { subscribeTodo: async () => ({ userId: "u1" }) },
    workspace: { listMembers: async () => ({ members: [] }) },
  }
  const callTodo = async (_appId: string, tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input })
    const n = state.nodes[input.nodeId as string]
    if (tool === "get-node") return { node: JSON.parse(JSON.stringify(n)) }
    if (tool === "get-tree") return { tree: [] }
    if (tool === "get-io-share") return state.share
    if (tool === "share-io") return (state.share = { shareId: "s1", publicUrl: "https://teros.test/share/s1" })
    return {}
  }
  return { client, state, calls, handlers, callTodo }
})

vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))
vi.mock("../TodoWindow/data/todoApi", () => ({
  callTodo: (...a: [string, string, Record<string, unknown>]) => h.callTodo(...a),
  TodoError: class extends Error {},
}))

function task(id: string, output: NodeIO | null): NodeDetail {
  return {
    nodeId: id, parentId: null, text: "Landing de precios", description: "", instructions: "", kind: "task", state: "review",
    blockedReason: null, allowedTransitions: [], progress: null, reportedProgress: null, input: null,
    output, hasInput: false, hasOutput: !!output, plannedFor: null, dayOrder: null,
    plannedTime: null, assignee: { kind: "user", id: "u1" }, assignedAt: null, completed: false, collapsed: false, position: 0,
    log: [], createdAt: 0, updatedAt: 0,
  }
}

const MD: NodeIO = { format: "markdown", markdown: "# Pricing page\n\nThree plans, monthly and yearly." }
const TODO = { workspaceId: "ws1", appId: "app1", nodeId: "n1", io: "output" as const }

const TREE = "__todo_tree_stub__"
function stub(type: string): WindowTypeDefinition {
  return {
    type, audience: "user", displayName: type, icon: (() => null) as never, color: "#000000", getTitle: () => type,
    defaultSize: { width: 100, height: 100 }, component: (() => null) as never, serialize: (p) => p, deserialize: (d) => d,
  }
}
const s = () => useTilingStore.getState()
function containers(node: LayoutNode | null): ContainerNode[] {
  if (!node) return []
  if (node.type === "container") return [node]
  return [...containers(node.first), ...containers(node.second)]
}
const paneOf = (id: string) => containers(s().desktops[s().activeDesktopIndex].layout).find((c) => c.windowIds.includes(id))!
const viewers = () => Object.values(s().windows).filter((w) => w.type === "markdown-viewer")

async function renderViewer(windowId = "w-md") {
  const { MarkdownViewerWindowContent } = await import("./MarkdownViewerWindowContent")
  const r = renderWithTamagui(<MarkdownViewerWindowContent windowId={windowId} filePath="" todo={TODO} title="Landing de precios" />)
  await waitFor(() => r.getByText("Landing de precios"))
  return r
}

beforeEach(() => {
  h.calls.length = 0
  h.state.share = null
  h.state.nodes = { n1: task("n1", MD) as unknown as Record<string, unknown> }
  windowRegistry.register(stub(TREE))
  windowRegistry.register(stub("todo-node"))
  windowRegistry.register(markdownViewerWindowDefinition)
  useTilingStore.setState({ windows: {}, nextId: 1 })
  s().resetDesktops()
  s().setCompactShell(false)
})
afterEach(() => {
  windowRegistry.unregister(TREE)
  windowRegistry.unregister("todo-node")
  windowRegistry.unregister("markdown-viewer")
})

describe("Markdown viewer, To Do source", () => {
  it("[TODOOV-AC-6] Open on a markdown output opens a markdown-viewer preview tab beside the detail, titled with the task and subtitled Output · markdown, rendering the markdown; a second Open shows the same window", async () => {
    const tree = s().openWindow(TREE, {})!
    const detail = s().openWindow("todo-node", { workspaceId: "ws1", appId: "app1", nodeId: "n1" }, { preview: true, sourceWindowId: tree })!
    const { TodoNodeWindowContent } = await import("../TodoWindow/node/TodoNodeWindowContent")
    const d = renderWithTamagui(<TodoNodeWindowContent windowId={detail} workspaceId="ws1" appId="app1" nodeId="n1" />)
    fireEvent.click(await waitFor(() => d.getByRole("tab", { name: /Output/ })))
    expect(d.queryByText("Full screen")).toBeNull()
    fireEvent.click(await waitFor(() => d.getByRole("button", { name: "Open" })))

    expect(viewers()).toHaveLength(1)
    const w = viewers()[0]
    expect(w).toMatchObject({ preview: true, openerId: detail, props: { filePath: "", todo: TODO, title: "Landing de precios" } })
    // Global preview tabs (preview-tabs.md, Pablo 2026-11-01): acting from
    // the preview does NOT pin it — ONLY the pin click does. The viewer
    // REUSES the desktop's preview tab (the detail itself): same window,
    // new content.
    expect(s().windows[detail].preview).toBe(true)
    expect(w.id).toBe(detail)
    expect(markdownViewerWindowDefinition.getTitle(w.props as never)).toBe("Landing de precios")
    expect(markdownViewerWindowDefinition.getSubtitle!(w.props as never)).toBe("Output · markdown")
    expect(markdownViewerWindowDefinition.getKey!(w.props as never)).toBe("todo:n1:output")

    // A second Open shows the existing window, no new one.
    act(() => s().focusWindow(tree))
    expect(paneOf(w.id).activeWindowId).toBe(tree)
    fireEvent.click(d.getByRole("button", { name: "Open" }))
    expect(viewers()).toHaveLength(1)
    expect(paneOf(w.id).activeWindowId).toBe(w.id)
    d.unmount()

    const r = await renderViewer(w.id)
    await waitFor(() => r.getByText("Pricing page"))
    expect(r.getByText("Output · markdown")).toBeTruthy()
    expect(useWindowTabMetaStore.getState().meta[w.id]?.title).toBe("Landing de precios")
  })

  it("[TODOOV-AC-6] a file output's Open opens the object URL in a new browser tab, not a window", async () => {
    h.state.nodes.n1.output = { format: "file", objectId: "o1", url: "https://x.test/objects/o1", name: "factura.pdf", mime: "application/pdf", size: 10 }
    const opened = vi.spyOn(window, "open").mockImplementation(() => null)
    const { TodoNodeWindowContent } = await import("../TodoWindow/node/TodoNodeWindowContent")
    const d = renderWithTamagui(<TodoNodeWindowContent windowId="w-detail" workspaceId="ws1" appId="app1" nodeId="n1" />)
    fireEvent.click(await waitFor(() => d.getByRole("tab", { name: /Output/ })))
    fireEvent.click(await waitFor(() => d.getByRole("button", { name: "Open" })))
    expect(opened).toHaveBeenCalledWith("https://x.test/objects/o1", "_blank", "noopener")
    expect(viewers()).toHaveLength(0)
    opened.mockRestore()
  })

  it("[TODOOV-AC-7] a todo_node_changed whose reload returns new markdown re-renders the window; a removed output shows No output yet", async () => {
    const r = await renderViewer()
    await waitFor(() => r.getByText("Pricing page"))
    h.state.nodes.n1.output = { format: "markdown", markdown: "# Pricing page v2" }
    act(() => h.handlers.todo_node_changed?.forEach((fn) => fn()))
    await waitFor(() => r.getByText("Pricing page v2"))
    h.state.nodes.n1.output = null
    act(() => h.handlers.todo_node_changed?.forEach((fn) => fn()))
    await waitFor(() => r.getByText("No output yet"))
    expect(r.queryByTestId("markdown-download")).toBeNull()
    expect(r.queryByTestId("markdown-share")).toBeNull()
  })

  it("[TODOOV-AC-8] the toolbar has Download, Share and Refresh; Download names <slug>.md; Refresh calls get-node; Share reads get-io-share and publishes with share-io", async () => {
    const created = vi.fn((_b: Blob) => "blob:md")
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: () => {} })
    const downloads: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(`${this.download}|${this.getAttribute("href")}`)
    })
    const r = await renderViewer()
    await waitFor(() => r.getByText("Pricing page"))
    await waitFor(() => expect(h.calls.some((c) => c.tool === "get-io-share" && c.input.nodeId === "n1" && c.input.io === "output")).toBe(true))
    expect(r.getByTestId("markdown-download")).toBeTruthy()
    expect(r.getByTestId("markdown-refresh")).toBeTruthy()

    fireEvent.click(r.getByTestId("markdown-download"))
    expect(downloads).toEqual(["landing-de-precios.md|blob:md"])
    expect(created.mock.calls[0][0].type).toBe("text/markdown;charset=utf-8")

    h.calls.length = 0
    fireEvent.click(r.getByTestId("markdown-refresh"))
    await waitFor(() => expect(h.calls.some((c) => c.tool === "get-node" && c.input.nodeId === "n1")).toBe(true))

    fireEvent.click(r.getByTestId("markdown-share"))
    await waitFor(() => expect(h.calls.some((c) => c.tool === "share-io")).toBe(true))
    expect(h.calls.filter((c) => c.tool === "share-io")).toEqual([{ tool: "share-io", input: { nodeId: "n1", io: "output" } }])
    click.mockRestore()
  })

  it("[TODOOV-AC-8] an existing share is shown on open, not recreated", async () => {
    h.state.share = { shareId: "s9", publicUrl: "https://teros.test/share/s9" }
    const r = await renderViewer()
    await waitFor(() => r.getByTestId("markdown-share-published"))
    expect(h.calls.some((c) => c.tool === "share-io")).toBe(false)
    fireEvent.click(r.getByTestId("markdown-share-published"))
    fireEvent.click(await waitFor(() => r.getByTestId("markdown-share-revoke")))
    await waitFor(() => expect(r.queryByTestId("markdown-share-published")).toBeNull())
    expect(h.calls.filter((c) => c.tool === "unshare-io")).toEqual([{ tool: "unshare-io", input: { shareId: "s9" } }])
  })
})
