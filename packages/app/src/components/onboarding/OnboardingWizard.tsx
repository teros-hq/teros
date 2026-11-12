/**
 * OnboardingWizard — Orchestrates the onboarding flow
 *
 * Flow (spec ONB v2): welcome → model (self-hosted, when no working default
 * provider) → about → done. Apps and Access steps were removed (ONB-REQ-5).
 * Provider selection and plan/payment are NO LONGER part of onboarding:
 *   - Every user runs on the Teros model by default (Starter/"Basic" plan,
 *     created server-side at signup in user-service.createUser).
 *   - BYOK providers and plan upgrades live in their own windows (Providers /
 *     Billing), reachable after onboarding.
 *
 * Architecture:
 *   Card
 *   ├── OnboardingProgress (fixed top)
 *   ├── AgentHeader (fixed top)
 *   ├── ScrollView (SINGLE, flex=1)
 *   │   └── Step content (pure content, no scroll, no footer)
 *   └── StepFooter (fixed bottom, OUTSIDE scroll, managed by wizard)
 *
 * Communication pattern:
 *   step → wizard: setFooterConfig({ continueLabel, continueDisabled, ... })
 *   step → wizard: registerContinueHandler(myAsyncHandler)
 *   wizard → step: footer Continue press → calls registered handler
 *
 * KISS: One ScrollView per screen. No nested ScrollViews.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, ScrollView, View, useWindowDimensions } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { AppSpinner } from "../ui/AppSpinner"
import { Btn, T } from "../ui/ds"
import { useColors } from "../mca/primitives/useColors"
import { AgentHeader } from "./AgentHeader"
import { OnboardingProgress, type OnboardingStep } from "./OnboardingProgress"
import { StepFooter, type StepFooterConfig } from "./StepFooter"
import { AgentStep } from "./steps/AgentStep"
import { DoneStep } from "./steps/DoneStep"
import { ModelStep } from "./steps/ModelStep"
import { buildOnboardingSteps, needsModelStep, type OnboardingStepId, STEP_COPY } from "./onboardingSteps"
import { useEdition } from "../../config/edition"
import { WelcomeStep } from "./steps/WelcomeStep"
import { WelcomeSplash } from "./WelcomeSplash"

// ── Init data shape ────────────────────────────────────────────────────────────

interface DefaultAgent {
  agentId: string
  name: string
  fullName: string
  context?: string
  avatarUrl?: string
}

interface InitData {
  defaultAgent: DefaultAgent | null
  /** Steps of this run (ONB-REQ-5/6), decided once at load. */
  steps: OnboardingStepId[]
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface OnboardingWizardProps {
  onFinish: () => void
  userName?: string
}

// ── Main component ─────────────────────────────────────────────────────────────

export function OnboardingWizard({ onFinish, userName }: OnboardingWizardProps) {
  const { t } = useTranslation()
  const c = useColors()
  const edition = useEdition()
  const { width, height: windowHeight } = useWindowDimensions()
  const isDesktop = width >= 768

  // Screen-space Y (from screen center) where the WelcomeStep logo will sit.
  // For desktop: card is centered in a 32px-padded container. For windowHeight >= 764 this is always -224.
  // For mobile: card fills the screen, logo is 126px from the top.
  const splashExitY = isDesktop ? Math.max(-224, 158 - windowHeight / 2) : 126 - windowHeight / 2
  const client = getTerosClient()
  const scrollRef = useRef<any>(null)

  const [currentStep, setCurrentStep] = useState<number>(0)
  const [splashDone, setSplashDone] = useState(false)
  const [summaryItems, setSummaryItems] = useState<string[]>([])
  const [preferredName, setPreferredName] = useState<string>("")

  // Footer state — set by the active step via setFooterConfig
  const [footerConfig, setFooterConfig] = useState<StepFooterConfig>({})

  // Continue handler ref — each step registers its handler here
  const continueHandlerRef = useRef<(() => void) | null>(null)
  const registerContinueHandler = useCallback((handler: () => void) => {
    continueHandlerRef.current = handler
  }, [])

  // ── Unified init load ──────────────────────────────────────────────────────
  const [initData, setInitData] = useState<InitData | null>(null)
  const [initLoading, setInitLoading] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setInitLoading(true)
    setInitError(null)
    try {
      const [{ agents }, { providers }] = await Promise.all([
        client.agent.listAgents(),
        client.provider.list(),
      ])
      const defaultAgentRaw = agents[0] ?? null
      const defaultAgent: DefaultAgent | null = defaultAgentRaw
        ? {
            agentId: defaultAgentRaw.agentId,
            name: defaultAgentRaw.name,
            fullName: defaultAgentRaw.fullName,
            context: defaultAgentRaw.context,
            avatarUrl: defaultAgentRaw.avatarUrl,
          }
        : null

      // ONB-REQ-6: on self-hosted, test the default provider (no probe — cheap,
      // and it fails for the Teros provider when no upstream is configured).
      let defaultTestOk: boolean | undefined
      const def = providers.find((p: any) => p.isDefault)
      if (edition === "self-hosted" && def && def.status === "active") {
        try {
          defaultTestOk = (await client.provider.test(def.providerId)).ok
        } catch {
          defaultTestOk = false
        }
      }
      const needsModel = needsModelStep({ edition, providers, defaultTestOk })

      setInitData({ defaultAgent, steps: buildOnboardingSteps({ edition, needsModel }) })
    } catch (err: any) {
      console.error("[OnboardingWizard] Init load failed:", err)
      setInitError(err?.message || t("onboarding.somethingWentWrong"))
    } finally {
      setInitLoading(false)
    }
  }, [edition])

  useEffect(() => {
    if (client.isConnected()) {
      load()
    } else {
      const onConnected = () => {
        load()
        client.off("connected", onConnected)
      }
      client.on("connected", onConnected)
      return () => client.off("connected", onConnected)
    }
  }, [load])

  // Scroll to top when step changes
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ y: 0, animated: false })
  }, [currentStep])

  // ── Navigation ─────────────────────────────────────────────────────────────

  const steps: OnboardingStepId[] = initData?.steps ?? ["welcome", "about", "done"]
  const STEPS: OnboardingStep[] = steps.map((id) => ({ id, label: t(STEP_COPY[id].labelKey) }))
  const DONE_STEP = steps.length - 1
  const stepId: OnboardingStepId = steps[currentStep] ?? "welcome"

  const goNext = useCallback(() => {
    setCurrentStep((s) => Math.min(s + 1, DONE_STEP))
  }, [DONE_STEP])

  const goBack = useCallback(() => {
    setCurrentStep((s) => Math.max(s - 1, 0))
  }, [])

  // ── Step completion handlers ───────────────────────────────────────────────

  const handleAgentComplete = useCallback(
    ({ useCase, preferredName: name }: { useCase: string | null; preferredName: string }) => {
      if (name) setPreferredName(name)
      if (useCase || name) {
        setSummaryItems((prev) => {
          const label = t("onboarding.youIntroducedYourself")
          return prev.includes(label) ? prev : [...prev, label]
        })
      }
      goNext()
    },
    [goNext, t],
  )

  const handleModelComplete = useCallback(
    ({ providerName }: { providerName: string }) => {
      setSummaryItems((prev) => {
        const label = t("onboarding.modelConnected", { provider: providerName })
        return prev.includes(label) ? prev : [label, ...prev]
      })
      goNext()
    },
    [goNext, t],
  )

  // ── Footer button handlers ─────────────────────────────────────────────────

  const handleFooterContinue = useCallback(() => {
    continueHandlerRef.current?.()
  }, [])

  const handleFooterSkip = useCallback(() => {
    setCurrentStep(DONE_STEP)
  }, [DONE_STEP])

  // ── Derived values ─────────────────────────────────────────────────────────

  const agentName = initData?.defaultAgent?.name || initData?.defaultAgent?.fullName || "Iria"
  const agentAvatarUrl = initData?.defaultAgent?.avatarUrl

  // ── Loading / Error states ─────────────────────────────────────────────────

  if (initLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 16 }}>
        <AppSpinner size="lg" />
        <T step="sm" tone="text2">
          {t("onboarding.loadingTeros")}
        </T>
      </View>
    )
  }

  if (initError) {
    return (
      <View
        style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32 }}
      >
        <View
          style={[
            {
              width: "100%",
              maxWidth: 416,
              borderRadius: 24,
              backgroundColor: c.bgStep,
              padding: 36,
              gap: 12,
            },
            Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
          ]}
        >
          <T step="xl">{t("onboarding.somethingWentWrong")}</T>
          <T step="sm" tone="text2" style={{ lineHeight: 19 }}>
            {initError}
          </T>
          <View style={{ flexDirection: "row", marginTop: 8 }}>
            <Btn variant="primary" size="md" icon="arrow-clockwise" onPress={load}>
              {t("onboarding.tryAgain")}
            </Btn>
          </View>
        </View>
      </View>
    )
  }

  // ── Card content ───────────────────────────────────────────────────────────

  const showFooter = footerConfig.continueLabel !== "" || footerConfig.specialCta

  const cardContent = (
    <View
      style={[
        {
          flex: isDesktop ? undefined : 1,
          width: "100%",
          maxWidth: isDesktop ? 560 : undefined,
          height: isDesktop ? Math.min(windowHeight - 64, 720) : undefined,
          backgroundColor: isDesktop ? c.bgStep : c.bgSheet,
          borderRadius: isDesktop ? 24 : 0,
          overflow: "hidden",
        },
        Platform.OS === "web" && isDesktop ? ({ boxShadow: c.elevRaised } as any) : null,
      ]}
      testID="onboarding-card"
    >
      {/* Progress — fixed top */}
      <OnboardingProgress steps={STEPS} currentStep={currentStep} />

      {/* Agent header — hidden on welcome step; WelcomeStep owns that real estate */}
      {stepId !== "welcome" && (
        <AgentHeader agentName={agentName} avatarUrl={agentAvatarUrl} stepId={stepId} />
      )}

      {/* ScrollView — SINGLE, contains step content only */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 28,
          paddingTop: 22,
          paddingBottom: 24,
          gap: 20,
          flexGrow: 1,
        }}
      >
        {/* WelcomeStep only mounts after splash completes — nothing to flash through */}
        {stepId === "welcome" && splashDone && (
          <WelcomeStep
            steps={steps}
            agentName={agentName}
            agentAvatarUrl={agentAvatarUrl}
            animateIn
            setFooterConfig={setFooterConfig}
            registerContinueHandler={registerContinueHandler}
            onComplete={goNext}
          />
        )}
        {stepId === "model" && (
          <ModelStep
            agentName={agentName}
            agentAvatarUrl={agentAvatarUrl}
            onComplete={handleModelComplete}
            setFooterConfig={setFooterConfig}
            registerContinueHandler={registerContinueHandler}
          />
        )}
        {stepId === "about" && (
          <AgentStep
            defaultAgent={initData?.defaultAgent ?? null}
            agentName={agentName}
            agentAvatarUrl={agentAvatarUrl}
            onComplete={handleAgentComplete}
            onSkip={() => setCurrentStep(DONE_STEP)}
            onBack={goBack}
            setFooterConfig={setFooterConfig}
            registerContinueHandler={registerContinueHandler}
          />
        )}
        {stepId === "done" && (
          <DoneStep
            userName={preferredName || userName}
            agentName={agentName}
            agentAvatarUrl={agentAvatarUrl}
            defaultAgentId={initData?.defaultAgent?.agentId ?? null}
            summaryItems={summaryItems}
            onFinish={onFinish}
            setFooterConfig={setFooterConfig}
          />
        )}
      </ScrollView>

      {/* Footer — fixed bottom, OUTSIDE scroll */}
      {showFooter && (
        <View style={{ paddingHorizontal: 28, paddingBottom: 28, paddingTop: 12 }}>
          <StepFooter
            config={footerConfig}
            onBack={goBack}
            onSkip={handleFooterSkip}
            onContinue={handleFooterContinue}
          />
        </View>
      )}
    </View>
  )

  // ── Responsive layout ──────────────────────────────────────────────────────

  const splashOverlay =
    stepId === "welcome" && !splashDone ? (
      <WelcomeSplash exitPosY={splashExitY} onDone={() => setSplashDone(true)} />
    ) : null

  if (isDesktop) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: 32,
          position: "relative",
        }}
      >
        {cardContent}
        {splashOverlay}
      </View>
    )
  }

  // Mobile: no landscape wrapper, no external ScrollView
  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet, position: "relative" }}>
      {cardContent}
      {splashOverlay}
    </View>
  )
}
