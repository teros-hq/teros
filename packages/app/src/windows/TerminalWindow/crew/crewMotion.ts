/**
 * Motion of the crew (spec "Movimiento"): the seat's ring breathes while its
 * driver types, the needs-you ring turns, a conflict shakes three times, a
 * new driver slides in. Web: real CSS keyframes injected once (the pattern of
 * StatusDot — compositor thread, immune to re-renders). Native and
 * prefers-reduced-motion: no animation, the colours stay.
 */

import { Platform } from "react-native"

const STYLE_ID = "teros-crew-keyframes"

const CSS = `
@keyframes crew-breathe { 0%,100% { opacity: 0; transform: scale(.86); } 50% { opacity: 1; transform: scale(1); } }
@keyframes crew-spin { to { transform: rotate(360deg); } }
@keyframes crew-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-1.5px); } 75% { transform: translateX(1.5px); } }
@keyframes crew-seat-in { from { transform: translateX(-60%) scale(.6); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes crew-pulse-amber { 0% { box-shadow: 0 0 0 0 rgba(242,169,59,.6); } 70% { box-shadow: 0 0 0 9px rgba(242,169,59,0); } 100% { box-shadow: 0 0 0 0 rgba(242,169,59,0); } }
@keyframes crew-pop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
`

let reduced: boolean | null = null

/** Inject the keyframes (idempotent) and tell whether motion is allowed. */
export function crewMotion(): boolean {
  if (Platform.OS !== "web" || typeof document === "undefined") return false
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style")
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }
  if (reduced === null) {
    try {
      reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    } catch {
      reduced = false
    }
  }
  return !reduced
}

/** A web-only `animation` style (opaque to RN's types), or nothing. */
export function anim(value: string): object {
  return crewMotion() ? ({ animation: value } as object) : {}
}

/** A web-only CSS style (transition, boxShadow, filter…) passed through RN-web as is. */
export function css(style: Record<string, string | number>): object {
  return Platform.OS === "web" ? (style as object) : {}
}
