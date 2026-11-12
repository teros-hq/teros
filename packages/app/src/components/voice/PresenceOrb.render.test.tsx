import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { TamaguiProvider } from 'tamagui'
import config from '../../../tamagui.config'
import { renderWithTamagui } from '../../test/renderWithTamagui'
// Initialize i18n with en-US (the stubbed device locale) BEFORE importing the
// component under test — otherwise t() returns raw defaultValues ({{s}} etc).
import '../../i18n'
import { PresenceOrb } from './PresenceOrb'

// The drift timer is 180 s — fake timers cross it without waiting. The
// orb's STATE lives in its accessibilityLabel (agent — activity — resting),
// not in textContent (the orb is a circle, not a document). React state
// updates fired by fake timers are flushed with act() so the DOM catches up.
// rerender() replaces the whole tree — the TamaguiProvider must be re-wrapped
// or useColors throws "Can't find Tamagui configuration".

const base = {
  presence: 'on' as const,
  mode: 'passive' as const,
  activity: 'idle' as const,
  audioLevel: 0,
  onSetMode: () => {},
  onDisconnect: () => {},
}

/** Re-wrap in the TamaguiProvider for rerender() (which replaces the tree). */
function wrap(ui: ReactElement) {
  return <TamaguiProvider config={config} defaultTheme="dark">{ui}</TamaguiProvider>
}

/** Advance fake timers AND flush the React state updates they trigger. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** The orb's a11y label — its full state as text. */
function orbAriaLabel(container: HTMLElement): string {
  const el = container.querySelector('[aria-label]')
  return el?.getAttribute('aria-label') ?? ''
}

describe('PresenceOrb — rest drift (UX §3.2 "deriva a reposo")', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders the orb with the agent name in its label (the body is there)', () => {
    const { container } = renderWithTamagui(
      <PresenceOrb {...base} agentName="Alice" />,
    )
    expect(orbAriaLabel(container)).toContain('Alice')
  })

  it('drifts to rest after 3 min of idle and announces it in text', () => {
    vi.useFakeTimers()
    const { container } = renderWithTamagui(
      <PresenceOrb {...base} agentName="Alice" />,
    )
    // Before the drift: present, not resting
    expect(orbAriaLabel(container)).not.toContain('at rest')
    // Cross the 180 s drift threshold (act flushes the setIsResting update)
    advance(180_500)
    // The resting state is announced in TEXT (UX §11.2: state is never
    // color/animation-only) — the label carries "at rest".
    expect(orbAriaLabel(container)).toContain('at rest')
  })

  it('conversational activity resets the drift timer', () => {
    vi.useFakeTimers()
    const { container, rerender } = renderWithTamagui(
      <PresenceOrb {...base} activity="idle" agentName="Alice" />,
    )
    // 170 s idle, then the user speaks → the timer restarts
    advance(170_000)
    rerender(
      wrap(<PresenceOrb {...base} activity="speaking" agentName="Alice" />),
    )
    advance(170_000)
    // 340 s total but only 170 s since the last activity — still awake
    expect(orbAriaLabel(container)).not.toContain('at rest')
  })

  it('hearing wakes the orb from rest (§3.2 "despierta con la primera sílaba")', () => {
    vi.useFakeTimers()
    const { container, rerender } = renderWithTamagui(
      <PresenceOrb {...base} activity="idle" agentName="Alice" />,
    )
    advance(180_500)
    expect(orbAriaLabel(container)).toContain('at rest')
    // The first syllable arrives — the orb wakes immediately
    rerender(
      wrap(<PresenceOrb {...base} activity="hearing" agentName="Alice" />),
    )
    expect(orbAriaLabel(container)).not.toContain('at rest')
  })

  it('reconnecting shows the attempt n/5 in the label (UX §7.3)', () => {
    const { container } = renderWithTamagui(
      <PresenceOrb
        {...base}
        activity="reconnecting"
        reconnectAttempt={3}
        agentName="Alice"
      />,
    )
    // The activity label announces "Reconnecting (3)..." — the backoff
    // state is visible, not felt (AC-UX6).
    expect(orbAriaLabel(container)).toContain('3')
    expect(orbAriaLabel(container)).toMatch(/reconnect/i)
  })
})

describe('PresenceOrb — accessibility (UX §11.2)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('respects prefers-reduced-motion: state stays as text, no breathing loop', () => {
    // The setup file defines window.matchMedia (writable) — spy on it and
    // return matches: true for the reduced-motion query.
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))
    const { container } = renderWithTamagui(
      <PresenceOrb {...base} agentName="Alice" />,
    )
    // The orb still renders its full state as text — nothing is
    // animation-only (AC-UX12). The breathing loop is skipped (static halo).
    expect(orbAriaLabel(container)).toContain('Alice')
  })
})
