/**
 * Web-only effects of the To Do windows (the mock's CSS that React Native
 * styles cannot express): the progress fill's blurred edge, the "done"
 * celebration (crisp fill + mint sweep + dot pop),
 * drag-and-drop indicators and the drag tooltip. Keyed by `data-tdx`
 * (RN-web `dataSet`); injected once. Motion sits under
 * prefers-reduced-motion: no-preference.
 */
import { useLayoutEffect, useRef } from "react"
import { Platform } from "react-native"

/**
 * Replays a CSS animation keyed by a data attribute: clears it, forces a
 * reflow so the browser forgets the previous run, sets it again and drops it
 * when the animation ends. Used for the click feedback (the handle's beat,
 * the detail's "here" glow, the tab ping). Web only, no-op elsewhere.
 */
export function replayAttr(el: Element | null | undefined, attr: string, value: string): void {
  if (!el || Platform.OS !== "web") return
  el.removeAttribute(attr)
  void (el as HTMLElement).offsetWidth
  el.setAttribute(attr, value)
  el.addEventListener("animationend", () => el.removeAttribute(attr), { once: true })
}

/**
 * Keeps a row's Pressable hovered while the pointer is over the Pressables
 * nested in it (handle, eye, +, avatar). RN-web's Pressable uses
 * `useHover({ contain: true })`: entering a nested Pressable dispatches a
 * bubbling `react-gui:hover:lock` custom event that un-hovers every ancestor
 * Pressable, and leaving it dispatches `unlock` to re-hover them. When the
 * ancestor's `hovered` gates the children's pointer-events, that un-hover
 * removes the child from under the cursor, which fires leave → unlock →
 * re-hover → enter → lock → … dozens of times a second (the eye flicker).
 * Stopping the two events in the capture phase at the row, for any target
 * but the row itself, leaves the row's own enter/leave in charge. Web only.
 */
export function useRowHover<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || Platform.OS !== "web") return
    const stop = (e: Event) => {
      if (e.target !== el) e.stopPropagation()
    }
    el.addEventListener("react-gui:hover:lock", stop, true)
    el.addEventListener("react-gui:hover:unlock", stop, true)
    return () => {
      el.removeEventListener("react-gui:hover:lock", stop, true)
      el.removeEventListener("react-gui:hover:unlock", stop, true)
    }
  }, [])
  return ref
}

const EASE = "cubic-bezier(.16,1,.3,1)"

const CSS = `
[data-tdx~="pfill"]{transition:width .6s ${EASE},background-color .4s;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent);filter:blur(.5px)}
[data-tdx~="pfill"][data-tdx~="full"]{-webkit-mask-image:none;mask-image:none;filter:none}
[data-tdx~="kfill"]{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 24px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 24px),transparent)}
[data-tdx~="kfill"][data-tdx~="full"]{-webkit-mask-image:none;mask-image:none}
[data-tdx~="row"]{outline:none}
[data-tdx~="row"]:focus-visible{box-shadow:inset 0 0 0 1.5px rgba(156,107,255,.6)}
[data-tdx~="hd"]{cursor:grab}
[data-tdx~="hd"]:active{cursor:grabbing}
[data-tdx~="row"][data-dz="b"]::after,[data-tdx~="row"][data-dz="a"]::after{content:"";position:absolute;left:4px;right:4px;height:2px;border-radius:1px;background:#9C6BFF;pointer-events:none;z-index:3}
[data-tdx~="row"][data-dz="b"]::after{top:-1px}
[data-tdx~="row"][data-dz="a"]::after{bottom:-1px}
[data-tdx~="row"][data-dz="in"]{box-shadow:inset 0 0 0 1.5px #9C6BFF}
[data-tdx~="row"][data-dz="no"]{cursor:not-allowed}
[data-tdx~="row"][data-dragging="1"]{opacity:.4}
[data-tdx~="dlist"][data-over="1"]{box-shadow:inset 0 0 0 1.5px rgba(156,107,255,.5)}
.tdx-tip{position:fixed;z-index:9999;pointer-events:none;font:400 10px/18px "Reddit Mono",ui-monospace,monospace;color:#fff;background:#6F27FF;border-radius:100px;padding:0 8px;white-space:nowrap;transform:translate(14px,10px);opacity:0;transition:opacity .12s}
.tdx-tip.on{opacity:1}
[data-tdx~="scroll"]{scrollbar-width:thin}
[data-tdx~="noscroll"]{scrollbar-width:none}
[data-tdx~="noscroll"]::-webkit-scrollbar{display:none}
[data-tdx~="strip"]{overscroll-behavior-x:contain;scroll-behavior:smooth}
[data-tdx~="strip"]:focus-visible{outline:none;box-shadow:inset 0 0 0 1.5px rgba(156,107,255,.6);border-radius:100px}
[data-tdx~="sfade"]{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent)}
[data-tdx~="cloud"]{isolation:isolate;--tdx-cloud:#6F27FF;--tdx-cloud-blur:60px;--tdx-cloud-o:.375}
html[data-theme="light"] [data-tdx~="cloud"]{--tdx-cloud:color-mix(in srgb,#968FA7 70%,#6F27FF);--tdx-cloud-blur:40px;--tdx-cloud-o:.2}
[data-tdx~="cloud"]::before{content:"";position:absolute;inset:-6px;border-radius:22px;background:radial-gradient(60% 70% at 16% 30%,var(--tdx-cloud),transparent 70%),radial-gradient(55% 70% at 84% 72%,var(--tdx-cloud),transparent 70%);filter:blur(var(--tdx-cloud-blur));opacity:var(--tdx-cloud-o);z-index:-1;pointer-events:none}
@media (prefers-reduced-motion: no-preference){
  [data-tdx~="cele"]{animation:tdxGlow 1.4s ${EASE}}
  [data-tdx~="cele"] [data-tdx~="pfill"]{animation:tdxDefine .9s ${EASE} both}
  [data-tdx~="cele"] [data-tdx~="sweep"]{display:block;animation:tdxSweep 1.1s ${EASE} both}
  [data-tdx~="cele"] [data-tdx~="dot"]{animation:tdxPop .7s ${EASE}}
  [data-tdx~="flash"]{animation:tdxFlash 1.2s ${EASE}}
  [data-tdx~="hd"][data-beat="1"]{animation:tdxBeat .35s ${EASE}}
  [data-tdx~="hd"][data-beat="2"]{animation:tdxBeat2 .55s ${EASE}}
  [data-here="1"]{animation:tdxHere .9s ${EASE}}
  [data-tab][data-ping="1"]{animation:tdxTabPing .7s ${EASE}}
  [data-tdx~="in"]{animation:tdxIn .28s ${EASE}}
  [data-tdx~="pop"]{animation:tdxMenu .18s ${EASE};transform-origin:top left}
  [data-tdx~="viewer"]{animation:tdxFade .25s ${EASE}}
  [data-tdx~="vbody"]{animation:tdxVin .35s ${EASE}}
}
[data-tdx~="sweep"]{display:none;background:linear-gradient(100deg,transparent 0%,rgba(30,255,206,0) 30%,rgba(30,255,206,.32) 50%,rgba(30,255,206,0) 70%,transparent 100%);background-size:250% 100%}

@keyframes tdxDefine{from{filter:blur(8px);opacity:.5}to{filter:blur(0);opacity:1}}
@keyframes tdxSweep{from{background-position:120% 0}to{background-position:-60% 0}}
@keyframes tdxGlow{0%{box-shadow:0 0 0 0 rgba(28,162,77,0)}35%{box-shadow:0 0 0 2px rgba(28,162,77,.16),0 0 14px 1px rgba(30,255,206,.22)}100%{box-shadow:0 0 0 0 rgba(28,162,77,0)}}
@keyframes tdxPop{0%{transform:scale(1)}40%{transform:scale(1.9)}100%{transform:scale(1)}}
@keyframes tdxFlash{0%,35%{background-color:rgba(111,39,255,.12)}}
@keyframes tdxBeat{0%{transform:scale(1)}40%{transform:scale(1.3)}100%{transform:scale(1)}}
@keyframes tdxBeat2{0%{transform:scale(1);box-shadow:0 0 0 0 rgba(156,107,255,.55)}35%{transform:scale(1.5)}65%{transform:scale(.96)}100%{transform:scale(1);box-shadow:0 0 0 10px rgba(156,107,255,0)}}
@keyframes tdxHere{0%{box-shadow:inset 0 0 0 0 rgba(156,107,255,0)}25%{box-shadow:inset 0 0 0 2px rgba(156,107,255,.55),inset 0 0 28px rgba(156,107,255,.16)}100%{box-shadow:inset 0 0 0 0 rgba(156,107,255,0)}}
@keyframes tdxTabPing{0%,100%{box-shadow:0 0 0 0 rgba(156,107,255,0)}35%{box-shadow:0 0 0 2px rgba(156,107,255,.6)}}
@keyframes tdxIn{from{opacity:0;transform:translateY(3px)}}
@keyframes tdxMenu{from{opacity:0;transform:scale(.97) translateY(-2px)}}
@keyframes tdxFade{from{opacity:0}}
@keyframes tdxVin{from{opacity:0;transform:translateY(10px) scale(.985)}}
`

let installed = false

export function installTodoFx(): void {
  if (installed || Platform.OS !== "web" || typeof document === "undefined") return
  installed = true
  const el = document.createElement("style")
  el.setAttribute("data-todo-fx", "")
  el.textContent = CSS
  document.head.appendChild(el)
}

/** RN-web `dataSet` for the effects above (spread on a View). */
export function tdx(names: string, extra?: Record<string, string>): Record<string, never> {
  return { dataSet: { tdx: names, ...extra } } as unknown as Record<string, never>
}

/** Web-only inline style (box-shadow strings etc.); empty on native. */
export function web<T extends object>(style: T): T | Record<string, never> {
  return Platform.OS === "web" ? style : {}
}
