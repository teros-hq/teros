/**
 * One floating terminal: the slim header (drag handle), the terminal page
 * (TerminalView, a fresh attach — the xterm page replays the screen) and a
 * resize grip. Dropping it on a crew rail docks it back.
 *
 * Focus rules: pressing anywhere in it brings it to the front; the header
 * and a new pop-out hand the keyboard to its terminal; the "keyboard here"
 * pill shows while the terminal page has the keyboard.
 */

import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useMcaTheme } from "../../../components/mca/primitives/useColors"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { useAuthStore } from "../../../store/authStore"
import { useTilingStore } from "../../../store/tilingStore"
import { useWorkspaceStore } from "../../../store/workspaceStore"
import { describeSeat, SEAT_COLORS } from "../crew"
import { useK } from "../crew/tokens"
import { TerminalView, type TerminalViewHandle } from "../TerminalView"
import { requestFocusSession, type TerminalSession } from "../terminalSessions"
import { FloatHeader } from "./FloatHeader.web"
import { FLOAT_MIN, type FloatEntry, type FloatRect } from "./floatGeometry"
import { useTerminalFloatStore } from "./terminalFloatStore"
import { highlightRailZone, railZoneAt } from "./useFaceDrag"

function readOptionIsMeta(): boolean {
  try {
    return localStorage.getItem("teros.terminal.optionIsMeta") === "1"
  } catch {
    return false
  }
}

/** Follow one pointer (captured: it keeps coming over iframes) until it lifts. */
export function trackPointer(
  down: PointerEvent | React.PointerEvent,
  onMove: (p: { x: number; y: number; dx: number; dy: number }) => void,
  onEnd: (p: { x: number; y: number; moved: boolean }, cancelled: boolean) => void,
): void {
  const start = { x: down.clientX, y: down.clientY }
  const target = down.target instanceof Element ? down.target : null
  try {
    target?.setPointerCapture(down.pointerId)
  } catch {}
  let moved = false
  const move = (e: PointerEvent) => {
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!moved && Math.hypot(dx, dy) < 3) return
    moved = true
    e.preventDefault()
    onMove({ x: e.clientX, y: e.clientY, dx, dy })
  }
  const finish = (e: PointerEvent, cancelled: boolean) => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    window.removeEventListener("pointercancel", cancel)
    document.body.style.userSelect = ""
    onEnd({ x: e.clientX, y: e.clientY, moved }, cancelled)
  }
  const up = (e: PointerEvent) => finish(e, false)
  const cancel = (e: PointerEvent) => finish(e, true)
  document.body.style.userSelect = "none"
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
  window.addEventListener("pointercancel", cancel)
}

/** Take the wheel (crew contract); typing takes it too, so the keyboard goes there either way. */
export function takeWheel(terminalId: string): void {
  getTerosClient()
    ?.send("terminal", "takeWheel", { terminalId })
    .catch(() => {})
}

/**
 * Back into the Terminal window: dock it, then have the window that shows
 * the workspace's sessions select it and come to the front — or open one on
 * it when none is open. The request waits a beat: the window's listener
 * sees the session as docked only once it re-rendered.
 */
export function dockAndSelect(terminalId: string): void {
  useTerminalFloatStore.getState().dock(terminalId)
  setTimeout(() => {
    if (requestFocusSession(terminalId)) return
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
    // A tab of its own: the window the person is in (the chat) stays
    useTilingStore.getState().openWindow("terminal", { workspaceId, active: terminalId }, true)
  }, 60)
}

/** End the session (Close terminal): it stops floating, its rail slot goes with it. */
export function closeTerminal(terminalId: string): void {
  useTerminalFloatStore.getState().dock(terminalId)
  getTerosClient()
    ?.send("terminal", "destroy", { terminalId })
    .catch(() => {})
}

interface Props {
  terminalId: string
  entry: FloatEntry
  session: TerminalSession | undefined
  /** On top of the other floating windows. */
  front: boolean
  keyboard: boolean
  onKeyboard: (terminalId: string | null) => void
}

export function FloatingTerminal({
  terminalId,
  entry,
  session,
  front,
  keyboard,
  onKeyboard,
}: Props) {
  const K = useK()
  const theme = useMcaTheme()
  const store = useTerminalFloatStore.getState()
  const viewRef = useRef<TerminalViewHandle>(null)
  /** Rect while dragging/resizing (committed on release). */
  const [live, setLive] = useState<FloatRect | null>(null)
  const [dragging, setDragging] = useState(false)
  const rect = live ?? entry
  const me = useAuthStore((s) => s.user?.userId)
  // Amber when the seat says "your turn" (same rule as the face and the header)
  const need = session ? describeSeat(session, me, Date.now()).seat === "need" : false

  const giveKeyboard = useCallback(() => {
    viewRef.current?.focus()
  }, [])

  const onHeaderDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      store.focus(terminalId)
      const from = { x: entry.x, y: entry.y, w: entry.w, h: entry.h }
      trackPointer(
        e,
        ({ x, y, dx, dy }) => {
          setDragging(true)
          highlightRailZone({ x, y })
          setLive({ ...from, x: from.x + dx, y: from.y + dy })
        },
        ({ x, y, moved }, cancelled) => {
          highlightRailZone(null)
          setDragging(false)
          setLive(null)
          if (!moved) {
            giveKeyboard()
            return
          }
          if (cancelled) return
          if (railZoneAt({ x, y })) {
            dockAndSelect(terminalId)
            return
          }
          store.setRect(terminalId, {
            ...from,
            x: from.x + x - e.clientX,
            y: from.y + y - e.clientY,
          })
        },
      )
    },
    [entry.x, entry.y, entry.w, entry.h, giveKeyboard, store, terminalId],
  )

  const onResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      store.focus(terminalId)
      const from = { x: entry.x, y: entry.y, w: entry.w, h: entry.h }
      trackPointer(
        e,
        ({ dx, dy }) =>
          setLive({
            ...from,
            w: Math.max(FLOAT_MIN.w, from.w + dx),
            h: Math.max(FLOAT_MIN.h, from.h + dy),
          }),
        ({ x, y }, cancelled) => {
          setLive(null)
          if (cancelled) return
          store.setRect(terminalId, {
            ...from,
            w: Math.max(FLOAT_MIN.w, from.w + x - e.clientX),
            h: Math.max(FLOAT_MIN.h, from.h + y - e.clientY),
          })
        },
      )
    },
    [entry.x, entry.y, entry.w, entry.h, store, terminalId],
  )

  // A window brought to the front (from a bubble, a face, the chat card) gets the keyboard.
  const wasFront = useRef(front)
  useEffect(() => {
    if (front && !wasFront.current) giveKeyboard()
    wasFront.current = front
  }, [front, giveKeyboard])

  const ring = keyboard
    ? K.floatRingKeyboard
    : need
      ? `0 0 0 2px ${SEAT_COLORS.need.ring},${K.floatDrop}`
      : K.floatRing

  return (
    <div
      data-floating-terminal={terminalId}
      role="dialog"
      aria-label={session?.title || terminalId}
      onPointerDownCapture={() => {
        if (!front) store.focus(terminalId)
      }}
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: entry.z,
        display: "flex",
        flexDirection: "column",
        background: K.floatBg,
        borderRadius: 14,
        overflow: "hidden",
        boxShadow: ring,
        opacity: dragging ? 0.95 : 1,
        pointerEvents: "auto",
        animation: "crew-pop-in 160ms ease-out",
      }}
    >
      <FloatHeader
        terminalId={terminalId}
        session={session}
        keyboard={keyboard}
        mode="floating"
        onPointerDown={onHeaderDown}
        onTakeWheel={() => {
          takeWheel(terminalId)
          giveKeyboard()
        }}
        onDock={() => dockAndSelect(terminalId)}
        onCloseTerminal={() => closeTerminal(terminalId)}
        onMinimize={() => {
          onKeyboard(null)
          store.minimize(terminalId, true)
        }}
      />
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
        <TerminalView
          ref={viewRef}
          terminalId={terminalId}
          theme={theme}
          optionIsMeta={readOptionIsMeta()}
          background={K.floatBg}
          onLive={() => {}}
          onFocus={() => {
            store.focus(terminalId)
            onKeyboard(terminalId)
          }}
          onAction={(_id, action) => {
            // The Terminal window owns restart/close: hand the session back to it.
            if (action === "close" || action === "restart") dockAndSelect(terminalId)
          }}
        />
        {live || dragging ? <div style={{ position: "absolute", inset: 0 }} /> : null}
      </div>
      <div
        onPointerDown={onResizeDown}
        title=""
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 18,
          height: 18,
          cursor: "nwse-resize",
          zIndex: 9,
          touchAction: "none",
          background: `linear-gradient(135deg,transparent 50%,${K.gripInk} 50%,${K.gripInk} 58%,transparent 58%,transparent 70%,${K.gripInk} 70%,${K.gripInk} 78%,transparent 78%)`,
        }}
      />
    </div>
  )
}
