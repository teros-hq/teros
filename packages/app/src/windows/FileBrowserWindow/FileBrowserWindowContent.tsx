/**
 * FileBrowserWindowContent — Root component for the File Browser window
 *
 * Manages navigation state (currentPath + history) and delegates to:
 *  - FileBrowserBreadcrumb: breadcrumb bar with back button
 *  - useFileListing: fetch directory entries via fs.list
 *  - FileBrowserEntry: individual file/directory rows
 *
 * If workspaceId is not provided as a prop, the component automatically
 * uses the activeWorkspaceId from the workspace store.
 *
 * File-open behaviour:
 *  - .md files: calls openFile() from fileOpener; shows toast if no handler registered
 *  - other files: shows toast "Opening this file type is not supported yet."
 *
 * Look: the OS prototype's file list — a breadcrumb strip on the sheet, a
 * mono column header and an LGroup of rows (folder/file glyph, name, size,
 * date, download IconBtn).
 */

import React, { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { ScrollView, View } from "react-native"
import { useToast } from "../../components/Toast"
import { openFile } from "../../services/fileOpener"
import type { FileEntry } from "../../services/FileBrowserApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useColors } from "../../components/mca/primitives/useColors"
import { AppSpinner } from "../../components/ui"
import { Btn, EmptyState, LGroup, T, usePagePadding } from "../../components/ui/ds"
import { FileBrowserBreadcrumb } from "./FileBrowserBreadcrumb"
import { FileBrowserEntry } from "./FileBrowserEntry"
import { useFileListing } from "./useFileListing"
import type { FileBrowserWindowProps } from "./definition"

// ============================================================================
// Types
// ============================================================================

interface Props extends FileBrowserWindowProps {
  windowId: string
}

// ============================================================================
// Main component
// ============================================================================

export function FileBrowserWindowContent({
  windowId,
  workspaceId: propWorkspaceId,
  initialPath,
}: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const c = useColors()
  const pad = usePagePadding()

  // Use the prop workspaceId if provided; otherwise fall back to the active workspace from the store
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const effectiveWorkspaceId = propWorkspaceId ?? activeWorkspaceId ?? ""

  // Navigation state
  const [currentPath, setCurrentPath] = useState(initialPath ?? "/workspace")
  const [history, setHistory] = useState<string[]>([])

  // Directory listing for the current path (only active when we have a workspaceId)
  const { status, entries, truncated, error, retry } = useFileListing(
    effectiveWorkspaceId,
    currentPath,
  )

  // ── Navigation ──────────────────────────────────────────────────────────────

  const navigateTo = useCallback(
    (path: string) => {
      setHistory((prev) => [...prev, currentPath])
      setCurrentPath(path)
    },
    [currentPath],
  )

  const navigateBack = useCallback(() => {
    if (history.length === 0) return
    const previous = history[history.length - 1]
    setHistory((prev) => prev.slice(0, -1))
    setCurrentPath(previous)
  }, [history])

  // ── File opening ────────────────────────────────────────────────────────────

  const handleOpenFile = useCallback(
    (entry: FileEntry) => {
      const handled = openFile(entry.path, effectiveWorkspaceId)
      if (!handled) {
        toast.info("No viewer available for this file type.")
      }
    },
    [effectiveWorkspaceId, toast],
  )

  // ── File download ───────────────────────────────────────────────────────────

  const handleDownloadFile = useCallback(
    async (entry: FileEntry) => {
      const client = getTerosClient()
      if (!client) {
        toast.error("Not connected")
        return
      }
      try {
        await client.fileBrowser.downloadFile(effectiveWorkspaceId, entry.path)
      } catch (err: any) {
        toast.error(err?.message ?? "Download failed")
      }
    },
    [effectiveWorkspaceId, toast],
  )

  // ── Render ──────────────────────────────────────────────────────────────────

  const folders = entries.filter((e) => e.type === "directory").length
  const files = entries.length - folders

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      {/* Breadcrumb */}
      <FileBrowserBreadcrumb
        currentPath={currentPath}
        canGoBack={history.length > 0}
        onNavigate={navigateTo}
        onBack={navigateBack}
        summary={
          status === "success"
            ? t("fileBrowser.summary", {
                defaultValue: "{{folders}} carpetas · {{files}} archivos",
                folders,
                files,
              })
            : undefined
        }
      />

      {/* Loading state */}
      {status === "loading" && (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
          <AppSpinner size="sm" variant="brand" />
          <T step="sm" tone="text3">
            {t("fileBrowser.loading", { defaultValue: "Loading…" })}
          </T>
        </View>
      )}

      {/* Error state */}
      {status === "error" && (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="warning-circle"
            title={t("fileBrowser.errorTitle", { defaultValue: "No se pudo leer la carpeta" })}
            text={error ?? t("errors.fileBrowser.loadFailed")}
            action={
              <Btn
                variant="sec"
                icon="arrows-clockwise"
                onPress={retry}
                testID="file-browser-retry"
              >
                {t("fileBrowser.retry", { defaultValue: "Retry" })}
              </Btn>
            }
          />
        </View>
      )}

      {/* Empty state */}
      {status === "success" && entries.length === 0 && (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="folder-open"
            title={t("fileBrowser.empty", { defaultValue: "This folder is empty." })}
          />
        </View>
      )}

      {/* Entries */}
      {status === "success" && entries.length > 0 && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: pad.h, paddingTop: 12, paddingBottom: pad.b }}
        >
          {/* Column header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 14,
              paddingBottom: 8,
              gap: 10,
            }}
          >
            <View style={{ width: 20 }} />
            <T step="codenote" tone="text3" style={{ flex: 1 }}>
              {t("fileBrowser.colName", { defaultValue: "Name" })}
            </T>
            <T step="codenote" tone="text3" style={{ width: 64, textAlign: "right" }}>
              {t("fileBrowser.colSize", { defaultValue: "Size" })}
            </T>
            <T step="codenote" tone="text3" style={{ width: 96, textAlign: "right" }}>
              {t("fileBrowser.colModified", { defaultValue: "Modified" })}
            </T>
            {/* Spacer for download button column */}
            <View style={{ width: 28 }} />
          </View>

          <View testID="file-browser-list">
            <LGroup>
              {entries.map((entry) => (
                <FileBrowserEntry
                  key={entry.path}
                  entry={entry}
                  onNavigate={navigateTo}
                  onOpenFile={handleOpenFile}
                  onDownloadFile={handleDownloadFile}
                />
              ))}
            </LGroup>
          </View>

          {/* Truncation notice */}
          {truncated && (
            <View
              style={{
                marginTop: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 10,
                backgroundColor: c.tint.a.bg,
                borderWidth: 1,
                borderColor: c.tint.a.bd,
              }}
            >
              <T step="12" color={c.tint.a.tx} center>
                {t("fileBrowser.truncated", {
                  defaultValue: "Showing first 1,000 entries. The directory contains more files.",
                })}
              </T>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  )
}
