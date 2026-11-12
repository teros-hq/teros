/**
 * ModelStep — "Connect a model" (spec ONB, self-hosted only).
 *
 * The user connects a provider with the same form as the Providers window.
 * Right after it is added the backend runs one real completion (the probe,
 * ONB-REQ-8); its text is shown as the agent's first words. On success the
 * provider becomes the user's default; on failure the provider just added is
 * removed and the error is shown. Back, no Skip: without a model the agent
 * cannot answer anything.
 *
 * @spec ONB-REQ-7
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Image, View } from "react-native"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { useColors } from "../../mca/primitives/useColors"
import { T } from "../../ui/ds"
import { AddProviderForm, type OAuthState } from "../AddProviderForm"
import type { StepFooterConfig } from "../StepFooter"
import { StepHeader } from "../StepHeader"

interface ModelStepProps {
  agentName: string
  agentAvatarUrl?: string
  onComplete: (data: { providerName: string }) => void
  setFooterConfig: (config: StepFooterConfig) => void
  registerContinueHandler: (handler: () => void) => void
}

type Phase = "form" | "probing" | "connected"

export function ModelStep({
  agentName,
  agentAvatarUrl,
  onComplete,
  setFooterConfig,
  registerContinueHandler,
}: ModelStepProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()

  const [phase, setPhase] = useState<Phase>("form")
  const [adding, setAdding] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [oauthState, setOauthState] = useState<OAuthState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [providerName, setProviderName] = useState("")

  useEffect(() => {
    setFooterConfig({
      showBack: true,
      showSkip: false,
      continueLabel: phase === "probing" ? t("onboarding.modelStep.checking") : t("onboarding.continueButton"),
      continueDisabled: phase !== "connected",
    })
  }, [phase, t])

  const completeRef = useRef<() => void>(() => {})
  completeRef.current = () => {
    if (phase === "connected") onComplete({ providerName })
  }
  useEffect(() => {
    registerContinueHandler(() => completeRef.current())
  }, [])

  /** Probe the provider just added; keep it as default on success, remove it on failure. */
  const probe = useCallback(
    async (providerId: string, name: string) => {
      setPhase("probing")
      setError(null)
      try {
        const res = await client.provider.test(providerId, { probe: true })
        if (!res.ok) throw new Error(res.error || t("onboarding.modelStep.noAnswer"))
        await client.provider.update(providerId, { isDefault: true })
        // ONB-REQ-8: a probe answered with a tool call has no text to show.
        setReply(res.reply || t("onboarding.modelStep.readyNoReply", { agentName }))
        setProviderName(name)
        setPhase("connected")
      } catch (err) {
        await client.provider.delete(providerId).catch(() => undefined)
        setError(err instanceof Error ? err.message : String(err))
        setPhase("form")
      }
    },
    [client, t, agentName],
  )

  const handleAdd = async (type: string, name: string, apiKey: string, config?: Record<string, any>) => {
    setAdding(true)
    setError(null)
    try {
      const { provider } = await client.provider.add({
        providerType: type,
        displayName: name,
        config,
        auth: apiKey ? { apiKey } : undefined,
      })
      await probe(provider.providerId, name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const handleStartOAuth = async (providerType: string) => {
    setAdding(true)
    setError(null)
    try {
      const r = await client.provider.startOAuth(providerType)
      setOauthState({
        method: r.method,
        authUrl: r.authUrl,
        verifier: r.verifier,
        userCode: r.userCode,
        interval: r.interval,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const handleCompleteOAuth = async (verifier: string, callbackUrl?: string) => {
    setCompleting(true)
    try {
      const { providerId } = await client.provider.completeOAuth(verifier, callbackUrl)
      setOauthState(null)
      await probe(providerId, providerId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCompleting(false)
    }
  }

  return (
    <View style={{ gap: 18 }}>
      <StepHeader title={t("onboarding.modelStep.title")} description={t("onboarding.modelStep.description")} />

      {phase === "connected" ? (
        <View
          testID="model-step-connected"
          style={{ flexDirection: "row", gap: 12, padding: 16, borderRadius: 16, backgroundColor: c.nest }}
        >
          {agentAvatarUrl ? (
            <Image source={{ uri: agentAvatarUrl }} style={{ width: 36, height: 36, borderRadius: 18 }} />
          ) : null}
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <T step="12" tone="text3">
              {t("onboarding.modelStep.connectedVia", { agentName, provider: providerName })}
            </T>
            <T step="sm" testID="model-step-reply">
              {reply}
            </T>
          </View>
        </View>
      ) : phase === "probing" ? (
        <T step="sm" tone="text2" testID="model-step-probing">
          {t("onboarding.modelStep.probing", { agentName })}
        </T>
      ) : (
        <AddProviderForm
          embedded
          onAdd={handleAdd}
          onStartOAuth={handleStartOAuth}
          onCompleteOAuth={handleCompleteOAuth}
          onCancel={() => {
            setOauthState(null)
            setError(null)
          }}
          adding={adding}
          completing={completing}
          oauthState={oauthState}
          error={error}
        />
      )}
    </View>
  )
}
