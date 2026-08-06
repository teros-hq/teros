/**
 * OnboardingWizard — Orchestrates the onboarding flow
 *
 * Flow (post-simplification): welcome → agent → apps → access → done.
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
import { useWindowDimensions } from "react-native"
import { ScrollView, Text, YStack } from "tamagui"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { AppData } from "../../services/AppApi"
import { TerosLoading } from "../TerosLoading"
import { colors as semanticColors } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"
import { AgentHeader } from "./AgentHeader"
import { OnboardingProgress, type OnboardingStep } from "./OnboardingProgress"
import { StepFooter, type StepFooterConfig } from "./StepFooter"
import { AccessStep } from "./steps/AccessStep"
import { AgentStep } from "./steps/AgentStep"
import { AppsStep } from "./steps/AppsStep"
import { DoneStep } from "./steps/DoneStep"
import { WelcomeStep } from "./steps/WelcomeStep"
import { WelcomeSplash } from "./WelcomeSplash"

// Exported (with STEP_IDS) so onboardingStepAlignment.render.test.tsx can assert
// the step-indexed arrays here and in AgentHeader stay the same length.
export const STEP_LABEL_KEYS = [
  "onboarding.stepWelcome",
  "onboarding.stepAboutYou",
  "onboarding.stepApps",
  "onboarding.stepAccess",
  "onboarding.stepDone",
]

export const STEP_IDS = ["welcome", "agent", "apps", "access", "done"]

// Apps is the only step whose "skip" needs to clear transient state.
const APPS_STEP = STEP_IDS.indexOf("apps")

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
  installedApps: AppData[]
  catalogMcaIds: Set<string>
  alreadyGrantedAppIds: string[]
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
  const STEPS: OnboardingStep[] = STEP_IDS.map((id, i) => ({ id, label: t(STEP_LABEL_KEYS[i]) }))
  const DONE_STEP = STEPS.length - 1
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
  const [installedAppIds, setInstalledAppIds] = useState<string[]>([])
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
      const [{ agents }, { apps: installedApps }, { catalog }] = await Promise.all([
        client.agent.listAgents(),
        client.app.listApps(),
        client.app.listCatalog(),
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

      let alreadyGrantedAppIds: string[] = []
      if (defaultAgent) {
        try {
          const { apps: agentApps } = await client.agent.getApps(defaultAgent.agentId)
          alreadyGrantedAppIds = agentApps.filter((a: any) => a.hasAccess).map((a: any) => a.appId)
        } catch (err) {
          console.warn("[OnboardingWizard] Failed to load agent app access:", err)
        }
      }

      setInitData({
        defaultAgent,
        installedApps,
        catalogMcaIds: new Set(catalog.map((c: any) => c.mcaId)),
        alreadyGrantedAppIds,
      })
    } catch (err: any) {
      console.error("[OnboardingWizard] Init load failed:", err)
      setInitError(err?.message || t('onboarding.somethingWentWrong'))
    } finally {
      setInitLoading(false)
    }
  }, [])

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

  const goNext = useCallback(() => {
    setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1))
  }, [])

  const goBack = useCallback(() => {
    setCurrentStep((s) => Math.max(s - 1, 0))
  }, [])

  // ── Step completion handlers ───────────────────────────────────────────────

  const handleAgentComplete = useCallback(
    ({ useCase, preferredName: name }: { useCase: string | null; preferredName: string }) => {
      if (name) setPreferredName(name)
      if (useCase || name) {
        setSummaryItems((prev) => {
          const label = t('onboarding.youIntroducedYourself')
          return prev.includes(label) ? prev : [...prev, label]
        })
      }
      goNext()
    },
    [goNext, t],
  )

  const handleAppsComplete = useCallback(
    async (appIds: string[]) => {
      setInstalledAppIds(appIds)
      if (appIds.length > 0) {
        setSummaryItems((prev) => {
          const label = t('onboarding.appsInstalledCount', { count: appIds.length })
          const filtered = prev.filter((i) => !i.includes("app") || !i.includes("installed"))
          return [...filtered, label]
        })
        // Refresh installedApps so AccessStep sees apps installed during this session (REQ-14)
        try {
          const { apps: freshApps } = await client.app.listApps()
          setInitData((prev) => (prev ? { ...prev, installedApps: freshApps } : prev))
        } catch (err) {
          console.warn("[OnboardingWizard] Failed to refresh apps after install:", err)
        }
        goNext()
      } else {
        // No apps installed → access step is moot, jump to Done.
        setCurrentStep(DONE_STEP)
      }
    },
    [goNext, client, t, DONE_STEP],
  )

  const handleAppsSkip = useCallback(() => {
    setInstalledAppIds([])
    setCurrentStep(DONE_STEP)
  }, [DONE_STEP])

  const handleAccessComplete = useCallback(() => {
    setSummaryItems((prev) => {
      const label = t('onboarding.accessConfigured')
      return prev.includes(label) ? prev : [...prev, label]
    })
    goNext()
  }, [goNext, t])

  // ── Footer button handlers ─────────────────────────────────────────────────

  const handleFooterContinue = useCallback(() => {
    continueHandlerRef.current?.()
  }, [])

  const handleFooterSkip = useCallback(() => {
    if (currentStep === APPS_STEP) setInstalledAppIds([])
    setCurrentStep(DONE_STEP)
  }, [currentStep, DONE_STEP])

  // ── Derived values ─────────────────────────────────────────────────────────

  const agentName = initData?.defaultAgent?.name || initData?.defaultAgent?.fullName || "Iria"
  const agentAvatarUrl = initData?.defaultAgent?.avatarUrl

  // ── Loading / Error states ─────────────────────────────────────────────────

  if (initLoading) {
    return (
      <YStack
        flex={1}
        backgroundColor={c.bgPage}
        justifyContent="center"
        alignItems="center"
        gap={16}
      >
        <TerosLoading size={48} color={semanticColors.indigo} />
        <Text color={c.text2} fontSize={14}>
          {t('onboarding.loadingTeros')}
        </Text>
      </YStack>
    )
  }

  if (initError) {
    return (
      <YStack
        flex={1}
        backgroundColor={c.bgPage}
        justifyContent="center"
        alignItems="center"
        gap={16}
        paddingHorizontal={32}
      >
        <Text fontSize={16} fontWeight="600" color={c.text} textAlign="center">
          {t('onboarding.somethingWentWrong')}
        </Text>
        <Text fontSize={14} color={c.text2} textAlign="center" lineHeight={22}>
          {initError}
        </Text>
        <YStack
          paddingHorizontal={20}
          paddingVertical={10}
          borderRadius={8}
          borderWidth={1}
          borderColor={`${semanticColors.indigo}66`}
          backgroundColor={semanticColors.indigoGlow}
          cursor="pointer"
          pressStyle={{ opacity: 0.7 }}
          onPress={load}
        >
          <Text color={semanticColors.indigo} fontSize={14} fontWeight="600">
            {t('onboarding.tryAgain')}
          </Text>
        </YStack>
      </YStack>
    )
  }

  // ── Card content ───────────────────────────────────────────────────────────

  const showFooter = footerConfig.continueLabel !== "" || footerConfig.specialCta

  const cardContent = (
    <YStack
      flex={isDesktop ? undefined : 1}
      width="100%"
      maxWidth={isDesktop ? 560 : undefined}
      height={isDesktop ? Math.min(windowHeight - 64, 700) : undefined}
      backgroundColor={isDesktop ? c.bgCard : c.bgPage}
      borderRadius={isDesktop ? 16 : 0}
      borderWidth={isDesktop ? 1 : 0}
      borderColor={c.border}
      overflow="hidden"
    >
      {/* Progress — fixed top */}
      <OnboardingProgress steps={STEPS} currentStep={currentStep} />

      {/* Agent header — hidden on welcome step; WelcomeStep owns that real estate */}
      {currentStep > 0 && (
        <AgentHeader agentName={agentName} avatarUrl={agentAvatarUrl} currentStep={currentStep} />
      )}

      {/* ScrollView — SINGLE, contains step content only */}
      <ScrollView
        ref={scrollRef}
        flex={1}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 24, gap: 20, flexGrow: 1 }}
      >
        {/* WelcomeStep only mounts after splash completes — nothing to flash through */}
        {currentStep === 0 && splashDone && (
          <WelcomeStep
            agentName={agentName}
            agentAvatarUrl={agentAvatarUrl}
            animateIn
            setFooterConfig={setFooterConfig}
            registerContinueHandler={registerContinueHandler}
            onComplete={goNext}
          />
        )}
        {currentStep === 1 && (
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
        {currentStep === 2 && (
          <AppsStep
            installedApps={initData?.installedApps ?? []}
            catalogMcaIds={initData?.catalogMcaIds ?? new Set()}
            agentName={agentName}
            agentAvatarUrl={agentAvatarUrl}
            onComplete={handleAppsComplete}
            onSkip={handleAppsSkip}
            onBack={goBack}
            setFooterConfig={setFooterConfig}
            registerContinueHandler={registerContinueHandler}
          />
        )}
        {currentStep === 3 && (
          <AccessStep
            installedAppIds={installedAppIds}
            installedApps={initData?.installedApps ?? []}
            alreadyGrantedAppIds={initData?.alreadyGrantedAppIds ?? []}
            defaultAgentId={initData?.defaultAgent?.agentId ?? null}
            agentName={agentName}
            agentAvatarUrl={agentAvatarUrl}
            onComplete={handleAccessComplete}
            onSkip={() => setCurrentStep(DONE_STEP)}
            onBack={goBack}
            setFooterConfig={setFooterConfig}
            registerContinueHandler={registerContinueHandler}
          />
        )}
        {currentStep === DONE_STEP && (
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
        <YStack paddingHorizontal={24} paddingBottom={24} paddingTop={12}>
          <StepFooter
            config={footerConfig}
            onBack={goBack}
            onSkip={handleFooterSkip}
            onContinue={handleFooterContinue}
          />
        </YStack>
      )}
    </YStack>
  )

  // ── Responsive layout ──────────────────────────────────────────────────────

  const splashOverlay =
    currentStep === 0 && !splashDone ? (
      <WelcomeSplash exitPosY={splashExitY} onDone={() => setSplashDone(true)} />
    ) : null

  if (isDesktop) {
    return (
      <YStack
        flex={1}
        backgroundColor={c.bgPage}
        justifyContent="center"
        alignItems="center"
        padding={32}
        position="relative"
      >
        {cardContent}
        {splashOverlay}
      </YStack>
    )
  }

  // Mobile: no landscape wrapper, no external ScrollView
  return (
    <YStack flex={1} backgroundColor={c.bgPage} position="relative">
      {cardContent}
      {splashOverlay}
    </YStack>
  )
}
