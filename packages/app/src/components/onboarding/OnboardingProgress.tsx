/**
 * OnboardingProgress — the stepper strip of the OS prototype (`.stepper`).
 *
 * A small mono note "PASO 1 · 4 — Bienvenida" and a row of progress pills:
 * done = violet at half strength, active = violet (wider), idle = washed.
 * Always visible at the top of the wizard.
 */

import React from "react"
import { Platform, View } from "react-native"
import { useTranslation } from "react-i18next"
import { colors as semanticColors } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"
import { T } from "../ui/ds"

export interface OnboardingStep {
  id: string
  label: string
}

interface OnboardingProgressProps {
  steps: OnboardingStep[]
  currentStep: number // 0-based index
}

export function OnboardingProgress({ steps, currentStep }: OnboardingProgressProps) {
  const { t } = useTranslation()
  const c = useColors()
  const stepNumber = currentStep + 1
  const totalSteps = steps.length
  const currentLabel = steps[currentStep]?.label ?? ""

  return (
    <View
      style={{ gap: 10, paddingHorizontal: 28, paddingTop: 24, paddingBottom: 0 }}
      testID="onboarding-progress"
    >
      {/* Pills row */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {steps.map((step, idx) => {
          const isDone = idx < currentStep
          const isActive = idx === currentStep
          return (
            <View
              key={step.id}
              accessibilityLabel={step.label}
              style={[
                {
                  height: 6,
                  borderRadius: 3,
                  flexGrow: isActive ? 2 : 1,
                  flexBasis: 0,
                  backgroundColor: isActive
                    ? semanticColors.purple300
                    : isDone
                      ? semanticColors.purple300
                      : c.wash2,
                  opacity: isDone ? 0.45 : 1,
                },
                Platform.OS === "web"
                  ? ({
                      transition:
                        "flex-grow 0.35s cubic-bezier(.16,1,.3,1), background-color 0.3s, opacity 0.3s",
                    } as any)
                  : null,
              ]}
            />
          )
        })}
      </View>

      {/* Step note — "STEP 1 · 4 — Welcome" */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <T step="codenote" tone="accent">
          {t("onboarding.stepNote", {
            defaultValue: "Step {{n}} · {{total}}",
            n: stepNumber,
            total: totalSteps,
          })}
        </T>
        <T step="xs" tone="text3">
          {currentLabel}
        </T>
      </View>
    </View>
  )
}
