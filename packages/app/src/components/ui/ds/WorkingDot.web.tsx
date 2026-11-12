/**
 * WorkingDot (web) — the TerosThinking "point" at dot size: the avatar glow's
 * ball, in amber, scaled to a row dot (Pablo, 2026-10-24 — "the avatar's
 * thinking ball, but orange"). A fat amber ball on a wide eased orbit whose
 * sharpness breathes crisp ↔ heavily blurred — it defines and dissolves as it
 * goes — swelling as it breathes, dragging a three-step blurred amber comet
 * behind it.
 *
 * It draws larger than its slot (overflow visible) so the motion reads at 8 px
 * without shifting layout. CSS only — no timers or rAF per instance, so dozens
 * of rows stay cheap (the canvas ThinkingGlow paints once and stays still at
 * ≤ 20 px). Under prefers-reduced-motion the ball sits still in the centre
 * with a soft halo.
 */
import React from "react"

const CSS = `
.wkdot{position:relative;display:inline-block;flex-shrink:0;overflow:visible}
.wkdot>i{position:absolute;border-radius:50%;background:var(--wk-c,#F59E0B);left:calc(50% - 3.5px);top:calc(50% - 3.5px);width:7px;height:7px}
.wkdot>i.b{box-shadow:0 0 6px 1.5px color-mix(in srgb,var(--wk-c,#F59E0B) 55%,transparent)}
.wkdot>i.t{opacity:.38;filter:blur(1.6px)}
.wkdot>i.t2{opacity:.2;filter:blur(2.6px)}
.wkdot>i.t3{opacity:.1;filter:blur(3.4px)}
@media (prefers-reduced-motion: no-preference){
  .wkdot>i.b{animation:wkOrb 2.4s cubic-bezier(.45,.05,.55,.95) infinite,wkBlur 1.9s ease-in-out infinite alternate,wkSwell 3.1s ease-in-out infinite alternate}
  .wkdot>i.t{animation:wkOrb 2.4s cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:-.26s}
  .wkdot>i.t2{animation:wkOrb 2.4s cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:-.52s}
  .wkdot>i.t3{animation:wkOrb 2.4s cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:-.78s}
}
@keyframes wkOrb{from{transform:rotate(0deg) translateX(3.1px) rotate(0deg)}to{transform:rotate(360deg) translateX(3.1px) rotate(-360deg)}}
@keyframes wkBlur{0%,18%{filter:blur(0)}100%{filter:blur(2.6px)}}
@keyframes wkSwell{from{width:6.5px;height:6.5px;left:calc(50% - 3.25px);top:calc(50% - 3.25px)}to{width:8.5px;height:8.5px;left:calc(50% - 4.25px);top:calc(50% - 4.25px)}}
`

let installed = false
function install() {
  if (installed || typeof document === "undefined") return
  installed = true
  const el = document.createElement("style")
  el.setAttribute("data-working-dot", "")
  el.textContent = CSS
  document.head.appendChild(el)
}

export function WorkingDot({ size = 8, color = "#F59E0B" }: { size?: number; color?: string }) {
  install()
  return (
    <span
      className="wkdot"
      aria-hidden
      style={{ width: size, height: size, ["--wk-c" as string]: color } as React.CSSProperties}
    >
      <i className="t3" />
      <i className="t2" />
      <i className="t" />
      <i className="b" />
    </span>
  )
}
