import { describe, expect, it } from 'vitest'
import { AddProviderForm, PROVIDER_TYPES } from './AddProviderForm'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import '../../i18n' // initialize i18next (en-US via mocked expo-localization)

/**
 * Subscription OAuth providers (anthropic-oauth = Claude Pro/Max,
 * openai-codex-oauth = ChatGPT Pro/Plus Codex) are hidden from the
 * add-provider list per Pablo's 2026-10-30 decision (ToS exposure, see
 * docs/providers/20261030_oauth-subscriptions-hidden.md). They must stay
 * in PROVIDER_TYPES so already-connected users keep their metadata, but
 * the selection list must not offer them — no NEW connections.
 */
const noop = () => {}

function renderForm() {
  return renderWithTamagui(
    <AddProviderForm
      onAdd={noop}
      onStartOAuth={noop}
      onCompleteOAuth={noop}
      onCancel={noop}
      adding={false}
      completing={false}
      oauthState={null}
    />,
  )
}

describe('AddProviderForm — hidden subscription OAuth providers', () => {
  it('keeps anthropic-oauth and openai-codex-oauth in PROVIDER_TYPES (existing connections resolve metadata)', () => {
    const claude = PROVIDER_TYPES.find((t) => t.id === 'anthropic-oauth')
    const codex = PROVIDER_TYPES.find((t) => t.id === 'openai-codex-oauth')
    expect(claude).toBeDefined()
    expect(codex).toBeDefined()
    expect(claude?.hidden).toBe(true)
    expect(codex?.hidden).toBe(true)
    // The metadata existing cards render (ProvidersWindowContent .find()) survives:
    expect(claude?.name).toBe('Claude Pro/Max')
    expect(codex?.name).toBe('ChatGPT Pro/Plus (Codex)')
  })

  it('does not offer the hidden subscription OAuth entries in the selection list', () => {
    const { getByText, queryByText } = renderForm()
    // The list renders and shows a visible provider…
    expect(getByText('Anthropic')).toBeTruthy()
    expect(getByText('OpenAI')).toBeTruthy()
    // …but neither hidden subscription entry appears.
    expect(queryByText('Claude Pro/Max')).toBeNull()
    expect(queryByText('ChatGPT Pro/Plus (Codex)')).toBeNull()
  })

  it('still offers the non-hidden OAuth-capable and regular providers', () => {
    const { getByText } = renderForm()
    for (const name of ['OpenRouter', 'Ollama Local', 'Teros']) {
      expect(getByText(name)).toBeTruthy()
    }
  })
})

describe('AddProviderForm — brand glyphs', () => {
  it('draws the brand glyph of a known provider type in the selection list', () => {
    const { container } = renderForm()
    // The OpenAI mark is an inline SVG path (ProviderIcons); the generic cloud is not.
    const paths = Array.from(container.querySelectorAll('svg path')).map((p) => p.getAttribute('d') ?? '')
    expect(paths.some((d) => d.startsWith('M22.282 9.821'))).toBe(true)
  })
})
