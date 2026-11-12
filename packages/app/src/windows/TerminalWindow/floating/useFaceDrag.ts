/**
 * Drag a face out of the crew rail → floating terminal; drop a floating
 * terminal back on a rail → docked. Web only (pointer events on the DOM node
 * React Native Web renders); on native both hooks are inert and the rail's
 * "pop out" action can call terminalFloat.popOut(id) directly.
 *
 * Wiring (tg-crew-rail):
 *   const drag = useFaceDrag(session.id, { onClick: () => pick(session.id) })
 *   <View ref={drag.ref} style={drag.dragging && { opacity: 0.4 }} … />
 *   const drop = useRailDropZone()
 *   <View ref={drop.ref} style={drop.over && styles.railDropHint} … />
 *
 * Use either opts.onClick or the face's own onPress, not both. After a real
 * drag the click that follows is swallowed, so onPress never fires for it.
 * A press that moves less than DRAG_THRESHOLD px is a click (onClick runs);
 * past it the layer draws a ghost under the pointer, and releasing outside
 * every rail drop zone pops the terminal out centred on the pointer.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Platform } from "react-native"
import { hit } from "./floatGeometry"
import { useTerminalFloatStore } from "./terminalFloatStore"

export const DRAG_THRESHOLD = 6

// ── Rail drop zones ─────────────────────────────────────────────────────────

type ZoneListener = (over: boolean) => void
const zones = new Map<HTMLElement, ZoneListener>()

/** Which drop zone (if any) is under a viewport point. */
export function railZoneAt(p: { x: number; y: number }): HTMLElement | null {
  for (const el of zones.keys()) {
    if (el.isConnected && hit(p, el.getBoundingClientRect(), 8)) return el
  }
  return null
}

/** Light up the zone under the pointer (and only that one). */
export function highlightRailZone(p: { x: number; y: number } | null): boolean {
  const at = p ? railZoneAt(p) : null
  for (const [el, listener] of zones) listener(el === at)
  return !!at
}

/** Mark an element (the crew rail) as a place a floating terminal can be dropped back on. */
export function useRailDropZone(): { ref: (node: unknown) => void; over: boolean } {
  const [over, setOver] = useState(false)
  const current = useRef<HTMLElement | null>(null)
  const ref = useCallback((node: unknown) => {
    if (Platform.OS !== "web") return
    if (current.current) zones.delete(current.current)
    current.current = node instanceof HTMLElement ? node : null
    if (current.current) zones.set(current.current, setOver)
  }, [])
  useEffect(
    () => () => {
      if (current.current) zones.delete(current.current)
    },
    [],
  )
  return { ref, over }
}

// ── Face drag ───────────────────────────────────────────────────────────────

export interface FaceDragOptions {
  /** A press that didn't become a drag. */
  onClick?: () => void
  disabled?: boolean
}

export interface FaceDrag {
  /** Put on the face's View (React Native Web renders it as the DOM node). */
  ref: (node: unknown) => void
  /** True while this face is being dragged out (dim the face). */
  dragging: boolean
}

export function useFaceDrag(terminalId: string, opts: FaceDragOptions = {}): FaceDrag {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const dragging = useTerminalFloatStore((s) => s.drag?.terminalId === terminalId)
  const nodeRef = useRef<HTMLElement | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  const ref = useCallback(
    (node: unknown) => {
      cleanupRef.current?.()
      cleanupRef.current = null
      nodeRef.current = Platform.OS === "web" && node instanceof HTMLElement ? node : null
      const el = nodeRef.current
      if (!el) return
      const onDown = (e: PointerEvent) => {
        if (optsRef.current.disabled || e.button !== 0) return
        startFaceDrag(terminalId, e, () => optsRef.current.onClick?.())
      }
      // A click that followed a drag must not also select the face
      const onClickCapture = (e: MouseEvent) => {
        if (suppressClickUntil > Date.now()) {
          e.stopPropagation()
          e.preventDefault()
        }
      }
      el.addEventListener("pointerdown", onDown)
      el.addEventListener("click", onClickCapture, true)
      el.style.touchAction = "none"
      cleanupRef.current = () => {
        el.removeEventListener("pointerdown", onDown)
        el.removeEventListener("click", onClickCapture, true)
      }
    },
    [terminalId],
  )
  useEffect(() => () => cleanupRef.current?.(), [])
  return { ref, dragging }
}

let suppressClickUntil = 0

/** Exported for the floating layer's tests and for a "drag handle" elsewhere. */
export function startFaceDrag(terminalId: string, down: PointerEvent, onClick?: () => void): void {
  const start = { x: down.clientX, y: down.clientY }
  let active = false
  // Captured, the moves keep coming while the pointer crosses a terminal
  // iframe (they still bubble to window)
  const target = down.target instanceof Element ? down.target : null
  try {
    target?.setPointerCapture(down.pointerId)
  } catch {}
  const store = useTerminalFloatStore.getState()

  const move = (e: PointerEvent) => {
    const p = { x: e.clientX, y: e.clientY }
    if (!active) {
      if (Math.hypot(p.x - start.x, p.y - start.y) < DRAG_THRESHOLD) return
      active = true
      document.body.style.userSelect = "none"
    }
    e.preventDefault()
    const overRail = highlightRailZone(p)
    store.setDrag({ terminalId, ...p, overRail })
  }
  const end = (e: PointerEvent, cancelled: boolean) => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    window.removeEventListener("pointercancel", cancel)
    window.removeEventListener("keydown", esc, true)
    document.body.style.userSelect = ""
    highlightRailZone(null)
    if (!active) {
      if (!cancelled) onClick?.()
      return
    }
    suppressClickUntil = Date.now() + 300
    useTerminalFloatStore.getState().setDrag(null)
    const p = { x: e.clientX, y: e.clientY }
    if (!cancelled && !railZoneAt(p)) useTerminalFloatStore.getState().popOut(terminalId, p)
  }
  const up = (e: PointerEvent) => end(e, false)
  const cancel = (e: PointerEvent) => end(e, true)
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    e.stopPropagation()
    end(new PointerEvent("pointercancel", { clientX: start.x, clientY: start.y }), true)
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
  window.addEventListener("pointercancel", cancel)
  window.addEventListener("keydown", esc, true)
}
