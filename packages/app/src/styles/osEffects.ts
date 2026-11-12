/**
 * OS effects layer (web only) — the motion of the design-testing prototype,
 * ported as one stylesheet keyed by `data-fx` attributes (RN-web `dataSet`).
 *
 *   page       staggered blur-in of a page's children (`.page-in > *` viewIn)
 *   hc + d=N   home cards (hcIn, 60ms × N stagger)
 *   card/hov   lift on hover (translate -2px) — the shadow lives in the component
 *   glow       cursor-following border glow (fx-bento-card--border-glow)
 *   msg-agent / msg-user   message entrances (msgIn / userIn)
 *   pip / pop  sidebar active pip + count pill pop
 *   sheen      the amber approvals banner sweep
 *   menu / modal / toast   blur-in entrances
 *   ring       the story avatar ring rotation (storyspin via @property --ra)
 *   cloud      violet cloud behind pending approvals (cloudIn)
 *   agent-switch / av · toggle · send   hover micro-interactions
 *
 * Everything that moves sits under `prefers-reduced-motion: no-preference`.
 * `installOsEffects()` injects the sheet once and runs the pointer tracker
 * that feeds `--glow-x/y/i` to every `[data-fx~="glow"]` element.
 */

const EASE = "cubic-bezier(.16,1,.3,1)"
const POP = "cubic-bezier(.22,1.25,.36,1)"

export const OS_EFFECTS_CSS = `
@property --ra { syntax: "<angle>"; inherits: false; initial-value: 200deg; }
/* inherits: the ::before/::after that paint the glow must see the value */
@property --glow-i { syntax: "<number>"; inherits: true; initial-value: 0; }

html[data-theme="light"] { --ring-rgb: 156, 107, 255; }
html[data-theme="dark"]  { --ring-rgb: 111, 39, 255; }
body { transition: background-color .4s cubic-bezier(.4,0,.2,1), color .4s cubic-bezier(.4,0,.2,1); }

/* ── Hover micro-interactions (no motion gate: they are transitions, not autoplay) */
[data-fx~="hov"] { transition: translate .35s ${EASE}, box-shadow .35s ${EASE}, background .25s, border-color .25s, --glow-i .6s cubic-bezier(.23,1,.32,1); }
[data-fx~="hov"]:hover { translate: 0 -2px; }
[data-fx~="hov"]:active { translate: 0 0; }
[data-fx~="agent-switch"] [data-fx~="av"] { transition: transform .5s ${EASE}; }
[data-fx~="agent-switch"]:hover [data-fx~="av"] { transform: rotate(-6deg) scale(1.05); }
[data-fx~="toggle"] { transition: transform .5s ${EASE}; }
[data-fx~="toggle"]:hover { transform: rotate(25deg); }
[data-fx~="send"] { transition: transform .4s ${EASE}, box-shadow .3s, background .25s; }
[data-fx~="send"]:hover { box-shadow: 0 6px 18px -8px rgba(111,39,255,.45); }
[data-fx~="send"]:active { transform: scale(.94); }
[data-fx~="go"] { transition: background .2s, color .2s, transform .35s ${EASE}; }
[data-fx~="go"]:hover { transform: translate(1px, -1px); }

/* ── Cursor border glow (fx-bento-card--border-glow) */
[data-fx~="glow"] { --glow-x: 50%; --glow-y: 50%; --glow-i: 0; --glow-r: 220px; isolation: isolate; transition: --glow-i .6s cubic-bezier(.23,1,.32,1); }
[data-fx~="glow"]::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 2;
  padding: 1.5px;
  background: radial-gradient(var(--glow-r) circle at var(--glow-x) var(--glow-y),
    rgba(var(--ring-rgb), calc(var(--glow-i) * .9)) 0%,
    rgba(var(--ring-rgb), calc(var(--glow-i) * .45)) 35%,
    transparent 75%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
}
[data-fx~="glow"]::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 0;
  background: radial-gradient(var(--glow-r) circle at var(--glow-x) var(--glow-y),
    rgba(var(--ring-rgb), calc(var(--glow-i) * .10)) 0%, transparent 60%);
}

/* ── Sheen on the approvals banner */
[data-fx~="sheen"] { position: relative; overflow: hidden; transition: transform .3s ${EASE}, box-shadow .3s; }
[data-fx~="sheen"]:hover { transform: translateY(-1px); box-shadow: 0 8px 20px -10px rgba(245,158,11,.6); }
[data-fx~="sheen"]::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,.55) 50%, transparent 65%);
  transform: translateX(-100%);
}

/* ── Cloud: the violet bloom behind a box that asks for attention (the
   prototype's pending approvals, task lists; here also markdown tables).
   Two blurred radial blobs of the cloud colour sit BEHIND the host (z -1
   inside its own stacking context) and brighten on hover; the ::after
   repaints the host's own background over the cloud so the box itself
   stays flat. Put the fx on a wrapper when the box clips (overflow hidden). */
:root { --cloud-c: #6F27FF; --cloud-blur: 70px; --cloud: .8; --cloud-hover: 1; }
html[data-theme="light"] { --cloud-c: color-mix(in srgb, #968FA7 70%, #6F27FF); --cloud-blur: 45px; --cloud: .4; --cloud-hover: .55; }
[data-fx~="cloud"] { position: relative; isolation: isolate; }
[data-fx~="cloud"]::before {
  content: ""; position: absolute; z-index: -2; pointer-events: none;
  inset: calc(2% - 220px) calc(1% - 220px) -220px -220px; padding: 220px;
  background:
    radial-gradient(60% 75% at 22% 72%, var(--cloud-c) 0 35%, transparent 100%),
    radial-gradient(32% 50% at 86% 18%, color-mix(in srgb, var(--cloud-c) 90%, transparent) 0 25%, transparent 100%);
  background-origin: content-box; background-clip: content-box; background-repeat: no-repeat;
  filter: blur(var(--cloud-blur)); opacity: var(--cloud);
  transition: opacity .3s ${EASE};
}
[data-fx~="cloud"]::after {
  content: ""; position: absolute; z-index: -1; pointer-events: none; inset: 0;
  border-radius: inherit; background: inherit;
}
[data-fx~="cloud"]:hover::before { opacity: var(--cloud-hover); }

@media (prefers-reduced-motion: no-preference) {
  @keyframes fxViewIn { 0% { opacity: 0; filter: blur(4px); transform: translateY(10px); } }
  @keyframes fxHcIn   { 0% { opacity: 0; filter: blur(6px); transform: translateY(14px) scale(.985); } }
  @keyframes fxMsgIn  { 0% { opacity: 0; filter: blur(10px); transform: translateY(24px) scale(.98); } }
  @keyframes fxUserIn { 0% { opacity: 0; filter: blur(8px); transform: translateX(40px); } }
  @keyframes fxPipIn  { 0% { opacity: 0; transform: scale(0); } }
  @keyframes fxPopIn  { 0% { opacity: 0; transform: scale(.4); } 60% { transform: scale(1.12); } }
  @keyframes fxSheen  { 0%, 70% { transform: translateX(-100%); } to { transform: translateX(100%); } }
  @keyframes fxMiIn   { 0% { opacity: 0; transform: translateX(-4px); } }
  @keyframes fxMenuIn { 0% { opacity: 0; filter: blur(4px); transform: translateY(-6px) scale(.96); } }
  @keyframes fxModalIn{ 0% { opacity: 0; filter: blur(6px); transform: translateY(14px) scale(.96); } }
  @keyframes fxToastIn{ 0% { opacity: 0; filter: blur(4px); transform: translateY(24px) scale(.96); } }
  @keyframes fxStory  { to { --ra: 560deg; } }
  @keyframes fxCloudIn{ 0% { opacity: 0; } 35% { opacity: .28; } }
  @keyframes fxTabOn  { 0% { transform: translateY(2px) scale(.97); } }

  [data-fx~="page"] > * { animation: fxViewIn .6s ${EASE} both; }
  [data-fx~="page"] > :nth-child(2) { animation-delay: 40ms; }
  [data-fx~="page"] > :nth-child(3) { animation-delay: 80ms; }
  [data-fx~="page"] > :nth-child(4) { animation-delay: 120ms; }
  [data-fx~="page"] > :nth-child(n + 5) { animation-delay: 160ms; }

  [data-fx~="hc"] { animation: fxHcIn .7s ${EASE} both; }
  [data-fx~="hc"][data-d="1"] { animation-delay: 60ms; }
  [data-fx~="hc"][data-d="2"] { animation-delay: 120ms; }
  [data-fx~="hc"][data-d="3"] { animation-delay: 180ms; }
  [data-fx~="hc"][data-d="4"] { animation-delay: 240ms; }
  [data-fx~="hc"][data-d="5"] { animation-delay: 300ms; }

  [data-fx~="msg-agent"] { animation: fxMsgIn .62s ${EASE} both; }
  [data-fx~="msg-user"]  { animation: fxUserIn .62s ${EASE} both; }
  [data-fx~="pip"] { animation: fxPipIn .45s ${EASE} both; }
  [data-fx~="pop"] { animation: fxPopIn .5s ${EASE} both; }
  [data-fx~="tab-on"] { animation: fxTabOn .3s ${EASE} both; }

  [data-fx~="menu"] { animation: fxMenuIn .4s ${EASE} both; transform-origin: top left; }
  [data-fx~="menu"] > * { animation: fxMiIn .4s ${EASE} both; }
  [data-fx~="menu"] > :nth-child(2) { animation-delay: 20ms; }
  [data-fx~="menu"] > :nth-child(3) { animation-delay: 40ms; }
  [data-fx~="menu"] > :nth-child(4) { animation-delay: 60ms; }
  [data-fx~="menu"] > :nth-child(n + 5) { animation-delay: 80ms; }
  [data-fx~="modal"] { animation: fxModalIn .55s ${POP} both; }
  [data-fx~="toast"] { animation: fxToastIn .6s ${POP} both; }

  [data-fx~="sheen"]::after { animation: fxSheen 4.5s ${EASE} 1.2s infinite; }
  [data-fx~="ring"] { animation: fxStory 9s linear infinite; }
  [data-fx~="cloud"]::before { animation: fxCloudIn 1.1s cubic-bezier(.22,.61,.36,1) backwards; }
}
`

let installed = false

/** Inject the sheet and start the border-glow pointer tracker. Web only, idempotent. */
export function installOsEffects(): () => void {
  if (typeof document === "undefined") return () => {}
  if (!installed) {
    const style = document.createElement("style")
    style.dataset.terosFx = "1"
    style.textContent = OS_EFFECTS_CSS
    document.head.appendChild(style)
    installed = true
  }

  // Pointer tracker — hover-capable pointers only (the prototype disables the
  // glow on touch / narrow screens too).
  if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return () => {}

  const PROX = 150
  const FADE = 225
  let raf = 0
  let last: { x: number; y: number } | null = null

  const paint = () => {
    raf = 0
    if (!last) return
    const { x, y } = last
    const els = document.querySelectorAll<HTMLElement>('[data-fx~="glow"]')
    els.forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.bottom < -FADE || r.top > innerHeight + FADE) return
      const dx = Math.max(r.left - x, 0, x - r.right)
      const dy = Math.max(r.top - y, 0, y - r.bottom)
      const d = Math.hypot(dx, dy)
      const i = d <= PROX ? 1 : d <= FADE ? (FADE - d) / (FADE - PROX) : 0
      if (i === 0 && el.style.getPropertyValue("--glow-i") === "0") return
      el.style.setProperty("--glow-x", `${((x - r.left) / r.width) * 100}%`)
      el.style.setProperty("--glow-y", `${((y - r.top) / r.height) * 100}%`)
      el.style.setProperty("--glow-i", i.toFixed(3))
    })
  }
  const onMove = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY }
    if (!raf) raf = requestAnimationFrame(paint)
  }
  const onLeave = () => {
    last = null
    document
      .querySelectorAll<HTMLElement>('[data-fx~="glow"]')
      .forEach((el) => el.style.setProperty("--glow-i", "0"))
  }
  window.addEventListener("pointermove", onMove, { passive: true })
  document.addEventListener("pointerleave", onLeave)
  return () => {
    window.removeEventListener("pointermove", onMove)
    document.removeEventListener("pointerleave", onLeave)
    if (raf) cancelAnimationFrame(raf)
  }
}
