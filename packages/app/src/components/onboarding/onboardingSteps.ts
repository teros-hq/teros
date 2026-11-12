/**
 * Onboarding v2 step logic (spec ONB), kept pure so it is tested without
 * mounting the wizard.
 *
 * @spec ONB-REQ-5 ONB-REQ-6 ONB-REQ-9
 */
import type { Edition } from "../../config/edition"

export type OnboardingStepId = "welcome" | "model" | "about" | "done"

/** Labels, agent quotes and setup-list copy per step (i18n keys). */
export const STEP_COPY: Record<
  OnboardingStepId,
  { labelKey: string; quoteKey: string; setupLabelKey?: string; setupSubKey?: string }
> = {
  welcome: { labelKey: "onboarding.stepWelcome", quoteKey: "onboarding.quoteWelcome" },
  model: {
    labelKey: "onboarding.stepModel",
    quoteKey: "onboarding.quoteModel",
    setupLabelKey: "onboarding.setupModelLabel",
    setupSubKey: "onboarding.setupModelSub",
  },
  about: {
    labelKey: "onboarding.stepAboutYou",
    quoteKey: "onboarding.quoteAboutYou",
    setupLabelKey: "onboarding.setupAboutLabel",
    setupSubKey: "onboarding.setupAboutSub",
  },
  done: { labelKey: "onboarding.stepDone", quoteKey: "onboarding.quoteDone" },
}

/** The minimal view of a provider this logic needs. */
export interface ProviderSnapshot {
  providerId: string
  isDefault?: boolean
  status?: string
}

/**
 * ONB-REQ-6: the model step is needed on self-hosted when the user's default
 * provider is missing, not active, or fails `provider.test`. Never on cloud.
 * `defaultTestOk` is the result of testing the default provider (undefined
 * when there is no default to test).
 */
export function needsModelStep(params: {
  edition: Edition
  providers: ProviderSnapshot[]
  defaultTestOk?: boolean
}): boolean {
  if (params.edition === "cloud") return false
  const def = params.providers.find((p) => p.isDefault)
  if (!def) return true
  if (def.status !== "active") return true
  return params.defaultTestOk !== true
}

/** ONB-REQ-5: the steps of this run, in order. */
export function buildOnboardingSteps(params: { edition: Edition; needsModel: boolean }): OnboardingStepId[] {
  const withModel = params.edition === "self-hosted" && params.needsModel
  return withModel ? ["welcome", "model", "about", "done"] : ["welcome", "about", "done"]
}

/** ONB-REQ-9: the "What we'll set up" items, exactly the steps after Welcome. */
export function setupItems(steps: OnboardingStepId[]): Array<{
  id: OnboardingStepId
  labelKey: string
  subKey: string
  required: boolean
}> {
  return steps
    .filter((id) => STEP_COPY[id].setupLabelKey)
    .map((id) => ({
      id,
      labelKey: STEP_COPY[id].setupLabelKey!,
      subKey: STEP_COPY[id].setupSubKey!,
      required: id === "model",
    }))
}
