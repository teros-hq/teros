/**
 * Halo — the button bloom of the design-testing prototype (its `TerosButton`):
 * while the pointer is over a solid pill, a soft cloud of the pill's OWN colour
 * blooms outside it and wanders slowly under the cursor, then drains away on
 * leave. There is no lift, no shadow, no scale — the pill just glows.
 *
 * Anatomy (a straight port of the prototype's inline component):
 *   - a wrapper bleeding `blurPeak × 2.5` px outside the host, display none
 *     while idle so the blur filters cost nothing;
 *   - six layers, each a copy of the pill blurred progressively
 *     (blurPeak × e/6) and MASKED by a radial gradient centred on the wander
 *     point, with a radius that shrinks per layer (blob × (1 − .8·(e−1)/5)):
 *     the sharp inner layers reach far, the soft outer ones stay close, so
 *     the bloom reads as one organic cloud rather than a drop shadow;
 *   - the mask alpha eases toward 1 on enter (12 %/frame) and back to 0 on
 *     leave; the point starts at a random spot and random-walks inside
 *     [−.15, 1.15] of the pill box. Reduced motion pins it at (.7, .5).
 *
 * Mounted as a child of the pill (a Pressable); the host is the parent DOM
 * node, which must keep `overflow: visible`. Content that should read above
 * the bloom sits in a positioned sibling with zIndex 1 (the halo itself has
 * no z-index, so it paints under later positioned siblings).
 */
import React, { useLayoutEffect, useRef } from "react"
import type { HaloProps, HaloSize } from "./Halo"

const N = 7
const IDLE = 0.002
const DRIFT_SPEED = 1
const REF_W = 167
const EASE_IN = 0.12
const WANDER_MIN = -0.15
const WANDER_MAX = 1.15

const PRESET: Record<HaloSize, { blob: number; blur: number }> = {
  sm: { blob: 76, blur: 13 },
  md: { blob: 98, blur: 16 },
  lg: { blob: 120, blur: 20 },
  xl: { blob: 120, blur: 20 },
}

function layersFor(size: HaloSize) {
  const { blob, blur } = PRESET[size]
  const out: Array<{ blur: number; r: number }> = []
  for (let e = 1; e < N; e++) {
    out.push({ blur: blur * (e / (N - 1)), r: blob * (1 - (0.8 * (e - 1)) / (N - 2)) })
  }
  return out
}

export function Halo({ color, size = "md", radius = 100, disabled }: HaloProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const layerRefs = useRef<Array<HTMLDivElement | null>>([])
  const layers = React.useMemo(() => layersFor(size), [size])
  const bleed = PRESET[size].blur * 2.5

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const host = wrap?.parentElement as HTMLElement | null
    if (disabled || !wrap || !host) return

    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

    let hovered = false
    let intensity = 0
    let raf = 0
    let running = false
    let sx = Math.random()
    let sy = Math.random()
    let heading = Math.random() * Math.PI * 2

    const show = (on: boolean) => {
      wrap.style.display = on ? "block" : "none"
      for (const l of layerRefs.current) if (l) l.style.willChange = on ? "mask" : "auto"
    }
    show(false)

    const frame = () => {
      const target = hovered ? 1 : 0
      intensity += (target - intensity) * EASE_IN
      if (!hovered && intensity < IDLE) {
        intensity = 0
        running = false
        raf = 0
        show(false)
        return
      }
      raf = requestAnimationFrame(frame)

      const a = intensity.toFixed(3)
      const w = host.offsetWidth || 1
      const h = host.offsetHeight || 1
      if (reduced) {
        sx = 0.7
        sy = 0.5
      } else {
        heading += (Math.random() - 0.5) * 0.2 * DRIFT_SPEED
        const step = 0.0022 * DRIFT_SPEED * (REF_W / w)
        sx += Math.cos(heading) * step
        sy += Math.sin(heading) * step
        if (sx < WANDER_MIN) {
          sx = WANDER_MIN
          heading = Math.PI - heading
        } else if (sx > WANDER_MAX) {
          sx = WANDER_MAX
          heading = Math.PI - heading
        }
        if (sy < WANDER_MIN) {
          sy = WANDER_MIN
          heading = -heading
        } else if (sy > WANDER_MAX) {
          sy = WANDER_MAX
          heading = -heading
        }
      }
      // Wander point as a percentage of the bled wrapper box.
      const cx = ((bleed + sx * w) / (2 * bleed + w)) * 100
      const cy = ((bleed + sy * h) / (2 * bleed + h)) * 100
      layers.forEach((l, i) => {
        const el = layerRefs.current[i]
        if (!el) return
        const mask = `radial-gradient(circle ${l.r.toFixed(1)}px at ${cx.toFixed(2)}% ${cy.toFixed(2)}%, rgba(0,0,0,${a}) 0%, rgba(0,0,0,${a}) 45%, rgba(0,0,0,0) 100%)`
        el.style.webkitMaskImage = mask
        el.style.maskImage = mask
      })
    }

    const start = () => {
      if (running) return
      running = true
      if (!reduced) {
        sx = Math.random()
        sy = Math.random()
        heading = Math.random() * Math.PI * 2
      }
      show(true)
      raf = requestAnimationFrame(frame)
    }
    const onEnter = () => {
      hovered = true
      start()
    }
    const onLeave = () => {
      hovered = false
      start()
    }
    const onVisibility = () => {
      if (!document.hidden) return
      hovered = false
      intensity = 0
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      show(false)
    }

    host.addEventListener("pointerenter", onEnter)
    host.addEventListener("pointerleave", onLeave)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      host.removeEventListener("pointerenter", onEnter)
      host.removeEventListener("pointerleave", onLeave)
      document.removeEventListener("visibilitychange", onVisibility)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [disabled, bleed, layers])

  if (disabled) return null
  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      data-halo=""
      style={{ position: "absolute", inset: -bleed, pointerEvents: "none", display: "none" }}
    >
      {layers.map((l, i) => (
        <div
          key={i}
          ref={(el) => {
            layerRefs.current[i] = el
          }}
          style={{
            position: "absolute",
            inset: 0,
            filter: `blur(${l.blur.toFixed(2)}px)`,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: bleed,
              borderRadius: radius,
              backgroundColor: color,
            }}
          />
        </div>
      ))}
    </div>
  )
}
