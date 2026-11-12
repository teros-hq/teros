/**
 * resizeGuard — iframe shield for drag-resize interactions (web only).
 *
 * While a split divider or window resize handle is being dragged, the pointer
 * can pass over an embedded iframe (Terminal, Code Editor, HTML file previews).
 * Pointer capture already routes the events to the handle, but if capture is
 * lost — browser quirk, focus steal, a handle that unmounts mid-drag — the
 * iframe swallows them and the drag freezes. As belt-and-suspenders, the
 * dragging code also toggles a `teros-resizing` class on <body> which this
 * module's stylesheet maps to `iframe { pointer-events: none }`, so iframes
 * become transparent to the pointer for the duration of the drag.
 *
 * Reference-counted: SplitHandle and useWindowResize can drag concurrently
 * (multi-touch) — the class leaves when the last drag ends. Idempotent and
 * SSR-safe (no document → no-op).
 */

const RESIZING_CLASS = "teros-resizing"

let installed = false
let activeDrags = 0

function installSheet(): void {
  if (installed || typeof document === "undefined") return
  const style = document.createElement("style")
  style.dataset.terosResizeGuard = "1"
  style.textContent = `body.${RESIZING_CLASS} iframe { pointer-events: none; }`
  document.head.appendChild(style)
  installed = true
}

/** Mark a drag as active (adds the body class). Safe to call repeatedly. */
export function beginResizeDrag(): void {
  if (typeof document === "undefined") return
  installSheet()
  activeDrags++
  document.body.classList.add(RESIZING_CLASS)
}

/** Mark a drag as over (removes the body class when the last one ends). */
export function endResizeDrag(): void {
  if (typeof document === "undefined") return
  activeDrags = Math.max(0, activeDrags - 1)
  if (activeDrags === 0) {
    document.body.classList.remove(RESIZING_CLASS)
  }
}

/** Test hook — reset the refcount and body state between cases. */
export function __resetResizeGuardForTest(): void {
  activeDrags = 0
  if (typeof document !== "undefined") {
    document.body.classList.remove(RESIZING_CLASS)
  }
}
