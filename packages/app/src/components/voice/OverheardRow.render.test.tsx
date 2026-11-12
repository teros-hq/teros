import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { OverheardRow } from './OverheardRow'

describe('OverheardRow (§3.4 — la transparencia hecha fila)', () => {
  // The test env has no device locale → i18n falls back to en-US
  // deterministically, so the meta reads "Voice · overheard".
  it('renders the overheard phrase verbatim with the "Voice · overheard" meta', () => {
    const { container } = renderWithTamagui(
      <OverheardRow text="¿Le digo a Jordan que pare?" timestamp={new Date('2026-10-02T13:26:00')} />,
    )
    // The phrase, verbatim — nothing enters context in secret (UX §6.2)
    expect(container.textContent).toContain('¿Le digo a Jordan que pare?')
    // The meta marks it as heard-but-not-addressed (decisión de Pablo #5)
    expect(container.textContent).toContain('Voice · overheard')
    // en-US renders 12-hour clock: 13:26 → "1:26 PM"
    expect(container.textContent).toContain('1:26')
  })

  it('accepts epoch-ms timestamps too (the live transcripts path)', () => {
    const ts = new Date('2026-10-02T13:26:00').getTime()
    const { container } = renderWithTamagui(
      <OverheardRow text="una frase oída al pasar" timestamp={ts} />,
    )
    expect(container.textContent).toContain('una frase oída al pasar')
    expect(container.textContent).toContain('Voice · overheard')
  })
})
