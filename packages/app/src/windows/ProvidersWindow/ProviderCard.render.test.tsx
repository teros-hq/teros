import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n' // initialize i18next (en-US via mocked expo-localization)
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { ProviderCard } from './ProvidersWindowContent'

/**
 * ProviderCard — auto-test-on-access contract.
 *
 * The manual "Test" button was removed; instead expanding the card (accessing
 * the provider) fires `onTest` automatically, once per access. These tests bite
 * that contract: they fail if the effect is dropped (no test on expand), if the
 * ref reset is forgotten (no re-test on re-expand), or if a dependency makes it
 * loop (more calls than accesses).
 */

const baseProvider = {
  providerId: 'prov_1',
  providerType: 'anthropic',
  displayName: 'My Anthropic',
  models: [],
  isDefault: false,
  priority: 0,
  status: 'active' as const,
  createdAt: new Date(0).toISOString(),
}

function renderCard(onTest: () => void) {
  return renderWithTamagui(
    <ProviderCard
      provider={baseProvider}
      onTest={onTest}
      onDelete={() => {}}
      onSetDefault={() => {}}
      onSetDefaultModel={() => {}}
      testing={false}
      settingDefault={false}
    />,
  )
}

describe('ProviderCard — auto-test on access', () => {
  it('does not auto-test on mount (card starts collapsed)', () => {
    const onTest = vi.fn()
    renderCard(onTest)
    expect(onTest).not.toHaveBeenCalled()
  })

  it('auto-tests once when the card is expanded', () => {
    const onTest = vi.fn()
    const { getByTestId } = renderCard(onTest)
    fireEvent.click(getByTestId('provider-card-header')) // expand
    expect(onTest).toHaveBeenCalledTimes(1)
  })

  it('does not re-test on collapse, and re-tests on every re-expand', () => {
    const onTest = vi.fn()
    const { getByTestId } = renderCard(onTest)
    const header = getByTestId('provider-card-header')

    fireEvent.click(header) // expand → 1
    expect(onTest).toHaveBeenCalledTimes(1)

    fireEvent.click(header) // collapse → still 1 (no test on collapse)
    expect(onTest).toHaveBeenCalledTimes(1)

    fireEvent.click(header) // expand again → 2 (every access re-tests)
    expect(onTest).toHaveBeenCalledTimes(2)
  })
})
