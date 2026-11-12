import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FrameMelt } from "./FrameMelt.web"

const H = 100
let painted: ImageData | null = null

function rect(r: Partial<DOMRect>): DOMRect {
  const full = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...r }
  return { ...full, toJSON: () => full } as DOMRect
}

function alphaAt(x: number, y: number): number {
  if (!painted) throw new Error("nothing painted")
  return painted.data[(y * painted.width + x) * 4 + 3]
}

describe("FrameMelt (pane) with reduced motion", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    painted = null
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: query.includes("reduce"), media: query }) as MediaQueryList,
    )
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(H)
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          createImageData: (w: number, h: number) =>
            ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData,
          putImageData: (img: ImageData) => {
            painted = { ...img, data: new Uint8ClampedArray(img.data) } as ImageData
          },
        }) as unknown as CanvasRenderingContext2D,
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("stops painting over a terminal iframe that opens after the first paint", async () => {
    const view = render(
      <div data-fx="shell">
        <div id="pane">
          <FrameMelt side="pane" frame="rgb(250, 250, 250)" sheet="rgb(14, 12, 18)" />
        </div>
      </div>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(alphaAt(2, 60)).toBeGreaterThan(0)

    const iframe = document.createElement("iframe")
    vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue(
      rect({ right: 600, bottom: H, width: 600, height: H }),
    )
    view.container.querySelector("#pane")?.appendChild(iframe)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(alphaAt(2, 60)).toBe(0)
  })
})
