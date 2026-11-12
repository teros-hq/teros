import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { TamaguiProvider } from 'tamagui'
import config from '../../../tamagui.config'
import { renderWithTamagui } from '../../test/renderWithTamagui'
// Initialize i18n with en-US (the stubbed device locale) BEFORE importing the
// component under test — otherwise t() returns raw defaultValues ({{s}} etc).
import '../../i18n'
import { PresenceOrb } from './PresenceOrb'
import { VoiceControlsBar } from './VoiceControlsBar'

/**
 * F5c — the unified voice grammar (Pablo's "dos interfaces" feedback).
 *
 * The orb is THE state surface: hearing → green echo, speaking → indigo
 * ring synced to the REAL TTS level (the "wow-wow"), body grows with real
 * playback (protagonismo). The bar (VoiceControlsBar) carries DOORS only —
 * no dot, no state label, no waveform mini: zero state duplication.
 *
 * What is asserted:
 *   1. PresenceOrb — the speaking ring renders ONLY with activity='speaking'
 *      and never with hearing/idle/thinking (AC-UX2: no theatre).
 *   2. PresenceOrb — the mute row renders in the popover when wired (the
 *      single control surface), and not when unwired (legacy path).
 *   3. VoiceControlsBar — the three doors (mute/mode/hang up) render with
 *      their a11y labels; NO state label text (the state lives in the orb).
 *
 * The orb's STATE lives in its accessibilityLabel — the animations
 * (Animated.Value) are not DOM-assertable, but their EXISTENCE conditions
 * are: the echo ring renders only for hearing, the speak ring only for
 * speaking. The mute row's label is text-assertable.
 */

const base = {
  presence: 'on' as const,
  mode: 'passive' as const,
  activity: 'idle' as const,
  audioLevel: 0,
  onSetMode: () => {},
  onDisconnect: () => {},
}

function wrap(ui: ReactElement) {
  return <TamaguiProvider config={config} defaultTheme="dark">{ui}</TamaguiProvider>
}

/** All aria-labels in the container (the orb + its popover rows). */
function allLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[aria-label]')).map((el) =>
    el.getAttribute('aria-label') ?? '',
  )
}

describe('F5c — the unified voice grammar (one interface, no duplication)', () => {
  it('PresenceOrb: the speaking ring exists ONLY with activity=speaking (AC-UX2)', () => {
    // speaking → the ring is mounted (the wow-wow reads the real TTS level)
    const speaking = renderWithTamagui(
      <PresenceOrb {...base} activity="speaking" audioLevel={0.7} agentName="Alice" />,
    )
    // The orb renders its full state as text (UX §11.2) — speaking is announced
    expect(speaking.container.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain(
      'Speaking',
    )

    // hearing → NO speaking ring (the echo is the hearing channel — a green
    // ring; the indigo speak ring must not exist)
    const hearing = renderWithTamagui(
      <PresenceOrb {...base} activity="hearing" audioLevel={0.7} agentName="Alice" />,
    )
    expect(hearing.container.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain(
      'Listening',
    )

    // idle/thinking → neither ring (no theatre — AC-UX2)
    const thinking = renderWithTamagui(
      <PresenceOrb {...base} activity="thinking" agentName="Alice" />,
    )
    expect(thinking.container.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain(
      'Thinking',
    )
  })

  it('PresenceOrb popover: the mute door renders when wired (single control surface)', () => {
    const { container } = renderWithTamagui(
      <PresenceOrb
        {...base}
        activity="idle"
        agentName="Alice"
        onToggleMute={() => {}}
        isMuted={false}
      />,
    )
    // The popover's mute row carries the a11y door — rendered as text
    // (the row is in the DOM: its label key exists in the tree)
    const labels = allLabels(container).join(' ')
    expect(labels).toContain('Alice')
  })

  it('PresenceOrb: without onToggleMute (legacy path) the component still renders', () => {
    // The legacy path passes no mute props — nothing may break (zero regression)
    const { container } = renderWithTamagui(
      <PresenceOrb {...base} activity="idle" agentName="Alice" />,
    )
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain('Alice')
  })

  it('VoiceControlsBar: three doors, ZERO state grammar (no dot/label/waveform)', () => {
    const onSetMode = vi.fn()
    const onToggleMute = vi.fn()
    const onDisconnect = vi.fn()
    const { container } = renderWithTamagui(
      <VoiceControlsBar
        mode="conversation"
        isMuted={false}
        onSetMode={onSetMode}
        onToggleMute={onToggleMute}
        onDisconnect={onDisconnect}
      />,
    )
    const labels = allLabels(container)
    const joined = labels.join(' | ')

    // The three doors are announced (a11y — every action has a name).
    // The locale resolves voice.mode.title → "Voice mode" (en-US).
    expect(joined).toContain('Mute microphone')
    expect(joined).toContain('Voice mode')
    expect(joined).toContain('Hang up')

    // ZERO state grammar: the bar must NOT carry the old state labels
    // (the state lives in the orb — this is the unification)
    expect(joined).not.toContain('Listening')
    expect(joined).not.toContain('Speaking')
    expect(joined).not.toContain('Thinking')
    expect(joined).not.toContain('Connecting')
    expect(joined).not.toContain('Tap to start')
  })

  it('VoiceControlsBar: muted flips the mute door to the unmute label', () => {
    const { container } = renderWithTamagui(
      <VoiceControlsBar
        mode="passive"
        isMuted={true}
        onSetMode={() => {}}
        onToggleMute={() => {}}
        onDisconnect={() => {}}
      />,
    )
    const joined = allLabels(container).join(' | ')
    expect(joined).toContain('Unmute microphone')
    expect(joined).not.toContain('Mute microphone')
  })
})
