/**
 * Onboarding v2 (spec ONB): step list, model-step gate, setup list, splash
 * length, and that every step has its copy.
 */
import { describe, expect, it } from "vitest"
import i18n from "../../i18n"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { AgentHeader } from "./AgentHeader"
import { buildOnboardingSteps, needsModelStep, setupItems, STEP_COPY, type OnboardingStepId } from "./onboardingSteps"
import { SPLASH_DURATION_MS } from "./WelcomeSplash"

const active = (isDefault = true) => ({ providerId: "p1", isDefault, status: "active" })

describe("ONB step logic", () => {
  it("[ONB-AC-3] builds the steps per edition", () => {
    expect(buildOnboardingSteps({ edition: "cloud", needsModel: true })).toEqual(["welcome", "about", "done"])
    expect(buildOnboardingSteps({ edition: "self-hosted", needsModel: true })).toEqual(["welcome", "model", "about", "done"])
    expect(buildOnboardingSteps({ edition: "self-hosted", needsModel: false })).toEqual(["welcome", "about", "done"])
  })

  it("[ONB-AC-4] needs the model step only on self-hosted without a working default", () => {
    expect(needsModelStep({ edition: "cloud", providers: [] })).toBe(false)
    expect(needsModelStep({ edition: "self-hosted", providers: [] })).toBe(true)
    expect(needsModelStep({ edition: "self-hosted", providers: [active(false)] })).toBe(true)
    expect(needsModelStep({ edition: "self-hosted", providers: [{ ...active(), status: "error" }], defaultTestOk: true })).toBe(true)
    expect(needsModelStep({ edition: "self-hosted", providers: [active()], defaultTestOk: false })).toBe(true)
    expect(needsModelStep({ edition: "self-hosted", providers: [active()], defaultTestOk: true })).toBe(false)
  })

  it("[ONB-AC-5] the setup list names exactly the steps after Welcome", () => {
    const withModel = setupItems(["welcome", "model", "about", "done"])
    expect(withModel.map((i) => i.id)).toEqual(["model", "about"])
    expect(withModel[0].required).toBe(true)
    expect(setupItems(["welcome", "about", "done"]).map((i) => i.id)).toEqual(["about"])
  })

  it("[ONB-AC-7] the splash lasts at most 1.5 s", () => {
    expect(SPLASH_DURATION_MS).toBeLessThanOrEqual(1500)
  })

  it("every step has a label, a quote and setup copy in English", () => {
    for (const id of Object.keys(STEP_COPY) as OnboardingStepId[]) {
      const c = STEP_COPY[id]
      for (const key of [c.labelKey, c.quoteKey, c.setupLabelKey, c.setupSubKey].filter(Boolean) as string[]) {
        expect(i18n.exists(key), key).toBe(true)
      }
    }
  })

  it("the agent header shows the quote of its step", () => {
    const { getByText } = renderWithTamagui(<AgentHeader agentName="Iria" stepId="model" />)
    expect(getByText(i18n.t("onboarding.quoteModel"))).toBeTruthy()
  })
})
