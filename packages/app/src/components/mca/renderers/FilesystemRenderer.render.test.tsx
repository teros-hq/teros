/**
 * Render tests — FilesystemRenderer dispatch coverage (task: re-map to the
 * 2026-09 tool rename).
 *
 * Two guards:
 * 1. COVERAGE: every tool declared in the filesystem tools.json (the source
 *    of truth for mca.teros.filesystem; the retired admin variant shared it)
 *    must render through a DEDICATED sub-renderer — not the dev-only
 *    FallbackRenderer. This is what lets a future rename break CI instead of
 *    silently regressing 100% of calls to the fallback (the bug this task fixed).
 * 2. CONTENT: representative tools render their real output shape (verified
 *    against live MCA calls, 2026-10-06).
 *
 * CodeBlock is mocked: the real one pulls react-native-code-highlighter, which
 * is unnecessary weight for jsdom and not part of what we assert here.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fireEvent, screen } from "@testing-library/react"
import { Text } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PermissionContext, type ToolCallRendererProps } from "../types"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import FilesystemToolCallRenderer from "./FilesystemRenderer"

// CodeBlock pulls react-native-code-highlighter — unnecessary weight for jsdom
// and not part of what we assert here.
vi.mock("../CodeBlock", () => ({
  CodeBlock: (props: { code?: string; filename?: string }) =>
    props.code ? <Text testID="code-block">{props.code}</Text> : null,
}))

// PermissionDetail (mounted by withPermissionSupport while pending) fetches
// tool metadata via this hook — mock it like the sibling permission tests do.
const useToolDetails = vi.hoisted(() => vi.fn())
vi.mock("../../../hooks/mca/useToolDetails", () => ({
  useToolDetails: (...args: unknown[]) => useToolDetails(...args),
  toolDetailsCache: { reset: () => {} },
}))

const here = dirname(fileURLToPath(import.meta.url))
// packages/app/src/components/mca/renderers → repo root/mcas
const TOOLS_JSON = resolve(here, "../../../../../../mcas/mca.teros.filesystem/tools.json")

interface ToolsFile {
  tools: Array<{ name: string }>
}

function toolNames(file: string): string[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ToolsFile
  return parsed.tools.map((t) => t.name)
}

function renderToolCall(props: Partial<ToolCallRendererProps>) {
  return renderWithTamagui(
    <PermissionContext.Provider
      value={{ onGrant: vi.fn(), onGrantAlways: vi.fn(), onDeny: vi.fn(), onDenyAlways: vi.fn() }}
    >
      <FilesystemToolCallRenderer
        toolCallId="tc-test"
        toolName="filesystem_read-file"
        status="completed"
        {...props}
      />
    </PermissionContext.Provider>,
  )
}

// Cards render collapsed by default — the header (role=button) toggles the
// body. Body-content assertions must expand first. jsdom: click (not press).
function expandCard() {
  fireEvent.click(screen.getByRole("button"))
}

beforeEach(() => {
  useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("FilesystemRenderer — dispatch coverage vs tools.json", () => {
  it("every filesystem tool has a dedicated renderer (no fallback)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const names = toolNames(TOOLS_JSON)

    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const { unmount } = renderToolCall({
        toolName: `filesystem_${name}`,
        output: JSON.stringify({ file: `/workspace/x/${name}.txt`, name: `${name}.txt` }),
      })
      expect(
        screen.queryByText("no renderer"),
        `tool "${name}" fell through to FallbackRenderer — add a sub-renderer + RENDERERS entry`,
      ).toBeNull()
      unmount()
    }
    // Scoped to OUR fallback warn — jsdom also fires RN's unrelated
    // `useNativeDriver` warning (HeaderRow uses Animated.timing).
    const fallbackWarns = warn.mock.calls.filter((call) =>
      String(call[0]).includes("[FilesystemRenderer]"),
    )
    expect(fallbackWarns).toEqual([])
  })
})

describe("FilesystemRenderer — representative content", () => {
  it("read-file renders content + line-count badge", () => {
    renderToolCall({
      toolName: "filesystem_read-file",
      input: { filePath: "/workspace/notes.md" },
      output: JSON.stringify({
        file: "/workspace/notes.md",
        name: "notes.md",
        size: 24,
        sizeHuman: "24 B",
        kind: "text",
        totalLines: 2,
        displayedLines: 2,
        truncated: false,
        mtime: "2026-10-06T00:00:00.000Z",
        content: "00001| hello\n00002| world",
      }),
    })

    expandCard()

    expect(screen.getByText("Read notes.md")).toBeTruthy()
    expect(screen.getByText("2/2 lines")).toBeTruthy()
    expect(screen.getByTestId("code-block").textContent).toContain("hello")
  })

  it("list-files renders entries + count badge", () => {
    renderToolCall({
      toolName: "filesystem_list-files",
      input: { path: "/workspace/src" },
      output: JSON.stringify({
        path: "/workspace/src",
        depth: 0,
        respectGitignore: false,
        totalEntries: 2,
        returned: 2,
        offset: 0,
        entries: [
          { name: "app.ts", path: "/workspace/src/app.ts", type: "file", size: 120, sizeHuman: "120 B", mtime: "2026-10-06T00:00:00.000Z", depth: 0, kind: "text" },
          { name: "lib", path: "/workspace/src/lib", type: "directory", size: 0, mtime: "", depth: 0, kind: "unknown" },
        ],
        nextCursor: null,
      }),
    })

    expandCard()

    expect(screen.getByText("List src")).toBeTruthy()
    expect(screen.getByText("2 entries")).toBeTruthy()
    expect(screen.getByText("app.ts")).toBeTruthy()
  })

  it("search-in-files content mode renders match with context", () => {
    renderToolCall({
      toolName: "filesystem_search-in-files",
      input: { pattern: "needle", path: "/workspace/src", output_mode: "content" },
      output: JSON.stringify({
        pattern: "needle",
        path: "/workspace/src",
        mode: "content",
        totalMatches: 1,
        totalFiles: 1,
        truncated: false,
        returned: 1,
        offset: 0,
        matches: [
          {
            file: "/workspace/src/app.ts",
            lineNumber: 3,
            matchText: "needle",
            lineText: "find the needle here",
            contextBefore: [{ lineNumber: 2, text: "line before" }],
            contextAfter: [{ lineNumber: 4, text: "line after" }],
          },
        ],
      }),
    })

    expandCard()

    expect(screen.getByText('Search "needle"')).toBeTruthy()
    expect(screen.getByText("1 matches")).toBeTruthy()
    // lineText is split by highlightMatch into segments — assert on the
    // unsplit elements instead: filename, line badge, highlighted "needle"
    // segment, and the context line.
    expect(screen.getByText("app.ts")).toBeTruthy()
    expect(screen.getByText(":3")).toBeTruthy()
    // "needle" renders twice: the header's grey subtitle (first short string input
    // value, 6e666b49b) and the highlighted segment inside the match line.
    expect(screen.getAllByText("needle")).toHaveLength(2)
    expect(screen.getByText("line before")).toBeTruthy()
  })

  it("delete-file renders the deleted path with line-through semantics", () => {
    renderToolCall({
      toolName: "filesystem_delete-file",
      input: { path: "/workspace/old.txt" },
      output: JSON.stringify({
        path: "/workspace/old.txt",
        name: "old.txt",
        existed: true,
        deleted: true,
        type: "file",
      }),
    })

    expandCard()

    expect(screen.getByText("Delete old.txt")).toBeTruthy()
    // "deleted" intentionally appears twice: the status badge and the
    // ResourceCard verb — both carry the outcome.
    expect(screen.getAllByText("deleted").length).toBeGreaterThan(0)
    expect(screen.getByText("old.txt")).toBeTruthy()
  })

  it("move-file renders source → destination", () => {
    renderToolCall({
      toolName: "filesystem_move-file",
      input: { source: "/workspace/a.txt", destination: "/workspace/b.txt" },
      output: JSON.stringify({
        source: "/workspace/a.txt",
        destination: "/workspace/b.txt",
        sourceName: "a.txt",
        destinationName: "b.txt",
        type: "file",
        overwritten: false,
      }),
    })

    expandCard()

    expect(screen.getByText("Move a.txt → b.txt")).toBeTruthy()
    expect(screen.getByText("moved")).toBeTruthy()
  })

  it("pending_permission surfaces the filesystem permission description", () => {
    renderToolCall({
      toolName: "filesystem_delete-file",
      status: "pending_permission",
      permissionRequestId: "pr-test",
      appId: "app-test",
      input: { path: "/workspace/old.txt" },
    })

    expect(
      screen.getByText(/Wants to permanently delete a path: \/workspace\/old\.txt/),
    ).toBeTruthy()
  })
})
