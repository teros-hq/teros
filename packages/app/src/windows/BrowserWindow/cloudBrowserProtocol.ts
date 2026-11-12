/**
 * /ws/browser frames — the cloud browser's data plane as the SPA speaks it
 * (CLB-REQ-4/6; server side: packages/backend/src/services/browser/stream-server.ts).
 * Pure helpers, no React, unit-tested in cloudBrowserProtocol.test.ts.
 */

export const KIND_FRAME = 1

/** `[kind u8][idLen u8][id utf8][payload]` */
export function decodeFrame(
  buf: ArrayBuffer,
): { kind: number; id: string; payload: Uint8Array } | null {
  const bytes = new Uint8Array(buf)
  if (bytes.length < 2) return null
  const idLen = bytes[1]
  if (bytes.length < 2 + idLen) return null
  return {
    kind: bytes[0],
    id: new TextDecoder().decode(bytes.subarray(2, 2 + idLen)),
    payload: bytes.subarray(2 + idLen),
  }
}

/** The tab's state as the server pushes it (mirror of the backend's TabState). */
export interface CloudTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  agentConsent: boolean
  control: "human" | "agent" | "none"
}

export type ServerMessage =
  | { t: "attached"; id: string; state: CloudTabState; display: string | null }
  | ({ t: "state" } & CloudTabState)
  | { t: "frame-meta"; id: string; cssWidth: number; cssHeight: number }
  | { t: "closed"; id: string; reason: string }
  | { t: "err"; id?: string; code: string; msg?: string }
  | { t: "pong"; c: number; s: number }

/** CDP Input modifier bits (DBAC-REQ-8). */
export const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const

export interface ModifierKeys {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function modsOf(e: ModifierKeys): number {
  return (
    (e.altKey ? MODS.Alt : 0) |
    (e.ctrlKey ? MODS.Control : 0) |
    (e.metaKey ? MODS.Meta : 0) |
    (e.shiftKey ? MODS.Shift : 0)
  )
}

export type MouseButtonName = "left" | "middle" | "right" | "back" | "forward" | "none"

export function buttonName(button: number): MouseButtonName {
  switch (button) {
    case 0:
      return "left"
    case 1:
      return "middle"
    case 2:
      return "right"
    case 3:
      return "back"
    case 4:
      return "forward"
    default:
      return "none"
  }
}

/** The button currently held during a move (from `buttons`), for drags. */
export function heldButton(buttons: number): MouseButtonName {
  if (buttons & 1) return "left"
  if (buttons & 2) return "right"
  if (buttons & 4) return "middle"
  return "none"
}

export interface MouseFrame {
  t: "in"
  id: string
  k: "move" | "down" | "up"
  x: number
  y: number
  b: MouseButtonName
  cc: number
  mods: number
}

export interface WheelFrame {
  t: "in"
  id: string
  k: "wheel"
  x: number
  y: number
  dx: number
  dy: number
  mods: number
}

export interface KeyFrame {
  t: "in"
  id: string
  k: "key"
  type: "down" | "up"
  key: string
  code: string
  kc: number
  mods: number
  text?: string
}

export interface TextFrame {
  t: "in"
  id: string
  k: "text"
  text: string
}

export type InputFrame = MouseFrame | WheelFrame | KeyFrame | TextFrame

/** What `keyFrame` needs from a DOM KeyboardEvent. */
export interface KeyEventLike extends ModifierKeys {
  key: string
  code: string
  keyCode: number
}

/**
 * @spec CLB-REQ-6 / CLB-AC-7 — a DOM key event as an `in` frame. `text`
 * travels only for a single printable character typed without
 * Ctrl/Meta/Alt (Ctrl+A must not type "a"); Enter delivers "\r" so inputs
 * submit as they would for a real key.
 */
export function keyFrame(id: string, type: "down" | "up", e: KeyEventLike): KeyFrame {
  const mods = modsOf(e)
  const frame: KeyFrame = {
    t: "in",
    id,
    k: "key",
    type,
    key: e.key,
    code: e.code ?? "",
    kc: e.keyCode ?? 0,
    mods,
  }
  if (type !== "down") return frame
  const plain = (mods & ~MODS.Shift) === 0
  if (plain && [...e.key].length === 1) frame.text = e.key
  else if (plain && e.key === "Enter") frame.text = "\r"
  return frame
}

/** Canvas-local coordinates → the tab's CSS px (the frame may be scaled to fit). */
export function toPageCoords(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  css: { width: number; height: number },
): { x: number; y: number } {
  const sx = rect.width > 0 ? css.width / rect.width : 1
  const sy = rect.height > 0 ? css.height / rect.height : 1
  return {
    x: Math.round((clientX - rect.left) * sx * 10) / 10,
    y: Math.round((clientY - rect.top) * sy * 10) / 10,
  }
}

/** Wheel deltas in CSS px whatever the event's deltaMode (0 px, 1 line, 2 page). */
export function wheelDeltas(
  e: { deltaX: number; deltaY: number; deltaMode: number },
  viewHeight: number,
): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(100, viewHeight * 0.8) : 1
  return { dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit) }
}
