import { act } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetResizeGuardForTest } from "../../lib/resizeGuard"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { SplitHandle } from "./SplitHandle"

/**
 * Drag lifecycle over the new unified Pointer Events implementation.
 *
 * jsdom has PointerEvent but no setPointerCapture — the component guards the
 * capture call (try/catch), so the full lifecycle runs through the
 * document-level fallback listeners, which is exactly the belt-and-suspenders
 * path real browsers take when capture is lost.
 */

const pointer = (type: string, x: number, y: number, pointerId = 1, extra: PointerEventInit = {}) =>
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

describe("SplitHandle pointer drag", () => {
  beforeEach(() => {
    __resetResizeGuardForTest()
  })

  afterEach(() => {
    __resetResizeGuardForTest()
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    vi.restoreAllMocks()
  })

  it("drags via pointer events and reports incremental deltas", () => {
    const onDrag = vi.fn()
    const { container } = renderWithTamagui(<SplitHandle direction="horizontal" onDrag={onDrag} />)

    const handle = container.querySelector('[style*="touch-action: none"]') as HTMLElement
    expect(handle).toBeTruthy()

    // pointerdown starts the drag
    act(() => {
      handle.dispatchEvent(pointer("pointerdown", 100, 50))
    })
    expect(onDrag).not.toHaveBeenCalled()

    // pointermove on DOCUMENT (not the handle) — the fallback path that real
    // browsers exercise when capture is lost, and the only path in jsdom.
    act(() => {
      document.dispatchEvent(pointer("pointermove", 140, 50))
    })
    expect(onDrag).toHaveBeenCalledTimes(1)
    // delta = 140 - 100 = 40, totalSize = measured parent width (jsdom: 0)
    expect(onDrag).toHaveBeenCalledWith(40, 0)

    // incremental: next move reports only the delta since the last one
    act(() => {
      document.dispatchEvent(pointer("pointermove", 170, 50))
    })
    expect(onDrag).toHaveBeenCalledTimes(2)
    expect(onDrag).toHaveBeenLastCalledWith(30, 0)

    // pointerup on document ends the drag
    act(() => {
      document.dispatchEvent(pointer("pointerup", 170, 50))
    })
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
    expect(document.body.classList.contains("teros-resizing")).toBe(false)

    // moves after release are ignored
    act(() => {
      document.dispatchEvent(pointer("pointermove", 200, 50))
    })
    expect(onDrag).toHaveBeenCalledTimes(2)
  })

  it("ignores moves from a different pointer (multi-touch guard)", () => {
    const onDrag = vi.fn()
    const { container } = renderWithTamagui(<SplitHandle direction="horizontal" onDrag={onDrag} />)

    const handle = container.querySelector('[style*="touch-action: none"]') as HTMLElement
    act(() => {
      handle.dispatchEvent(pointer("pointerdown", 100, 50, 1))
    })

    // a second finger (different pointerId) must not move this drag
    act(() => {
      document.dispatchEvent(pointer("pointermove", 999, 50, 2))
    })
    expect(onDrag).not.toHaveBeenCalled()

    act(() => {
      document.dispatchEvent(pointer("pointermove", 120, 50, 1))
    })
    expect(onDrag).toHaveBeenCalledWith(20, 0)

    // and its pointerup must not end our drag
    act(() => {
      document.dispatchEvent(pointer("pointerup", 999, 50, 2))
    })
    expect(document.body.classList.contains("teros-resizing")).toBe(true)

    act(() => {
      document.dispatchEvent(pointer("pointerup", 120, 50, 1))
    })
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
  })

  it("ends cleanly on pointercancel (no stuck cursor / userSelect / body class)", () => {
    const onDrag = vi.fn()
    const { container } = renderWithTamagui(<SplitHandle direction="horizontal" onDrag={onDrag} />)

    const handle = container.querySelector('[style*="touch-action: none"]') as HTMLElement
    act(() => {
      handle.dispatchEvent(pointer("pointerdown", 100, 50))
    })
    expect(document.body.classList.contains("teros-resizing")).toBe(true)
    expect(document.body.style.cursor).toBe("col-resize")
    expect(document.body.style.userSelect).toBe("none")

    act(() => {
      document.dispatchEvent(pointer("pointercancel", 130, 50))
    })
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
  })

  it("uses row-resize cursor for vertical splits", () => {
    const onDrag = vi.fn()
    const { container } = renderWithTamagui(<SplitHandle direction="vertical" onDrag={onDrag} />)

    const handle = container.querySelector('[style*="touch-action: none"]') as HTMLElement
    act(() => {
      handle.dispatchEvent(pointer("pointerdown", 100, 50))
    })
    expect(document.body.style.cursor).toBe("row-resize")

    // vertical split tracks clientY
    act(() => {
      document.dispatchEvent(pointer("pointermove", 100, 80))
    })
    expect(onDrag).toHaveBeenCalledWith(30, 0)

    act(() => {
      document.dispatchEvent(pointer("pointerup", 100, 80))
    })
  })

  it("ignores right-click (non-primary button) pointerdown", () => {
    const onDrag = vi.fn()
    const { container } = renderWithTamagui(<SplitHandle direction="horizontal" onDrag={onDrag} />)

    const handle = container.querySelector('[style*="touch-action: none"]') as HTMLElement
    act(() => {
      handle.dispatchEvent(
        pointer("pointerdown", 100, 50, 1, { button: 2, buttons: 2 }),
      )
    })
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
    expect(document.body.style.cursor).toBe("")

    act(() => {
      document.dispatchEvent(pointer("pointermove", 140, 50))
    })
    expect(onDrag).not.toHaveBeenCalled()
  })

  it("cleans up on unmount mid-drag (no stuck body class or listeners)", () => {
    const onDrag = vi.fn()
    const { container, unmount } = renderWithTamagui(
      <SplitHandle direction="horizontal" onDrag={onDrag} />,
    )

    const handle = container.querySelector('[style*="touch-action: none"]') as HTMLElement
    act(() => {
      handle.dispatchEvent(pointer("pointerdown", 100, 50))
    })
    expect(document.body.classList.contains("teros-resizing")).toBe(true)

    act(() => {
      unmount()
    })
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")

    // the document fallback listeners were removed too — a stray move after
    // unmount must not call onDrag
    act(() => {
      document.dispatchEvent(pointer("pointermove", 300, 50))
    })
    expect(onDrag).not.toHaveBeenCalled()
  })

  it("releases pointer capture on drag end when the browser supports it", () => {
    const releaseSpy = vi.fn()
    const { container } = renderWithTamagui(<SplitHandle direction="horizontal" onDrag={vi.fn()} />)

    const handle = container.querySelector('[style*="touch-action: none"]') as HTMLElement

    // jsdom lacks setPointerCapture — shim both to verify the calls happen.
    const setSpy = vi.fn()
    handle.setPointerCapture = setSpy as unknown as typeof handle.setPointerCapture
    handle.releasePointerCapture = releaseSpy as unknown as typeof handle.releasePointerCapture

    act(() => {
      handle.dispatchEvent(pointer("pointerdown", 100, 50))
    })
    expect(setSpy).toHaveBeenCalledWith(1)

    act(() => {
      document.dispatchEvent(pointer("pointerup", 130, 50))
    })
    expect(releaseSpy).toHaveBeenCalledWith(1)
  })
})
