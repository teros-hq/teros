import type React from "react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useTabState } from "../../../hooks/useTabState"
import { BUBBLE_SIZE } from "../../../store/floatGeometry"
import { type TilingWindow, useTilingStore } from "../../../store/tilingStore"
import { useColors } from "../../mca/primitives/useColors"
import { Ph, T } from "../../ui/ds"
import { TabStatusSlot, useStatusColors } from "../TabStatusSlot"
import { ChromeIcon } from "../WindowChrome"
import { FLOAT_IN, FLOAT_PULSE } from "./floatMotion"
import { trackPointer } from "./trackPointer"

interface Props {
  window: TilingWindow
  x: number
  y: number
  labelSide: "left" | "right"
}

export function FloatBubble({ window: win, x, y, labelSide }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const status = useStatusColors()
  const state = useTabState(win, false)
  const [hover, setHover] = useState(false)
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const id = win.id
  const phIcon = state.meta?.phIcon ?? (state.definition?.phIcon as string | undefined)
  const Icon = state.Icon
  const open = () => useTilingStore.getState().focusWindow(id)
  const dock = () => useTilingStore.getState().dockWindow(id)

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest?.("[data-float-bubble-dock]")) return
    trackPointer(
      e,
      ({ dx, dy }) => setDrag({ dx, dy }),
      ({ moved }, cancelled) => {
        setDrag(null)
        if (!cancelled && !moved) open()
      },
    )
  }

  const label = state.wantsYou
    ? `${state.title} · ${t("windows.float.needsYou", { defaultValue: "needs you" })}`
    : state.title

  return (
    <div
      role="button"
      tabIndex={0}
      data-float-bubble={id}
      data-wants-you={String(state.wantsYou)}
      aria-label={state.title}
      onPointerDown={onDown}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") open()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        left: x + (drag?.dx ?? 0),
        top: y + (drag?.dy ?? 0),
        width: BUBBLE_SIZE,
        height: BUBBLE_SIZE,
        borderRadius: 17,
        display: "grid",
        placeItems: "center",
        background: c.bgStep,
        border: `1px solid ${c.borderStrong}`,
        boxShadow: state.wantsYou
          ? `0 0 0 2px ${status.needsYou}, ${c.elevHover}`
          : state.chrome?.ring
            ? `0 0 0 1px ${c.accent}, ${c.elevHover}`
            : c.elevHover,
        cursor: drag ? "grabbing" : "pointer",
        pointerEvents: "auto",
        touchAction: "none",
        zIndex: drag ? 1000 : 500,
        animation: state.wantsYou ? FLOAT_PULSE : FLOAT_IN,
      }}
    >
      {state.chrome?.icon ? (
        <ChromeIcon icon={state.chrome.icon} size={22} glyph={c.text2} />
      ) : phIcon ? (
        <Ph name={phIcon} size={22} color={c.text2} />
      ) : Icon ? (
        <Icon size={22} color={c.text2} />
      ) : null}
      {state.showIcon ? null : (
        <span
          style={{
            position: "absolute",
            top: -5,
            right: -5,
            width: 20,
            height: 20,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            background: c.bgSheet,
            border: `1px solid ${c.borderStrong}`,
          }}
        >
          <TabStatusSlot state={state} glyph={c.text2} box={14} iconSize={12} />
        </span>
      )}
      {hover && !drag ? (
        <span
          style={{
            position: "absolute",
            top: "50%",
            transform: "translateY(-50%)",
            [labelSide === "right" ? "left" : "right"]: "100%",
            [labelSide === "right" ? "paddingLeft" : "paddingRight"]: 8,
            display: "flex",
            width: "max-content",
            cursor: "default",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              whiteSpace: "nowrap",
              padding: "4px 4px 4px 10px",
              borderRadius: 10,
              background: c.bgStep,
              border: `1px solid ${c.borderStrong}`,
              boxShadow: c.elevHover,
            }}
          >
            <T step="12" numberOfLines={1} style={{ color: c.text, flexShrink: 0 }}>
              {label}
            </T>
            <span
              role="button"
              tabIndex={0}
              data-float-bubble-dock={id}
              data-testid={`float-bubble-dock-${id}`}
              title={t("windows.float.dock", { defaultValue: "Back to a tab" })}
              onClick={(e) => {
                e.stopPropagation()
                dock()
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") dock()
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 24,
                padding: "0 8px",
                borderRadius: 7,
                background: c.wash2,
                cursor: "pointer",
              }}
            >
              <Ph name="arrow-square-in" size={12} color={c.text2} />
              <T step="12" numberOfLines={1} style={{ color: c.text2, flexShrink: 0 }}>
                {t("windows.float.toTab", { defaultValue: "To a tab" })}
              </T>
            </span>
          </span>
        </span>
      ) : null}
    </div>
  )
}
