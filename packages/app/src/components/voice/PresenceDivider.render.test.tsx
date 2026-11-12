import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { formatSessionDuration, PresenceDivider } from './PresenceDivider'

// The test env has no device locale → i18n falls back to en-US deterministically
// (src/i18n/index.ts: fallbackLng "en-US"), so the rendered labels are the
// en-US translations of voice.divider.*.

describe('PresenceDivider (§3.5 — el recibo de presencia)', () => {
  it('renders the opening receipt: "{name} connected · {time}" (UC-11)', () => {
    const startedAt = new Date('2026-10-02T13:25:00')
    const { container } = renderWithTamagui(
      <PresenceDivider agentName="Alice" mode="conversation" startedAt={startedAt} />,
    )
    expect(container.textContent).toContain('Alice connected')
    // en-US renders 12-hour clock: 13:25 → "1:25 PM"
    expect(container.textContent).toContain('1:25')
    // The mode rides the opening divider (UC-11)
    // Product name of the mode (PoC 2026-10-31: conversation → "Talking" / "Conversando")
    expect(container.textContent).toMatch(/talking|conversando/i)
  })

  it('renders the closing receipt with the real duration (UX §5.5)', () => {
    // 9:12 → 14:03 = 4h 51m — the spec's exact example
    const startedAt = new Date('2026-10-02T09:12:00')
    const endedAt = new Date('2026-10-02T14:03:00')
    const { container } = renderWithTamagui(
      <PresenceDivider agentName="Alice" startedAt={startedAt} endedAt={endedAt} />,
    )
    expect(container.textContent).toContain('Alice connected')
    expect(container.textContent).toContain('4h 51m')
  })

  it('says "interrupted" when the session died of error', () => {
    const startedAt = new Date('2026-10-02T09:12:00')
    const endedAt = new Date('2026-10-02T09:14:00')
    const { container } = renderWithTamagui(
      <PresenceDivider agentName="Alice" startedAt={startedAt} endedAt={endedAt} interrupted />,
    )
    expect(container.textContent).toContain('interrupted')
    // No duration when interrupted — the receipt says how it ended, not how long
    expect(container.textContent).not.toContain('2 m')
  })

  it('formatSessionDuration: "45 s" / "12 m" / "4h 51m" — reads like a person', () => {
    expect(formatSessionDuration(45)).toBe('45 s')
    expect(formatSessionDuration(720)).toBe('12 m')
    expect(formatSessionDuration(3600)).toBe('1h 0m')
    expect(formatSessionDuration(17460)).toBe('4h 51m')
    expect(formatSessionDuration(0)).toBe('0 s')
    expect(formatSessionDuration(-5)).toBe('0 s')
  })
})
