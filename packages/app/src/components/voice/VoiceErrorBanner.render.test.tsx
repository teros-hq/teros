import { describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
// Initialize i18n with en-US (the stubbed device locale) BEFORE importing the
// component under test — otherwise t() returns raw defaultValues ({{s}} etc).
import '../../i18n'
import { VoiceErrorBanner } from './VoiceErrorBanner'
import type { VoiceSessionError } from '@teros/shared'

// The test env has no device locale → i18n falls back to en-US
// deterministically, so the banner copy reads in English.

const err = (code: VoiceSessionError['code']): VoiceSessionError => ({
  code,
  message: 'technical detail for support',
})

describe('VoiceErrorBanner (§3.3/§7.2 — the catalog with an action)', () => {
  it('renders nothing when there is no error', () => {
    const { container } = renderWithTamagui(
      <VoiceErrorBanner error={null} onRetry={() => {}} />,
    )
    expect(container.textContent).toBe('')
  })

  it('auth → human message + "Log in" action (not a generic retry)', () => {
    const onLogin = vi.fn()
    const { container } = renderWithTamagui(
      <VoiceErrorBanner error={err('auth')} agentName="Alice" onRetry={() => {}} onLogin={onLogin} />,
    )
    expect(container.textContent).toContain('session has expired')
    expect(container.textContent).toContain('Alice')
    expect(container.textContent).toContain('Log in')
    // The technical code is present but small — for support, not to read
    expect(container.textContent).toContain('auth')
  })

  it('flag_disabled → "Request access" (the honest door)', () => {
    const { container } = renderWithTamagui(
      <VoiceErrorBanner error={err('flag_disabled')} onRetry={() => {}} />,
    )
    expect(container.textContent).toContain('not enabled for your account')
    expect(container.textContent).toContain('Request access')
  })

  it('mic_permission → "Open permission settings" deep-link action (AC-UX5)', () => {
    const { container } = renderWithTamagui(
      <VoiceErrorBanner error={err('mic_permission')} agentName="Alice" onRetry={() => {}} />,
    )
    expect(container.textContent).toContain('microphone access')
    expect(container.textContent).toContain('Open permission settings')
  })

  it('timeout → auto-retry countdown is visible and cancelable (UX §7.1)', async () => {
    const { container } = renderWithTamagui(
      <VoiceErrorBanner error={err('timeout')} onRetry={() => {}} />,
    )
    // The countdown starts at the catalog's 5 s and is announced in text
    expect(container.textContent).toContain('Retrying in 5s')
    expect(container.textContent).toContain('cancel')
  })

  it('elevenlabs_signed_url → 10 s auto-retry countdown', () => {
    const { container } = renderWithTamagui(
      <VoiceErrorBanner error={err('elevenlabs_signed_url')} onRetry={() => {}} />,
    )
    expect(container.textContent).toContain('Retrying in 10s')
  })

  it('unknown → retry + "Copy code" (for support)', () => {
    const { container } = renderWithTamagui(
      <VoiceErrorBanner error={err('unknown')} onRetry={() => {}} />,
    )
    expect(container.textContent).toContain('Retry')
    expect(container.textContent).toContain('Copy code')
  })

  it('workspace_unresolved → retry + copy code', () => {
    const { container } = renderWithTamagui(
      <VoiceErrorBanner error={err('workspace_unresolved')} onRetry={() => {}} />,
    )
    expect(container.textContent).toContain("couldn't identify your workspace")
    expect(container.textContent).toContain('Copy code')
  })

  it('stt_error / tts_error → their own messages (not generic)', () => {
    const stt = renderWithTamagui(
      <VoiceErrorBanner error={err('stt_error')} onRetry={() => {}} />,
    )
    expect(stt.container.textContent).toContain("couldn't transcribe your voice")
    const tts = renderWithTamagui(
      <VoiceErrorBanner error={err('tts_error')} onRetry={() => {}} />,
    )
    expect(tts.container.textContent).toContain("couldn't generate")
  })

  it('every code renders a human message + the technical code (catalog completeness)', () => {
    const codes: VoiceSessionError['code'][] = [
      'auth',
      'flag_disabled',
      'elevenlabs_signed_url',
      'timeout',
      'workspace_unresolved',
      'mic_permission',
      'server_error',
      'bad_request',
      'stt_error',
      'tts_error',
      'unknown',
    ]
    for (const code of codes) {
      const { container } = renderWithTamagui(
        <VoiceErrorBanner error={err(code)} onRetry={() => {}} />,
      )
      // The technical code is always present (mono, small — for support)
      expect(container.textContent).toContain(code)
      // And an action is always present — nothing breaks in silence
      expect(
        container.textContent!.match(/Log in|Request access|Open permission settings|Retry/),
      ).not.toBeNull()
    }
  })
})
