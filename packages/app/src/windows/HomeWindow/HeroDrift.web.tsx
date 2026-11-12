/**
 * HeroDrift — `TerosBgDrift` from the design-testing prototype, as mounted by
 * the home hero (`.hero-bg[data-kind="drift"]`, size 380, wander .8).
 *
 * One blob of brand colour wanders over the page background on a canvas:
 * its position is a sum of three sines per axis, it leaves a fading trail
 * drawn as gradient strokes, its colour cycles through the "essentials"
 * palette as it travels, and every few seconds it "rests" (pulse): the trail
 * shortens and the head swells. The canvas is 64px larger than the box and
 * blurred 30px, with a veil towards the text painted by the caller.
 *
 * Pauses when hidden or off-screen; one static frame under reduced motion.
 */

import React, { useEffect, useRef } from "react"
import type { HeroDriftProps } from "./HeroDrift"

// colors.essentials: Mint/200, Purple/300, Yellow/200, Purple/200
const PALETTE: [number, number, number][] = [
  [0x1e, 0xff, 0xce],
  [0x6f, 0x27, 0xff],
  [0xff, 0xff, 0xb0],
  [0x9c, 0x6b, 0xff],
]
const CFG = {
  colorStep: 400,
  speed: 0.9,
  trail: 3,
  tailFade: 0.55,
  restScale: 1.4,
  restTrail: 0.7,
  pulseDuration: 4,
  minGap: 2.5,
  maxGap: 7,
}
const HARMONICS = [0.5, 0.3, 0.2]

const lerpColor = (t: number) => {
  const n = PALETTE.length
  let r = t % n
  if (r < 0) r += n
  const i = Math.floor(r)
  const a = (i + 1) % n
  const o = r - i
  const s = PALETTE[i]
  const c = PALETTE[a]
  return `rgb(${Math.round(s[0] + (c[0] - s[0]) * o)},${Math.round(s[1] + (c[1] - s[1]) * o)},${Math.round(s[2] + (c[2] - s[2]) * o)})`
}
const withAlpha = (rgb: string, a: number) => rgb.replace("rgb(", "rgba(").replace(")", `,${a})`)

interface Point {
  x: number
  y: number
  t: number
  color: string
}
interface Blob {
  bxFrac: number
  byFrac: number
  fx: number[]
  fy: number[]
  px: number[]
  py: number[]
  colorOffset: number
  headX: number
  headY: number
  initialized: boolean
  phase: number
  trailMs: number
  points: Point[]
  pulseStart: number
  nextPulseT: number
}

/** 0 → 1 → 0 over `durationMs` every `minGap..maxGap` seconds. */
function pulse(b: Blob, t: number, durationMs: number, minGapMs: number, maxGapMs: number) {
  const gap = () => minGapMs + Math.random() * (maxGapMs - minGapMs)
  if (b.nextPulseT <= 0) b.nextPulseT = t + gap()
  if (b.pulseStart < 0 && t >= b.nextPulseT) b.pulseStart = t
  if (b.pulseStart >= 0) {
    const r = (t - b.pulseStart) / durationMs
    if (r >= 1) {
      b.pulseStart = -1
      b.nextPulseT = t + gap()
      return 0
    }
    return Math.sin(Math.PI * r)
  }
  return 0
}

export function HeroDrift({ bg, size = 380, wander = 0.8 }: HeroDriftProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    const rnd = Math.random
    const box = { w: 1, h: 1 }

    const measure = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1)
      box.w = canvas.clientWidth || 1
      box.h = canvas.clientHeight || 1
      canvas.width = Math.floor(box.w * dpr)
      canvas.height = Math.floor(box.h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(canvas)

    const a = 55e-5 * Math.max(0.01, CFG.speed)
    const b: Blob = {
      bxFrac: 0.5,
      byFrac: 0.1,
      fx: [a * (0.8 + rnd() * 0.6), a * (1.4 + rnd() * 0.9), a * (2 + rnd() * 1.1)],
      fy: [a * (0.9 + rnd() * 0.6), a * (1.5 + rnd() * 0.9), a * (2.2 + rnd() * 1.1)],
      px: [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283],
      py: [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283],
      colorOffset: rnd() * PALETTE.length,
      headX: 0,
      headY: 0,
      initialized: false,
      phase: rnd() * PALETTE.length,
      trailMs: Math.max(0, (CFG.trail + CFG.restTrail) * 1e3),
      points: [],
      pulseStart: -1,
      nextPulseT: 0,
    }
    const wave = (f: number[], p: number[], t: number) =>
      HARMONICS[0] * Math.sin(f[0] * t + p[0]) +
      HARMONICS[1] * Math.sin(f[1] * t + p[1]) +
      HARMONICS[2] * Math.sin(f[2] * t + p[2])

    let lastT = 0
    const frame = (now: number) => {
      if (lastT !== 0 && now - lastT < 1000 / 70) return
      let dt = now - (lastT === 0 ? now : lastT)
      lastT = now
      if (dt > 100) dt = 100
      const half = size / 2
      const bw = Math.max(1, box.w - size)
      const bh = Math.max(1, box.h - size)
      const cx = half + (0.04 + 0.92 * b.bxFrac) * bw
      const cy = half + (0.04 + 0.92 * b.byFrac) * bh
      const wx = Math.max(0, Math.min(wander * box.w, cx - half, box.w - half - cx))
      const wy = Math.max(0, Math.min(wander * box.h, cy - half, box.h - half - cy))
      const X = cx + wx * wave(b.fx, b.px, now)
      const Y = cy + wy * wave(b.fy, b.py, now)
      const rest =
        1 -
        pulse(
          b,
          now,
          Math.max(1, CFG.pulseDuration * 1e3),
          Math.max(0, CFG.minGap) * 1e3,
          Math.max(CFG.minGap, CFG.maxGap) * 1e3,
        )
      // trail length eases towards its target
      const targetTrail = Math.max(0, (CFG.trail + rest * CFG.restTrail) * 1e3)
      if (targetTrail >= b.trailMs) b.trailMs = targetTrail
      else b.trailMs += (targetTrail - b.trailMs) * (1 - Math.exp(-dt / 600))

      if (!b.initialized) {
        b.headX = X
        b.headY = Y
        b.initialized = true
        b.points.push({ x: X, y: Y, t: now, color: lerpColor(b.phase + b.colorOffset) })
      } else {
        const x0 = b.headX
        const y0 = b.headY
        const dist = Math.hypot(X - x0, Y - y0)
        const steps = Math.max(1, Math.min(48, Math.ceil(dist / Math.max(6, size * 0.08))))
        const ph = b.phase
        const dPhase = dist / Math.max(1, CFG.colorStep)
        for (let n = 1; n <= steps; n++) {
          const o = n / steps
          b.points.push({
            x: x0 + (X - x0) * o,
            y: y0 + (Y - y0) * o,
            t: now - dt * (1 - o),
            color: lerpColor(ph + dPhase * o + b.colorOffset),
          })
        }
        b.phase = ph + dPhase
        b.headX = X
        b.headY = Y
      }
      const cutoff = now - b.trailMs
      while (b.points.length && b.points[0].t < cutoff) b.points.shift()

      ctx.clearRect(0, 0, box.w, box.h)
      ctx.globalAlpha = 1
      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      ctx.lineWidth = size
      if (!b.points.length) return
      // tail alpha: 1 along the fresh part, fading over the last `tailFade`
      const span = Math.max(1, Math.min(b.trailMs, now - b.points[0].t))
      const solid = 1 - CFG.tailFade
      const alphaAt = (t: number) => {
        const n = (now - t) / span
        if (n <= solid || CFG.tailFade <= 1e-4) return 1
        const i = (1 - n) / CFG.tailFade
        return i < 0 ? 0 : i > 1 ? 1 : i
      }
      const pts = b.points
      for (let r = 0; r < pts.length - 1; r++) {
        const p = pts[r]
        const q = pts[r + 1]
        if (p.x === q.x && p.y === q.y) continue
        const g = ctx.createLinearGradient(p.x, p.y, q.x, q.y)
        g.addColorStop(0, withAlpha(p.color, alphaAt(p.t)))
        g.addColorStop(1, withAlpha(q.color, alphaAt(q.t)))
        ctx.strokeStyle = g
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(q.x, q.y)
        ctx.stroke()
      }
      const swell = 1 + rest * (CFG.restScale - 1)
      ctx.fillStyle = lerpColor(b.phase + b.colorOffset)
      ctx.beginPath()
      ctx.arc(b.headX, b.headY, half * swell, 0, Math.PI * 2)
      ctx.fill()
    }

    // run only while visible, on-screen and motion is allowed
    let raf = 0
    let running = false
    let onScreen = true
    let pageVisible = !document.hidden
    const loop = (now: number) => {
      if (running) raf = requestAnimationFrame(loop)
      frame(now)
    }
    const start = () => {
      if (running) return
      running = true
      lastT = 0
      raf = requestAnimationFrame(loop)
    }
    const stop = () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    const sync = () => (onScreen && pageVisible && !reduced ? start() : stop())
    const onVis = () => {
      pageVisible = !document.hidden
      sync()
    }
    document.addEventListener("visibilitychange", onVis)
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = !entries[0] || entries[0].isIntersecting
        sync()
      },
      { threshold: 0 },
    )
    io.observe(canvas)
    if (reduced) requestAnimationFrame(frame)
    else sync()

    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVis)
      io.disconnect()
      ro.disconnect()
    }
  }, [size, wander])

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        borderRadius: "inherit",
        pointerEvents: "none",
        WebkitMaskImage: "-webkit-radial-gradient(#fff, #000)",
        background: bg,
        transition: "background .6s ease",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: -32,
          width: "calc(100% + 64px)",
          height: "calc(100% + 64px)",
          display: "block",
          filter: "blur(30px)",
          willChange: "filter",
        }}
      />
    </div>
  )
}
