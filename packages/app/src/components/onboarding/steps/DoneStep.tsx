/**
 * DoneStep — Step 4 of the onboarding wizard (final)
 *
 * - Persists onboardingCompletedAt via profile.complete-onboarding (with retry).
 * - Shows summary of what was set up.
 * - Footer handled by wizard (special CTA: "Start chatting", arrow icon from the button).
 *
 * Returns pure content — no footer, no spacers.
 */

import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Image, View } from "react-native"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { useAuthStore } from "../../../store/authStore"
import { useWorkspaceStore } from "../../../store/workspaceStore"
import { useTilingStore } from "../../../store/tilingStore"
import { useColors } from "../../mca/primitives/useColors"
import { Ph, T, Tile } from "../../ui/ds"
import type { StepFooterConfig } from "../StepFooter"
import { useEdition } from "../../../config/edition"

interface DoneStepProps {
  userName?: string
  agentName: string
  agentAvatarUrl?: string
  defaultAgentId: string | null
  summaryItems: string[]
  onFinish: () => void
  setFooterConfig: (config: StepFooterConfig) => void
}

export function DoneStep({
  userName,
  agentName,
  agentAvatarUrl,
  defaultAgentId,
  summaryItems,
  onFinish,
  setFooterConfig,
}: DoneStepProps) {
  // ONB-REQ-10: no provider talk on cloud.
  const edition = useEdition()
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const { completeOnboarding } = useAuthStore()
  const { openWindow } = useTilingStore()
  const { setActiveWorkspace } = useWorkspaceStore()
  const [completed, setCompleted] = useState(false)

  // Complete onboarding on mount — with retry
  useEffect(() => {
    let cancelled = false
    const complete = async () => {
      try {
        await client.send("profile", "complete-onboarding", {})
        completeOnboarding()
        if (!cancelled) setCompleted(true)
      } catch (err) {
        console.error("[DoneStep] complete-onboarding failed, retrying:", err)
        try {
          await client.send("profile", "complete-onboarding", {})
          completeOnboarding()
          if (!cancelled) setCompleted(true)
        } catch (retryErr) {
          console.error("[DoneStep] Retry also failed:", retryErr)
          completeOnboarding() // mark locally anyway
          if (!cancelled) setCompleted(true)
        }
      }
    }
    complete()
    return () => {
      cancelled = true
    }
  }, [])

  const handleStartChatting = async () => {
    if (!completed) {
      completeOnboarding() // safety net
    }
    try {
      const { workspaces } = await client.workspace.listWorkspaces()
      const privateWs = workspaces.find((ws: any) => ws.type === "private")
      if (privateWs) {
        setActiveWorkspace(privateWs.workspaceId)
      }
    } catch (err) {
      console.warn("[DoneStep] Failed to preselect private workspace:", err)
    }
    if (defaultAgentId) {
      openWindow("chat", { agentId: defaultAgentId, agentName })
    }
    onFinish()
  }

  // Communicate footer config to wizard — special CTA
  useEffect(() => {
    setFooterConfig({
      specialCta: {
        label: t("onboarding.startChatting"),
        onPress: handleStartChatting,
      },
    })
  }, [completed, defaultAgentId, t])

  const firstName = userName?.split(" ")[0]?.trim() || "there"

  return (
    <View style={{ alignItems: "center", gap: 22, paddingTop: 8, paddingBottom: 8 }}>
      {/* Large avatar with the brand ring */}
      {agentAvatarUrl ? (
        <Image
          source={{ uri: agentAvatarUrl }}
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            borderWidth: 2,
            borderColor: c.borderAccent,
          }}
        />
      ) : (
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: c.tile,
            borderWidth: 2,
            borderColor: c.borderAccent,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <T step="xl" tone="accent">
            {agentName.slice(0, 2).toUpperCase()}
          </T>
        </View>
      )}

      {/* Sparkle accent + title */}
      <View style={{ alignItems: "center", gap: 8 }}>
        <Ph name="sparkle" size={22} color={c.accent} weight="fill" />
        <T step="2xl" center style={{ fontSize: 30, lineHeight: 34 }}>
          {t("onboarding.allSetTitle", { firstName })}
        </T>
        {/* ONB-REQ-10: no summary heading when nothing was set up in this run */}
        {summaryItems.length > 0 && (
          <T step="sm" tone="text2" center>
            {t("onboarding.hereIsWhatWeSetUp")}
          </T>
        )}
      </View>

      {/* Summary — one list card, mint check tiles */}
      {summaryItems.length > 0 && (
        <View
          style={{ width: "100%", borderRadius: 16, backgroundColor: c.nest, overflow: "hidden" }}
        >
          {summaryItems.map((item, i) => (
            <View
              key={item}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderTopWidth: i > 0 ? 1 : 0,
                borderTopColor: c.border,
              }}
            >
              <Tile icon="check" tone="mint" size="xs" weight="bold" />
              <T step="sm" style={{ flex: 1 }}>
                {item}
              </T>
            </View>
          ))}
        </View>
      )}

      <T step="12" tone="text3" center style={{ maxWidth: 360 }}>
        {t(edition === "cloud" ? "onboarding.addMoreAnytimeCloud" : "onboarding.addMoreAnytime")}
      </T>
    </View>
  )
}
