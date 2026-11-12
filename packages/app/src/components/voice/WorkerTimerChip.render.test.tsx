import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { formatElapsedSeconds, WorkerTimerChip } from './WorkerTimerChip'

describe('WorkerTimerChip (§3.8 — la espera legible)', () => {
  it('renders the worker name and the live elapsed seconds', () => {
    const startedAt = Date.now() - 12_000
    const { container } = renderWithTamagui(
      <WorkerTimerChip workerName="Jordan" startedAt={startedAt} />,
    )
    expect(container.textContent).toContain('Jordan')
    // The spec's first beat: "Jordan · 12 s" (±1s of tick tolerance)
    expect(container.textContent).toMatch(/1[123] s/)
    expect(container.textContent).not.toBeNull()
  })

  it('renders name-only when startedAt is null — no fake timer (AC-UX2)', () => {
    const { container } = renderWithTamagui(
      <WorkerTimerChip workerName="Jordan" startedAt={null} />,
    )
    expect(container.textContent).toContain('Jordan')
    // No timer without an origin — a timer without a start is theater
    expect(container.textContent).not.toMatch(/\d+ s/)
    expect(container.textContent).not.toMatch(/\d:\d\d/)
  })

  it('renders +N when there are parallel workers', () => {
    const { container } = renderWithTamagui(
      <WorkerTimerChip workerName="Jordan" startedAt={Date.now() - 5_000} parallelCount={2} />,
    )
    expect(container.textContent).toContain('+2')
  })

  it('formatElapsedSeconds: "12 s" under a minute, "1:05" above it', () => {
    expect(formatElapsedSeconds(0)).toBe('0 s')
    expect(formatElapsedSeconds(12)).toBe('12 s')
    expect(formatElapsedSeconds(59)).toBe('59 s')
    expect(formatElapsedSeconds(65)).toBe('1:05')
    expect(formatElapsedSeconds(125)).toBe('2:05')
    // Negative inputs clamp to zero — the chip never shows a negative wait
    expect(formatElapsedSeconds(-3)).toBe('0 s')
  })
})
