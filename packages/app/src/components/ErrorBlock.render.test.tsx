/**
 * ErrorBlock — the agent-hours hard block (FASE 6, decision #10) must render the
 * request-access CTA, not a plain error. The block arrives as a chat error message
 * with errorType 'upgrade_required' + context { reason:'hours_exhausted', ... }.
 * The assertions that bite the special-case:
 *   - that exact shape → HoursExhaustedWidget (with the usage line),
 *   - a generic error → NO widget,
 *   - 'upgrade_required' WITHOUT reason:'hours_exhausted' (a feature gate) → NO
 *     widget (the reason check, not just errorType, gates it).
 *
 *   cd packages/app && npx vitest run src/components/ErrorBlock.render.test.tsx
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TamaguiProvider } from 'tamagui'
import config from '../../tamagui.config'

vi.mock('../services/terosClientSingleton', () => ({
  getTerosClient: () => ({ send: vi.fn(async () => ({})) }),
}))

// The hours-exhausted widget opens the BoostModal (Dialog portal + Stripe deps)
// and reads tilingStore.openWindow. Both are mocked here — this suite asserts the
// ErrorBlock ROUTING (which context → which widget), not the modal internals.
vi.mock('./billing/BoostModal', () => ({ BoostModal: () => null }))
const openWindowSpy = vi.hoisted(() => vi.fn())
vi.mock('../store/tilingStore', () => ({
  useTilingStore: (sel: (s: { openWindow: unknown }) => unknown) => sel({ openWindow: openWindowSpy }),
}))

// Harness quirk (TER-385): @tamagui/lucide-icons is aliased to an enumerated stub
// that omits some names (they resolve to undefined). They are purely presentational,
// so stub the ones this subtree renders to no-ops — the assertions are on
// testIDs/data, never the icon glyphs. The stub is defined INSIDE the factory:
// vi.mock is hoisted above the file body, so a top-level const would hit the TDZ
// ("Cannot access StubIcon before initialization").
vi.mock('@tamagui/lucide-icons', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  const StubIcon = () => null
  return {
    ...real,
    AlertTriangle: StubIcon,
    ChevronDown: StubIcon,
    ChevronUp: StubIcon,
    RefreshCw: StubIcon,
    Minus: StubIcon,
    Plus: StubIcon,
  }
})

import { ErrorBlock, type ErrorBlockProps } from './ErrorBlock'

function renderError(props: ErrorBlockProps) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <ErrorBlock {...props} />
    </TamaguiProvider>,
  )
}

describe('ErrorBlock — hours-exhausted widget', () => {
  it('renders the request-access widget for an exhausted-hours block', () => {
    const { getByTestId } = renderError({
      errorType: 'upgrade_required',
      userMessage: 'You used all your hours',
      context: {
        reason: 'hours_exhausted',
        used: 20,
        limit: 20,
        tier: 'pro',
        planName: 'Pro',
        periodEnd: '2026-07-01T00:00:00.000Z',
      },
    })
    expect(getByTestId('hours-exhausted-widget')).toBeTruthy()
    // Framed around the active plan + reset date, not a raw hour count.
    expect(getByTestId('hours-exhausted-body').textContent).toContain('Pro')
  })

  it('renders a plain error (no widget) for a generic error', () => {
    const { queryByTestId } = renderError({
      errorType: 'llm',
      userMessage: 'model failed',
    })
    expect(queryByTestId('hours-exhausted-widget')).toBeNull()
  })

  it('does NOT render the widget for upgrade_required without the hours_exhausted reason', () => {
    const { queryByTestId } = renderError({
      errorType: 'upgrade_required',
      userMessage: 'Feature needs a higher tier',
      context: { feature: 'voice', currentTier: 'Basic', requiredTier: 'Pro' },
    })
    expect(queryByTestId('hours-exhausted-widget')).toBeNull()
  })
})

describe('ErrorBlock — payment-due widget (FASE 9)', () => {
  it('renders the payment-due widget with a settle CTA when a hosted invoice URL is present', () => {
    const { getByTestId } = renderError({
      errorType: 'upgrade_required',
      userMessage: 'Payment due',
      context: {
        reason: 'payment_due',
        amount: 89,
        currency: 'EUR',
        hostedInvoiceUrl: 'https://pay.stripe.test/inv_1',
      },
    })
    expect(getByTestId('payment-due-widget')).toBeTruthy()
    expect(getByTestId('payment-due-amount').textContent).toContain('89')
    // CTA present (links to the hosted invoice) and NOT the hours widget.
    expect(getByTestId('payment-due-cta')).toBeTruthy()
  })

  it('shows a contact hint (no CTA) when there is no hosted invoice URL (BETA)', () => {
    const { getByTestId, queryByTestId } = renderError({
      errorType: 'upgrade_required',
      userMessage: 'Payment due',
      context: { reason: 'payment_due' },
    })
    expect(getByTestId('payment-due-widget')).toBeTruthy()
    // MUST BITE: rendering the CTA unconditionally would open an undefined URL.
    expect(queryByTestId('payment-due-cta')).toBeNull()
  })

  it('does NOT render the payment-due widget for the hours_exhausted reason', () => {
    const { queryByTestId } = renderError({
      errorType: 'upgrade_required',
      userMessage: 'hours',
      context: { reason: 'hours_exhausted', used: 5, limit: 5, tier: 'Pro' },
    })
    expect(queryByTestId('payment-due-widget')).toBeNull()
  })
})
