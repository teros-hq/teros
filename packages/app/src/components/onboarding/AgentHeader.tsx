/**
 * AgentHeader — Avatar + contextual quote, shown below the progress bar.
 *
 * Extracted from OnboardingWizard for clarity. Reads as the prototype's
 * "Iria · Personal Assistant" row: a 36px disc, the name in text and the
 * quote in text3.
 */

import React from "react"
import { useTranslation } from "react-i18next"
import { Image, View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { T } from "../ui/ds"
import { type OnboardingStepId, STEP_COPY } from "./onboardingSteps"

interface AgentHeaderProps {
  agentName: string
  avatarUrl?: string
  /** Step of the run; its quote comes from STEP_COPY (spec ONB). */
  stepId: OnboardingStepId
}

function AgentAvatar({ avatarUrl, name }: { avatarUrl?: string; name: string }) {
  const c = useColors()
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          borderWidth: 2,
          borderColor: c.borderAccent,
        }}
      />
    )
  }
  const initials = name
    .split(" ")
    .map((w) => w[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase()
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: c.tile,
        borderWidth: 2,
        borderColor: c.borderAccent,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <T step="12" tone="accent">
        {initials || "?"}
      </T>
    </View>
  )
}

export function AgentHeader({ agentName, avatarUrl, stepId }: AgentHeaderProps) {
  const { t } = useTranslation()
  const c = useColors()
  const quoteKey = STEP_COPY[stepId].quoteKey
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 28,
        paddingVertical: 14,
        marginTop: 14,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <AgentAvatar avatarUrl={avatarUrl} name={agentName} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm">{agentName}</T>
        <T step="12" tone="text3" style={{ fontStyle: "italic" }}>
          {quoteKey ? t(quoteKey) : ""}
        </T>
      </View>
    </View>
  )
}
