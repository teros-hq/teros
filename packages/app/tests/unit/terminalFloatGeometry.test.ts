import { describe, expect, it } from "vitest"
import {
  clampRect,
  FLOAT_DEFAULT,
  FLOAT_MIN,
  type FloatEntry,
  hit,
  overflowIds,
  placeNew,
  topZ,
} from "../../src/windows/TerminalWindow/floating/floatGeometry"

const vp = { w: 1340, h: 820 }
const e = (z: number, minimized = false): FloatEntry => ({
  x: 0,
  y: 0,
  w: 520,
  h: 340,
  z,
  minimized,
})

describe("floating geometry", () => {
  it("keeps the header reachable and the size within bounds", () => {
    expect(clampRect({ x: -2000, y: -50, w: 100, h: 50 }, vp)).toEqual({
      x: 64 - FLOAT_MIN.w,
      y: 0,
      w: FLOAT_MIN.w,
      h: FLOAT_MIN.h,
    })
    const r = clampRect({ x: 5000, y: 5000, w: 4000, h: 4000 }, vp)
    expect(r.x).toBe(vp.w - 64)
    expect(r.y).toBe(vp.h - 44)
    expect(r.w).toBe(vp.w - 16)
  })

  it("centres a drop on the pointer and cascades the others", () => {
    const at = placeNew(vp, [], { x: 700, y: 300 })
    expect(at.x).toBe(700 - FLOAT_DEFAULT.w / 2)
    expect(at.y).toBe(300 - 22)
    const a = placeNew(vp, [])
    const b = placeNew(vp, [a])
    expect(b.x).toBe(a.x - 28)
    expect(b.y).toBe(a.y + 28)
  })

  it("docks the window at the back when one more would pass the max", () => {
    expect(overflowIds({ a: e(3), b: e(1), c: e(2) })).toEqual(["b"])
    expect(overflowIds({ a: e(1), b: e(2) })).toEqual([])
    expect(topZ({ a: e(3), b: e(7) })).toBe(7)
  })

  it("hit-tests with slack", () => {
    const box = { left: 10, top: 10, right: 20, bottom: 20 }
    expect(hit({ x: 5, y: 15 }, box)).toBe(false)
    expect(hit({ x: 5, y: 15 }, box, 8)).toBe(true)
  })
})
