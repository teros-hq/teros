/**
 * QuotaStrip — "X of Y runs today" at the top of the Automate list.
 *   - unlimited (limit 0) or no data → nothing,
 *   - usage line with plan and reset, no CTA below 80%,
 *   - exhausted → red copy, busiest automation with a Review link, Upgrade CTA.
 *
 *   cd packages/app && npx vitest run src/windows/AutomateWindow/QuotaStrip.render.test.tsx
 */
import '../../i18n'
import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { QuotaStrip } from './QuotaStrip'
import type { AutomateQuota } from './types/automate'

const base: AutomateQuota = {
  limit: 5,
  used: 1,
  remaining: 4,
  exhausted: false,
  planId: 'plan_seed',
  planName: 'Seed',
  resetsAt: '2026-10-16T00:00:00.000Z',
  topStarters: [{ starterId: 's1', name: 'Cada minuto', workspaceId: 'w1', count: 1 }],
}

describe('QuotaStrip', () => {
  it('hides for unlimited plans and when there is no data', () => {
    expect(renderWithTamagui(<QuotaStrip quota={null} onUpgrade={() => {}} />).queryByTestId('automate-quota-strip')).toBeNull()
    expect(
      renderWithTamagui(<QuotaStrip quota={{ ...base, limit: 0, remaining: null }} onUpgrade={() => {}} />).queryByTestId('automate-quota-strip'),
    ).toBeNull()
  })

  it('shows usage, plan and reset; no upgrade CTA below 80%', () => {
    const r = renderWithTamagui(<QuotaStrip quota={base} onUpgrade={() => {}} />)
    expect(r.getByTestId('automate-quota-strip-usage').textContent).toContain('1 of 5 runs today · Seed plan')
    expect(r.queryByTestId('automate-quota-strip-upgrade')).toBeNull()
  })

  it('exhausted: says so, names the busiest automation with a Review link, offers the upgrade', () => {
    const onUpgrade = vi.fn()
    const onOpenStarter = vi.fn()
    const r = renderWithTamagui(
      <QuotaStrip
        quota={{ ...base, used: 5, remaining: 0, exhausted: true, topStarters: [{ starterId: 's1', name: 'Cada minuto', workspaceId: 'w1', count: 5 }] }}
        onUpgrade={onUpgrade}
        onOpenStarter={onOpenStarter}
      />,
    )
    expect(r.getByTestId('automate-quota-strip-usage').textContent).toContain("Today's 5 runs of your Seed plan are used up")
    expect(r.getByTestId('automate-quota-strip-busiest').textContent).toContain('“Cada minuto” ran 5 times today')
    fireEvent.click(r.getByTestId('automate-quota-strip-review'))
    expect(onOpenStarter).toHaveBeenCalledWith('s1')
    fireEvent.click(r.getByTestId('automate-quota-strip-upgrade'))
    expect(onUpgrade).toHaveBeenCalled()
  })
})
