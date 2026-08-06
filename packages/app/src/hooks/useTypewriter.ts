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
  // Do NOT snap when `active` flips to false mid-message — the buffer must keep draining or short answers never get to typewriter at all.
  const snapImmediately = prefersReducedMotion
  const isInitiallyInactive = !active

  const [displayed, setDisplayed] = useState(
    snapImmediately || isInitiallyInactive ? targetText : "",
  )
  const displayedRef = useRef(displayed)
  displayedRef.current = displayed
  const everActive = useRef(active)
  if (active) everActive.current = true

  useEffect(() => {
    if (snapImmediately) {
      setDisplayed(targetText)
      return
    }
    // Never animated for this message (rendered post-turn) — snap.
    if (!everActive.current) {
      setDisplayed(targetText)
      return
    }
    // Backend rewrote or truncated — snap to avoid animating over stale text.
    // Truncation (shorter target) and same-length rewrites are both non-prefix cases.
    const isPrefixOfTarget = targetText.startsWith(displayedRef.current)
    if (!isPrefixOfTarget) {
      setDisplayed(targetText)
      return
    }
    // Already caught up — nothing to schedule.
    if (targetText.length === displayedRef.current.length) return

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
  }, [targetText, snapImmediately, tickMs, minChars, catchUpTicks])

  return displayed
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
