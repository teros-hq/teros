/**
 * AutomateQuotaWidget — the chat block for "today's Automate runs are spent".
 * Assertions that bite:
 *   - names the skipped automation, the plan, the limit and the busiest one,
 *   - "Upgrade plan" opens Profile → Plan, "Open Automate" opens the Automate window,
 *   - no plan → generic body (no fabricated plan name).
 *
 *   cd packages/app && npx vitest run src/components/billing/AutomateQuotaWidget.render.test.tsx
 */
import '../../i18n'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TamaguiProvider } from 'tamagui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../../../tamagui.config'

const openWindowSpy = vi.hoisted(() => vi.fn())
vi.mock('../../store/tilingStore', () => ({
  useTilingStore: (sel: (s: { openWindow: unknown }) => unknown) => sel({ openWindow: openWindowSpy }),
}))

import { AutomateQuotaWidget } from './AutomateQuotaWidget'

function renderWidget(props: Parameters<typeof AutomateQuotaWidget>[0]) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <AutomateQuotaWidget {...props} />
    </TamaguiProvider>,
  )
}

beforeEach(() => openWindowSpy.mockReset())

describe('AutomateQuotaWidget', () => {
  it('frames the block around the automation, the plan, the limit and the busiest automation', () => {
    const { getByTestId } = renderWidget({
      used: 5,
      limit: 5,
      planName: 'Seed',
      resetsAt: '2026-10-16T00:00:00.000Z',
      starterName: 'Cada minuto',
      topStarters: [{ starterId: 's1', name: 'Cada minuto', count: 5 }],
    })
    expect(getByTestId('automate-quota-widget').textContent).toContain('“Cada minuto” was skipped')
    expect(getByTestId('automate-quota-body').textContent).toContain('Seed plan allows 5 Automate runs a day')
    expect(getByTestId('automate-quota-busiest').textContent).toContain('ran 5 times today')
  })

  it('CTAs: upgrade → Profile/Plan, open → Automate window', async () => {
    const user = userEvent.setup()
    const { getByTestId } = renderWidget({ limit: 5, planName: 'Seed', resetsAt: '2026-10-16T00:00:00.000Z', starterName: 'x' })
    await user.click(getByTestId('automate-quota-upgrade'))
    expect(openWindowSpy).toHaveBeenCalledWith('profile', { initialMode: 'plan' })
    await user.click(getByTestId('automate-quota-open'))
    expect(openWindowSpy).toHaveBeenCalledWith('automate', {})
  })

  it('without a plan it does not invent one', () => {
    const { getByTestId } = renderWidget({ resetsAt: '2026-10-16T00:00:00.000Z' })
    expect(getByTestId('automate-quota-body').textContent).toContain("Your plan's Automate runs for today are used up")
    expect(getByTestId('automate-quota-widget').textContent).toContain("Today's Automate runs are used up")
  })
})
