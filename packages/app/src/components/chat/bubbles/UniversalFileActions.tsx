/**
 * UniversalFileActions — the FVU action row (spec FVU-REQ-2, ux.md v1.3).
 *
 * TWO context variants (Pablo's product decision v1.3.0, after trying the
 * Loop 2 implementation — the 4-button row overloaded the chat strip):
 *
 * - BUBBLE (variant="bubble", the default): the 2 essential actions only,
 *   icon-only, top-right INSIDE the strip:
 *       Descargar (download-simple) · Abrir en FileViewer (arrow-square-out)
 *   Fullscreen/Share/extra live in the viewer window, not in the chat.
 *
 * - WINDOW (variant="window"): the full set in mirror of the widget, icon-only
 *   (no text — the v1.2 labeled buttons looked off in the window chrome):
 *       Descargar · Pantalla completa · Compartir · Refrescar
 *   ("Abrir en FileViewer" is omitted — you are already there — and its slot
 *   is taken by Refresh, ux.md §3.3.)
 *
 * - OVERLAY (variant="overlay"): same full set as the window (the immersive
 *   overlay IS a fullscreen surface — its "Pantalla completa" exits back).
 *
 * Icon-only everywhere now (28px visual, hit area >= 44px on touch), each
 * button with title/accessibilityLabel. All quiet, uniform hover (Iria) —
 * violet is reserved for STATE only (.share-on = published), never hierarchy.
 */
import React from "react"
import { Platform, Pressable, View } from "react-native"
import { useTranslation } from "react-i18next"
import { useColors } from "../../mca/primitives/useColors"
import { Ph } from "../../ui/ds"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { SharePopover } from "../../ui"
import { shareFileType, type FileRenderKind } from "./fileRenderers"

export type UniversalFileActionsVariant = "bubble" | "window" | "overlay"

export interface UniversalFileActionsProps {
  /** Download target — the snapshot media URL (always present in the message). */
  url: string
  /** Volume path when the file is live (opens FileViewer + Share popover). */
  filePath?: string
  channelId?: string
  workspaceId?: string
  /** Render kind — drives the SharePopover fileType mapping. */
  kind: FileRenderKind
  /** Context variant (spec v1.3.0): "bubble" = 2 essential actions;
   *  "window"/"overlay" = the full set (Download·Fullscreen·Share·Refresh). */
  variant?: UniversalFileActionsVariant
  /** Open the FileViewer window (parent wires openWindow). */
  onOpenViewer?: () => void
  /** Enter fullscreen: the bubble opens its immersive overlay; the window
   *  toggles its own maximize/restore (the window IS the viewer). */
  onFullscreen?: () => void
  /** Open the immersive fullscreen overlay (overlay variant). */
  onOpenOverlay?: () => void
  onRefresh?: () => void
  /** TestID prefix for the buttons. */
  testID?: string
}

/** One quiet icon button of the row: 28px visual, >=44px hit on touch. */
function ActionIconBtn({
  icon,
  label,
  onPress,
  active,
  testID,
  labels,
  disabled,
}: {
  icon: string
  label: string
  onPress?: () => void
  active?: boolean
  testID: string
  labels?: boolean
  disabled?: boolean
}) {
  const c = useColors()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      // @ts-ignore web-only tooltip
      title={label}
      hitSlop={8}
      style={({ hovered }: any) => ({
        minWidth: labels ? 44 : 28,
        minHeight: 28,
        // >=44px hit target on touch platforms while keeping 28px visuals
        paddingHorizontal: labels ? 10 : 8,
        paddingVertical: Platform.OS === "web" ? 4 : 8,
        borderRadius: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        opacity: disabled ? 0.4 : 1,
        backgroundColor: hovered && !disabled ? c.wash : "transparent",
      })}
    >
      <Ph
        name={icon as any}
        size={16}
        weight={active ? "fill" : "regular"}
        color={active ? c.accent : c.text2}
      />
      {labels ? (
        <span
          style={{
            color: active ? c.accent : c.text2,
            fontSize: 12,
            fontFamily: "inherit",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      ) : null}
    </Pressable>
  )
}

/**
 * The action row. Rendered inside the strip (fixed height) at the top-right.
 * flex-shrink: 0 — the file name truncates first, the actions never do.
 */
export function UniversalFileActions(props: UniversalFileActionsProps) {
  const {
    url,
    filePath,
    channelId,
    workspaceId,
    kind,
    variant = "bubble",
    onOpenViewer,
    onFullscreen,
    onOpenOverlay,
    onRefresh,
    testID = "ufa",
  } = props

  // v1.3.0: text labels are gone everywhere — icon-only, mirrored styles.
  const labels = false

  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()

  const handleDownload = () => {
    if (Platform.OS === "web") {
      window.open(url, "_blank")
    } else {
      const { Linking } = require("react-native") as typeof import("react-native")
      Linking.openURL(url)
    }
  }

  const canShare = !!client && !!channelId && !!filePath

  const isBubble = variant === "bubble"

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        flexShrink: 0,
      }}
      testID={`${testID}-row`}
    >
      {isBubble && kind === "pdf" ? (
        /* PDF (v1.3.8, Pablo): ONE action only — Abrir en nueva pestaña
           (arrow-square-out). The browser's native PDF viewer that opens in
           the new tab already carries the real download button with the
           download-simple icon — our old "Descargar" was window.open (a new
           tab, never a real download), duplicating both the action and the
           icon. The real download lives inside the native viewer. */
        <ActionIconBtn
          icon="arrow-square-out"
          label={t("conversation.openInNewTab")}
          onPress={handleDownload}
          testID={`${testID}-newtab`}
          labels={labels}
        />
      ) : (
        <>
          {/* 1 — Descargar: always available, works on the snapshot URL */}
          <ActionIconBtn
            icon="download-simple"
            label={t("conversation.download")}
            onPress={handleDownload}
            testID={`${testID}-download`}
            labels={labels}
          />

          {isBubble ? (
            /* BUBBLE (v1.3.0): the 2nd essential action — Abrir en FileViewer.
               Fullscreen/Share/extra live in the viewer window, not in the chat. */
            <ActionIconBtn
              icon="arrow-square-out"
              label={t("conversation.openInFileViewer")}
              onPress={onOpenViewer}
              disabled={!onOpenViewer}
              testID={`${testID}-viewer`}
              labels={labels}
            />
          ) : (
            /* WINDOW / OVERLAY: the FileViewer slot is taken by Refresh —
               you are already in the viewer (ux.md §3.3). */
            <ActionIconBtn
              icon="arrows-clockwise"
              label={t("conversation.refresh")}
              onPress={onRefresh}
              testID={`${testID}-refresh`}
              labels={labels}
            />
          )}
        </>
      )}

      {/* Pantalla completa — window/overlay variants only (v1.3.0):
          the window toggles its own maximize/restore; the overlay exits. */}
      {!isBubble && (
        <ActionIconBtn
          icon="arrows-out-simple"
          label={t("conversation.fullscreen")}
          onPress={onFullscreen}
          disabled={!onFullscreen}
          testID={`${testID}-fullscreen`}
          labels={labels}
        />
      )}

      {/* Compartir — window/overlay variants only (v1.3.0): SharePopover on
          live files; snapshot URL copy otherwise. */}
      {!isBubble &&
        (canShare ? (
          <SharePopover
            filePath={filePath!}
            channelId={channelId!}
            workspaceId={workspaceId}
            fileType={shareFileType(kind)}
            client={client}
          />
        ) : (
          <ActionIconBtn
            icon="share-network"
            label={t("conversation.share")}
            onPress={() => {
              if (Platform.OS === "web") {
                navigator.clipboard?.writeText(url).catch(() => {})
              }
            }}
            testID={`${testID}-share`}
            labels={labels}
          />
        ))}
    </View>
  )
}
