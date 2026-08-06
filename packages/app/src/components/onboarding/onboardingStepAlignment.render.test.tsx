import { describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { AgentHeader, STEP_QUOTE_KEYS } from './AgentHeader'
import { STEP_IDS, STEP_LABEL_KEYS } from './OnboardingWizard'

/**
 * Three arrays are indexed by the same `currentStep`: STEP_IDS + STEP_LABEL_KEYS
 * (OnboardingWizard) and STEP_QUOTE_KEYS (AgentHeader). When provider/plan/payment
 * were removed from onboarding, AgentHeader's array was missed and every step
 * showed the next step's old quote (off-by-one). These guard that class of drift.
 */
describe('onboarding step-array alignment', () => {
  it('keeps the step-indexed arrays the same length', () => {
    expect(STEP_LABEL_KEYS.length).toBe(STEP_IDS.length)
    expect(STEP_QUOTE_KEYS.length).toBe(STEP_IDS.length)
  })

  it('references no removed step (provider / plan / payment) in any step array', () => {
    const all = [...STEP_IDS, ...STEP_LABEL_KEYS, ...STEP_QUOTE_KEYS].join(' ').toLowerCase()
    for (const dead of ['provider', 'plan', 'payment']) {
      expect(all.includes(dead)).toBe(false)
    }
  })
})

describe('AgentHeader quote follows the step', () => {
  it('shows the About-you quote at step 1, not the removed provider quote', () => {
    const { getByText, queryByText } = renderWithTamagui(
      <AgentHeader agentName="Iria" currentStep={1} />,
    )
    expect(getByText(i18n.t('onboarding.quoteAboutYou'))).toBeTruthy()
    expect(queryByText(i18n.t('onboarding.quoteProvider'))).toBeNull()
  })

  it('shows the Done quote at the last step', () => {
    const { getByText } = renderWithTamagui(
      <AgentHeader agentName="Iria" currentStep={STEP_IDS.length - 1} />,
    )
    expect(getByText(i18n.t('onboarding.quoteDone'))).toBeTruthy()
  })
})
