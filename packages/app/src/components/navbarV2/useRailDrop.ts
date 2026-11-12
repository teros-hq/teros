/**
 * useRailDrop — the three phases of "drag a tab to the rail" (web only).
 *
 * 1. The tab drag is the tiling's own HTML5 drag (TilingContainer sets
 *    `text/plain` = window id). The rail does nothing until the cursor enters it.
 * 2. Inside the rail both zones light up; the zone under the cursor and the
 *    insertion point come from the DOM (`data-zone`, `data-pin` on the rows).
 * 3. Drop anchors the window in that zone and position; the tab never moves.
 *    Leaving the rail cancels. A group drag (`group`) is ignored.
 *
 * The listeners live on `document` and decide by coordinates against the
 * rail's rectangle: the rows under the cursor re-render while the pointer
 * moves (legend, insertion line), so per-element dragenter/dragleave churn
 * would make the browser refuse the drop.
 *
 * A row drag (`PIN_DRAG_MIME`, NAV-REQ-19) uses the same zones and insertion
 * line and ends in a reorder or a move instead of a pin.
 *
 * @spec NAV-REQ-15, NAV-REQ-19
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Platform } from "react-native"
import type { NavbarPinScope } from "../../services/NavbarApi"
import { PIN_DRAG_MIME } from "./pinModel"

export type RailDragKind = "window" | "pin"

export interface RailDropState {
  active: boolean
  /** What is being dragged: a tiling tab or a rail row. */
  kind: RailDragKind | null
  zone: NavbarPinScope | null
  /** Insert before this pin; null = append to the zone. */
  beforeId: string | null
  x: number
  y: number
}

const IDLE: RailDropState = { active: false, kind: null, zone: null, beforeId: null, x: 0, y: 0 }

export function useRailDrop(opts: {
  onEnter?: (kind: RailDragKind) => void
  onDrop: (zone: NavbarPinScope, beforeId: string | null, windowId: string) => void
  /** A rail row dropped in a zone (NAV-REQ-19). */
  onDropPin?: (zone: NavbarPinScope, beforeId: string | null, pinId: string) => void
}) {
  const [state, setState] = useState<RailDropState>(IDLE)
  const nodeRef = useRef<HTMLElement | null>(null)
  const activeRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  /** Attach to the sidebar's DOM node (RN-web View refs are the element). */
  const setNode = useCallback((el: unknown) => {
    nodeRef.current = (el as HTMLElement | null) ?? null
  }, [])

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return

    const kindOf = (e: DragEvent): RailDragKind | null => {
      const types = e.dataTransfer?.types
      if (!types) return null
      const list = Array.from(types)
      if (list.includes(PIN_DRAG_MIME)) return "pin"
      if (list.includes("text/plain")) return "window"
      return null
    }
    const inside = (e: DragEvent) => {
      const node = nodeRef.current
      if (!node) return false
      const r = node.getBoundingClientRect()
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    }
    const locate = (e: DragEvent): Pick<RailDropState, "zone" | "beforeId"> => {
      const node = nodeRef.current
      let zone: NavbarPinScope | null = null
      let beforeId: string | null = null
      if (!node) return { zone, beforeId }
      for (const z of Array.from(node.querySelectorAll<HTMLElement>("[data-zone]"))) {
        const r = z.getBoundingClientRect()
        if (e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6) {
          zone = z.dataset.zone as NavbarPinScope
          for (const row of Array.from(z.querySelectorAll<HTMLElement>("[data-pin]"))) {
            const rr = row.getBoundingClientRect()
            if (e.clientY < rr.top + rr.height / 2) {
              beforeId = row.dataset.pin ?? null
              break
            }
          }
          break
        }
      }
      return { zone, beforeId }
    }
    const reset = () => {
      activeRef.current = false
      setState(IDLE)
    }

    const onDragOver = (e: DragEvent) => {
      const kind = kindOf(e)
      if (!kind) return
      if (!inside(e)) {
        if (activeRef.current) reset()
        return
      }
      // Accept the drop anywhere over the rail (phase 2).
      e.preventDefault()
      // The tab drag allows "move" only: an incompatible dropEffect makes the browser refuse the drop.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
      if (!activeRef.current) {
        activeRef.current = true
        optsRef.current.onEnter?.(kind)
      }
      const loc = locate(e)
      setState((s) =>
        s.active && s.kind === kind && s.zone === loc.zone && s.beforeId === loc.beforeId && Math.abs(s.x - e.clientX) < 2 && Math.abs(s.y - e.clientY) < 2
          ? s
          : { active: true, kind, ...loc, x: e.clientX, y: e.clientY },
      )
    }
    const onDrop = (e: DragEvent) => {
      const kind = kindOf(e)
      if (!kind || !inside(e)) return
      e.preventDefault()
      e.stopPropagation()
      const loc = locate(e)
      reset()
      if (!loc.zone) return
      if (kind === "pin") {
        const pinId = e.dataTransfer?.getData(PIN_DRAG_MIME) ?? ""
        if (pinId) optsRef.current.onDropPin?.(loc.zone, loc.beforeId, pinId)
        return
      }
      const id = e.dataTransfer?.getData("text/plain") ?? ""
      if (!id || id === "group") return
      optsRef.current.onDrop(loc.zone, loc.beforeId, id)
    }
    const onDragEnd = () => {
      if (activeRef.current) reset()
    }

    document.addEventListener("dragover", onDragOver, true)
    document.addEventListener("drop", onDrop, true)
    document.addEventListener("dragend", onDragEnd, true)
    return () => {
      document.removeEventListener("dragover", onDragOver, true)
      document.removeEventListener("drop", onDrop, true)
      document.removeEventListener("dragend", onDragEnd, true)
    }
  }, [])

  return { drop: state, setDropNode: setNode }
}
