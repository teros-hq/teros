/**
 * AgentStep — Step 1 of the onboarding wizard (skippable → Done)
 *
 * Returns pure content — no ScrollView, no footer, no spacers.
 * The wizard handles scroll and footer rendering.
 */

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { Chip, Field, FieldLabel } from "../../ui/ds"
import { StepHeader } from "../StepHeader"
import type { StepFooterConfig } from "../StepFooter"

const USE_CASES = [
  { id: "work", labelKey: "onboarding.useCaseWork", icon: "briefcase" },
  { id: "dev", labelKey: "onboarding.useCaseDev", icon: "code" },
  { id: "research", labelKey: "onboarding.useCaseResearch", icon: "flask" },
  { id: "personal", labelKey: "onboarding.useCasePersonal", icon: "tree" },
  { id: "everything", labelKey: "onboarding.useCaseEverything", icon: "sparkle" },
]

// English labels used for context storage (backward-compatible parsing)
const USE_CASE_STORAGE_LABELS: Record<string, string> = {
  work: "Work & productivity",
  dev: "Software development",
  research: "Research",
  personal: "Personal projects",
  everything: "A bit of everything",
}

interface DefaultAgent {
  agentId: string
  name: string
  fullName: string
  context?: string
}

interface AgentStepProps {
  defaultAgent: DefaultAgent | null
  agentName: string
  agentAvatarUrl?: string
  onComplete: (data: { useCase: string | null; preferredName: string }) => void
  onSkip: () => void
  onBack: () => void
  setFooterConfig: (config: StepFooterConfig) => void
  registerContinueHandler: (handler: () => void) => void
}

// ── Context parsing helpers ────────────────────────────────────────────────────

function parseOnboardingContext(context: string | undefined): {
  useCaseId: string | null
  preferredName: string
} {
  if (!context || !context.includes("[User context — set during onboarding]")) {
    return { useCaseId: null, preferredName: "" }
  }

  let useCaseId: string | null = null
  const useCaseMatch = context.match(/Primary use case:\s*([^.]+)\./)
  if (useCaseMatch) {
    const label = useCaseMatch[1].trim()
    const found = Object.entries(USE_CASE_STORAGE_LABELS).find(([, l]) => l === label)
    if (found) useCaseId = found[0]
  }

  let preferredName = ""
  const nameMatch = context.match(/The user prefers to be called "([^"]+)"/)
  if (nameMatch) preferredName = nameMatch[1]

  return { useCaseId, preferredName }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AgentStep({
  defaultAgent,
  onComplete,
  onSkip,
  onBack,
  setFooterConfig,
  registerContinueHandler,
}: AgentStepProps) {
  const { t } = useTranslation()
  const client = getTerosClient()

  const { useCaseId: initialUseCase, preferredName: initialName } = parseOnboardingContext(
    defaultAgent?.context,
  )

  const [selectedUseCases, setSelectedUseCases] = useState<string[]>(() =>
    initialUseCase ? [initialUseCase] : [],
  )
  const [preferredName, setPreferredName] = useState(initialName)
  const [saving, setSaving] = useState(false)

  // Communicate footer config to wizard
  useEffect(() => {
    setFooterConfig({
      showBack: true,
      showSkip: true,
      continueLabel: saving ? t("common.saving") : t("onboarding.continueButton"),
      continueDisabled: saving,
    })
  }, [saving, t])

  // Keep a ref to handleContinue so the registered handler always calls the latest version
  const handleContinueRef = useRef<() => void>(() => {})

  // Register continue handler — wizard footer calls this on Continue press
  useEffect(() => {
    registerContinueHandler(() => handleContinueRef.current())
  }, [])

  const toggleUseCase = (id: string) => {
    setSelectedUseCases((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const handleContinue = useCallback(async () => {
    setSaving(true)
    try {
      if (defaultAgent?.agentId && selectedUseCases.length > 0) {
        const useCaseLabels = selectedUseCases.map((id) => USE_CASE_STORAGE_LABELS[id] ?? id)
        const useCaseStr = useCaseLabels.join(", ")
        const nameClause = preferredName.trim()
          ? ` The user prefers to be called "${preferredName.trim()}".`
          : ""
        const patch = `[User context — set during onboarding]\nPrimary use case: ${useCaseStr}.${nameClause}`
        await client.agent.updateAgent({ agentId: defaultAgent.agentId, context: patch })
      }
    } catch (err) {
      console.error("[AgentStep] Failed to update agent:", err)
    } finally {
      setSaving(false)
      const useCaseValue =
        selectedUseCases.length > 0
          ? selectedUseCases.map((id) => USE_CASE_STORAGE_LABELS[id] ?? id).join(", ")
          : null
      onComplete({ useCase: useCaseValue, preferredName: preferredName.trim() })
    }
  }, [defaultAgent, selectedUseCases, preferredName, onComplete])

  // Keep ref in sync with latest handleContinue
  useEffect(() => {
    handleContinueRef.current = handleContinue
  }, [handleContinue])

  return (
    <View style={{ gap: 22 }}>
      <StepHeader
        title={t("onboarding.agentStep.title")}
        description={t("onboarding.tellMeAboutYourselfDescription")}
      />

      {/* Q1: Use case chips — multi-select */}
      <View>
        <FieldLabel>{t("onboarding.whatWillYouUseTeros")}</FieldLabel>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {USE_CASES.map((uc) => {
            const isSelected = selectedUseCases.includes(uc.id)
            return (
              <Chip
                key={uc.id}
                icon={uc.icon}
                on={isSelected}
                onPress={() => toggleUseCase(uc.id)}
                testID={`use-case-${uc.id}`}
                accessibilityState={{ selected: isSelected }}
              >
                {t(uc.labelKey)}
              </Chip>
            )
          })}
        </View>
      </View>

      {/* Q2: Preferred name */}
      <View>
        <FieldLabel>{t("onboarding.whatShouldICallYou")}</FieldLabel>
        <Field
          lg
          icon="user"
          placeholder={t("onboarding.agentStep.namePlaceholder")}
          value={preferredName}
          onChangeText={setPreferredName}
          maxLength={40}
          autoCapitalize="words"
          testID="preferred-name-input"
        />
      </View>
    </View>
  )
}
