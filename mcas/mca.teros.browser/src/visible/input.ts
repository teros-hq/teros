/**
 * A viewer's input frame → one CDP Input call (spec BRW-REQ-4; the shapes
 * of the desktop/cloud browser, CLB-REQ-6). Pure, unit-tested.
 *
 *   { k:'move'|'down'|'up', x, y, b?, cc?, mods? }
 *   { k:'wheel', x, y, dx, dy, mods? }
 *   { k:'key', type:'down'|'up', key, code?, kc?, text?, mods? }
 *   { k:'text', text }                       → Input.insertText (paste)
 *
 * `mods` is the CDP bit set Alt=1 Control=2 Meta=4 Shift=8.
 */

const BUTTONS = new Set(["left", "middle", "right", "back", "forward", "none"])
const MAX_TEXT_LEN = 20_000

function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function buttonsMask(b: string): number {
  switch (b) {
    case "left":
      return 1
    case "right":
      return 2
    case "middle":
      return 4
    default:
      return 0
  }
}

export interface CdpInputCall {
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText"
  params: Record<string, unknown>
}

export function inputParams(msg: Record<string, unknown>): CdpInputCall | null {
  const mods = Math.max(0, Math.min(15, Math.trunc(num(msg.mods))))
  switch (msg.k) {
    case "move":
    case "down":
    case "up": {
      const x = num(msg.x, Number.NaN)
      const y = num(msg.y, Number.NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      const button =
        typeof msg.b === "string" && BUTTONS.has(msg.b) ? msg.b : msg.k === "move" ? "none" : "left"
      const type =
        msg.k === "move" ? "mouseMoved" : msg.k === "down" ? "mousePressed" : "mouseReleased"
      const clickCount = Math.max(0, Math.min(3, Math.trunc(num(msg.cc, msg.k === "move" ? 0 : 1))))
      return {
        method: "Input.dispatchMouseEvent",
        params: {
          type,
          x,
          y,
          button,
          clickCount,
          modifiers: mods,
          ...(msg.k === "move" && msg.b && msg.b !== "none"
            ? { buttons: buttonsMask(String(msg.b)) }
            : {}),
        },
      }
    }
    case "wheel": {
      const x = num(msg.x, Number.NaN)
      const y = num(msg.y, Number.NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x,
          y,
          deltaX: Math.max(-2000, Math.min(2000, num(msg.dx))),
          deltaY: Math.max(-2000, Math.min(2000, num(msg.dy))),
          modifiers: mods,
        },
      }
    }
    case "key": {
      if (typeof msg.key !== "string" || !msg.key || msg.key.length > 32) return null
      const down = msg.type !== "up"
      const text =
        typeof msg.text === "string" && msg.text.length <= 8 && down ? msg.text : undefined
      const params: Record<string, unknown> = {
        type: down ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
        key: msg.key,
        modifiers: mods,
      }
      if (typeof msg.code === "string" && msg.code.length <= 32) params.code = msg.code
      const kc = Math.trunc(num(msg.kc, Number.NaN))
      if (Number.isFinite(kc) && kc >= 0 && kc < 256) {
        params.windowsVirtualKeyCode = kc
        params.nativeVirtualKeyCode = kc
      }
      if (text) {
        params.text = text
        params.unmodifiedText = text
      }
      return { method: "Input.dispatchKeyEvent", params }
    }
    case "text": {
      if (typeof msg.text !== "string" || !msg.text || msg.text.length > MAX_TEXT_LEN) return null
      return { method: "Input.insertText", params: { text: msg.text } }
    }
    default:
      return null
  }
}

/** Viewer size as a viewer reports it (attach meta / resize input), clamped. */
export function clampSize(
  msg: Record<string, unknown>,
): { width: number; height: number; dpr: number } | null {
  const w = Number(msg.width)
  const h = Number(msg.height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 50 || h < 50) return null
  const dprRaw = Number(msg.dpr)
  const dpr = Number.isFinite(dprRaw) && dprRaw > 0 ? Math.min(3, Math.max(0.5, dprRaw)) : 1
  return { width: Math.min(4096, Math.round(w)), height: Math.min(4096, Math.round(h)), dpr }
}

/** A bare host gets https:// (the address bar already resolved searches). */
export function normalizeUrl(url: unknown): string {
  const trimmed = String(url ?? "").trim()
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
