/**
 * FileBrowserEntry — A single row in the file browser listing
 *
 * Displays:
 *  - Icon (folder or file)
 *  - Name
 *  - Size (files only; directories show '—')
 *  - Last modified date
 *  - Download button (files only)
 *
 * Clicking a directory navigates into it.
 * Clicking a .md file calls the fileOpener hook.
 * Clicking other files shows a toast.
 * Clicking the download button triggers a file download (files only).
 *
 * Look: an LRow inside the browser's LGroup — accent folder glyph, muted
 * file glyph, mono file names, codenote size/date, a quiet download IconBtn.
 */

import React from "react"
import { View } from "react-native"
import type { FileEntry } from "../../services/FileBrowserApi"
import { useColors } from "../../components/mca/primitives/useColors"
import { IconBtn, LRow, Ph, T } from "../../components/ui/ds"

// ============================================================================
// Types
// ============================================================================

interface Props {
  entry: FileEntry
  onNavigate: (path: string) => void
  onOpenFile: (entry: FileEntry) => void
  onDownloadFile?: (entry: FileEntry) => void
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a byte count as a human-readable string.
 * e.g. 1234567 → '1.2 MB'
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Format an ISO 8601 date string as a short human-readable date.
 * e.g. '2026-03-17T09:12:34.292Z' → 'Mar 17, 2026'
 */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  } catch {
    return "—"
  }
}

/** Phosphor glyph by extension — a little semantic colour for common types. */
function fileGlyph(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "md" || ext === "mdx") return "file-md"
  if (["html", "htm"].includes(ext)) return "file-html"
  if (["js", "ts", "tsx", "jsx", "py", "json", "yaml", "yml", "sh", "css"].includes(ext))
    return "file-code"
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image"
  if (["txt", "log", "csv"].includes(ext)) return "file-text"
  return "file"
}

// ============================================================================
// Component
// ============================================================================

export function FileBrowserEntry({ entry, onNavigate, onOpenFile, onDownloadFile }: Props) {
  const c = useColors()
  const isDir = entry.type === "directory"

  const handlePress = () => {
    if (isDir) {
      onNavigate(entry.path)
    } else {
      onOpenFile(entry)
    }
  }

  const handleDownload = (e: any) => {
    // Prevent the row click from also firing
    e?.stopPropagation?.()
    onDownloadFile?.(entry)
  }

  const sizeLabel = isDir ? "—" : entry.size !== null ? formatSize(entry.size) : "—"
  const dateLabel = formatDate(entry.modifiedAt)

  return (
    <LRow onPress={handlePress} padV={9} padH={14} gap={10} testID={`file-entry-${entry.path}`}>
      {/* Icon */}
      <View style={{ width: 20, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {isDir ? (
          <Ph name="folder" size={16} color={c.accent} weight="fill" />
        ) : (
          <Ph name={fileGlyph(entry.name)} size={16} color={c.text3} />
        )}
      </View>

      {/* Name */}
      <T
        step={isDir ? "sm" : "code13"}
        tone={isDir ? "text" : "text2"}
        ellipsis
        style={{ flex: 1 }}
      >
        {entry.name}
      </T>

      {/* Size */}
      <T step="codenote" tone="text3" style={{ width: 64, textAlign: "right" }} selectable={false}>
        {sizeLabel}
      </T>

      {/* Modified date */}
      <T
        step="codenote"
        tone="text3"
        style={{ width: 96, textAlign: "right", textTransform: "none" }}
        selectable={false}
      >
        {dateLabel}
      </T>

      {/* Download button — files only */}
      {!isDir ? (
        <IconBtn
          icon="download-simple"
          plain
          sm
          onPress={handleDownload}
          accessibilityLabel="Download"
          title="Download"
          testID={`file-download-${entry.path}`}
        />
      ) : (
        /* Spacer to keep alignment consistent for directories */
        <View style={{ width: 28, flexShrink: 0 }} />
      )}
    </LRow>
  )
}
