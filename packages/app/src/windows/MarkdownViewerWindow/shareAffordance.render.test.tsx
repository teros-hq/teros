/**
 * The Markdown viewer's share affordance (docs/specs/todo/output-window.md,
 * TODOOV-AC-9): the Share popover with stubbed clipboard and share APIs.
 * The To Do tool path (callTodo) and the client are mocked.
 *
 *   cd packages/app && npx vitest run src/windows/MarkdownViewerWindow
 */
import { fireEvent, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import type { NodeDetail } from "../TodoWindow/model/types"

const URL1 = "https://teros.test/share/s1"

const h = vi.hoisted(() => {
  const state = { nodes: {} as Record<string, unknown>, share: null as null | { shareId: string; publicUrl: string }, fileShareId: null as null | string }
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
  const handlers: Record<string, Array<(m: unknown) => void>> = {}
  const client = {
    on: (ev: string, fn: (m: unknown) => void) => {
      ;(handlers[ev] ??= []).push(fn)
    },
    off: () => {},
    app: { subscribeTodo: async () => ({ userId: "u1" }) },
    workspace: { listMembers: async () => ({ members: [] }) },
    fileWatcher: {
      watch: async (filePath: string) => {
        setTimeout(() => handlers.file_changed?.forEach((fn) => fn({ filePath, content: "# Notes" })), 0)
      },
      unwatch: async () => {},
    },
    fileShare: {
      getShare: async () => (state.fileShareId ? { shareId: state.fileShareId } : null),
      share: async (filePath: string, channelId: string, fileType: string) => {
        calls.push({ tool: "file.share", input: { filePath, channelId, fileType } })
        state.fileShareId = "f1"
        return { shareId: "f1" }
      },
      unshare: async (shareId: string) => {
        calls.push({ tool: "file.unshare", input: { shareId } })
        state.fileShareId = null
      },
      publicUrl: (id: string) => `https://teros.test/share/${id}`,
    },
  }
  const callTodo = async (_appId: string, tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input })
    if (tool === "get-node") return { node: JSON.parse(JSON.stringify(state.nodes[input.nodeId as string])) }
    if (tool === "get-io-share") return state.share
    if (tool === "share-io") return (state.share = { shareId: "s1", publicUrl: "https://teros.test/share/s1" })
    if (tool === "unshare-io") state.share = null
    return {}
  }
  return { client, state, calls, handlers, callTodo }
})

vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))
vi.mock("../TodoWindow/data/todoApi", () => ({
  callTodo: (...a: [string, string, Record<string, unknown>]) => h.callTodo(...a),
  TodoError: class extends Error {},
}))

const TODO = { workspaceId: "ws1", appId: "app1", nodeId: "n1", io: "output" as const }

function task(): NodeDetail {
  return {
    nodeId: "n1", parentId: null, text: "Landing de precios", description: "", instructions: "", kind: "task", state: "review",
    blockedReason: null, allowedTransitions: [], progress: null, reportedProgress: null, input: null,
    output: { format: "markdown", markdown: "# Pricing page" }, hasInput: false, hasOutput: true, plannedFor: null, dayOrder: null,
    plannedTime: null, assignee: { kind: "user", id: "u1" }, assignedAt: null, completed: false, collapsed: false, position: 0,
    log: [], createdAt: 0, updatedAt: 0,
  }
}

async function renderTodoViewer() {
  const { MarkdownViewerWindowContent } = await import("./MarkdownViewerWindowContent")
  const r = renderWithTamagui(<MarkdownViewerWindowContent windowId="w-md" filePath="" todo={TODO} title="Landing de precios" />)
  await waitFor(() => r.getByText("Pricing page"))
  await waitFor(() => expect(h.calls.some((c) => c.tool === "get-io-share")).toBe(true))
  return r
}

const writeText = vi.fn<(s: string) => Promise<void>>()
const share = vi.fn<(d: { url: string; title: string }) => Promise<void>>()
const realMatchMedia = window.matchMedia

function stubEnv({ pointer, clipboard, nativeShare }: { pointer: "fine" | "coarse"; clipboard: "resolve" | "reject"; nativeShare: boolean }) {
  writeText.mockReset().mockImplementation(clipboard === "resolve" ? async () => {} : async () => Promise.reject(new Error("denied")))
  share.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  if (nativeShare) Object.defineProperty(navigator, "share", { configurable: true, value: share })
  else delete (navigator as { share?: unknown }).share
  const matches = (q: string) => (pointer === "fine" ? q === "(pointer: fine)" || q === "(hover: hover)" : q === "(pointer: coarse)" || q === "(hover: none)")
  window.matchMedia = ((q: string) => ({ ...realMatchMedia(q), matches: matches(q), media: q })) as typeof window.matchMedia
}

beforeEach(() => {
  h.calls.length = 0
  h.state.share = null
  h.state.fileShareId = null
  h.state.nodes = { n1: task() }
})
afterEach(() => {
  delete (navigator as { share?: unknown }).share
  window.matchMedia = realMatchMedia
})

/** The popover's actions are one row: Copy · Open · Revoke (+ Share… on touch). */
function actionRow(r: Awaited<ReturnType<typeof renderTodoViewer>>) {
  const row = r.getByTestId("markdown-share-actions")
  return ["markdown-share-copy", "markdown-share-native", "markdown-share-open", "markdown-share-revoke"].filter((id) => row.querySelector(`[data-testid="${id}"]`))
}

describe("Markdown viewer share affordance", () => {
  it("[TODOOV-AC-9] fine pointer: one click on Share publishes, copies the link and shows Link copied then Published, with no popover, even with navigator.share stubbed", async () => {
    stubEnv({ pointer: "fine", clipboard: "resolve", nativeShare: true })
    const r = await renderTodoViewer()
    fireEvent.click(r.getByTestId("markdown-share"))
    await waitFor(() => r.getByTestId("markdown-share-copied-badge"))
    expect(h.calls.filter((c) => c.tool === "share-io")).toHaveLength(1)
    expect(writeText).toHaveBeenCalledWith(URL1)
    expect(share).not.toHaveBeenCalled()
    expect(r.getByTestId("markdown-share-copied-badge").textContent).toContain("Link copied")
    expect(r.queryByTestId("markdown-share-popover")).toBeNull()
    await waitFor(() => r.getByTestId("markdown-share-published"), { timeout: 4500 })
    expect(r.queryByTestId("markdown-share-copied-badge")).toBeNull()
    expect(r.queryByTestId("markdown-share-popover")).toBeNull()
  }, 10000)

  it("[TODOOV-AC-9] clicking Published opens the popover with the link and one row Copy · Open · Revoke (tooltip = the link); Revoke unpublishes and closes it", async () => {
    h.state.share = { shareId: "s1", publicUrl: URL1 }
    stubEnv({ pointer: "fine", clipboard: "resolve", nativeShare: true })
    const r = await renderTodoViewer()
    const badge = await waitFor(() => r.getByTestId("markdown-share-published"))
    expect(badge.textContent).toContain("Published")
    expect(badge.getAttribute("title")).toBe(URL1)
    expect(r.queryByTestId("markdown-share-popover")).toBeNull()

    fireEvent.click(badge)
    await waitFor(() => r.getByTestId("markdown-share-popover"))
    const field = r.getByTestId("markdown-share-url") as HTMLInputElement
    expect(field.value).toBe(URL1)
    expect(field.readOnly).toBe(true)
    expect(actionRow(r)).toEqual(["markdown-share-copy", "markdown-share-open", "markdown-share-revoke"])
    expect(h.calls.some((c) => c.tool === "share-io")).toBe(false)

    // Copy confirms below the field; its pill keeps the label "Copy", so the row never reflows.
    const copy = r.getByTestId("markdown-share-copy")
    expect(copy.textContent).toBe("Copy")
    fireEvent.click(copy)
    await waitFor(() => r.getByTestId("markdown-share-copied"))
    expect(writeText).toHaveBeenCalledWith(URL1)
    expect(r.getByTestId("markdown-share-copied").textContent).toBe("Link copied")
    expect(r.getByTestId("markdown-share-copy").textContent).toBe("Copy")
    expect(actionRow(r)).toEqual(["markdown-share-copy", "markdown-share-open", "markdown-share-revoke"])

    fireEvent.click(r.getByTestId("markdown-share-revoke"))
    await waitFor(() => expect(r.queryByTestId("markdown-share-published")).toBeNull())
    expect(h.calls.filter((c) => c.tool === "unshare-io")).toEqual([{ tool: "unshare-io", input: { shareId: "s1" } }])
    await waitFor(() => expect(r.queryByTestId("markdown-share-popover")).toBeNull())
  })

  it("[TODOOV-AC-9] fine pointer, a rejected clipboard write opens the popover on the link with Copy it by hand", async () => {
    stubEnv({ pointer: "fine", clipboard: "reject", nativeShare: false })
    const r = await renderTodoViewer()
    fireEvent.click(r.getByTestId("markdown-share"))
    await waitFor(() => r.getByTestId("markdown-share-popover"))
    expect(writeText).toHaveBeenCalledWith(URL1)
    expect(r.getByTestId("markdown-share-copy-hint").textContent).toBe("Copy it by hand")
    expect((r.getByTestId("markdown-share-url") as HTMLInputElement).value).toBe(URL1)
    expect(r.queryByTestId("markdown-share-copied-badge")).toBeNull()
    expect(r.getByTestId("markdown-share-published")).toBeTruthy()
  })

  it("[TODOOV-AC-9] coarse pointer with navigator.share stubbed: Share publishes without copying and opens the popover with Share… calling it with the url", async () => {
    stubEnv({ pointer: "coarse", clipboard: "resolve", nativeShare: true })
    const r = await renderTodoViewer()
    fireEvent.click(r.getByTestId("markdown-share"))
    await waitFor(() => r.getByTestId("markdown-share-popover"))
    expect(h.calls.filter((c) => c.tool === "share-io")).toHaveLength(1)
    expect(writeText).not.toHaveBeenCalled()
    expect((r.getByTestId("markdown-share-url") as HTMLInputElement).value).toBe(URL1)
    expect(actionRow(r)).toEqual(["markdown-share-copy", "markdown-share-native", "markdown-share-open", "markdown-share-revoke"])
    const native = r.getByTestId("markdown-share-native")
    expect(native.textContent).toContain("Share…")
    fireEvent.click(native)
    expect(share).toHaveBeenCalledWith({ url: URL1, title: "Landing de precios" })
  })

  it("[TODOOV-AC-9] the file source publishes through file.share with the same one-click flow and revokes through file.unshare", async () => {
    stubEnv({ pointer: "fine", clipboard: "resolve", nativeShare: false })
    const { MarkdownViewerWindowContent } = await import("./MarkdownViewerWindowContent")
    const r = renderWithTamagui(<MarkdownViewerWindowContent windowId="w-f" filePath="/docs/notes.md" channelId="c1" workspaceId="ws1" />)
    await waitFor(() => r.getByText("Notes"))
    fireEvent.click(r.getByTestId("markdown-share"))
    await waitFor(() => r.getByTestId("markdown-share-copied-badge"))
    expect(h.calls.filter((c) => c.tool === "file.share")).toEqual([{ tool: "file.share", input: { filePath: "/docs/notes.md", channelId: "c1", fileType: "markdown" } }])
    expect(writeText).toHaveBeenCalledWith("https://teros.test/share/f1")
    expect(r.queryByTestId("markdown-share-popover")).toBeNull()
    // Share again (already published) opens the popover; Revoke goes through file.unshare.
    fireEvent.click(r.getByTestId("markdown-share"))
    fireEvent.click(await waitFor(() => r.getByTestId("markdown-share-revoke")))
    await waitFor(() => expect(h.calls.filter((c) => c.tool === "file.unshare")).toEqual([{ tool: "file.unshare", input: { shareId: "f1" } }]))
  })
})
