import type React from "react"
import { beginResizeDrag, endResizeDrag } from "../../../lib/resizeGuard"

export interface PointerTrack {
  x: number
  y: number
  dx: number
  dy: number
}

const THRESHOLD = 3

function capture(down: PointerEvent | React.PointerEvent): boolean {
  const target = down.target instanceof Element ? down.target : null
  try {
    target?.setPointerCapture(down.pointerId)
    return true
  } catch {
    return false
  }
}

export function trackPointer(
  down: PointerEvent | React.PointerEvent,
  onMove: (p: PointerTrack) => void,
  onEnd: (p: PointerTrack & { moved: boolean }, cancelled: boolean) => void,
): void {
  const start = { x: down.clientX, y: down.clientY }
  capture(down)
  let moved = false
  const at = (e: PointerEvent): PointerTrack => ({
    x: e.clientX,
    y: e.clientY,
    dx: e.clientX - start.x,
    dy: e.clientY - start.y,
  })
  const mine = (e: PointerEvent) => e.pointerId === undefined || e.pointerId === down.pointerId
  const move = (e: PointerEvent) => {
    if (!mine(e)) return
    const p = at(e)
    if (!moved && Math.hypot(p.dx, p.dy) < THRESHOLD) return
    moved = true
    e.preventDefault()
    onMove(p)
  }
  const finish = (e: PointerEvent, cancelled: boolean) => {
    if (!mine(e)) return
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    window.removeEventListener("pointercancel", cancel)
    document.body.style.userSelect = ""
    endResizeDrag()
    onEnd({ ...at(e), moved }, cancelled)
  }
  const up = (e: PointerEvent) => finish(e, false)
  const cancel = (e: PointerEvent) => finish(e, true)
  document.body.style.userSelect = "none"
  beginResizeDrag()
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
  window.addEventListener("pointercancel", cancel)
}
