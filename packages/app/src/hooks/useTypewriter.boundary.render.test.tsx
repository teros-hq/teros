/**
 * useTypewriterBoundary — regression tests for the reveal-tail boundary.
 *
 * Bug 1 (shipped Fase 2): the prev-length ref was mutated DURING render,
 * so the effect never saw growth — the boundary stayed null forever and
 * Pablo saw no effect in the live app.
 *
 * Bug 2 (found in the same review): the boundary jumped to the newest
 * tick's start on EVERY tick (every ~25ms), unmounting each span ~4% into
 * its 600ms entry — the chars would never visibly settle. The DS pattern
 * folds a chunk only when its animation has FINISHED (at + duration +
 * 40ms grace). The hook now tracks live chunks and the boundary is the
 * oldest live chunk's start.
 *
 * These tests pin the hook directly (the coverage gap that let both ship).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import React from 'react'
import { useTypewriterBoundary, TYPEIN } from './useTypewriter'

function Probe({ text, active }: { text: string; active: boolean }) {
  const boundary = useTypewriterBoundary(text, active)
  return <div data-testid="boundary">{boundary === null ? 'null' : String(boundary)}</div>
}

function read(container: HTMLElement): string {
  return container.querySelector('[data-testid="boundary"]')?.textContent ?? 'missing'
}

describe('useTypewriterBoundary', () => {
  it('returns null while inactive', () => {
    const { container } = render(<Probe text="hola" active={false} />)
    expect(read(container)).toBe('null')
  })

  it('first active render: everything revealed so far is the tail (boundary 0)', () => {
    const { container } = render(<Probe text="hola" active />)
    expect(read(container)).toBe('0')
  })

  it('GROWTH keeps the oldest live chunk as the boundary — not the newest tick', () => {
    // Bug 1 regression: growth must be detected (ref not mutated in render).
    // Bug 2 semantics: two ticks within the animation window → the boundary
    // stays at the FIRST chunk's start; the tail accumulates.
    const { container, rerender } = render(<Probe text="hola" active />)
    expect(read(container)).toBe('0')
    rerender(<Probe text="hola mundo" active />)
    // 'hola' (chunk 1, from 0) is still animating → boundary stays 0.
    expect(read(container)).toBe('0')
    rerender(<Probe text="hola mundo cruel" active />)
    expect(read(container)).toBe('0')
  })

  it('chunks expire: a chunk older than duration+grace folds into the prefix', async () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<Probe text="hola" active />)
    expect(read(container)).toBe('0')
    // Advance past durationMs + tailGraceMs with growth in between.
    vi.advanceTimersByTime(TYPEIN.durationMs + TYPEIN.tailGraceMs + 10)
    rerender(<Probe text="hola mundo" active />)
    // Chunk 1 ('hola', from 0) has expired → boundary = chunk 2's start (4).
    expect(read(container)).toBe('4')
    vi.useRealTimers()
  })

  it('CAP: when the LLM outruns the reveal, the tail clamps to tailCap', () => {
    const long = 'x'.repeat(TYPEIN.tailCap + 40)
    const { container, rerender } = render(<Probe text="seed" active />)
    rerender(<Probe text={long} active />)
    expect(read(container)).toBe(String(long.length - TYPEIN.tailCap))
  })

  it('stream end (active=false) DRAINS the tail gradually, then folds', () => {
    // Pablo's report: snapping the boundary to null at stream end folded
    // the whole in-flight tail (~40-90 chars) sharp in one jump — "the
    // last chunk loads all at once". Now the boundary keeps advancing
    // chunk-by-chunk (each folds when its 600ms animation finishes) and
    // only goes null once the last char settled. Reduced motion still
    // snaps (no animation to wait for).
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(<Probe text="hola mundo" active />)
      // Mid-stream: a boundary exists (the reveal is in flight).
      expect(read(container)).not.toBe('null')
      rerender(<Probe text="hola mundo" active={false} />)
      // Just ended: the tail is STILL draining — boundary not yet null.
      expect(read(container)).not.toBe('null')
      // After the last chunk's animation (600ms + grace) the drain
      // finishes and the boundary folds to null (plain render).
      act(() => { vi.advanceTimersByTime(TYPEIN.durationMs + TYPEIN.tailGraceMs + 100) })
      expect(read(container)).toBe('null')
    } finally {
      vi.useRealTimers()
    }
  })
})
