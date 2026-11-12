import { act, renderHook } from "@testing-library/react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetResizeGuardForTest } from "../lib/resizeGuard"
import { useWindowResize, type ResizeDirection } from "./useWindowResize"

/**
 * Resize lifecycle over the unified Pointer Events implementation.
 *
 * jsdom has PointerEvent but no setPointerCapture — the hook guards the
 * capture call (try/catch), so the lifecycle runs through the document-level
 * listeners, which is exactly the fallback path real browsers take when
 * capture is lost.
 */

const pointer = (
  type: string,
  x: number,
  y: number,
  pointerId = 1,
  extra: PointerEventInit = {},
) =>
  new PointerEvent(type, {
    pointerId,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
    button: type === "pointerdown" ? 0 : -1,
    ...extra,
  })

function renderResizeHook(overrides: Partial<Parameters<typeof useWindowResize>[0]> = {}) {
  const onResize = vi.fn()
  const { result } = renderHook(() =>
    useWindowResize({
      onResize,
      minSize: { width: 100, height: 80 },
      currentSize: { width: 400, height: 300 },
      ...overrides,
    }),
  )
  return { result, onResize }
}

/** Simulate a React onPointerDown on a handle via the hook's returned props. */
function pointerDown(result: { current: ReturnType<typeof useWindowResize> }, direction: ResizeDirection, x: number, y: number) {
  const props = result.current.getResizeHandleProps(direction)
  const target = document.createElement("div")
  document.body.appendChild(target)
  const evt = pointer("pointerdown", x, y, 1)
  Object.defineProperty(evt, "currentTarget", { value: target })
  act(() => {
    props.onPointerDown(evt as unknown as ReactPointerEvent)
  })
  target.remove()
}

describe("useWindowResize pointer drag", () => {
  beforeEach(() => {
    __resetResizeGuardForTest()
  })

  afterEach(() => {
    __resetResizeGuardForTest()
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    vi.restoreAllMocks()
  })

  it("resizes via pointer events (east handle grows width)", () => {
    const { result, onResize } = renderResizeHook()
    expect(result.current.isResizing).toBe(false)

    pointerDown(result, "e", 400, 150)
    expect(result.current.isResizing).toBe(true)
    expect(result.current.resizeDirection).toBe("e")
    expect(document.body.classList.contains("teros-resizing")).toBe(true)
    expect(document.body.style.cursor).toBe("ew-resize")

    // drag right by 50px → width 450, height unchanged, no move deltas
    act(() => {
      document.dispatchEvent(pointer("pointermove", 450, 150))
    })
    expect(onResize).toHaveBeenLastCalledWith(450, 300, 0, 0)

    // drag further right by 50px more → 500
    act(() => {
      document.dispatchEvent(pointer("pointermove", 500, 150))
    })
    expect(onResize).toHaveBeenLastCalledWith(500, 300, 0, 0)

    // release ends the drag and cleans body state
    act(() => {
      document.dispatchEvent(pointer("pointerup", 500, 150))
    })
    expect(result.current.isResizing).toBe(false)
    expect(result.current.resizeDirection).toBe(null)
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")

    // moves after release are ignored
    act(() => {
      document.dispatchEvent(pointer("pointermove", 900, 150))
    })
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  it("west handle: dragging left grows width and moves the window left", () => {
    const { result, onResize } = renderResizeHook()
    pointerDown(result, "w", 100, 150)

    // drag left by 40px → width grows to 440, window moves left by 40
    // (negative position delta — the consumer adds it to window.x)
    act(() => {
      document.dispatchEvent(pointer("pointermove", 60, 150))
    })
    expect(onResize).toHaveBeenLastCalledWith(440, 300, -40, 0)

    act(() => {
      document.dispatchEvent(pointer("pointerup", 60, 150))
    })
  })

  it("west handle: dragging right shrinks width, clamped at minSize", () => {
    const { result, onResize } = renderResizeHook()
    pointerDown(result, "w", 100, 150)

    // drag right by 250px → width shrinks to 150, window moves right by 250
    act(() => {
      document.dispatchEvent(pointer("pointermove", 350, 150))
    })
    expect(onResize).toHaveBeenLastCalledWith(150, 300, 250, 0)

    // drag right past minSize: width clamps at 100 and the position delta
    // follows the actual width change (300), not the raw pointer delta (400)
    act(() => {
      document.dispatchEvent(pointer("pointermove", 500, 150))
    })
    expect(onResize).toHaveBeenLastCalledWith(100, 300, 300, 0)

    act(() => {
      document.dispatchEvent(pointer("pointerup", 500, 150))
    })
  })

  it("ignores moves from a different pointer (multi-touch guard)", () => {
    const { result, onResize } = renderResizeHook()
    pointerDown(result, "e", 400, 150)

    act(() => {
      document.dispatchEvent(pointer("pointermove", 999, 999, 2))
    })
    expect(onResize).not.toHaveBeenCalled()

    act(() => {
      document.dispatchEvent(pointer("pointermove", 430, 150, 1))
    })
    expect(onResize).toHaveBeenLastCalledWith(430, 300, 0, 0)

    // the other finger's pointerup must not end our drag
    act(() => {
      document.dispatchEvent(pointer("pointerup", 999, 999, 2))
    })
    expect(result.current.isResizing).toBe(true)
    expect(document.body.classList.contains("teros-resizing")).toBe(true)

    act(() => {
      document.dispatchEvent(pointer("pointerup", 430, 150, 1))
    })
    expect(result.current.isResizing).toBe(false)
  })

  it("ends cleanly on pointercancel (no stuck cursor / userSelect / body class)", () => {
    const { result } = renderResizeHook()
    pointerDown(result, "se", 400, 300)
    expect(document.body.style.cursor).toBe("nwse-resize")
    expect(document.body.style.userSelect).toBe("none")

    act(() => {
      document.dispatchEvent(pointer("pointercancel", 450, 350))
    })
    expect(result.current.isResizing).toBe(false)
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
  })

  it("ignores non-primary-button pointerdown", () => {
    const { result, onResize } = renderResizeHook()
    const props = result.current.getResizeHandleProps("e")
    const target = document.createElement("div")
    document.body.appendChild(target)
    const evt = pointer("pointerdown", 400, 150, 1, { button: 2, buttons: 2 })
    Object.defineProperty(evt, "currentTarget", { value: target })
    act(() => {
      props.onPointerDown(evt as unknown as ReactPointerEvent)
    })
    target.remove()

    expect(result.current.isResizing).toBe(false)
    expect(document.body.classList.contains("teros-resizing")).toBe(false)

    act(() => {
      document.dispatchEvent(pointer("pointermove", 500, 150))
    })
    expect(onResize).not.toHaveBeenCalled()
  })

  it("takes pointer capture on the handle when the browser supports it", () => {
    const { result } = renderResizeHook()
    const setSpy = vi.fn()
    const target = document.createElement("div")
    target.setPointerCapture = setSpy as unknown as typeof target.setPointerCapture
    document.body.appendChild(target)

    const props = result.current.getResizeHandleProps("e")
    const evt = pointer("pointerdown", 400, 150)
    Object.defineProperty(evt, "currentTarget", { value: target })
    act(() => {
      props.onPointerDown(evt as unknown as ReactPointerEvent)
    })
    target.remove()

    expect(setSpy).toHaveBeenCalledWith(1)

    act(() => {
      document.dispatchEvent(pointer("pointerup", 400, 150))
    })
  })

  it("respects maxSize bounds", () => {
    const { result, onResize } = renderResizeHook({ maxSize: { width: 500, height: 400 } })
    pointerDown(result, "e", 400, 150)

    act(() => {
      document.dispatchEvent(pointer("pointermove", 800, 150))
    })
    expect(onResize).toHaveBeenLastCalledWith(500, 300, 0, 0)

    act(() => {
      document.dispatchEvent(pointer("pointerup", 800, 150))
    })
  })

  it("does nothing when disabled", () => {
    const { result, onResize } = renderResizeHook({ enabled: false })
    pointerDown(result, "e", 400, 150)
    expect(result.current.isResizing).toBe(false)
    expect(document.body.classList.contains("teros-resizing")).toBe(false)

    act(() => {
      document.dispatchEvent(pointer("pointermove", 500, 150))
    })
    expect(onResize).not.toHaveBeenCalled()
  })
})
