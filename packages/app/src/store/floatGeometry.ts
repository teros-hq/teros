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

export type Floats = Record<string, FloatEntry>

export interface Viewport {
  w: number
  h: number
}

export const FLOAT_DEFAULT = { w: 520, h: 340 }
export const FLOAT_MIN = { w: 300, h: 200 }
export const MAX_OPEN_FLOATS = 3
export const MAX_FLOATS = 8
export const FLOAT_HEADER_H = 36
export const BUBBLE_SIZE = 52
export const BUBBLE_GAP = 12
export const BUBBLE_BOTTOM = 108
export const SHEET_HEIGHT = 0.64

const KEEP_VISIBLE = 64
const KEEP_VISIBLE_LEFT = 160
const CASCADE = 28
const EDGE = 16

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function clampRect(r: FloatRect, vp: Viewport): FloatRect {
  const w = Math.max(FLOAT_MIN.w, Math.min(r.w, vp.w - EDGE))
  const h = Math.max(FLOAT_MIN.h, Math.min(r.h, vp.h - EDGE))
  const x = Math.min(Math.max(r.x, KEEP_VISIBLE_LEFT - w), vp.w - KEEP_VISIBLE)
  const y = Math.min(Math.max(r.y, 0), vp.h - FLOAT_HEADER_H)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

export function placeNew(
  vp: Viewport,
  existing: FloatRect[],
  at?: { x: number; y: number } | null,
  size: { w: number; h: number } = FLOAT_DEFAULT,
): FloatRect {
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    return clampRect(
      { x: at.x - size.w / 2, y: at.y - FLOAT_HEADER_H / 2, w: size.w, h: size.h },
      vp,
    )
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

export function topZ(floats: Floats): number {
  let z = 0
  for (const e of Object.values(floats)) z = Math.max(z, e.z)
  return z
}

export function byZ(floats: Floats): string[] {
  return Object.keys(floats).sort((a, b) => floats[a].z - floats[b].z)
}

export function openIds(floats: Floats): string[] {
  return byZ(floats).filter((id) => !floats[id].minimized)
}

export function minimizedIds(floats: Floats): string[] {
  return byZ(floats).filter((id) => floats[id].minimized)
}

export function frontId(floats: Floats): string | null {
  const open = openIds(floats)
  return open.length > 0 ? open[open.length - 1] : null
}

export function overflowToMinimize(floats: Floats, max = MAX_OPEN_FLOATS): string[] {
  const open = openIds(floats)
  const extra = open.length + 1 - max
  return extra > 0 ? open.slice(0, extra) : []
}

export function overflowToDock(floats: Floats, max = MAX_FLOATS): string[] {
  const all = byZ(floats)
  const extra = all.length + 1 - max
  if (extra <= 0) return []
  return [...minimizedIds(floats), ...openIds(floats)].slice(0, extra)
}

export function sanitizeFloats(
  saved: unknown,
  windowIds: ReadonlySet<string>,
  dockedIds: ReadonlySet<string>,
  vp: Viewport,
  options: { clamp?: boolean } = {},
): Floats {
  const fit = (r: FloatRect) =>
    options.clamp === false
      ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }
      : clampRect(r, vp)
  const out: Floats = {}
  if (!saved || typeof saved !== "object") return out
  const entries = Object.entries(saved as Record<string, Partial<FloatEntry> | null>)
    .filter(([id, e]) => !!e && typeof e === "object" && windowIds.has(id) && !dockedIds.has(id))
    .sort((a, b) => finite(a[1]?.z, 0) - finite(b[1]?.z, 0))
    .slice(-MAX_FLOATS) as Array<[string, Partial<FloatEntry>]>
  let z = 0
  for (const [id, e] of entries) {
    const fallback = placeNew(vp, Object.values(out))
    const rect = fit({
      x: finite(e.x, fallback.x),
      y: finite(e.y, fallback.y),
      w: Math.max(FLOAT_MIN.w, finite(e.w, fallback.w)),
      h: Math.max(FLOAT_MIN.h, finite(e.h, fallback.h)),
    })
    z += 1
    out[id] = { ...rect, minimized: e.minimized === true, z }
  }
  const extra = overflowToMinimize(out, MAX_OPEN_FLOATS + 1)
  for (const id of extra) out[id] = { ...out[id], minimized: true }
  return out
}

export function fitFloats(floats: Floats, vp: Viewport): Floats {
  let changed = false
  const next: Floats = {}
  for (const [id, e] of Object.entries(floats)) {
    const r = clampRect(e, vp)
    changed ||= r.x !== e.x || r.y !== e.y || r.w !== e.w || r.h !== e.h
    next[id] = { ...e, ...r }
  }
  return changed ? next : floats
}

export function bubbleSpot(
  index: number,
  vp: Viewport,
  navWidth: number,
  compact: boolean,
): { x: number; y: number } {
  const pitch = BUBBLE_SIZE + BUBBLE_GAP
  const perColumn = Math.max(1, Math.floor((vp.h - BUBBLE_BOTTOM - 8 + BUBBLE_GAP) / pitch))
  const column = Math.floor(index / perColumn)
  const row = index % perColumn
  return {
    x: compact ? vp.w - BUBBLE_SIZE - EDGE - column * pitch : navWidth + 20 + column * pitch,
    y: vp.h - BUBBLE_BOTTOM - BUBBLE_SIZE - row * pitch,
  }
}

export function sheetRect(vp: Viewport): FloatRect {
  const h = Math.round(vp.h * SHEET_HEIGHT)
  return { x: 8, y: vp.h - h, w: Math.max(0, vp.w - 16), h }
}
