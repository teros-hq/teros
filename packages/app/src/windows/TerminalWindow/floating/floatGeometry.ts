/**
 * Pure geometry for floating terminals: default sizes, clamping into the
 * viewport, cascading new windows and the max-floating rule. No React, no
 * stores — unit-tested in tests/unit/terminalFloat.test.ts.
 */

export interface FloatRect {
  x: number
  y: number
  w: number
  h: number
}

export interface FloatEntry extends FloatRect {
  minimized: boolean
  z: number
}

export interface Viewport {
  w: number
  h: number
}

/** Spec: a floating terminal opens at 520×340, never smaller than 300×200. */
export const FLOAT_DEFAULT = { w: 520, h: 340 }
export const FLOAT_MIN = { w: 300, h: 200 }
/** At most this many floating at once; popping out one more docks the one at the back. */
export const MAX_FLOATING = 3
/** Below this app width every floating terminal shows as a bubble (tap → sheet). */
export const NARROW_FLOAT_WIDTH = 960
/** Keep at least this much of a window (its header) on screen. */
const KEEP_VISIBLE = 64
const HEADER_H = 44
const CASCADE = 28

/** Clamp a rect so its header stays reachable and it fits the viewport. */
export function clampRect(r: FloatRect, vp: Viewport): FloatRect {
  const w = Math.max(FLOAT_MIN.w, Math.min(r.w, vp.w - 16))
  const h = Math.max(FLOAT_MIN.h, Math.min(r.h, vp.h - 16))
  const x = Math.min(Math.max(r.x, KEEP_VISIBLE - w), vp.w - KEEP_VISIBLE)
  const y = Math.min(Math.max(r.y, 0), vp.h - HEADER_H)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * Where a new floating terminal goes: centred on the drop point when there is
 * one (the face was dragged there), else cascaded from the top-right so
 * several pop-outs don't stack exactly on top of each other.
 */
export function placeNew(
  vp: Viewport,
  existing: FloatRect[],
  at?: { x: number; y: number } | null,
  size: { w: number; h: number } = FLOAT_DEFAULT,
): FloatRect {
  if (at) {
    return clampRect({ x: at.x - size.w / 2, y: at.y - HEADER_H / 2, w: size.w, h: size.h }, vp)
  }
  let x = vp.w - size.w - 96
  let y = 96
  for (
    let i = 0;
    i < 10 && existing.some((r) => Math.abs(r.x - x) < 8 && Math.abs(r.y - y) < 8);
    i++
  ) {
    x -= CASCADE
    y += CASCADE
  }
  return clampRect({ x, y, w: size.w, h: size.h }, vp)
}

/** The ids to dock so that adding one more keeps at most MAX_FLOATING (lowest z first). */
export function overflowIds(floating: Record<string, FloatEntry>, max = MAX_FLOATING): string[] {
  const ids = Object.keys(floating)
  const extra = ids.length + 1 - max
  if (extra <= 0) return []
  return ids.sort((a, b) => floating[a].z - floating[b].z).slice(0, extra)
}

export function topZ(floating: Record<string, FloatEntry>): number {
  let z = 0
  for (const e of Object.values(floating)) z = Math.max(z, e.z)
  return z
}

/** Is a point inside a DOMRect-like box (with optional slack)? */
export function hit(
  p: { x: number; y: number },
  box: { left: number; top: number; right: number; bottom: number },
  slack = 0,
): boolean {
  return (
    p.x >= box.left - slack &&
    p.x <= box.right + slack &&
    p.y >= box.top - slack &&
    p.y <= box.bottom + slack
  )
}
