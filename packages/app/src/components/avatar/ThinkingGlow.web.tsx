/**
 * ThinkingGlow — an agent's PRESENCE behind its avatar (web).
 *
 * Port of the prototype's TerosThinking point (design-testing, by Relaja),
 * tuned with Pablo on the avatar spec page (Oct 2026). One object, two
 * energies, driven by a single ENERGY value:
 *
 *   rest (0)     a violet disc just smaller than the avatar, slightly off
 *                centre, so a thin rim peeks out — wider on one side — where
 *                the old ring used to be. It turns once every ~50 s and its
 *                blur breathes on a ~21 s cycle. 60 % opacity.
 *   working (1)  the full glow: the point at ~3/4 of the avatar on a tight
 *                orbit behind the face, trail cycling the essentials palette,
 *                sharpness breathing crisp ↔ heavily blurred, trail swelling
 *                and shrinking, and gaits — cruise, rest (nearly stops,
 *                shrinks and drifts to the rim) and burst (dashes, the trail
 *                streaks round).
 *
 * Energy wakes fast (~0.8 s) and settles slow (~1.6 s); every parameter is a
 * function of it, so state changes are transitions, never pops. Opacity is
 * applied to the canvas (not per stroke) and the trail reels in with the
 * energy, so a settle never flickers.
 *
 * Cost: every instance shares ONE requestAnimationFrame loop. At rest an
 * instance repaints at ~12 fps (its motion is glacial); while working or in
 * transition, every frame. Small avatars (≤ 20px) paint once and stay still.
 * Paused while the tab is hidden; reduced motion paints a still frame.
 */
import React, { useEffect, useRef } from "react"
import type { ThinkingGlowProps } from "./ThinkingGlow"

// colors.essentials: Mint/200, Purple/300, Yellow/200, Purple/200
const PALETTE: [number, number, number][] = [
  [0x1e, 0xff, 0xce],
  [0x6f, 0x27, 0xff],
  [0xff, 0xff, 0xb0],
  [0x9c, 0x6b, 0xff],
]
/** The resting colour: Purple/200. */
const REST_RGB: [number, number, number] = [0x9c, 0x6b, 0xff]
/** Canvas bleed around the avatar, as a fraction of its size. */
const BLEED = 0.5
const REST_FRAME_MS = 80

function palAt(t: number): [number, number, number] {
  const n = PALETTE.length
  let r = t % n
  if (r < 0) r += n
  const i = Math.floor(r)
  const a = (i + 1) % n
  const o = r - i
  const s = PALETTE[i]
  const c = PALETTE[a]
  return [s[0] + (c[0] - s[0]) * o, s[1] + (c[1] - s[1]) * o, s[2] + (c[2] - s[2]) * o]
}
function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`
}

// ── Shared loop ─────────────────────────────────────────────────────────────

interface Instance {
  frame: (t: number) => void
}
const instances = new Set<Instance>()
let raf = 0
function tick(t: number) {
  raf = instances.size && !document.hidden ? requestAnimationFrame(tick) : 0
  for (const inst of instances) inst.frame(t)
}
function ensureLoop() {
  if (!raf && instances.size && typeof document !== "undefined" && !document.hidden)
    raf = requestAnimationFrame(tick)
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    } else ensureLoop()
  })
}

type Gait = "cruise" | "rest" | "burst"
interface Pt {
  x: number
  y: number
  t: number
  p: number
}

export function ThinkingGlow({ size, working }: ThinkingGlowProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const targetRef = useRef(working ? 1 : 0)
  targetRef.current = working ? 1 : 0
  // Wake the shared loop when the state flips.
  useEffect(() => {
    ensureLoop()
  }, [working])

  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext("2d")
    if (!cv || !ctx) return
    const S = size
    const rnd = Math.random
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    const still = reduced || S <= 20

    // Working tuning
    const DOT = S * 0.72
    const ORBIT = S * 0.11
    const PAUSE_ORBIT = S * 0.3
    const PAUSE_SIZE = 0.55
    const BLUR_MAX = Math.max(3, S * 0.13)
    // Rest tuning
    const IDLE_DOT = S * 0.93
    const IDLE_ORBIT = S * 0.02
    const IDLE_BLUR = Math.max(1, S * 0.03)

    const W = S * (1 + 2 * BLEED)
    const H = W
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = Math.floor(W * dpr)
    cv.height = Math.floor(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const SPEED = 0.55
    const O = 0.0012 * SPEED
    const kM = [O * 0.45, O * 0.8]
    const pM = [rnd() * 6.283, rnd() * 6.283]
    const M = (e: number) => 0.6 * Math.sin(kM[0] * e + pM[0]) + 0.4 * Math.sin(kM[1] * e + pM[1])
    const kF = [O * 0.6, O * 1.1]
    const pF = [rnd() * 6.283, rnd() * 6.283]
    const F = (e: number) => 0.6 * Math.sin(kF[0] * e + pF[0]) + 0.4 * Math.sin(kF[1] * e + pF[1])
    const bph = rnd() * 6.28
    const tph = rnd() * 6.28
    const iph = rnd() * 6.28

    let energy = targetRef.current
    let ang = rnd() * 6.283
    let angV = 0
    let gait: Gait = "cruise"
    let gaitUntil = 0
    let gaitMul = 1
    let gaitTrail = 0
    let restAmt = 0
    let trail = 0
    let phase = 0
    let lx = 0
    let ly = 0
    let started = false
    let last = 0
    let lastPaint = 0
    let lastOpacity = -1
    const pts: Pt[] = []

    const pickGait = (e: number) => {
      const t = rnd()
      if (t < 0.4) {
        gait = "cruise"
        gaitUntil = e + 1400 + rnd() * 2200
      } else if (t < 0.7) {
        gait = "rest"
        gaitUntil = e + 900 + rnd() * 1300
      } else {
        gait = "burst"
        gaitUntil = e + 700 + rnd() * 900
      }
    }

    const frame = (e: number) => {
      const target = targetRef.current
      const settled = energy === target && target === 0
      // At rest the motion is glacial: repaint at a low rate.
      if (settled && lastPaint && e - lastPaint < REST_FRAME_MS) return
      let dt = last === 0 ? 16 : e - last
      if (dt > 100) dt = 100
      last = e
      lastPaint = e

      energy += (target - energy) * (1 - Math.exp(-dt / (target > energy ? 260 : 520)))
      if (Math.abs(target - energy) < 0.002) energy = target
      const Ee = energy * energy * (3 - 2 * energy)
      const cx = W / 2
      const cy = H / 2

      if (e >= gaitUntil) pickGait(e)
      const gm = gait === "rest" ? 0.04 : gait === "burst" ? 3.2 : 1
      gaitMul += (gm - gaitMul) * (1 - Math.exp(-dt / (gait === "rest" ? 260 : 180)))
      const gt = gait === "burst" ? 1 : gait === "rest" ? -1 : 0
      gaitTrail += (gt - gaitTrail) * (1 - Math.exp(-dt / 220))
      restAmt += ((gait === "rest" ? 1 : 0) - restAmt) * (1 - Math.exp(-dt / 380))

      const workV = (0.0028 + 0.0012 * M(e)) * SPEED * gaitMul
      const restV = 0.000125 // ~ one turn per 50 s
      angV += (restV + (workV - restV) * Ee - angV) * (1 - Math.exp(-dt / 300))
      ang += angV * dt
      const workOrbit = (ORBIT + (PAUSE_ORBIT - ORBIT) * restAmt) * (1 + 0.04 * F(e))
      const orbit = IDLE_ORBIT + (workOrbit - IDLE_ORBIT) * Ee
      const px = cx + Math.cos(ang) * orbit
      const py = cy + Math.sin(ang) * orbit

      let bw = 0.5 + 0.5 * Math.sin(e * 0.0015 + bph) * (0.7 + 0.3 * F(e))
      bw = bw * bw * (3 - 2 * bw)
      bw = bw * bw * (3 - 2 * bw)
      const idleBlur = IDLE_BLUR * (0.5 + 0.5 * Math.sin(e * 0.0003 + iph)) // ~21 s
      const blur = idleBlur + (BLUR_MAX * bw - idleBlur) * Ee

      const tw = 0.5 + 0.5 * Math.sin(e * 0.00085 + tph) * (0.75 + 0.25 * M(e))
      let want = (0.15 + (1.8 - 0.15) * tw) * 1000
      want = gaitTrail > 0 ? want + (2600 - want) * gaitTrail : want * (1 + gaitTrail * 0.9)
      want *= Ee
      trail = want >= trail ? want : trail + (want - trail) * (1 - Math.exp(-dt / 600))
      // The trail never outlasts the energy: it reels in as the point settles.
      trail = Math.min(trail, 2600 * Ee)

      if (!started) {
        lx = px
        ly = py
        started = true
        pts.push({ x: lx, y: ly, t: e, p: phase })
      } else {
        const d2 = Math.hypot(px - lx, py - ly)
        const n = Math.max(1, Math.min(80, Math.ceil(d2 / 8)))
        const dc = d2 / 120
        for (let i = 1; i <= n; i++) {
          const f = i / n
          pts.push({
            x: lx + (px - lx) * f,
            y: ly + (py - ly) * f,
            t: e - dt * (1 - f),
            p: phase + dc * f,
          })
        }
        phase += dc
        lx = px
        ly = py
      }
      while (pts.length > 1 && pts[0].t < e - trail) pts.shift()

      // Opacity on the canvas, not per stroke: overlaps never add up.
      const op = 0.6 + 0.4 * Ee
      if (Math.abs(op - lastOpacity) > 0.005) {
        cv.style.opacity = op.toFixed(3)
        lastOpacity = op
      }

      ctx.clearRect(0, 0, W, H)
      const dot = IDLE_DOT + (DOT * (1 - (1 - PAUSE_SIZE) * restAmt) - IDLE_DOT) * Ee
      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      ctx.lineWidth = dot
      ctx.filter = blur > 0.05 ? `blur(${(blur * 0.6).toFixed(2)}px)` : "none"
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        if (a.x === b.x && a.y === b.y) continue
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
        g.addColorStop(0, mix(REST_RGB, palAt(a.p), Ee))
        g.addColorStop(1, mix(REST_RGB, palAt(b.p), Ee))
        ctx.strokeStyle = g
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      ctx.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none"
      ctx.fillStyle = mix(REST_RGB, palAt(phase), Ee)
      ctx.beginPath()
      ctx.arc(lx, ly, dot / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.filter = "none"
    }

    if (still) {
      // One still frame, in whichever state it is (re-run on state change).
      energy = targetRef.current
      frame(performance.now())
      return
    }
    const inst: Instance = { frame }
    instances.add(inst)
    ensureLoop()
    return () => {
      instances.delete(inst)
    }
  }, [size, size <= 20 ? working : 0])

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{
        position: "absolute",
        left: -size * BLEED,
        top: -size * BLEED,
        width: size * (1 + 2 * BLEED),
        height: size * (1 + 2 * BLEED),
        zIndex: -1,
        pointerEvents: "none",
      }}
    />
  )
}
