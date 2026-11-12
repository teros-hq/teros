import '../../i18n' // side-effect: initializes i18n (en-US) so t() returns real strings
import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { AcademyDetail } from './AcademyDetail'
import { getVideosByPhase } from '../../data/academyCatalog'

describe('AcademyDetail', () => {
  it('renders the player iframe, objective/steps/transcript, and back/next navigation', () => {
    const [first, second] = getVideosByPhase('phase1')
    const onBack = vi.fn()
    const onNavigate = vi.fn()
    const { container, getByText } = renderWithTamagui(
      <AcademyDetail videoId={first.id} onBack={onBack} onNavigate={onNavigate} />,
    )
    // Player present
    const iframe = container.querySelector('iframe')
    expect(iframe?.getAttribute('src')).toContain(first.youtubeId)
    // Labels present (UI chrome, en-US)
    expect(getByText(/^Objective$/)).toBeTruthy()
    expect(getByText(/^Transcript$/)).toBeTruthy()
    // Back
    fireEvent.click(getByText(/Back to catalog|Volver al catálogo/))
    expect(onBack).toHaveBeenCalled()
    // Next → moves to the second video of the phase
    fireEvent.click(getByText(/^Next$|^Siguiente$/))
    expect(onNavigate).toHaveBeenCalledWith(second.id)
  })

  it('defaults content to the UI language (en) and the EN/ES toggle switches it', () => {
    const [first] = getVideosByPhase('phase1')
    const { getByText } = renderWithTamagui(
      <AcademyDetail videoId={first.id} onBack={() => {}} onNavigate={() => {}} />,
    )
    // Default follows UI language (en-US) → English transcript (snippet from the data)
    const enSnippet = first.transcript.en.slice(0, 20)
    expect(getByText(enSnippet, { exact: false })).toBeTruthy()
    // Toggle to ES → Spanish transcript (content only; chrome stays English)
    fireEvent.click(getByText('ES'))
    const esSnippet = first.transcript.es.slice(0, 20)
    expect(getByText(esSnippet, { exact: false })).toBeTruthy()
  })
})
