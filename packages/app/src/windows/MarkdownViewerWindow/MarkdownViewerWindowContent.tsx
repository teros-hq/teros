/**
 * MarkdownViewerWindowContent
 *
 * Main component for the Markdown Viewer window.
 *
 * Lifecycle:
 *   1. On mount (or filePath/channelId change): call client.fileWatcher.watch()
 *      and listen for the first `file_changed` event.
 *   2. Once content is received: unwatch (read-once model per spec) and render.
 *   3. Refresh button: re-initiates the watch → receive → unwatch cycle.
 *   4. "← Back" button (only when returnPath is provided): opens the File Browser
 *      at the returnPath directory.
 *
 * Error handling:
 *   - File not found / permission denied / WS disconnect → descriptive error + Retry
 *   - Markdown parse error → "Could not render" + raw fallback if possible
 *
 * Look: the OS prototype's window header strip (file name + mono path,
 * quiet download / share / refresh IconBtns) over the rendered document on the sheet.
 * Share opens the share popover (./shareAffordance, TODOOV-REQ-8).
 * Before Download, the Formatted / Source toggle (./viewMode, TODOOV-REQ-10).
 *
 * Second source (TODOOV, docs/specs/todo/output-window.md): with `todo`
 * props the window shows a To Do task's markdown output or input, live from
 * the To Do app slice, shared through the To Do app's share-io actions.
 */

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, ScrollView, View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { AppSpinner } from "../../components/ui"
import { useTilingStore } from "../../store/tilingStore"
import type { MarkdownViewerWindowProps, TodoMarkdownSource } from "./definition"
import { downloadMarkdown, type ViewerLoadState, useTodoMarkdown, useTodoShareModel } from "./todoSource"
import { ShareAffordance, useFileShareModel } from "./shareAffordance"
import type { SharePopoverModel } from "../../components/ui/SharePopover"
import { MarkdownRenderer } from "./components/MarkdownRenderer"
import { MarkdownSource, ViewModeToggle, useViewMode } from "./viewMode"
import { useColors } from "../../components/mca/primitives/useColors"
import { Btn, EmptyState, IconBtn, Ph, T } from "../../components/ui/ds"

interface Props extends MarkdownViewerWindowProps {
  windowId: string
}

type LoadState = "loading" | "loaded" | "error"

export function MarkdownViewerWindowContent(props: Props) {
  return props.todo ? <TodoSourceViewer {...props} todo={props.todo} /> : <FileSourceViewer {...props} />
}

function FileSourceViewer({
  windowId,
  filePath,
  channelId,
  workspaceId,
  returnPath,
}: Props) {
  const c = useColors()

  const [content, setContent] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [errorMsg, setErrorMsg] = useState<string>("")
  const [loadKey, setLoadKey] = useState(0) // increment to trigger re-load

  const listenerRef = useRef<((msg: any) => void) | null>(null)
  const unwatchedRef = useRef(false) // guard: only unwatch once per load cycle

  const openWindow = useTilingStore((s) => s.openWindow)
  const client = getTerosClient()

  const filename = filePath.split("/").pop() ?? filePath
  const share = useFileShareModel(client, filePath, channelId, workspaceId, filename)

  // ── Load file ──────────────────────────────────────────────────────────────

  const startLoading = useCallback(() => {
    if (!client || !filePath || (!channelId && !workspaceId)) return

    setLoadState("loading")
    setContent(null)
    setErrorMsg("")
    unwatchedRef.current = false

    // Remove any stale listener from a previous load cycle
    if (listenerRef.current) {
      client.off("file_changed", listenerRef.current)
      listenerRef.current = null
    }

    const handler = (msg: { filePath: string; content: string; error?: string }) => {
      if (msg.filePath !== filePath) return

      // Read-once: stop watching after the first event
      if (!unwatchedRef.current) {
        unwatchedRef.current = true
        client.fileWatcher.unwatch(filePath).catch(() => {})
        client.off("file_changed", handler as (...args: unknown[]) => void)
        listenerRef.current = null
      }

      if (msg.error) {
        setErrorMsg(msg.error)
        setLoadState("error")
        return
      }

      setContent(msg.content ?? "")
      setLoadState("loaded")
    }

    listenerRef.current = handler as (...args: unknown[]) => void
    client.on("file_changed", handler as (...args: unknown[]) => void)

    client.fileWatcher.watch(filePath, channelId!, workspaceId!).catch((err: Error) => {
      const msg = err?.message ?? "Unknown error"
      // Distinguish common error types
      if (/not found|ENOENT/i.test(msg)) {
        setErrorMsg(`File not found: ${filePath}`)
      } else if (/permission|EACCES/i.test(msg)) {
        setErrorMsg("Cannot read file: permission denied.")
      } else if (/connect|websocket/i.test(msg)) {
        setErrorMsg("Connection lost. Could not load file.")
      } else {
        setErrorMsg(`Could not load file: ${msg}`)
      }
      setLoadState("error")

      // Clean up listener
      if (listenerRef.current) {
        client.off("file_changed", listenerRef.current)
        listenerRef.current = null
      }
    })
  }, [client, filePath, channelId, workspaceId])

  // Trigger load on mount and when loadKey changes (refresh)
  useEffect(() => {
    startLoading()

    return () => {
      // Cleanup on unmount or before next effect run
      if (listenerRef.current) {
        client?.off("file_changed", listenerRef.current)
        listenerRef.current = null
      }
      // Best-effort unwatch if we haven't already
      if (!unwatchedRef.current && client) {
        client.fileWatcher.unwatch(filePath).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, channelId, workspaceId, loadKey])

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleRefresh = () => {
    setLoadKey((k) => k + 1)
  }

  const handleBack = () => {
    if (!returnPath) return
    // Open (or focus) the File Browser at returnPath
    openWindow("file-browser", { initialPath: returnPath }, false)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <ViewerFrame
      leading={
        returnPath ? (
          <Btn variant="ghost" size="sm" icon="arrow-left" onPress={handleBack} testID="markdown-back">
            Back
          </Btn>
        ) : null
      }
      name={filename}
      sub={filePath}
      share={share}
      onDownload={content !== null ? () => downloadMarkdown(content, filename) : undefined}
      onRefresh={handleRefresh}
      loadState={loadState}
      loadingText={`Loading ${filename}…`}
      errorTitle="Could not load file"
      errorText={errorMsg || "An unknown error occurred."}
      content={content}
    />
  )
}

// ============================================================================
// To Do source (TODOOV)
// ============================================================================

/** The To Do source (TODOOV-REQ-5, TODOOV-REQ-7): logic in ./todoSource. */
function TodoSourceViewer({ windowId, todo, title }: Props & { todo: TodoMarkdownSource }) {
  const { t } = useTranslation()
  const doc = useTodoMarkdown(todo, windowId, title)
  const share = useTodoShareModel(todo, doc.name)
  return (
    <ViewerFrame
      name={doc.name}
      sub={doc.subtitle}
      share={doc.markdown !== null ? share : null}
      onDownload={doc.markdown !== null ? doc.download : undefined}
      onRefresh={doc.refresh}
      loadState={doc.loadState}
      loadingText={t("todo.loading")}
      errorTitle={t("todo.empty.missingTitle")}
      errorText={t("todo.empty.missingBody")}
      emptyTitle={doc.emptyTitle}
      content={doc.markdown}
    />
  )
}

// ============================================================================
// Frame: toolbar strip + document (shared by both sources)
// ============================================================================

function ViewerFrame({
  leading,
  name,
  sub,
  share,
  onDownload,
  onRefresh,
  loadState,
  loadingText,
  errorTitle,
  errorText,
  emptyTitle,
  content,
}: {
  leading?: React.ReactNode
  name: string
  sub: string
  share: SharePopoverModel | null
  onDownload?: () => void
  onRefresh: () => void
  loadState: ViewerLoadState
  loadingText: string
  errorTitle: string
  errorText: string
  emptyTitle?: string
  content: string | null
}) {
  const c = useColors()
  const { t } = useTranslation()
  const [mode, setMode] = useViewMode()
  const body = (text: string) => (mode === "source" ? <MarkdownSource content={text} /> : <MarkdownRenderer content={text} />)

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      {/* ── Toolbar ── */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 56,
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: c.bgSheet,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          flexShrink: 0,
        }}
      >
        {leading}

        <Ph name="file-md" size={18} color={c.accent} />

        {/* File icon + name */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="sm" ellipsis>
            {name}
          </T>
          <T step="codenote" tone="text3" ellipsis style={{ textTransform: "none" }}>
            {sub}
          </T>
        </View>

        {/* Formatted / Source (TODOOV-REQ-10) */}
        <ViewModeToggle mode={mode} onChange={setMode} />

        {/* Download (TODOOV-REQ-7): the rendered markdown as a .md file */}
        {onDownload ? (
          <IconBtn
            icon="download-simple"
            plain
            sm
            onPress={onDownload}
            accessibilityLabel={t("conversation.download")}
            title={t("conversation.download")}
            testID="markdown-download"
          />
        ) : null}

        {/* Share (TODOOV-REQ-8): Published badge + popover */}
        {share ? <ShareAffordance model={share} /> : null}

        {/* Refresh button */}
        <IconBtn
          icon="arrows-clockwise"
          plain
          sm
          onPress={onRefresh}
          accessibilityLabel="Refresh"
          title="Refresh"
          testID="markdown-refresh"
        />
      </View>

      {/* ── Content area ── */}
      {loadState === "loading" && (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
          <AppSpinner size="md" />
          <T step="sm" tone="text3">
            {loadingText}
          </T>
        </View>
      )}

      {loadState === "error" && (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="warning-circle"
            title={errorTitle}
            text={errorText}
            action={
              <Btn variant="sec" icon="arrows-clockwise" onPress={onRefresh} testID="markdown-retry">
                Retry
              </Btn>
            }
          />
        </View>
      )}

      {loadState === "empty" && (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState icon="file-md" title={emptyTitle ?? ""} />
        </View>
      )}

      {loadState === "loaded" &&
        content !== null &&
        // MarkdownRenderer handles its own ScrollView on native.
        // On web, wrap in a ScrollView so the toolbar stays fixed at the top.
        (Platform.OS === "web" ? (
          <ScrollView style={{ flex: 1, backgroundColor: c.bgSheet }} contentContainerStyle={{ flexGrow: 1 }}>
            {body(content)}
          </ScrollView>
        ) : mode === "source" ? (
          <ScrollView style={{ flex: 1, backgroundColor: c.bgSheet }}>{body(content)}</ScrollView>
        ) : (
          body(content)
        ))}
    </View>
  )
}
