import { describe, expect, it } from "vitest"
import {
  BUBBLE_SIZE,
  bubbleSpot,
  clampRect,
  FLOAT_DEFAULT,
  FLOAT_HEADER_H,
  FLOAT_MIN,
  type Floats,
  fitFloats,
  frontId,
  MAX_FLOATS,
  MAX_OPEN_FLOATS,
  overflowToDock,
  overflowToMinimize,
  placeNew,
  sanitizeFloats,
  sheetRect,
} from "./floatGeometry"

const VP = { w: 1440, h: 900 }

function entry(z: number, minimized = false, x = 100, y = 100) {
  return { x, y, w: 520, h: 340, minimized, z }
}

describe("float geometry", () => {
  it("[FLOAT-AC-5] a new float opens at the default size, cascading from the top right", () => {
    const first = placeNew(VP, [])
    expect(first).toEqual({ x: VP.w - FLOAT_DEFAULT.w - 96, y: 96, ...FLOAT_DEFAULT })
    const second = placeNew(VP, [first])
    expect(second.x).toBe(first.x - 28)
    expect(second.y).toBe(first.y + 28)
    const third = placeNew(VP, [first, second])
    expect(third.x).toBe(first.x - 56)
  })

  it("[FLOAT-AC-5] a float dropped at a point is centred on it, inside the screen", () => {
    const r = placeNew(VP, [], { x: 700, y: 400 })
    expect(r.x).toBe(700 - FLOAT_DEFAULT.w / 2)
    expect(r.y).toBe(400 - FLOAT_HEADER_H / 2)
    expect(placeNew(VP, [], { x: Number.NaN, y: 10 })).toEqual(placeNew(VP, []))
    const corner = placeNew(VP, [], { x: 5, y: 5 })
    expect(corner.y).toBe(0)
    expect(corner.x + corner.w).toBeGreaterThanOrEqual(160)
  })

  it("[FLOAT-AC-6] a rect is never smaller than the minimum nor larger than the screen", () => {
    expect(clampRect({ x: 10, y: 10, w: 50, h: 50 }, VP)).toMatchObject(FLOAT_MIN)
    const huge = clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, VP)
    expect(huge.w).toBe(VP.w - 16)
    expect(huge.h).toBe(VP.h - 16)
  })

  it("[FLOAT-AC-6] the header stays reachable wherever the float is dragged", () => {
    const right = clampRect({ x: 9999, y: 9999, w: 520, h: 340 }, VP)
    expect(right.x).toBe(VP.w - 64)
    expect(right.y).toBe(VP.h - FLOAT_HEADER_H)
    const left = clampRect({ x: -9999, y: -9999, w: 520, h: 340 }, VP)
    expect(left.x).toBe(160 - 520)
    expect(left.y).toBe(0)
  })

  it("[FLOAT-AC-8] a fourth open float turns the one at the back into a bubble", () => {
    const floats: Floats = { a: entry(1), b: entry(2), c: entry(3) }
    expect(MAX_OPEN_FLOATS).toBe(3)
    expect(overflowToMinimize(floats)).toEqual(["a"])
    expect(overflowToMinimize({ a: entry(1), b: entry(2) })).toEqual([])
    expect(overflowToMinimize({ a: entry(1, true), b: entry(2), c: entry(3) })).toEqual([])
  })

  it("[FLOAT-AC-8] past the total limit the oldest bubble is the one that docks", () => {
    const floats: Floats = {}
    for (let i = 1; i <= MAX_FLOATS; i++) floats[`w${i}`] = entry(i, i !== 2)
    expect(overflowToDock(floats)).toEqual(["w1"])
    const allOpen: Floats = {}
    for (let i = 1; i <= MAX_FLOATS; i++) allOpen[`w${i}`] = entry(i)
    expect(overflowToDock(allOpen)).toEqual(["w1"])
    expect(overflowToDock({ a: entry(1) })).toEqual([])
  })

  it("[FLOAT-AC-6] the front float is the open one with the highest z", () => {
    expect(frontId({ a: entry(5, true), b: entry(2), c: entry(3) })).toBe("c")
    expect(frontId({ a: entry(5, true) })).toBeNull()
  })

  it("[FLOAT-AC-13] saved floats come back only for windows that exist and are not in a pane", () => {
    const saved = {
      gone: entry(1),
      docked: entry(2),
      ok: entry(3, true, 200, 220),
      broken: { x: "nope", minimized: false, z: 4 },
      junk: null,
    }
    const out = sanitizeFloats(saved, new Set(["docked", "ok", "broken"]), new Set(["docked"]), VP)
    expect(Object.keys(out).sort()).toEqual(["broken", "ok"])
    expect(out.ok).toMatchObject({ x: 200, y: 220, minimized: true })
    expect(out.broken.w).toBe(FLOAT_DEFAULT.w)
    expect(Number.isFinite(out.broken.x)).toBe(true)
    expect(sanitizeFloats(undefined, new Set(), new Set(), VP)).toEqual({})
    expect(sanitizeFloats("x", new Set(), new Set(), VP)).toEqual({})
  })

  it("[FLOAT-AC-13] saved floats are clamped to the screen they come back on and to the limits", () => {
    const small = { w: 800, h: 600 }
    const out = sanitizeFloats({ a: entry(1, false, 1300, 800) }, new Set(["a"]), new Set(), small)
    expect(out.a.x).toBe(small.w - 64)
    expect(out.a.y).toBe(small.h - FLOAT_HEADER_H)
    const many: Record<string, unknown> = {}
    const ids = new Set<string>()
    for (let i = 1; i <= 12; i++) {
      many[`w${i}`] = entry(i)
      ids.add(`w${i}`)
    }
    const kept = sanitizeFloats(many, ids, new Set(), VP)
    expect(Object.keys(kept)).toHaveLength(MAX_FLOATS)
    expect(Object.values(kept).filter((e) => !e.minimized)).toHaveLength(MAX_OPEN_FLOATS)
  })

  it("[FLOAT-AC-13] a smaller screen pulls floats back in, and leaves them alone when they fit", () => {
    const floats: Floats = { a: entry(1, false, 1300, 100) }
    expect(fitFloats(floats, VP)).toBe(floats)
    const fitted = fitFloats(floats, { w: 800, h: 600 })
    expect(fitted.a.x).toBe(800 - 64)
  })

  it("[FLOAT-AC-7] bubbles stack upwards next to the navbar; on a phone, at the right edge", () => {
    const first = bubbleSpot(0, VP, 272, false)
    const second = bubbleSpot(1, VP, 272, false)
    expect(first.x).toBe(292)
    expect(first.y - second.y).toBe(BUBBLE_SIZE + 12)
    const phone = bubbleSpot(0, { w: 390, h: 844 }, 0, true)
    expect(phone.x).toBe(390 - BUBBLE_SIZE - 16)
  })

  it("[FLOAT-AC-7] bubbles that do not fit one column start another, so none is off the screen", () => {
    const short = { w: 1280, h: 420 }
    const spots = Array.from({ length: MAX_FLOATS }, (_, i) => bubbleSpot(i, short, 64, false))
    expect(spots.every((p) => p.y >= 8)).toBe(true)
    expect(new Set(spots.map((p) => `${p.x},${p.y}`)).size).toBe(MAX_FLOATS)
    expect(spots[0].x).toBe(84)
    expect(Math.max(...spots.map((p) => p.x))).toBeGreaterThan(84)
    const phone = Array.from({ length: MAX_FLOATS }, (_, i) => bubbleSpot(i, { w: 390, h: 420 }, 0, true))
    expect(phone.every((p) => p.x >= 0 && p.y >= 8)).toBe(true)
    expect(Math.min(...phone.map((p) => p.x))).toBeLessThan(phone[0].x)
  })

  it("[FLOAT-AC-13] restoring on a phone does not squeeze the saved places into the phone's screen", () => {
    const phone = { w: 390, h: 844 }
    const saved = { a: entry(1, false, 900, 500) }
    const kept = sanitizeFloats(saved, new Set(["a"]), new Set(), phone, { clamp: false })
    expect(kept.a).toMatchObject({ x: 900, y: 500, w: 520, h: 340 })
    const squeezed = sanitizeFloats(saved, new Set(["a"]), new Set(), phone)
    expect(squeezed.a.x).toBeLessThan(400)
  })

  it("[FLOAT-AC-10] the phone sheet covers the bottom 64 % of the screen", () => {
    const r = sheetRect({ w: 390, h: 844 })
    expect(r.h).toBe(Math.round(844 * 0.64))
    expect(r.y + r.h).toBe(844)
    expect(r.w).toBe(390 - 16)
  })
})
