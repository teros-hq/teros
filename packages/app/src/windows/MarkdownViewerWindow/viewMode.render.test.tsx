/**
 * The Markdown viewer's Formatted / Source toggle and its bold
 * (docs/specs/todo/output-window.md, TODOOV-AC-11, TODOOV-AC-12). Same
 * harness as todoSource.render.test.tsx: callTodo and the client are mocked.
 *
 *   cd packages/app && npx vitest run src/windows/MarkdownViewerWindow
 */
import { fireEvent, render, waitFor } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import config from "../../../tamagui.config"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import type { NodeDetail, NodeIO } from "../TodoWindow/model/types"
import { MarkdownRenderer } from "./components/MarkdownRenderer"

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

const RAW = "# Pricing page\n\nThe plan that **really works**.\n\n| Plan | Price |\n| --- | --- |\n| Pro | 20 |\n"
const MD: NodeIO = { format: "markdown", markdown: RAW }
const TODO = { workspaceId: "ws1", appId: "app1", nodeId: "n1", io: "output" as const }

async function renderViewer() {
  const { MarkdownViewerWindowContent } = await import("./MarkdownViewerWindowContent")
  const r = renderWithTamagui(<MarkdownViewerWindowContent windowId="w-md" filePath="" todo={TODO} title="Landing de precios" />)
  await waitFor(() => r.getByText("Pricing page"))
  return r
}

const selected = (el: HTMLElement) => el.getAttribute("aria-selected") === "true"

beforeEach(() => {
  h.calls.length = 0
  h.state.share = null
  h.state.nodes = { n1: task("n1", MD) as unknown as Record<string, unknown> }
})

describe("Markdown viewer, Formatted / Source", () => {
  it("[TODOOV-AC-11] the toolbar shows the toggle with Formatted active; Source shows the raw markdown in a mono selectable block; Formatted restores the rendering; Download and Share work in both modes", async () => {
    Object.assign(URL, { createObjectURL: () => "blob:md", revokeObjectURL: () => {} })
    const downloads: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    const r = await renderViewer()

    const formatted = r.getByRole("button", { name: "Show formatted" })
    const source = r.getByRole("button", { name: "Show source" })
    expect(selected(formatted)).toBe(true)
    expect(selected(source)).toBe(false)
    // The toggle sits before Download in the toolbar.
    expect(source.compareDocumentPosition(r.getByTestId("markdown-download")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(r.queryByTestId("markdown-source")).toBeNull()
    expect(document.querySelector(".teros-md strong")?.textContent).toBe("really works")

    fireEvent.click(source)
    const block = await waitFor(() => r.getByTestId("markdown-source"))
    expect(selected(r.getByRole("button", { name: "Show source" }))).toBe(true)
    expect(block.textContent).toBe(RAW)
    expect(block.textContent).toContain("**")
    expect(block.textContent).toContain("|")
    expect(block.style.fontFamily).toContain("Reddit Mono")
    expect(block.style.fontSize).toBe("13px")
    expect(block.style.lineHeight).toBe("20px")
    expect(getComputedStyle(block).userSelect).not.toBe("none")
    expect(r.queryByText("Pricing page")).toBeNull()

    // Download and Share in source mode.
    fireEvent.click(r.getByTestId("markdown-download"))
    expect(downloads).toEqual(["landing-de-precios.md"])
    fireEvent.click(r.getByTestId("markdown-share"))
    await waitFor(() => expect(h.calls.some((c) => c.tool === "share-io")).toBe(true))

    fireEvent.click(r.getByRole("button", { name: "Show formatted" }))
    await waitFor(() => r.getByText("Pricing page"))
    expect(r.queryByTestId("markdown-source")).toBeNull()
    fireEvent.click(r.getByTestId("markdown-download"))
    expect(downloads).toEqual(["landing-de-precios.md", "landing-de-precios.md"])
    click.mockRestore()
  })

  it("[TODOOV-AC-12] a **bold** span renders with weight 400 and the violet underlay, in light and dark", async () => {
    for (const theme of ["light", "dark"] as const) {
      const r = render(
        <TamaguiProvider config={config} defaultTheme={theme}>
          <MarkdownRenderer content={RAW} />
        </TamaguiProvider>,
      )
      const strong = await waitFor(() => {
        const el = r.container.querySelector(".teros-md strong")
        if (!el) throw new Error("no strong")
        return el as HTMLElement
      })
      const cs = getComputedStyle(strong)
      expect(cs.fontWeight).toBe("400")
      expect(cs.backgroundImage).toContain("linear-gradient")
      expect(cs.backgroundImage).toContain(theme === "dark" ? "rgba(156, 107, 255, 0.14)" : "rgba(111, 39, 255, 0.12)")
      r.unmount()
    }
  })
})
