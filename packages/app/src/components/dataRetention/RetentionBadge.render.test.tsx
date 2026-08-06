import { describe, expect, it } from 'vitest'
import { resolveRetention } from '@teros/shared'
import '../../i18n' // initialize i18next (en-US via mocked expo-localization)
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { RetentionBadge } from './RetentionBadge'
import { RetentionNotice } from './RetentionNotice'

/**
 * The data-retention warning is the user-facing payoff of the feature: the
 * badge colour/label and the notice text must follow the resolved tier, and
 * the headline-risk providers (consumer OAuth subscriptions that train on your
 * data by default) must render the red `trains` variant.
 */
describe('RetentionBadge', () => {
  it('renders the zdr badge for a zero-retention provider', () => {
    const { getByTestId, getByText } = renderWithTamagui(
      <RetentionBadge info={resolveRetention('teros')} />,
    )
    expect(getByTestId('retention-badge-zdr')).toBeTruthy()
    expect(getByText('Zero retention')).toBeTruthy()
  })

  it('renders the retains badge for a paid API', () => {
    const { getByTestId, getByText } = renderWithTamagui(
      <RetentionBadge info={resolveRetention('anthropic')} />,
    )
    expect(getByTestId('retention-badge-retains')).toBeTruthy()
    expect(getByText('Retains data')).toBeTruthy()
  })

  it('renders the trains badge for consumer subscriptions and opaque providers', () => {
    for (const provider of ['anthropic-oauth', 'openai-codex-oauth', 'minimax']) {
      // unmount between iterations: getByTestId is document-scoped, so two live
      // renders of the same testID would trip "multiple elements found".
      const { getByTestId, getByText, unmount } = renderWithTamagui(
        <RetentionBadge info={resolveRetention(provider)} />,
      )
      expect(getByTestId('retention-badge-trains')).toBeTruthy()
      expect(getByText('Trains on your data')).toBeTruthy()
      unmount()
    }
  })

  it('renders the trains badge when zhipu is routed to China', () => {
    const { getByTestId } = renderWithTamagui(
      <RetentionBadge info={resolveRetention('zhipu', { useChina: true })} />,
    )
    expect(getByTestId('retention-badge-trains')).toBeTruthy()
  })
})

describe('RetentionNotice', () => {
  it('shows the actionable opt-out text for Claude Pro/Max', () => {
    const { getByTestId, getByText } = renderWithTamagui(
      <RetentionNotice info={resolveRetention('anthropic-oauth')} />,
    )
    expect(getByTestId('retention-notice-trains')).toBeTruthy()
    expect(getByText(/Claude Pro\/Max trains on your conversations/i)).toBeTruthy()
  })

  it('shows reassurance for a zero-retention provider', () => {
    const { getByTestId, getByText } = renderWithTamagui(
      <RetentionNotice info={resolveRetention('teros')} />,
    )
    expect(getByTestId('retention-notice-zdr')).toBeTruthy()
    expect(getByText(/Zero Data Retention/i)).toBeTruthy()
  })

  it('explains the free-vs-paid nuance for Gemini', () => {
    const { getByText } = renderWithTamagui(
      <RetentionNotice info={resolveRetention('google')} />,
    )
    expect(getByText(/Google AI Studio/i)).toBeTruthy()
  })

  it('warns about an unclassified provider instead of going silent', () => {
    const { getByTestId, getByText } = renderWithTamagui(
      <RetentionNotice info={resolveRetention('some-future-provider')} />,
    )
    expect(getByTestId('retention-notice-retains')).toBeTruthy()
    expect(getByText(/haven't classified/i)).toBeTruthy()
  })
})
