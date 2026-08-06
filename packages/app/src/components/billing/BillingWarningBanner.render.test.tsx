/**
 * BillingWarningBanner (FASE 6, decision #11; refreshed TER-596 I4) — the
 * non-invasive 80% notice. The assertions that bite the visibility guard:
 *   - no warning → renders nothing,
 *   - warning present → renders with the exact usage data + plan name,
 *   - dismissed → renders nothing (even with a warning),
 *   - the CTA opens the BoostModal (open flips true),
 *   - dismiss hides the banner.
 *
 * BoostModal is mocked (its Dialog portal + Stripe deps are covered by the live
 * smoke / the BoostPanel test); here we only assert the banner drives `open`.
 *
 *   cd packages/app && npx vitest run src/components/billing/BillingWarningBanner.render.test.tsx
 */
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TamaguiProvider } from 'tamagui'
import config from '../../../tamagui.config'

vi.mock('@tamagui/lucide-icons', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  const StubIcon = () => null
  return { ...real, X: StubIcon }
})

const modalState = vi.hoisted(() => ({ open: false }))
vi.mock('./BoostModal', () => ({
  BoostModal: ({ open }: { open: boolean }) => {
    modalState.open = open
    return null
  },
}))

import { useBillingStore } from '../../store/billingStore'
import { BillingWarningBanner } from './BillingWarningBanner'

const WARNING = {
  used: 16,
  limit: 20,
  boostHours: 0,
  threshold: 0.8,
  tier: 'pro',
  planName: 'Pro',
  periodEnd: '2026-07-01T00:00:00.000Z',
}

function renderBanner() {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <BillingWarningBanner />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  modalState.open = false
  useBillingStore.setState({
    warning: null,
    warningDismissed: false,
    pendingAdminRequests: 0,
    lastResolution: null,
  })
})

describe('BillingWarningBanner', () => {
  it('renders nothing without a warning', () => {
    const { queryByTestId } = renderBanner()
    expect(queryByTestId('billing-warning-banner')).toBeNull()
  })

  it('renders the banner with the usage data and plan name when a warning is present', () => {
    useBillingStore.setState({ warning: WARNING })
    const { getByTestId } = renderBanner()
    expect(getByTestId('billing-warning-banner')).toBeTruthy()
    expect(getByTestId('billing-warning-usage').textContent).toContain('16.0h / 20h')
    // The plan name lands in the title (titlePlan).
    expect(getByTestId('billing-warning-banner').textContent).toContain('Pro')
  })

  it('renders nothing when the warning was dismissed', () => {
    useBillingStore.setState({ warning: WARNING, warningDismissed: true })
    const { queryByTestId } = renderBanner()
    expect(queryByTestId('billing-warning-banner')).toBeNull()
  })

  it('the CTA opens the boost modal', async () => {
    const user = userEvent.setup()
    useBillingStore.setState({ warning: WARNING })
    const { getByTestId } = renderBanner()
    expect(modalState.open).toBe(false)
    await user.click(getByTestId('billing-warning-cta'))
    expect(modalState.open).toBe(true)
  })

  it('the dismiss button hides the banner', async () => {
    const user = userEvent.setup()
    useBillingStore.setState({ warning: WARNING })
    const { getByTestId, queryByTestId } = renderBanner()
    await user.click(getByTestId('billing-warning-dismiss'))
    expect(queryByTestId('billing-warning-banner')).toBeNull()
    expect(useBillingStore.getState().warningDismissed).toBe(true)
  })
})
