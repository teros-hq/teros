/**
 * FileFullscreenOverlay — the FVU immersive fullscreen overlay (ux.md §3.4,
 * OQ3 decision: in-app overlay, NOT system fullscreen).
 *
 * Same pattern as HtmlBubble's fullscreen: portal to document.body, dark
 * translucent backdrop, header with title + actions + Exit, ESC closes.
 * Differences from HtmlBubble per the UX spec:
 *   - backdrop-click closes ONLY for images (avoid accidental closes while
 *     selecting text in MD/CSV/JSON/TXT bodies)
 *   - focus returns to the trigger button on close
 *   - the 4 universal actions ride along in the overlay header
 *
 * Native: not rendered (mobile uses the window manager's full-width tab —
 * ux.md §8 — so the overlay is web-only).
 */
import React, { useEffect } from "react"
import { Platform } from "react-native"
// @ts-ignore - react-dom types not available but package is present
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { useColors, useMcaTheme } from "../../mca/primitives/useColors"
import { Ph } from "../../ui/ds"
import { FileTypeBody } from "./FileTypeBody"
import { UniversalFileActions } from "./UniversalFileActions"
import type { FileRenderKind } from "./fileRenderers"

export interface FileFullscreenOverlayProps {
  open: boolean
  onClose: () => void
  kind: FileRenderKind
  filename: string
  url: string
  textContent?: string | null
  size?: number
  filePath?: string
  channelId?: string
  workspaceId?: string
  onOpenViewer?: () => void
  /** Element that opened the overlay — focus returns here on close. */
  triggerRef?: React.RefObject<HTMLElement | null>
  testID?: string
}

export function FileFullscreenOverlay({
  open,
  onClose,
  kind,
  filename,
  url,
  textContent,
  size,
  filePath,
  channelId,
  workspaceId,
  onOpenViewer,
  triggerRef,
  testID = "fvu-overlay",
}: FileFullscreenOverlayProps) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = useMcaTheme() === "dark"

  // ESC closes (web) — pattern of the current HtmlBubble overlay
  useEffect(() => {
    if (!open || Platform.OS !== "web") return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  // Focus returns to the trigger on close (ux §4)
  useEffect(() => {
    if (!open && triggerRef?.current) {
      triggerRef.current.focus?.()
    }
  }, [open, triggerRef])

  if (!open || Platform.OS !== "web") return null

  // Backdrop-click closes ONLY for images (ux §3.4)
  const backdropClickCloses = kind === "image"

  return createPortal(
    <div
      data-testid={testID}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: isDark ? "rgba(32, 28, 39, 0.96)" : "rgba(250, 249, 252, 0.98)",
        zIndex: 99999,
        display: "flex",
        flexDirection: "column",
      }}
      onClick={backdropClickCloses ? onClose : undefined}
    >
      {/* Header: title + 4 actions + Exit */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 20px",
          backgroundColor: c.bgStep,
          borderBottom: `1px solid ${isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(10, 10, 15, 0.1)"}`,
          flexShrink: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Ph name="file" size={16} color={c.text2} />
          <span
            style={{
              color: c.text2,
              fontSize: 14,
              fontWeight: 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {filename}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {/* v1.3.0 - overlay carries the full set, icon-only (mirror of
              the viewer window); "Pantalla completa" exits the overlay. */}
          <UniversalFileActions
            url={url}
            filePath={filePath}
            channelId={channelId}
            workspaceId={workspaceId}
            kind={kind}
            variant="overlay"
            onOpenViewer={onOpenViewer}
            onFullscreen={onClose}
            testID={`${testID}-actions`}
          />
          <button
            onClick={onClose}
            data-testid={`${testID}-exit`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 16px",
              backgroundColor: c.wash2,
              border: `1px solid ${isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(10, 10, 15, 0.15)"}`,
              borderRadius: 8,
              color: c.text,
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "inherit",
            }}
          >
            <Ph name="arrows-in-simple" size={16} color={c.text} />
            {t("conversation.exitFullscreen")}
          </button>
        </div>
      </div>

      {/* Content: centered, margins, internal scroll (ux §3.4) */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          display: "flex",
          justifyContent: "center",
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            maxWidth: 900,
            width: "100%",
            borderRadius: 12,
            backgroundColor: c.bgStep,
            boxShadow: isDark
              ? "0 8px 32px rgba(0, 0, 0, 0.5)"
              : "0 4px 20px rgba(10, 10, 15, 0.14)",
            overflow: "hidden",
          }}
        >
          <FileTypeBody
            kind={kind}
            filename={filename}
            url={url}
            textContent={textContent}
            size={size}
            testID={`${testID}-body`}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
