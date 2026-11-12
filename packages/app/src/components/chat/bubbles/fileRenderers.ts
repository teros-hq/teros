/**
 * fileRenderers — the single source of truth of the FVU render table
 * (spec FVU-REQ-3): mimetype/extension → render kind.
 *
 * ONE table shared by the inline chat widget (FileBubble) and the
 * FileViewerWindow host, so both always agree on how a file renders.
 * Pure logic — no React, no styles: trivially testable.
 */

// ─── Render kinds ─────────────────────────────────────────────────────────────

export type FileRenderKind =
  | "markdown"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "csv"
  | "json"
  | "text"
  | "html"
  | "fallback"

/** Types whose content is textual and can be watched live via file.watch
 *  (auto-refresh in the FileViewer, FVU-REQ-4). Binaries reload on reopen. */
export const WATCHABLE_KINDS: ReadonlySet<FileRenderKind> = new Set([
  "markdown",
  "csv",
  "json",
  "text",
  "html",
])

/** Max file size (bytes) we try to render inline. Larger → fallback (edge case
 *  in the spec: >10MB binary never goes inline; download always works). */
export const INLINE_MAX_BYTES = 10 * 1024 * 1024

/** v1.3.6: single source of truth for "the body of this bubble IS the fallback
 *  row" (icon + name + size + explicit buttons, no strip above it) — used by
 *  FileBubble to hide the strip. v1.3.9: TRUE for fallback kinds only
 *  (zip/binaries). The "pdf on narrow web" case is GONE: that v1.3.4
 *  diagnosis (mobile browsers don't render PDF iframes) was contaminated by
 *  the X-Frame-Options bug — Pablo verified on iPhone that the inline iframe
 *  renders perfectly once XFO was fixed (v1.3.7). PDF = strip + inline
 *  iframe at EVERY width. */
export function rendersAsFallbackRow(kind: FileRenderKind): boolean {
  return kind === "fallback"
}

// ─── Extension → kind (fast path, filename-driven) ───────────────────────────

const EXT_TO_KIND: Record<string, FileRenderKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".svg": "image",
  ".pdf": "pdf",
  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".flac": "audio",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".csv": "csv",
  ".tsv": "csv",
  ".json": "json",
  ".jsonl": "json",
  ".txt": "text",
  ".log": "text",
  ".html": "html",
  ".htm": "html",
}

// ─── Mimetype → kind (fallback path when mimeType is present) ────────────────

const MIME_PREFIX_TO_KIND: Array<[string, FileRenderKind]> = [
  ["text/markdown", "markdown"],
  ["image/", "image"],
  ["application/pdf", "pdf"],
  ["audio/", "audio"],
  ["video/", "video"],
  ["text/csv", "csv"],
  ["application/json", "json"],
  ["text/plain", "text"],
  ["text/html", "html"],
]

/**
 * Resolve the render kind for a file. Extension wins (it is what the agent
 * controls and what the UX spec keys on); the mimetype is a fallback when
 * there is no known extension. Unknown → "fallback" — the render NEVER fails
 * by type (FVU-REQ-5).
 */
export function getRenderKind(filename: string, mimeType?: string): FileRenderKind {
  const dot = filename.lastIndexOf(".")
  if (dot >= 0) {
    const ext = filename.slice(dot).toLowerCase()
    const byExt = EXT_TO_KIND[ext]
    if (byExt) return byExt
  }
  if (mimeType) {
    const mime = mimeType.toLowerCase()
    for (const [prefix, kind] of MIME_PREFIX_TO_KIND) {
      if (mime.startsWith(prefix)) return kind
    }
  }
  return "fallback"
}

/** Whether this kind should be inline-rendered at the given size.
 *  Oversized files always fall back to icon + name + size + actions. */
export function isInlineRenderable(kind: FileRenderKind, size?: number): boolean {
  if (kind === "fallback") return false
  if (size !== undefined && size > INLINE_MAX_BYTES) return false
  return true
}

/** Phosphor icon name for a kind — used by the strip and the fallback body. */
export function kindIcon(kind: FileRenderKind, filename = ""): string {
  switch (kind) {
    case "markdown":
      return "file-md"
    case "image":
      return "image"
    case "pdf":
      return "file-pdf"
    case "audio":
      return "speaker-high"
    case "video":
      return "video-camera"
    case "csv":
      return "table"
    case "json":
      return "brackets-curly"
    case "text":
      return "file-text"
    case "html":
      return "file-code"
    case "fallback":
      // v1.3.5: archives keep their specific icon — the generic 'file'
      // regressed in v1.3.4 (Pablo: "el icono ha pasado a fichero genérico").
      if (/\.(zip|rar|7z|tar|gz|tgz)$/i.test(filename)) return "file-zip"
      return "file"
    default:
      return "file"
  }
}

/** Short uppercase subtype label for the strip (e.g. "MD", "PDF", "ZIP"). */
export function kindLabel(kind: FileRenderKind, filename: string): string {
  if (kind !== "fallback") {
    const map: Record<FileRenderKind, string> = {
      markdown: "MD",
      image: "IMG",
      pdf: "PDF",
      audio: "AUDIO",
      video: "VIDEO",
      csv: "CSV",
      json: "JSON",
      text: "TXT",
      html: "HTML",
      fallback: "FILE",
    }
    return map[kind]
  }
  const dot = filename.lastIndexOf(".")
  return dot >= 0 ? filename.slice(dot + 1).slice(0, 6).toUpperCase() : "FILE"
}

/** Format bytes for display ("12.4 KB") — shared by strip and fallback body. */
export function formatFileSize(bytes?: number): string {
  if (!bytes) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Map a render kind to the SharePopover fileType (backend contract). */
export function shareFileType(kind: FileRenderKind): "html" | "markdown" | "file" {
  if (kind === "html") return "html"
  if (kind === "markdown") return "markdown"
  return "file"
}
