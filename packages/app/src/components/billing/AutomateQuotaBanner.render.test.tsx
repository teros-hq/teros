/**
 * AutomateQuotaBanner — the global "today's Automate runs are spent" strip,
 * driven by billingStore.automateQuota (fed by automate.quota-exhausted).
 *   - nothing without a notice, nothing once dismissed,
 *   - names limit, plan and the busiest automation,
 *   - a fresh notice re-surfaces a dismissed banner,
 *   - CTAs open Automate / Profile → Plan.
 *
 *   cd packages/app && npx vitest run src/components/billing/AutomateQuotaBanner.render.test.tsx
 */
import '../../i18n'
import { act, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TamaguiProvider } from 'tamagui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../../../tamagui.config'

const openWindowSpy = vi.hoisted(() => vi.fn())
vi.mock('../../store/tilingStore', () => ({
  useTilingStore: (sel: (s: { openWindow: unknown }) => unknown) => sel({ openWindow: openWindowSpy }),
}))

import { useBillingStore } from '../../store/billingStore'
import { AutomateQuotaBanner } from './AutomateQuotaBanner'

const NOTICE = {
  used: 20,
  limit: 20,
  planId: 'plan_starter',
  planName: 'Starter',
  resetsAt: '2026-10-16T00:00:00.000Z',
  starterId: 's2',
  starterName: 'Digest',
  workspaceId: 'w1',
  topStarters: [{ starterId: 's1', name: 'Cada minuto', workspaceId: 'w1', count: 18 }],
}

function renderBanner() {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <AutomateQuotaBanner />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  openWindowSpy.mockReset()
  useBillingStore.setState({ automateQuota: null, automateQuotaDismissed: false })
})

describe('AutomateQuotaBanner', () => {
  it('renders nothing without a notice', () => {
    expect(renderBanner().queryByTestId('automate-quota-banner')).toBeNull()
  })

  it('names the limit, the plan and the busiest automation', () => {
    useBillingStore.getState().setAutomateQuota(NOTICE)
    const { getByTestId } = renderBanner()
    expect(getByTestId('automate-quota-banner').textContent).toContain("Today's 20 Automate runs of your Starter plan are used up")
    expect(getByTestId('automate-quota-banner-detail').textContent).toContain('“Cada minuto” ran 18 times today')
  })

  it('dismiss hides it; a fresh notice brings it back', async () => {
    const user = userEvent.setup()
    useBillingStore.getState().setAutomateQuota(NOTICE)
    const { getByTestId, queryByTestId } = renderBanner()
    await user.click(getByTestId('automate-quota-banner-dismiss'))
    expect(queryByTestId('automate-quota-banner')).toBeNull()
    act(() => useBillingStore.getState().setAutomateQuota({ ...NOTICE, used: 21 }))
    expect(queryByTestId('automate-quota-banner')).not.toBeNull()
  })

  it('CTAs open Automate and Profile → Plan', async () => {
    const user = userEvent.setup()
    useBillingStore.getState().setAutomateQuota(NOTICE)
    const { getByTestId } = renderBanner()
    await user.click(getByTestId('automate-quota-banner-open'))
    expect(openWindowSpy).toHaveBeenCalledWith('automate', {})
    await user.click(getByTestId('automate-quota-banner-upgrade'))
    expect(openWindowSpy).toHaveBeenCalledWith('profile', { initialMode: 'plan' })
  })
})
