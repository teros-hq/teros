import { useEffect, useRef, useState } from "react"

/**
 * Reveals `targetText` chunk-by-chunk on a rAF loop while `active`. Respects `prefers-reduced-motion`.
 */
export function useTypewriter(
  targetText: string,
  active: boolean,
  opts: { tickMs?: number; minCharsPerTick?: number; catchUpTicks?: number } = {},
): string {
  const tickMs = opts.tickMs ?? 25
  const minChars = opts.minCharsPerTick ?? 2
  const catchUpTicks = opts.catchUpTicks ?? 40

  const prefersReducedMotion = useReducedMotion()
  const snapImmediately = prefersReducedMotion

  // Track whether this message EVER streamed. A message that mounts
  // inactive and stays inactive (older bubble, or one that never becomes
  // the reveal target) must render its full text — never animate. A
  // message that IS streaming reveals progressively and, crucially, keeps
  // DRAINING when `active` flips false at stream end (the last chars
  // finish their blur→sharp instead of snapping — Pablo's "last 20-30
  // chars load all at once").
  const everStreamedRef = useRef(false)

  const [displayed, setDisplayed] = useState(snapImmediately || !active ? targetText : "")
  const displayedRef = useRef(displayed)
  displayedRef.current = displayed

  useEffect(() => {
    if (snapImmediately) {
      setDisplayed(targetText)
      return
    }

    if (active) everStreamedRef.current = true

    // Never streamed (mounted inactive and still inactive) → show full
    // text. This is the safe default for older bubbles / non-target rows:
    // render complete, no animation.
    if (!active && !everStreamedRef.current) {
      if (displayedRef.current !== targetText) setDisplayed(targetText)
      return
    }

    // Backend rewrote or truncated — snap to avoid animating over stale text.
    // Truncation (shorter target) and same-length rewrites are both non-prefix cases.
    const isPrefixOfTarget = targetText.startsWith(displayedRef.current)
    if (!isPrefixOfTarget) {
      setDisplayed(targetText)
      return
    }
    // Already caught up — nothing to schedule. (When inactive AND caught
    // up, the drain is done — the boundary folds the last spans away.)
    if (targetText.length === displayedRef.current.length) return

    // From here: there is text left to reveal. Keep revealing EVEN IF
    // `active` just flipped false — that is the stream-end drain: the
    // buffer must finish typing out or the last chars snap sharp in one
    // jump. We only stop scheduling once fully caught up.
    let rafId: number | null = null
    let lastTick = 0

    const step = (now: number) => {
      if (now - lastTick >= tickMs) {
        lastTick = now
        const current = displayedRef.current
        const remaining = targetText.length - current.length
        if (remaining <= 0) return
        const chunk = Math.max(minChars, Math.ceil(remaining / catchUpTicks))
        const nextLen = Math.min(current.length + chunk, targetText.length)
        setDisplayed(targetText.slice(0, nextLen))
        if (nextLen >= targetText.length) return
      }
      rafId = requestAnimationFrame(step)
    }
    rafId = requestAnimationFrame(step)

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [targetText, active, snapImmediately, tickMs, minChars, catchUpTicks])

  return displayed
}

/**
 * Type-in (TerosTypeIn, DS Motion) — the reveal boundary of the typewriter.
 *
 * `useTypewriter` returns only the visible string; the type-in effect needs
 * to know WHERE the latest reveal tick started, so the chars revealed by the
 * current tick can enter blurred while everything before them is already
 * settled plain text. This hook exposes that boundary WITHOUT touching the
 * reveal rhythm: it observes the same `displayed` string and keeps the start
 * index of the most recent growth step.
 *
 * The boundary is capped (tailCap): when the stream outruns the reveal, the
 * boundary keeps advancing so the in-flight tail never exceeds tailCap chars
 * — older chunks fold into the settled prefix even if their animation hasn't
 * finished (contract open decision #6: without the cap the DOM explodes
 * exactly when the LLM runs fastest, which is the case this effect exists
 * for). The fold is visual only — the reveal rhythm is untouched.
 *
 * Returns null when there is no tail (reduced motion, stream ended, or the
 * boundary caught up with the full text) — callers render plain.
 */
export const TYPEIN = {
  // The feel values, fixed by Pablo's review (2026-10-06) after the
  // live-slider round — same numbers as the DS pattern (sections/Motion.jsx
  // TYPEIN): duration 600ms, blur 8px, stagger deleted (every char of a
  // chunk enters together — no per-char delay). Single-sourced here so
  // promoting one to a DS.motion token is a one-line change.
  durationCss: "0.6s",
  durationMs: 600, // the same number twice: CSS wants a string, the fold wants ms
  blurCss: "8px",
  // Max chars carrying spans at any instant. The boundary advances to keep
  // the tail within this even when the LLM outruns the reveal.
  tailCap: 96,
  // Grace after durationMs before a chunk folds (late rAF landing — the
  // Fase-1 pattern folds at at + duration + 40ms).
  tailGraceMs: 40,
}

// ─── Syntax-safe fold (Pablo's buffer, 2026-10-06) ─────────────────────
// The fold boundary must NEVER cross an OPEN inline construction: the
// settled span renders its raw slice through marked, and an unclosed
// '**foo' stays LITERAL — the user sees asterisks pop in and then vanish
// when the closer arrives (the exact artifact Pablo reported on the PoC).
// The buffer IS the construction: the boundary waits BEFORE the oldest
// open opener (its chars stay in the tail, hidden with U+FEFF by
// insertTailMarker) and folds it already-resolved when the closer arrives
// — bold pops directly, no literal phase. tailCap remains the escape
// hatch for constructions that never close (DOM budget, decision #6).

// Delimiter RUNS, not single chars: '**' is ONE strong opener for marked —
// counting chars made '**' push+pop = "closed" and let the boundary cross
// it (the t=1100 flash). A run only closes against a run of the SAME
// length ('***a***' closes; '**a*' stays open, as marked renders it).
type DelimRun = { at: number; len: number }

export type SyntaxScanState = {
  star: DelimRun[]
  under: DelimRun[]
  tick: DelimRun[]
  tilde: DelimRun[]
  link: number[] // unmatched '[' without a following '](...)'
  scanned: number // chars consumed — an incomplete trailing run is deferred
}

export function createSyntaxScan(): SyntaxScanState {
  return { star: [], under: [], tick: [], tilde: [], link: [], scanned: 0 }
}

function pairRun(list: DelimRun[], at: number, len: number): void {
  const top = list[list.length - 1]
  if (top && top.len === len) list.pop()
  else list.push({ at, len })
}

export function syntaxScanPush(st: SyntaxScanState, text: string, from: number): void {
  // Scan [from, len) incrementally. A delimiter run touching the end of
  // the current text is DEFERRED (it may still grow: '*' → '**' next
  // tick) — the next tick rescans it complete.
  const end = text.length
  let i = Math.max(from, st.scanned)
  while (i < end) {
    const ch = text[i]
    if (ch === "*" || ch === "_" || ch === "`" || ch === "~") {
      let r = 1
      while (i + r < end && text[i + r] === ch) r++
      if (i + r >= end) break // run incomplete — defer to next tick
      if (ch === "_") {
        const prev = i > 0 ? text[i - 1] : ""
        const next = text[i + r]
        if (/\w/.test(prev) && /\w/.test(next)) {
          i += r // snake_case — not a delimiter run in GFM
          continue
        }
      }
      if (ch === "~") {
        if (r >= 2) pairRun(st.tilde, i, r)
        // single '~' is literal
      } else {
        pairRun(ch === "*" ? st.star : ch === "_" ? st.under : st.tick, i, r)
      }
      i += r
      continue
    }
    if (ch === "[") {
      // A link only counts as closed when '](...)' follows complete.
      if (!/\]\([^)]*\)/.test(text.slice(i))) st.link.push(i)
      i++
      continue
    }
    i++
  }
  st.scanned = i
}

/** Absolute index of the oldest open inline construction, or null. */
export function firstOpenSyntax(st: SyntaxScanState): number | null {
  let open: number | null = null
  for (const list of [st.star, st.under, st.tick, st.tilde]) {
    if (list.length > 0 && (open === null || list[0].at < open)) open = list[0].at
  }
  if (st.link.length > 0 && (open === null || st.link[0] < open)) open = st.link[0]
  return open
}

/**
 * One reveal tick's worth of text: [from, len) revealed at time `at`.
 * A chunk folds into the settled prefix when its entry animation has
 * finished (at + durationMs + tailGraceMs) — NOT when the next tick
 * arrives. Folding on every tick (boundary = newest tick's start) unmounts
 * each span ~25ms into a 600ms animation: the chars never visibly settle,
 * the effect collapses to plain text (the second Fase-2 bug).
 */
type TailChunk = { from: number; at: number }

export function useTypewriterBoundary(
  displayed: string,
  active: boolean,
  opts: { tailCap?: number; scanSyntax?: boolean } = {},
): number | null {
  const tailCap = opts.tailCap ?? TYPEIN.tailCap
  // Off when `displayed` is RENDERED text (reveal-over-rendered path):
  // there is no markdown left to hold the boundary on — a literal '*' in
  // prose must not pin the tail.
  const scanSyntax = opts.scanSyntax ?? true
  const prefersReducedMotion = useReducedMotion()

  const [boundary, setBoundary] = useState<number | null>(null)
  // A re-render nudge: when the stream ends, `displayed` stops changing
  // and the effect stops re-running — but the live chunks still need to
  // drain (each folds when its animation finishes). A timer bumps this
  // counter at the last chunk's expiry so the effect re-evaluates.
  const [drainTick, setDrainTick] = useState(0)
  const chunksRef = useRef<TailChunk[]>([])
  const scanRef = useRef<SyntaxScanState | null>(null)
  // The rendered boundary is MONOTONIC — it never moves backward (going
  // back would un-settle already-sharp chars = visible rewind). The
  // syntax clamp only acts on openers not yet crossed.
  const boundaryRef = useRef<number | null>(null)
  // ⚠️ prev length is tracked ONLY inside the effect. Mutating this ref
  // during render syncs it to the new length BEFORE the effect compares,
  // so growth is never detected and the boundary stays null forever —
  // the first Fase-2 bug (Pablo saw no effect in the live app).
  const lenRef = useRef<number | null>(null)

  useEffect(() => {
    // Rule 13 (DS): reduced motion gets the FINISHED state — no tail, no
    // spans, plain render.
    // ⚠️ Stream END does NOT snap to plain: boundary=null would fold the
    // whole in-flight tail (~40-90 chars) sharp in one jump — the visible
    // "the last chunk loads all at once" Pablo reported. Instead the
    // reveal keeps draining: the boundary advances chunk-by-chunk as each
    // animation finishes, and only goes null once the LAST char settled.
    // (Reduced motion still snaps — no animation to wait for.)
    if (prefersReducedMotion) {
      chunksRef.current = []
      lenRef.current = displayed.length
      scanRef.current = null
      boundaryRef.current = null
      setBoundary(null)
      return
    }
    const len = displayed.length
    const prevLen = lenRef.current
    const now = Date.now()
    // Stream ended: keep draining the live chunks (each folds when its
    // animation finishes) instead of snapping the whole tail plain. When
    // the last chunk's animation is done, the boundary catches up with
    // the full text and the caller renders plain — the fold is invisible
    // because every char already finished its animation.
    const horizon = now - TYPEIN.durationMs - TYPEIN.tailGraceMs
    if (!active) {
      // Stream ended. useTypewriter may STILL be draining (revealing the
      // last chars after `active` flipped false) — register that growth as
      // chunks too, or the final chars would appear sharp with no blur
      // (Pablo's "last 20-30 chars load all at once"). Then drain: each
      // chunk folds when its animation finishes.
      if (prevLen !== null && len > prevLen) {
        chunksRef.current.push({ from: prevLen, at: now })
      }
      const chunks = chunksRef.current.filter((c) => c.at > horizon)
      chunksRef.current = chunks
      const next = chunks.length > 0 ? chunks[0].from : null
      setBoundary(next !== null && next < len ? next : null)
      lenRef.current = len
      // Schedule the next drain step: re-run when the oldest live chunk's
      // animation expires, so the boundary advances without new text.
      if (chunks.length > 0) {
        const ms = chunks[0].at + TYPEIN.durationMs + TYPEIN.tailGraceMs - now
        const t = setTimeout(() => setDrainTick((n) => n + 1), Math.max(0, ms) + 16)
        return () => clearTimeout(t)
      }
      return
    }

    if (prevLen === null) {
      // First run while active (mount mid-stream): everything revealed so
      // far enters as one chunk, clamped to the cap floor.
      chunksRef.current = len > 0 ? [{ from: Math.max(0, len - tailCap), at: now }] : []
    } else if (len > prevLen) {
      // Growth: the new reveal tick is a chunk starting at prevLen.
      chunksRef.current.push({ from: prevLen, at: now })
    } else if (len < prevLen) {
      // Shrink (backend rewrite/truncate — useTypewriter snapped): reset.
      chunksRef.current = []
    }
    // Prune finished chunks, then enforce the cap: if the tail still
    // exceeds tailCap, fold the oldest chunks even mid-animation (the DOM
    // budget rule — contract decision #6). A single huge tick (LLM dump)
    // clamps the boundary forward to len - tailCap instead of dropping
    // the whole tail.
    // Incremental syntax scan — tracks open inline constructions so the
    // fold boundary never crosses one (see Syntax-safe fold above).
    if (scanRef.current === null || prevLen === null || len < prevLen) {
      scanRef.current = createSyntaxScan()
      syntaxScanPush(scanRef.current, displayed, 0)
    } else if (len > prevLen) {
      syntaxScanPush(scanRef.current, displayed, prevLen)
    }
    const open = scanSyntax ? firstOpenSyntax(scanRef.current) : null

    const chunks = chunksRef.current.filter((c) => c.at > horizon)
    chunksRef.current = chunks

    // The boundary is the start of the oldest live chunk, clamped forward
    // by the cap: everything before it is settled (plain), from it to the
    // end is in flight.
    let next: number | null = null
    if (chunks.length > 0) {
      next = Math.max(chunks[0].from, len - tailCap)
    } else if (open !== null && open < len) {
      // No live chunks, but a construction is open: keep the retained tail
      // alive so the open syntax never lands literal in the settled span.
      next = open
    }
    if (next !== null) {
      // Pablo's buffer, as a PREVENTIVE clamp: the boundary never advances
      // past an open opener — its chars stay in the tail (hidden) until
      // the closer arrives, then fold already-resolved. An opener ALREADY
      // crossed (the one-tick deferral window: it arrived as the last
      // char of a tick and the scanner deferred it) is LEFT — pulling the
      // boundary back would rewind already-settled text, and the residual
      // is a single literal char for ~25ms (one tick), not a stuck tail.
      if (open !== null && open < next) {
        if (boundaryRef.current !== null && open < boundaryRef.current) {
          // Already crossed — never retreat.
        } else {
          next = open
        }
      }
      // The cap wins over the retention (DOM budget, contract decision #6):
      // a construction that outgrows tailCap folds literal — accepted.
      if (len - next > tailCap) next = len - tailCap
      if (next >= len) next = null
    }
    setBoundary(next)
    lenRef.current = len
    boundaryRef.current = next
  }, [displayed, active, prefersReducedMotion, tailCap, drainTick, scanSyntax])

  if (boundary === null || boundary >= displayed.length) return null
  return boundary
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener?.("change", onChange)
    return () => mq.removeEventListener?.("change", onChange)
  }, [])
  return reduced
}

/**
 * The reveal COUNT over rendered text (reveal-over-rendered path): the same
 * rhythm as `useTypewriter` (rAF ticks, catch-up chunks, drain after the
 * stream ends) on a number instead of a string. It never snaps forward when
 * the rendered text changes shape under it (a table materialising, a held
 * construct resolving): the count only grows, clamped to `total`.
 */
export function useRevealCount(
  total: number,
  active: boolean,
  opts: { tickMs?: number; minCharsPerTick?: number; catchUpTicks?: number } = {},
): number {
  const tickMs = opts.tickMs ?? 25
  const minChars = opts.minCharsPerTick ?? 2
  const catchUpTicks = opts.catchUpTicks ?? 40
  const prefersReducedMotion = useReducedMotion()
  const everStreamedRef = useRef(false)
  const [count, setCount] = useState(prefersReducedMotion || !active ? total : 0)
  const countRef = useRef(count)
  countRef.current = count

  useEffect(() => {
    if (prefersReducedMotion) {
      setCount(total)
      return
    }
    if (active) everStreamedRef.current = true
    if (!active && !everStreamedRef.current) {
      if (countRef.current !== total) setCount(total)
      return
    }
    if (countRef.current > total) {
      setCount(total)
      return
    }
    if (countRef.current === total) return
    let rafId: number | null = null
    let lastTick = 0
    const step = (now: number) => {
      if (now - lastTick >= tickMs) {
        lastTick = now
        const current = countRef.current
        const remaining = total - current
        if (remaining <= 0) return
        const chunk = Math.max(minChars, Math.ceil(remaining / catchUpTicks))
        const next = Math.min(current + chunk, total)
        setCount(next)
        if (next >= total) return
      }
      rafId = requestAnimationFrame(step)
    }
    rafId = requestAnimationFrame(step)
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [total, active, prefersReducedMotion, tickMs, minChars, catchUpTicks])

  return Math.min(count, total)
}
