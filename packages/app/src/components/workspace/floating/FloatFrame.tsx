import type React from "react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useTabState } from "../../../hooks/useTabState"
import { type ResizeDirection, useWindowResize } from "../../../hooks/useWindowResize"
import {
  FLOAT_HEADER_H,
  FLOAT_MIN,
  type FloatEntry,
  type FloatRect,
  SHEET_HEIGHT,
} from "../../../store/floatGeometry"
import { type TilingWindow, useTilingStore } from "../../../store/tilingStore"
import { useColors } from "../../mca/primitives/useColors"
import { IconBtn, T } from "../../ui/ds"
import { TabContext } from "../TabContext"
import { TabStatusSlot, useStatusColors } from "../TabStatusSlot"
import { WindowContent } from "../WindowContent"
import { requestCloseWindow } from "../windowClose"
import { TabMarks, TabTitleInput, WindowMenuButton, WindowRing } from "../WindowChrome"
import { FLOAT_IN } from "./floatMotion"
import { trackPointer } from "./trackPointer"

export type FloatMode = "frame" | "sheet" | "hidden"

interface Props {
  window: TilingWindow
  entry: FloatEntry
  mode: FloatMode
  front: boolean
}

const MIN_SIZE = { width: FLOAT_MIN.w, height: FLOAT_MIN.h }
const EDGE = 6
const CORNER = 14
const DIRECTIONS: ResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"]

function handleStyle(direction: ResizeDirection): React.CSSProperties {
  const style: React.CSSProperties = { position: "absolute", zIndex: 5 }
  const corner = direction.length === 2
  if (direction.includes("n")) style.top = 0
  if (direction.includes("s")) style.bottom = 0
  if (direction.includes("w")) style.left = 0
  if (direction.includes("e")) style.right = 0
  if (corner) return { ...style, width: CORNER, height: CORNER }
  if (direction === "n" || direction === "s")
    return { ...style, left: CORNER, right: CORNER, height: EDGE }
  return { ...style, top: CORNER, bottom: CORNER, width: EDGE }
}

function placeOf(mode: FloatMode, rect: FloatRect, z: number): React.CSSProperties {
  if (mode === "sheet")
    return {
      left: 8,
      right: 8,
      bottom: 0,
      height: `${SHEET_HEIGHT * 100}%`,
      zIndex: 601,
      borderRadius: "16px 16px 0 0",
    }
  return {
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    zIndex: z,
    borderRadius: 14,
    display: mode === "hidden" ? "none" : "flex",
  }
}

const FloatBody = memo(function FloatBody({
  id,
  type,
  props,
}: {
  id: string
  type: string
  props: Record<string, any>
}) {
  const window = useMemo(() => ({ id, type, props, mode: "floating" }), [id, type, props])
  return <WindowContent window={window} />
})

function FloatContent({
  id,
  type,
  props,
  front,
  visible,
}: {
  id: string
  type: string
  props: Record<string, any>
  front: boolean
  visible: boolean
}) {
  const c = useColors()
  const tab = useMemo(
    () => ({ tabBgColor: c.bgSheet, isContainerActive: front, isTabActive: visible }),
    [c.bgSheet, front, visible],
  )
  return (
    <TabContext.Provider value={tab}>
      <FloatBody id={id} type={type} props={props} />
    </TabContext.Provider>
  )
}

function useRaiseFromEmbeddedPage(
  ref: React.RefObject<HTMLDivElement | null>,
  id: string,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      const active = document.activeElement
      if (active instanceof HTMLIFrameElement && ref.current?.contains(active))
        useTilingStore.getState().focusWindow(id)
    }
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(check, 0)
    }
    window.addEventListener("blur", later)
    return () => {
      clearTimeout(timer)
      window.removeEventListener("blur", later)
    }
  }, [ref, id, enabled])
}

export function FloatFrame({ window: win, entry, mode, front }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const status = useStatusColors()
  const tabState = useTabState(win, mode !== "hidden")
  const [live, setLive] = useState<FloatRect | null>(null)
  const liveRef = useRef<FloatRect | null>(null)
  const resizing = useRef(false)
  const root = useRef<HTMLDivElement | null>(null)
  const id = win.id
  useRaiseFromEmbeddedPage(root, id, mode === "frame" && !front)
  const rect = live ?? entry

  const show = useCallback((next: FloatRect | null) => {
    liveRef.current = next
    setLive(next)
  }, [])

  const onResize = useCallback(
    (width: number, height: number, dx?: number, dy?: number) => {
      resizing.current = true
      show({ x: entry.x + (dx ?? 0), y: entry.y + (dy ?? 0), w: width, h: height })
    },
    [entry.x, entry.y, show],
  )
  const { getResizeHandleProps, isResizing } = useWindowResize({
    onResize,
    minSize: MIN_SIZE,
    currentSize: { width: entry.w, height: entry.h },
    enabled: mode === "frame",
  })
  useEffect(() => {
    if (isResizing || !resizing.current) return
    resizing.current = false
    if (liveRef.current) useTilingStore.getState().setFloatRect(id, liveRef.current)
    show(null)
  }, [isResizing, id, show])

  const onHeaderDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== "frame" || e.button !== 0) return
    if ((e.target as HTMLElement).closest?.("[role=button],button,input")) return
    const from = { x: entry.x, y: entry.y, w: entry.w, h: entry.h }
    trackPointer(
      e,
      ({ dx, dy }) => show({ ...from, x: from.x + dx, y: from.y + dy }),
      ({ dx, dy, moved }, cancelled) => {
        show(null)
        if (!moved || cancelled) return
        useTilingStore.getState().setFloatRect(id, { ...from, x: from.x + dx, y: from.y + dy })
      },
    )
  }

  const tiling = useTilingStore.getState
  const ring = tabState.wantsYou ? `0 0 0 2px ${status.needsYou}, ` : ""

  return (
    <div
      ref={root}
      data-float-window={id}
      data-float-mode={mode}
      data-wants-you={String(tabState.wantsYou)}
      role="dialog"
      aria-label={tabState.title}
      onPointerDownCapture={() => {
        if (!front) tiling().focusWindow(id)
      }}
      style={{
        position: "absolute",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "auto",
        boxSizing: "border-box",
        background: c.bgSheet,
        border: `1px solid ${c.borderStrong}`,
        boxShadow: `${ring}${front ? c.elevRaised : c.shadow}`,
        animation: mode === "hidden" ? undefined : FLOAT_IN,
        ...placeOf(mode, rect, entry.z),
      }}
    >
      <div
        data-float-header={id}
        onPointerDown={onHeaderDown}
        style={{
          height: FLOAT_HEADER_H,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingLeft: 12,
          paddingRight: 4,
          background: c.bgStep,
          borderBottom: `1px solid ${c.border}`,
          cursor: mode === "frame" ? (live ? "grabbing" : "grab") : "default",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <TabStatusSlot state={tabState} glyph={front ? c.accent : c.text3} />
        {tabState.chrome?.titleEdit ? (
          <TabTitleInput edit={tabState.chrome.titleEdit} />
        ) : (
          <T step="sm" ellipsis style={{ flex: 1, minWidth: 0, color: front ? c.text : c.text2 }}>
            {tabState.title}
          </T>
        )}
        <TabMarks marks={tabState.chrome?.marks} color={c.text3} />
        <WindowMenuButton window={win} />
        <IconBtn
          plain
          sm
          icon={mode === "sheet" ? "caret-down" : "minus"}
          testID={`float-minimize-${id}`}
          title={t("windows.float.minimize", { defaultValue: "Minimise to a bubble" })}
          accessibilityLabel={t("windows.float.minimize", { defaultValue: "Minimise to a bubble" })}
          onPress={() => tiling().minimizeFloat(id, true)}
        />
        <IconBtn
          plain
          sm
          icon="arrow-square-in"
          testID={`float-dock-${id}`}
          title={t("windows.float.dock", { defaultValue: "Back to a tab" })}
          accessibilityLabel={t("windows.float.dock", { defaultValue: "Back to a tab" })}
          onPress={() => tiling().dockWindow(id)}
        />
        <IconBtn
          plain
          sm
          icon="x"
          testID={`float-close-${id}`}
          title={t("windows.float.close", { defaultValue: "Close this window" })}
          accessibilityLabel={t("windows.float.close", { defaultValue: "Close this window" })}
          onPress={() => requestCloseWindow(id)}
        />
      </div>
      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: c.bgSheet,
        }}
      >
        <FloatContent
          id={id}
          type={win.type}
          props={win.props}
          front={front}
          visible={mode !== "hidden"}
        />
        {tabState.chrome?.ring ? (
          <WindowRing radius={mode === "sheet" ? undefined : "0 0 13px 13px"} />
        ) : null}
        {live ? <div style={{ position: "absolute", inset: 0 }} /> : null}
      </div>
      {mode === "frame"
        ? DIRECTIONS.map((direction) => {
            const handle = getResizeHandleProps(direction)
            return (
              <div
                key={direction}
                data-float-resize={`${id}-${direction}`}
                onPointerDown={handle.onPointerDown}
                style={{ ...handleStyle(direction), ...handle.style }}
              />
            )
          })
        : null}
    </div>
  )
}
