/**
 * FileBubble — the FVU universal file widget (spec v1.2.0).
 *
 * Structure (ux.md §3.1, Pablo's product decision v1.2):
 *   ┌────────────────────────────────────────────────────────┐
 *   │ ▤ name.ext   12.4 KB · MD        [⤓][FV][⤢][↗] (+5º)  │ ← strip: icon +
 *   │ /workspace/path/to/file.md  (hidden on narrow mobile)  │   name + meta +
 *   ├────────────────────────────────────────────────────────┤   ACTION ROW
 *   │              body — render by type (FileTypeBody)       │   (fixed-height
 *   └────────────────────────────────────────────────────────┘    row in strip)
 *
 * - v1.3.0: the strip carries ONLY the 2 essential actions (Descargar ·
 *   Abrir en FileViewer). Fullscreen/Share live in the viewer window.
 * - v1.3.0 adaptive width: the widget fills the available container width
 *   up to a cap (min(85%, 680px)) — wide markdown no longer overflows the
 *   screen (bodies scroll internally) and narrow content no longer looks
 *   lost in a short strip.
 * - The strip is INERT outside the buttons (Iria): the old click-to-download
 *   on the whole card is gone — actions live only in explicit buttons.
 * - The name truncates first (flex 1, min-width 0, ellipsis); the action row
 *   never shrinks. On narrow mobile the path line hides BEFORE the actions.
 * - Text content (MD/CSV/JSON/TXT) is fetched from /api/files when the file
 *   is live (filePath present); snapshots render URL-driven bodies only.
 * - Backward compatible: old `file` messages (url only) render as before but
 *   now with the 4 universal actions.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { getDateLocale } from "../../../i18n"
import { Platform, useWindowDimensions } from "react-native"
import { View, XStack, YStack } from "tamagui"
import { useColors } from "../../mca/primitives/useColors"
import { Ph, T } from "../../ui/ds"
import { useAuthStore } from "../../../store/authStore"
import { useTilingStore } from "../../../store/tilingStore"
import { QueuedIndicator, QueuedShimmer } from "../queuedDecorations"
import { SelectableText } from "./shared"
import { UniversalFileActions } from "./UniversalFileActions"
import { FileTypeBody } from "./FileTypeBody"
import { FileFullscreenOverlay } from "./FileFullscreenOverlay"
import {
  formatFileSize,
  getRenderKind,
  isInlineRenderable,
  kindIcon,
  kindLabel,
  rendersAsFallbackRow,
  WATCHABLE_KINDS,
} from "./fileRenderers"
import { backendUrl as resolveBackendUrl } from "../../../config/runtime"

export function FileBubble({
  url,
  filename,
  caption,
  mimeType,
  size,
  filePath,
  workspaceId,
  channelId,
  timestamp,
  isUser = false,
  showTimestamp = true,
  status,
}: {
  url: string
  filename: string
  caption?: string
  mimeType?: string
  size?: number
  /** FVU: live volume reference — enables FileViewer + Share + live fetch. */
  filePath?: string
  workspaceId?: string
  channelId?: string
  timestamp: Date
  isUser?: boolean
  showTimestamp?: boolean
  status?: "sending" | "sent" | "failed" | "queued"
}) {
  const c = useColors()
  const { width: screenWidth } = useWindowDimensions()
  const openWindow = useTilingStore((s: any) => s.openWindow)
  const sessionToken = useAuthStore((s: any) => s.sessionToken)
  const cookieAuth = useAuthStore((s: any) => s.cookieAuth)

  const kind = useMemo(() => getRenderKind(filename, mimeType), [filename, mimeType])
  const inline = isInlineRenderable(kind, size)
  // v1.3.4: html joins the text pipeline — the inline body (HtmlBody) needs
  // the fetched text to build its srcDoc; without it only the strip rendered
  // (Pablo: "del .html solo me ha cargado el header").
  const needsText = WATCHABLE_KINDS.has(kind)

  const [textContent, setTextContent] = useState<string | null>(null)
  const [textError, setTextError] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenTriggerRef = useRef<HTMLDivElement | null>(null)

  // Fetch text content for text files (MD/CSV/JSON/TXT):
  // - LIVE (filePath + context + session): authenticated /api/files — the
  //   file on the workspace volume, always current.
  // - SNAPSHOT (url only): the uploaded snapshot URL is public (download uses
  //   it directly) — fetch it plainly so MD/CSV/JSON/TXT snapshots still
  //   render inline (FVU-AC-1 covers snapshots too).
  useEffect(() => {
    if (!needsText) return
    let cancelled = false
    const backendUrl = resolveBackendUrl()
    let fetchUrl: string
    let headers: Record<string, string> = {}
    // F2: cookieAuth (web reload) has no in-memory token — the httpOnly
    // cookie sent with credentials:'include' authenticates the LIVE fetch.
    if (filePath && (channelId || workspaceId) && (sessionToken || cookieAuth)) {
      const contextParam = workspaceId
        ? `workspaceId=${encodeURIComponent(workspaceId)}`
        : `channelId=${encodeURIComponent(channelId!)}`
      fetchUrl = `${backendUrl}/api/files?path=${encodeURIComponent(filePath)}&${contextParam}`
      headers = { Authorization: `Bearer ${sessionToken}` }
    } else if (/^https?:\/\//.test(url)) {
      fetchUrl = url
    } else {
      return
    }
    fetch(fetchUrl, { credentials: "include", headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      })
      .then((text) => {
        if (!cancelled) {
          setTextContent(text)
          setTextError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setTextError(err?.message ?? "unknown")
      })
    return () => {
      cancelled = true
    }
  }, [needsText, filePath, channelId, workspaceId, sessionToken, cookieAuth, url])

  const handleOpenViewer = () => {
    if (!filePath || (!channelId && !workspaceId)) return
    setIsFullscreen(false)
    // _ts busts dedup so a re-download of the same path re-opens; preview
    // routing (preview-tabs.md) keeps it in the desktop's preview tab instead
    // of piling up tabs. Only ctrl/cmd-click opens a separate tab.
    openWindow("file-viewer", { filePath, channelId, workspaceId, _ts: Date.now() }, false)
  }

  const isQueued = status === "queued"
  const isNarrow = screenWidth < 640

  // v1.3.3 mobile width fix (Pablo's feedback 2026-10-16): NO FVU bubble may
  // ever exceed the window width. On narrow screens (<640px) the bubble fills
  // 100% of the available width — the symmetric L=R margins come from the
  // chat padding — and the 85%/680px cap only applies on wide screens, where
  // the leftover space is large enough not to read as a lopsided right gap.
  // minWidth:0 down the chain lets flex children shrink below their content's
  // intrinsic width (wide markdown tables) so bodies scroll INTERNALLY
  // instead of stretching the bubble past the screen edge.
  const maxWidth = isNarrow ? ("100%" as const) : Math.min(screenWidth * 0.85, 680)

  return (
    <YStack
      testID="file-bubble"
      maxWidth={maxWidth}
      width={"100%"}
      minWidth={0}
      gap="$2"
      alignSelf={isUser ? "flex-end" : "flex-start"}
      alignItems={isUser ? "flex-end" : "flex-start"}
    >
      {/* A card on the sheet (`.card hov`): violet lift, no border.
          v1.3.3: alignSelf stretch — the card fills the (capped) bubble
          width instead of fit-content; fit-content opted out of stretching
          (alignItems on the parent) and let wide tables blow past maxWidth.
          minWidth:0 lets it shrink when the parent is narrower. */}
      <YStack
        testID="file-bubble-card"
        borderRadius={16}
        overflow="hidden"
        backgroundColor={c.bgStep}
        position={isQueued ? "relative" : undefined}
        minWidth={0}
        alignSelf="stretch"
        borderWidth={1}
        borderColor={c.border}
        // @ts-ignore web-only lift — v1.3.4: light mode needs the border to
        // read against the near-identical sheet bg (#FFFFFF on #FAF9FC);
        // dark mode keeps the violet lift only (Pablo: "destaca muy poco").
        style={Platform.OS === "web" ? { boxShadow: c.lift } : undefined}
      >
        {isQueued && <QueuedShimmer />}

        {/* ── Strip: icon + name + meta + ACTION ROW (fixed-height row, not overlay) ──
            v1.3.4: hidden when the body IS the fallback row — the body already
            shows icon+name+size+buttons, so the strip was a duplicate header
            (Pablo: "no tendría que mostrar el header"). v1.3.6: shared
            predicate so the two can never diverge. v1.3.9: fallback kinds
            only — PDF shows strip + inline iframe at EVERY width (Pablo
            verified the iPhone iframe works; the old blank was XFO). */}
        {!rendersAsFallbackRow(kind) && (
        <XStack
          testID="file-bubble-strip"
          padding="$2"
          paddingHorizontal="$2.5"
          backgroundColor={c.nest}
          borderBottomWidth={1}
          borderBottomColor={c.border}
          alignItems="center"
          gap="$2"
        >
          <View
            width={32}
            height={32}
            borderRadius={8}
            backgroundColor={c.tile}
            alignItems="center"
            justifyContent="center"
            flexShrink={0}
          >
            <Ph name={kindIcon(kind, filename) as any} size={16} color={c.accent} />
          </View>

          {/* Name truncates FIRST (flex 1, min-width 0); actions never shrink */}
          <YStack flex={1} gap="$0.5" minWidth={0}>
            <T step="sm" ellipsis selectable>
              {filename}
            </T>
            {/* Meta line: size · subtype; path line hides on narrow mobile
                BEFORE touching the actions (ux v1.2 — no kebab, no overflow) */}
            <T step="codenote" tone="text3" ellipsis>
              {[formatFileSize(size), kindLabel(kind, filename)].filter(Boolean).join(" · ")}
            </T>
            {filePath && !isNarrow && (
              <T step="codenote" tone="text3" ellipsis style={{ textTransform: "none" }}>
                {filePath}
              </T>
            )}
          </YStack>

          {/* v1.3.0 — the 2 essential actions, top-right INSIDE the strip.
              Fullscreen/Share live in the viewer window, not in the chat. */}
          <UniversalFileActions
            url={url}
            filePath={filePath}
            channelId={channelId}
            workspaceId={workspaceId}
            kind={kind}
            variant="bubble"
            onOpenViewer={handleOpenViewer}
            testID="file-bubble-actions"
          />
        </XStack>
        )}

        {/* ── Body: the only variable part (render table) ── */}
        {textError ? (
          <XStack padding="$3" backgroundColor={c.nest} alignItems="center" gap="$2">
            <Ph name="warning-circle" size={16} color={c.tint.r.tx} />
            <T step="sm" tone="text3">
              {`⚠ ${textError}`}
            </T>
          </XStack>
        ) : (
          <FileTypeBody
            kind={kind}
            filename={filename}
            url={url}
            textContent={needsText ? textContent : null}
            size={size}
            onFullscreen={() => setIsFullscreen(true)}
            testID="file-bubble-body"
          />
        )}
      </YStack>

      {caption && (
        <SelectableText color={c.text2} fontSize="$3" selectable paddingLeft="$1">
          {caption}
        </SelectableText>
      )}

      {(showTimestamp || isQueued) && (
        <XStack alignItems="center" gap="$2">
          {isQueued && <QueuedIndicator />}
          {showTimestamp && (
            <T step="codenote" tone="text3" selectable>
              {timestamp.toLocaleTimeString(getDateLocale(), {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </T>
          )}
        </XStack>
      )}

      {/* Immersive fullscreen overlay (OQ3) — web only */}
      {Platform.OS === "web" && (
        <div ref={fullscreenTriggerRef as any} style={{ display: "contents" }}>
          <FileFullscreenOverlay
            open={isFullscreen}
            onClose={() => setIsFullscreen(false)}
            kind={kind}
            filename={filename}
            url={url}
            textContent={needsText ? textContent : null}
            size={size}
            filePath={filePath}
            channelId={channelId}
            workspaceId={workspaceId}
            onOpenViewer={handleOpenViewer}
            triggerRef={fullscreenTriggerRef as any}
            testID="file-bubble-overlay"
          />
        </div>
      )}
    </YStack>
  )
}
