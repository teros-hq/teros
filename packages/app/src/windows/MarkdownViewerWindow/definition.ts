/**
 * MarkdownViewer Window Type Definition
 *
 * Renders a Markdown file from the workspace volume with full formatting:
 * headings, lists, tables (GFM), fenced code blocks with syntax highlighting,
 * blockquotes, links (open in new tab), and images (external ones blocked).
 *
 * Opened from:
 *   - File Browser: clicking a .md / .markdown file
 *   - Chat: "Open in Markdown Viewer" button in an html_file bubble whose
 *     filePath ends in .md or .markdown
 *   - To Do: *Open* on a task's markdown output or input (`todo` source,
 *     docs/specs/todo/output-window.md) — then `filePath` is empty.
 */

import { FileText } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const MarkdownViewerWindowContent = lazyWithRetry(() =>
  import("./MarkdownViewerWindowContent").then((m) => ({ default: m.MarkdownViewerWindowContent })),
)

/** @spec TODOOV-REQ-5 A task's markdown output or input as the viewer's source. */
export interface TodoMarkdownSource {
  workspaceId: string
  appId: string
  nodeId: string
  io: "output" | "input"
}

export interface MarkdownViewerWindowProps {
  /** Absolute path inside the agent's volume (e.g. '/workspace/spec.md'); empty for a `todo` source. */
  filePath: string
  /** @spec TODOOV-REQ-5 Read a To Do task's io instead of a volume file. */
  todo?: TodoMarkdownSource
  /** @spec TODOOV-REQ-5 Tab title before the content loads (the task text for a `todo` source). */
  title?: string
  /**
   * Channel ID — used to resolve the correct workspace volume when opening from a chat context.
   * Mutually exclusive with workspaceId; at least one must be provided.
   */
  channelId?: string
  /**
   * Workspace ID — used to resolve the workspace volume when opening from the File Browser
   * (which has no channelId). Mutually exclusive with channelId.
   */
  workspaceId?: string
  /** Directory to return to when "← Back" is pressed. Omit when not opened from File Browser. */
  returnPath?: string
}

export const markdownViewerWindowDefinition: WindowTypeDefinition<MarkdownViewerWindowProps> = {
  type: "markdown-viewer",
  audience: "user",
  displayName: "Markdown Viewer",
  icon: FileText,
  phIcon: "file-text",
  color: "#6366f1", // Indigo

  component: MarkdownViewerWindowContent,

  defaultSize: { width: 800, height: 700 },
  minSize: { width: 400, height: 300 },

  // Same file path (or task io) → same window (deduplication)
  getKey: (props) => (props.todo ? `todo:${props.todo.nodeId}:${props.todo.io}` : props.filePath),

  getTitle: (props) => props.title ?? props.filePath.split("/").pop() ?? props.filePath,

  getSubtitle: (props) =>
    props.todo ? i18n.t(props.todo.io === "input" ? "todo.io.inputMarkdown" : "todo.io.outputMarkdown") : props.filePath,

  serialize: (props) => ({
    filePath: props.filePath,
    channelId: props.channelId,
    workspaceId: props.workspaceId,
    returnPath: props.returnPath,
    todo: props.todo,
    title: props.title,
  }),

  deserialize: (data) => ({
    filePath: data.filePath as string,
    channelId: data.channelId as string | undefined,
    workspaceId: data.workspaceId as string | undefined,
    returnPath: data.returnPath as string | undefined,
    todo: data.todo as TodoMarkdownSource | undefined,
    title: data.title as string | undefined,
  }),
}
