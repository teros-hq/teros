/**
 * The Markdown viewer's To Do source (docs/specs/todo/output-window.md):
 * a task's markdown output or input, read live from the To Do app slice and
 * shared through the To Do app's share-io actions (TODOOV-REQ-4).
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform } from "react-native"
import { useTilingStore } from "../../store/tilingStore"
import { windowRegistry } from "../../services/windowRegistry"
import { useWindowTabMeta } from "../../store/windowTabMetaStore"
import { callTodo } from "../TodoWindow/data/todoApi"
import { loadNode, subscribeApp, useAppSlice, watchNode } from "../TodoWindow/data/todoStore"
import type { SharePopoverModel } from "../../components/ui/SharePopover"
import type { TodoMarkdownSource } from "./definition"

/** @spec TODOOV-REQ-5 Dedup key of a To Do source: one window per node + io. */
export const todoSourceKey = (s: TodoMarkdownSource) => `todo:${s.nodeId}:${s.io}` // = definition.getKey

/**
 * @spec TODOOV-REQ-6 Open a task's markdown io in the Markdown viewer as a
 * preview tab beside `sourceWindowId` (the detail). A window already showing
 * that io is shown again instead of opening a second one.
 */
export function openTodoMarkdown(todo: TodoMarkdownSource, title: string, sourceWindowId?: string): void {
  const tiling = useTilingStore.getState()
  const def = windowRegistry.get("markdown-viewer")
  const key = todoSourceKey(todo)
  const existing = Object.values(tiling.windows).find((w) => w.type === "markdown-viewer" && def?.getKey?.(w.props as never) === key)
  // The tiling store dedups by prop identity: reuse the open window's props object.
  const props = existing ? existing.props : { filePath: "", todo, title }
  tiling.openWindow("markdown-viewer", props, { preview: true, sourceWindowId })
}

/** @spec TODOOV-REQ-7 Text as an ASCII, dash-separated file name stem. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "document"
}

/** @spec TODOOV-REQ-7 Anchor download of markdown text as a UTF-8 `.md` file. */
export function downloadMarkdown(markdown: string, fileName: string): void {
  if (Platform.OS !== "web") return
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }))
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.rel = "noopener"
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export type ShareState = "idle" | "publishing" | "published"

interface Share {
  shareId: string
  publicUrl: string
}

/**
 * @spec TODOOV-REQ-7 Share state of a To Do io: read with `get-io-share` on
 * mount (an existing link is shown, not recreated), `share-io` publishes,
 * `unshare-io` revokes. A failed publish / revoke leaves the state as it
 * was and exposes the error message.
 */
function useTodoShare(todo: TodoMarkdownSource) {
  const { appId, nodeId, io } = todo
  const [state, setState] = useState<ShareState>("idle")
  const [share, setShare] = useState<Share | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    callTodo<Share | null>(appId, "get-io-share", { nodeId, io })
      .then((s) => {
        if (!live.current) return
        setShare(s?.shareId ? s : null)
        setState(s?.shareId ? "published" : "idle")
      })
      .catch(() => {
        // Non-critical, as for file shares: the window stays unshared and Share can still publish.
      })
    return () => {
      live.current = false
    }
  }, [appId, nodeId, io])

  const publish = useCallback(async (): Promise<string | null> => {
    setState("publishing")
    setError(null)
    try {
      const s = await callTodo<Share>(appId, "share-io", { nodeId, io })
      setShare(s)
      setState("published")
      return s.publicUrl
    } catch (err) {
      setState("idle")
      setError(message(err))
      return null
    }
  }, [appId, nodeId, io])

  const unpublish = useCallback(async () => {
    if (!share) return
    setError(null)
    try {
      await callTodo(appId, "unshare-io", { shareId: share.shareId })
      setShare(null)
      setState("idle")
    } catch (err) {
      setError(message(err))
    }
  }, [appId, share])

  return { state, publicUrl: share?.publicUrl ?? null, error, publish, unpublish }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export type ViewerLoadState = "loading" | "loaded" | "error" | "empty"

/**
 * @spec TODOOV-REQ-5 A task's markdown io, live from the To Do app slice
 * (subscribeApp + watchNode: every `todo_node_changed` reloads it through
 * get-node). `empty` when the io is missing or not markdown, `error` when the
 * task is gone. Publishes the task text as the tab title.
 */
export function useTodoMarkdown(todo: TodoMarkdownSource, windowId: string | undefined, title: string | undefined) {
  const { t } = useTranslation()
  const { appId, nodeId, io } = todo
  useEffect(() => subscribeApp(appId), [appId])
  useEffect(() => watchNode(appId, nodeId), [appId, nodeId])
  const node = useAppSlice(appId, (s) => s.details[nodeId])
  const status = useAppSlice(appId, (s) => s.detailStatus[nodeId])
  useWindowTabMeta(windowId, node ? { title: node.text } : null)

  const name = node?.text ?? title ?? ""
  const value = node ? (io === "input" ? node.input : node.output) : null
  const markdown = value?.format === "markdown" ? value.markdown : null
  const loadState: ViewerLoadState =
    status === "missing" || status === "error" ? "error" : !node ? "loading" : markdown === null ? "empty" : "loaded"
  return {
    name,
    markdown,
    loadState,
    subtitle: t(io === "input" ? "todo.io.inputMarkdown" : "todo.io.outputMarkdown"),
    emptyTitle: t(io === "input" ? "todo.io.noInputShort" : "todo.io.noOutputShort"),
    refresh: () => void loadNode(appId, nodeId),
    download: () => markdown !== null && downloadMarkdown(markdown, `${slugify(name)}.md`),
  }
}

/**
 * @spec TODOOV-REQ-7 @spec TODOOV-REQ-8 The To Do source's share model for
 * the viewer's share popover (get-io-share / share-io / unshare-io). It does
 * not copy by itself: the popover decides (auto-copy on desktop only).
 */
export function useTodoShareModel(todo: TodoMarkdownSource, title: string): SharePopoverModel {
  const share = useTodoShare(todo)
  return {
    state: share.state,
    publicUrl: share.publicUrl,
    error: share.error,
    title,
    publish: async () => void (await share.publish()),
    unpublish: share.unpublish,
  }
}
