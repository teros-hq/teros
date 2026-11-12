/**
 * AuthColumns — `TerosBgColumns` from the design-testing prototype, the
 * welcome engine behind the access screens ("Bienvenida → Columnas").
 *
 * The viewport is split into columns `size` px wide. Each column is one
 * round-capped stroke as thick as the column whose HEAD travels up and down
 * between a top and a bottom margin, bouncing; behind it trails a short
 * ribbon of the path it just took, drawn as gradient segments whose colour
 * cycles through the brand "essentials" palette as the head moves, fading
 * towards the tail. Every few seconds a column PULSES: for ~1s its head
 * swells (×1.4), its trail lengthens and the whole column blurs (up to 24px).
 *
 * Five stacked canvases: the sharp base and four blur layers — at most four
 * columns pulse at once, each drawn on the layer whose CSS blur matches its
 * own, so blur never costs a per-column filter. DPR capped at 1.5; frames
 * capped at ~70fps; paused when hidden or off-screen; reduced motion gets
 * one static frame.
 */
import React, { useEffect, useRef } from "react"
import type { AuthColumnsProps } from "./AuthColumns"

// colors.essentials: Mint/200, Purple/300, Yellow/200, Purple/200
const PALETTE: [number, number, number][] = [
  [0x1e, 0xff, 0xce],
  [0x6f, 0x27, 0xff],
  [0xff, 0xff, 0xb0],
  [0x9c, 0x6b, 0xff],
]
const CFG = {
  size: 200,
  topMargin: 20, // % of the viewport height
  bottomMargin: 15,
  colorStep: 450,
  speed: 0.3,
  trail: 0.8, // seconds
  tailFade: 0.5,
  pulseScale: 1.4,
  pulseBlur: 24,
  pulseTrail: 0.6,
  pulseDuration: 1.1,
  minGap: 2.5,
  maxGap: 7,
}
const LAYERS = 5
const BLUR_FLOOR = 0.3
const FRAME_MIN_MS = 1000 / 70.6

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
interface Column {
  x: number
  headY: number
  dir: 1 | -1
  phase: number
  colorOffset: number
  speedMul: number
  trailMs: number
  points: Point[]
  pulseStart: number
  nextPulseT: number
  curBlur: number
  pulse: number
}

/** Alpha along the trail: 1 for the fresh part, fading to 0 over `tailFade` of it. */
function fadeFn(points: Point[], now: number, trailMs: number, tailFade: number) {
  const span = Math.max(1, Math.min(trailMs, now - points[0].t))
  const solid = 1 - tailFade
  return (t: number) => {
    const age = (now - t) / span
    if (age <= solid || tailFade <= 1e-4) return 1
    const f = (1 - age) / tailFade
    return f < 0 ? 0 : f > 1 ? 1 : f
  }
}

function strokeTrail(ctx: CanvasRenderingContext2D, pts: Point[], alpha: (t: number) => number) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (a.x === b.x && a.y === b.y) continue
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    g.addColorStop(0, withAlpha(a.color, alpha(a.t)))
    g.addColorStop(1, withAlpha(b.color, alpha(b.t)))
    ctx.strokeStyle = g
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
}

/** 0 → 1 → 0 sine pulse that fires at random gaps. */
function pulseOf(col: Column, now: number, durMs: number, minGap: number, maxGap: number) {
  const gap = () => minGap + Math.random() * (maxGap - minGap)
  if (col.nextPulseT <= 0) col.nextPulseT = now + gap()
  if (col.pulseStart < 0 && now >= col.nextPulseT) col.pulseStart = now
  if (col.pulseStart >= 0) {
    const p = (now - col.pulseStart) / durMs
    if (p >= 1) {
      col.pulseStart = -1
      col.nextPulseT = now + gap()
      return 0
    }
    return Math.sin(Math.PI * p)
  }
  return 0
}

export function AuthColumns({ background }: AuthColumnsProps) {
  const refs = useRef<Array<HTMLCanvasElement | null>>([])

  useEffect(() => {
    const canvases: HTMLCanvasElement[] = []
    const ctxs: CanvasRenderingContext2D[] = []
    for (let i = 0; i < LAYERS; i++) {
      const el = refs.current[i]
      const ctx = el?.getContext("2d")
      if (!el || !ctx) return
      canvases.push(el)
      ctxs.push(ctx)
    }
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

    // ── Size ────────────────────────────────────────────────────────────
    const box = { w: 0, h: 0, vh: 0 }
    const resize = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1)
      box.w = canvases[0].clientWidth || 1
      box.h = canvases[0].clientHeight || 1
      box.vh = window.innerHeight || box.h
      for (let i = 0; i < LAYERS; i++) {
        canvases[i].width = Math.floor(box.w * dpr)
        canvases[i].height = Math.floor(box.h * dpr)
        ctxs[i].setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }
    resize()
    window.addEventListener("resize", resize)
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null
    ro?.observe(canvases[0])

    // ── State ───────────────────────────────────────────────────────────
    const pulseMs = CFG.pulseDuration * 1000
    const minGap = CFG.minGap * 1000
    const maxGap = Math.max(minGap, CFG.maxGap * 1000)
    const layerBlur = [0, -1, -1, -1, -1]
    let columns: Column[] = []
    let lastCount = -1
    let lastT = 0

    const makeColumn = (x: number, now: number, top: number, bottom: number): Column => {
      const offset = Math.random() * PALETTE.length
      const y = top + Math.random() * (bottom - top)
      return {
        x,
        headY: y,
        dir: Math.random() < 0.5 ? -1 : 1,
        phase: 0,
        colorOffset: offset,
        speedMul: 0.85 + Math.random() * 0.3,
        trailMs: Math.max(0, CFG.trail * 1000),
        points: [{ x, y, t: now, color: lerpColor(offset) }],
        pulseStart: -1,
        nextPulseT: now + minGap + Math.random() * (maxGap - minGap),
        curBlur: 0,
        pulse: 0,
      }
    }

    const frame = (now: number) => {
      if (lastT !== 0 && now - lastT < FRAME_MIN_MS) return
      let dt = now - (lastT === 0 ? now : lastT)
      lastT = now
      if (dt > 100) dt = 100
      const stepT = Math.min(Math.max(0, dt), 100)
      const size = Math.max(1, CFG.size)
      const count = Math.max(1, Math.ceil(box.w / size))
      const vh = Math.min(box.vh, box.h)
      const top = size / 2 + (Math.max(0, CFG.topMargin) / 100) * vh
      const bottom = Math.max(top, box.h - size / 2 - (Math.max(0, CFG.bottomMargin) / 100) * vh)
      if (count !== lastCount) {
        columns = Array.from({ length: count }, (_, i) =>
          makeColumn((i + 0.5) * size, now, top, bottom),
        )
        lastCount = count
      }
      for (let i = 0; i < LAYERS; i++) {
        ctxs[i].clearRect(0, 0, box.w, box.h)
        ctxs[i].globalAlpha = 1
        ctxs[i].lineCap = "round"
        ctxs[i].lineJoin = "round"
        ctxs[i].lineWidth = size
      }
      for (const col of columns) {
        col.pulse = pulseOf(col, now, pulseMs, minGap, maxGap)
        col.curBlur = col.pulse * CFG.pulseBlur
        const wantTrail = Math.max(0, (CFG.trail + col.pulse * CFG.pulseTrail) * 1000)
        col.trailMs =
          wantTrail >= col.trailMs
            ? wantTrail
            : col.trailMs + (wantTrail - col.trailMs) * (1 - Math.exp(-dt / 600))
        const step = size * 0.003 * Math.max(0.01, CFG.speed) * col.speedMul * dt
        let y = col.headY + col.dir * step
        if (y > bottom) {
          y = bottom
          col.dir = -1
        } else if (y < top) {
          y = top
          col.dir = 1
        }
        const travelled = Math.abs(y - col.headY)
        const dPhase = step / Math.max(1, CFG.colorStep)
        const segs = Math.max(1, Math.min(80, Math.ceil(travelled / 8)))
        const phase0 = col.phase
        const y0 = col.headY
        for (let s = 1; s <= segs; s++) {
          const f = s / segs
          col.points.push({
            x: col.x,
            y: y0 + (y - y0) * f,
            t: now - stepT * (1 - f),
            color: lerpColor(phase0 + dPhase * f + col.colorOffset),
          })
        }
        col.phase = phase0 + dPhase
        col.headY = y
        const oldest = now - col.trailMs
        while (col.points.length && col.points[0].t < oldest) col.points.shift()
      }
      // The four most blurred columns get the blur layers.
      const blurred = columns
        .filter((c) => c.curBlur > BLUR_FLOOR)
        .sort((a, b) => b.curBlur - a.curBlur)
        .slice(0, LAYERS - 1)
      for (let i = 0; i < LAYERS - 1; i++) {
        const v = blurred[i] ? Math.round(blurred[i].curBlur * 10) / 10 : 0
        if (v !== layerBlur[i + 1]) {
          canvases[i + 1].style.filter = v > BLUR_FLOOR ? `blur(${v}px)` : "none"
          layerBlur[i + 1] = v
        }
      }
      const layerFor = (col: Column) => {
        if (col.curBlur <= BLUR_FLOOR) return 0
        const idx = blurred.indexOf(col)
        if (idx >= 0) return idx + 1
        let best = 0
        let diff = col.curBlur
        for (let i = 0; i < blurred.length; i++) {
          const d = Math.abs(blurred[i].curBlur - col.curBlur)
          if (d < diff) {
            diff = d
            best = i + 1
          }
        }
        return best
      }
      for (const col of columns) {
        if (!col.points.length) continue
        const ctx = ctxs[layerFor(col)]
        strokeTrail(ctx, col.points, fadeFn(col.points, now, col.trailMs, CFG.tailFade))
        ctx.fillStyle = lerpColor(col.phase + col.colorOffset)
        ctx.beginPath()
        ctx.arc(
          col.x,
          col.headY,
          (size / 2) * (1 + col.pulse * (CFG.pulseScale - 1)),
          0,
          Math.PI * 2,
        )
        ctx.fill()
      }
    }

    // ── Loop: runs only while visible and on-screen ─────────────────────
    let raf = 0
    let running = false
    let onScreen = true
    let pageVisible = !document.hidden
    const tick = (t: number) => {
      if (running) raf = requestAnimationFrame(tick)
      frame(t)
    }
    const start = () => {
      if (running) return
      running = true
      lastT = 0
      raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    const sync = () => {
      if (onScreen && pageVisible && !reduced) start()
      else stop()
    }
    const onVisibility = () => {
      pageVisible = !document.hidden
      sync()
    }
    document.addEventListener("visibilitychange", onVisibility)
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              onScreen = !entries[0] || entries[0].isIntersecting
              sync()
            },
            { threshold: 0 },
          )
        : null
    io?.observe(canvases[0])
    if (reduced) requestAnimationFrame((t) => frame(t))
    else sync()

    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
      io?.disconnect()
      ro?.disconnect()
      window.removeEventListener("resize", resize)
    }
  }, [])

  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        background,
        transition: "background 0.6s ease",
      }}
    >
      {Array.from({ length: LAYERS }).map((_, i) => (
        <canvas
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            display: "block",
            pointerEvents: "none",
            willChange: "filter",
          }}
        />
      ))}
    </div>
  )
}
