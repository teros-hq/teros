/**
 * A minimised floating terminal: a 52 px bubble (face 34 + seat 18), amber
 * and pulsing when it needs you. Click → restore (narrow: open the sheet);
 * drag it onto a crew rail → docked.
 */

import type React from "react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useAuthStore } from "../../../store/authStore"
import { describeSeat, Face, SEAT_COLORS, Seat } from "../crew"
import { useK } from "../crew/tokens"
import { sessionLabel, type TerminalSession } from "../terminalSessions"
import { dockAndSelect, trackPointer } from "./FloatingTerminal.web"
import { FloatIcon } from "./floatIcons.web"
import { highlightRailZone, railZoneAt } from "./useFaceDrag"

export const BUBBLE = 52

interface Props {
  terminalId: string
  session: TerminalSession | undefined
  x: number
  y: number
  /** Which side the hover label opens to. */
  labelSide: "left" | "right"
  onOpen: () => void
}

export function FloatBubble({ terminalId, session, x, y, labelSide, onOpen }: Props) {
  const { t } = useTranslation()
  const K = useK()
  const me = useAuthStore((s) => s.user?.userId)
  const [hover, setHover] = useState(false)
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const need = session ? describeSeat(session, me, Date.now()).seat === "need" : false
  const name = session
    ? sessionLabel(session)
    : t("terminal.float.untitled", { defaultValue: "Terminal" })
  const label = need
    ? `${name} · ${t("terminal.float.needsYou", { defaultValue: "needs you" })}`
    : name

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    trackPointer(
      e,
      ({ x: px, y: py, dx, dy }) => {
        highlightRailZone({ x: px, y: py })
        setDrag({ dx, dy })
      },
      ({ x: px, y: py, moved }, cancelled) => {
        highlightRailZone(null)
        setDrag(null)
        if (cancelled) return
        if (!moved) onOpen()
        else if (railZoneAt({ x: px, y: py })) dockAndSelect(terminalId)
      },
    )
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: it holds a real <button> (back to the Terminal) on hover
    <div
      role="button"
      tabIndex={0}
      data-float-bubble={terminalId}
      aria-label={label}
      onPointerDown={onDown}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        left: x + (drag?.dx ?? 0),
        top: y + (drag?.dy ?? 0),
        width: BUBBLE,
        height: BUBBLE,
        borderRadius: 17,
        border: 0,
        padding: 0,
        background: K.bubbleBg,
        display: "grid",
        placeItems: "center",
        cursor: drag ? "grabbing" : "pointer",
        pointerEvents: "auto",
        touchAction: "none",
        zIndex: drag ? 1000 : 500,
        boxShadow: need
          ? `0 0 0 2px ${SEAT_COLORS.need.ring},${K.bubbleDrop}`
          : `0 0 0 1px ${K.bubbleRing} inset,${K.bubbleDrop}`,
        animation: need ? "crew-pulse-amber 1.6s infinite" : "crew-pop-in 160ms ease-out",
      }}
    >
      <span style={{ position: "relative", lineHeight: 0 }}>
        <Face session={session} terminalId={terminalId} size={34} />
        {session ? <Seat session={session} size={18} gap={K.bubbleBg} corner offset={6} /> : null}
      </span>
      {hover && !drag ? (
        // The hover label, with the way back: "Back to the Terminal window"
        <span
          style={{
            position: "absolute",
            top: "50%",
            transform: "translateY(-50%)",
            [labelSide === "right" ? "left" : "right"]: "100%",
            [labelSide === "right" ? "paddingLeft" : "paddingRight"]: 8,
            display: "flex",
            cursor: "default",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              whiteSpace: "nowrap",
              padding: "4px 4px 4px 9px",
              borderRadius: 8,
              background: K.ghostBg,
              color: K.ghostText,
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 11.5,
              fontWeight: 500,
              boxShadow: K.bubbleLabelShadow,
            }}
          >
            {label}
            <button
              type="button"
              data-testid="float-bubble-dock"
              title={t("terminal.float.dock", {
                defaultValue: "Back to the Terminal window (it keeps running)",
              })}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                dockAndSelect(terminalId)
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 22,
                padding: "0 7px",
                border: 0,
                borderRadius: 6,
                background: K.menuHover,
                color: K.text,
                fontFamily: "inherit",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              <FloatIcon name="dock" size={12} />
              {t("terminal.float.toWindow", { defaultValue: "To the Terminal" })}
            </button>
          </span>
        </span>
      ) : null}
    </div>
  )
}
