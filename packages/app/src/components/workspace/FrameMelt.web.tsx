/**
 * FrameMelt — the "melt" of the unida frame, ported from the design-testing
 * prototype (`fr-melt`). A canvas on each side of the sidebar ↔ pane boundary
 * paints the OTHER surface's colour as a slow, dithered, wavy edge, so the
 * frame and the sheet look poured into each other instead of cut by a line:
 *
 *   side  — sits on the right edge of the sidebar (z -1, behind its content)
 *           and paints the sheet colour bulging into the frame.
 *   pane  — sits on the left edge of the first pane (z 30, above content,
 *           pointer-events none) and paints the frame colour bulging into the
 *           sheet; holes are carved around cards, buttons, icons and text so
 *           nothing readable is ever covered.
 *
 * Both variants compute the wave over the whole shell height (the element
 * tagged `data-fx~="shell"`), so the two halves describe one boundary.
 * Reduced motion → one static frame.
 */

import React, { useLayoutEffect, useMemo, useRef } from "react"
import type { FrameMeltProps } from "./FrameMelt"

const TAU = Math.PI * 2
const FALL = 20 // erf falloff width (px)
const W_SIDE = 50
const W_PANE = 55
const FADE_TOP: [number, number] = [0.1, 0.17]
const LOBE_A: [number, number] = [0.1, 0.34]
const LOBE_B: [number, number] = [0.3, 0.95]
const RIPPLE = 0.14
const DRIFT_S = 36
const SHIFT_PX = 70
const SHIFT_S = 11
const AMP = 0.12
const AMP_S = 9
const STRETCH = 0.24
const STRETCH_S = 13
const BULGE = 10
const BULGE_S = 17
const BULGE2_S = 23
const FPS = 20
const PAD = 92
const SUB = 4 // sub-pixel lookup resolution
const CENTER = 80 // where the falloff sits inside the band (px)
const TEXT_PAD = 14
const MAX_HOLES = 12

function erfc01(x: number): number {
  const t = Math.abs(x) / Math.SQRT2
  const n = 1 / (1 + 0.3275911 * t)
  const r =
    1 -
    ((((1.061405429 * n - 1.453152027) * n + 1.421413741) * n - 0.284496736) * n + 0.254829592) *
      n *
      Math.exp(-t * t)
  return x >= 0 ? (1 + r) / 2 : (1 - r) / 2
}

/** Alpha lookup along the band (641 entries, SUB per px). */
const FALLOFF = Uint8Array.from({ length: 641 }, (_, i) =>
  Math.round(255 * (1 - erfc01((i / SUB - CENTER) / FALL))),
)

/** 128×128 tile of xorshift noise in [-.5, .5] for the dither. */
const NOISE = (() => {
  let s = 2654435769
  return Float32Array.from({ length: 16384 }, () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296 - 0.5
  })
})()

// iframes (terminal, editors, embedded pages) and anything tagged `solid` are
// opaque content whatever their size: the melt never paints over them.
const BOX_SEL =
  '[data-fx~="card"], [data-fx~="glow"], [data-fx~="hov"], [data-fx~="solid"], [data-tab], iframe'
const INK_SEL = "i.ph, svg, img, canvas, video, input, textarea"

const radiusCache = new WeakMap<Element, number>()
const radiusOf = (el: Element) => {
  let r = radiusCache.get(el)
  if (r === undefined) {
    r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
    radiusCache.set(el, r)
  }
  return r
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
/** Resolve any CSS colour string to [r, g, b] through the engine. */
const rgbOf = (host: HTMLElement, color: string): [number, number, number] => {
  const probe = document.createElement("i")
  probe.style.color = color
  host.appendChild(probe)
  const m = getComputedStyle(probe)
    .color.match(/[\d.]+/g)
    ?.map(Number) ?? [0, 0, 0]
  probe.remove()
  return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0]
}

interface Phases {
  p0: number
  p1: number
  p2: number
  p3: number
}

/** The wave: offset (px) and vertical fade per shell row. */
function wave(
  off: Float32Array,
  fade: Float32Array,
  rows: number,
  t: number,
  ph: Phases,
  still: boolean,
  scale: number,
) {
  const drift = still ? 0 : (t / DRIFT_S) * TAU
  const shift = still ? 0 : SHIFT_PX * Math.sin((t / SHIFT_S) * TAU + ph.p2)
  const amp = 1 + (still ? 0 : AMP * Math.sin((t / AMP_S) * TAU + ph.p3))
  const stretch = 1 + (still ? 0 : STRETCH * Math.sin((t / STRETCH_S) * TAU + ph.p0))
  const bulge = still ? 0 : BULGE * Math.sin((t / BULGE_S) * TAU + ph.p1)
  const bulge2 = still ? 0 : BULGE * 0.7 * Math.sin((t / BULGE2_S) * TAU + ph.p3)
  for (let r = 0; r < rows; r++) {
    const a = 0.55 + ((r + shift) / rows - 0.55) / stretch
    const p = -50 * smooth(LOBE_A[0], LOBE_A[1], a) + 105 * smooth(LOBE_B[0], LOBE_B[1], a)
    const m =
      1 +
      RIPPLE *
        (0.6 * Math.sin(a * TAU * 1.3 + ph.p0 + drift) +
          0.4 * Math.sin(a * TAU * 2.6 + ph.p1 - drift * 0.7))
    const h =
      Math.sin(Math.PI * Math.min(1, Math.max(0, (a - LOBE_B[0]) / (LOBE_B[1] - LOBE_B[0])))) *
        bulge +
      Math.sin(Math.PI * Math.min(1, Math.max(0, (a - LOBE_A[0]) / (LOBE_A[1] - LOBE_A[0])))) *
        bulge2
    off[r] = (p * m * amp + h) * scale
    fade[r] = smooth(FADE_TOP[0], FADE_TOP[1], r / rows)
  }
}

declare global {
  interface Window {
    __frMeltRnd?: Phases
  }
}

export function FrameMelt({ side, frame, sheet, scale = 1 }: FrameMeltProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isSide = side === "side"
  const bandW = Math.ceil((isSide ? W_SIDE : W_PANE) * 1.26 + BULGE + PAD)
  // One set of random phases per page load, shared by both halves.
  const phases = useMemo(
    () =>
      (window.__frMeltRnd ||= {
        p0: Math.random() * TAU,
        p1: Math.random() * TAU,
        p2: Math.random() * TAU,
        p3: Math.random() * TAU,
      }),
    [],
  )

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches
    const shell = wrap.closest<HTMLElement>('[data-fx~="shell"]')

    let h = 0 // canvas height
    let shellH = 0
    let top = 0 // wrap offset inside the shell
    let ctx: CanvasRenderingContext2D | null = null
    let img: ImageData | null = null
    let px: Uint32Array | null = null
    let fill = 0 // 0x00BBGGRR
    let dither = 21
    let off = new Float32Array(0)
    let fade = new Float32Array(0)
    let boxSpans = new Float32Array(0) // per row: MAX_HOLES × [l, r]
    let boxN = new Uint8Array(0)
    let inkSpans = new Float32Array(0) // per row: MAX_HOLES × [l, r, dy]
    let inkN = new Uint8Array(0)
    let paneBg = ""
    let raf = 0
    let last = -1
    let boxes: Element[] = []
    let inks: (Element | Range)[] = []
    let dirty = true

    const setup = (): boolean => {
      h = wrap.clientHeight
      if (!h || !shell) return false
      shellH = shell.clientHeight
      top = Math.round(wrap.getBoundingClientRect().top - shell.getBoundingClientRect().top)
      canvas.width = bandW
      canvas.height = h
      canvas.style.width = `${bandW}px`
      canvas.style.height = `${h}px`
      ctx = canvas.getContext("2d")
      if (!ctx) return false
      img = ctx.createImageData(bandW, h)
      px = new Uint32Array(img.data.buffer)
      off = new Float32Array(shellH)
      fade = new Float32Array(shellH)
      boxSpans = new Float32Array(h * MAX_HOLES * 2)
      boxN = new Uint8Array(h)
      inkSpans = new Float32Array(h * MAX_HOLES * 3)
      inkN = new Uint8Array(h)
      paneBg = getComputedStyle(wrap.parentElement as Element).backgroundColor
      const [r, g, b] = rgbOf(wrap, isSide ? sheet : frame)
      fill = (b << 16) | (g << 8) | r
      const [r2, g2, b2] = rgbOf(wrap, isSide ? frame : sheet)
      dither = Math.min(64, 255 / Math.max(1, Math.abs(r - r2), Math.abs(g - g2), Math.abs(b - b2)))
      return true
    }

    /** Collect the content the pane melt must flow around. */
    const scan = () => {
      dirty = false
      boxes = []
      inks = []
      const root = wrap.parentElement as Element
      const me = wrap.getBoundingClientRect()
      const limit = me.left + bandW + TEXT_PAD
      const inBand = (r: DOMRect) => r.width && r.height && r.right > me.left && r.left < limit
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (wrap.contains(el)) continue
        const r = el.getBoundingClientRect()
        if (!inBand(r)) continue
        if (el.matches(BOX_SEL)) {
          boxes.push(el)
          continue
        }
        const cs = getComputedStyle(el)
        if (cs.visibility === "hidden" || +cs.opacity === 0) continue
        if (el.matches(INK_SEL)) {
          inks.push(el)
          continue
        }
        const bg = cs.backgroundColor
        if (
          ((bg !== "transparent" && !/,\s*0\)$/.test(bg) && bg !== paneBg) ||
            cs.backgroundImage !== "none") &&
          r.height < h * 0.8
        ) {
          boxes.push(el)
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          (n as Text).data.trim() && !wrap.contains(n)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      })
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const range = document.createRange()
        range.selectNodeContents(n)
        if (inBand(range.getBoundingClientRect())) inks.push(range)
      }
    }

    /** Rasterise the holes (boxes → spans with rounded corners; ink → padded spans). */
    const holes = () => {
      boxN.fill(0)
      inkN.fill(0)
      if (isSide) return
      if (dirty) scan()
      const me = wrap.getBoundingClientRect()
      for (const el of boxes) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        const l = r.left - me.left
        const rr = r.right - me.left
        const t = r.top - me.top
        const b = r.bottom - me.top
        if (rr <= 0 || l >= bandW || b <= 0 || t >= h) continue
        const rad = Math.min(radiusOf(el), r.width / 2, r.height / 2)
        for (let y = Math.max(0, Math.floor(t)), end = Math.min(h, Math.ceil(b)); y < end; y++) {
          const edge = Math.min(y + 0.5 - t, b - y - 0.5)
          let inset = 0
          if (edge < rad) {
            const d = rad - edge
            inset = rad - Math.sqrt(Math.max(0, rad * rad - d * d))
          }
          const n = boxN[y]
          if (n < MAX_HOLES) {
            boxSpans[y * MAX_HOLES * 2 + n * 2] = l + inset
            boxSpans[y * MAX_HOLES * 2 + n * 2 + 1] = rr - inset
            boxN[y] = n + 1
          }
        }
      }
      for (const ink of inks) {
        for (const r of Array.from(ink.getClientRects())) {
          if (!r.width || !r.height) continue
          const l = r.left - me.left
          const rr = r.right - me.left
          const t = r.top - me.top
          const b = r.bottom - me.top
          if (rr <= -TEXT_PAD || l >= bandW + TEXT_PAD || b <= -TEXT_PAD || t >= h + TEXT_PAD)
            continue
          for (
            let y = Math.max(0, Math.floor(t - TEXT_PAD)),
              end = Math.min(h, Math.ceil(b + TEXT_PAD));
            y < end;
            y++
          ) {
            const n = inkN[y]
            if (n >= MAX_HOLES) continue
            const o = (y * MAX_HOLES + n) * 3
            inkSpans[o] = l
            inkSpans[o + 1] = rr
            inkSpans[o + 2] = Math.max(0, t - y - 0.5, y + 0.5 - b)
            inkN[y] = n + 1
          }
        }
      }
    }

    const paint = (t: number) => {
      if (!((img && canvas.height === wrap.clientHeight) || setup())) return
      if (!ctx || !img || !px) return
      wave(off, fade, shellH, t, phases, still, scale)
      holes()
      for (let y = 0; y < h; y++) {
        const row = Math.min(shellH - 1, y + top)
        const o = isSide ? off[row] : -off[row]
        const f = fade[row]
        const base = y * bandW
        for (let x = 0; x < bandW; x++) {
          let i = Math.round((x + o + CENTER) * SUB)
          i = i < 0 ? 0 : i > FALLOFF.length - 1 ? FALLOFF.length - 1 : i
          const a0 = FALLOFF[i] * f
          const k = Math.min(1, a0 / dither, (255 - a0) / dither)
          let a = a0 + NOISE[((row & 127) << 7) | (x & 127)] * dither * k
          a = a < 0 ? 0 : a > 255 ? 255 : a
          for (let n = boxN[y], j = y * MAX_HOLES * 2; n > 0; n--, j += 2) {
            if (x >= boxSpans[j] && x < boxSpans[j + 1]) {
              a = 0
              break
            }
          }
          if (a) {
            for (let n = inkN[y], j = y * MAX_HOLES * 3; n > 0; n--, j += 3) {
              const dx =
                x < inkSpans[j] ? inkSpans[j] - x : x > inkSpans[j + 1] ? x - inkSpans[j + 1] : 0
              const d = Math.hypot(dx, inkSpans[j + 2])
              if (d < TEXT_PAD) {
                const e = d / TEXT_PAD
                a *= e * e * (3 - 2 * e)
                if (a < 1) {
                  a = 0
                  break
                }
              }
            }
          }
          px[base + (isSide ? bandW - 1 - x : x)] = ((Math.round(a) << 24) >>> 0) | fill
        }
      }
      ctx.putImageData(img, 0, 0)
    }

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 1000 / FPS || !wrap.clientHeight) return
      last = now
      paint(now / 1000)
    }
    const settle = setTimeout(() => {
      img = null
      paint(performance.now() / 1000)
    }, 60)
    const ro = new ResizeObserver(() => {
      img = null
      dirty = true
      paint(performance.now() / 1000)
    })
    ro.observe(wrap)
    const mo = new MutationObserver(() => {
      dirty = true
    })
    if (wrap.parentElement && !isSide) {
      mo.observe(wrap.parentElement, { childList: true, subtree: true, characterData: true })
    }
    const poll = setInterval(() => {
      dirty = true
      if (still) paint(0)
    }, 1000)
    if (still) paint(0)
    else raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(settle)
      clearInterval(poll)
      ro.disconnect()
      mo.disconnect()
    }
  }, [isSide, bandW, frame, sheet, scale, phases])

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      data-fx="melt"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: isSide ? -1 : 30,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: 0,
          [isSide ? "right" : "left"]: 0,
          imageRendering: "pixelated",
        }}
      />
    </div>
  )
}
