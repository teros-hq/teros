/**
 * ProfileWindowContent - Contenido de la ventana de perfil
 *
 * OS prototype vocabulary (design-testing): a Page on the sheet with a
 * PageHead ("Cuenta" eyebrow · serif name · email lead), an identity Card
 * (mint human avatar, name, email, member-since, badges), Stats, the
 * achievement cards, an LGroup of account rows (edit · plan · help ·
 * theme), the improve-Teros opt-in, a danger zone (sign out) isolated
 * at the bottom, and a quiet delete-account link by the version footer.
 * Edit mode swaps in a form Card.
 */

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from "react-native"
import { useTranslation } from "react-i18next"
import i18n, { SUPPORTED_LOCALES, LOCALE_LABELS, type SupportedLocale } from "../../i18n"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useAuthStore } from "../../store/authStore"
import { useTilingStore } from "../../store/tilingStore"
import { useUiPreferencesStore } from "../../store/uiPreferencesStore"
import type { ProfileWindowProps } from "./definition"
import { FullscreenLoader } from "../../components/ui"
import { ProfilePlanSection } from "./ProfilePlanSection"
import { ProfileImproveTerosSection } from "./ProfileImproveTerosSection"
import { ProfileConversationSummarySection } from "./ProfileConversationSummarySection"
import { DeleteAccountDialog } from "./DeleteAccountDialog"
import { useColors } from "../../components/mca/primitives/useColors"
import { useImageWithFallback } from "../../hooks/useImageWithFallback"
import { Avatar } from "../../components/Avatar"
import {
  Badge,
  Btn,
  Card,
  ChipBtn,
  DangerZone,
  Field,
  FieldHelp,
  FieldLabel,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  Segmented,
  Stat,
  Stats,
  T,
  Tile,
} from "../../components/ui/ds"
import { backendUrl } from "../../config/runtime"

// ── Badge image sub-component (needs its own hook state per badge) ─────────────

function BadgeImage({ imageUrl, alt }: { imageUrl: string; alt: string }) {
  const c = useColors()
  const { showImage, onError } = useImageWithFallback(imageUrl)
  if (Platform.OS === "web" && showImage) {
    return (
      <img
        src={imageUrl}
        alt={alt}
        style={{
          width: 64,
          height: 64,
          objectFit: "contain",
        }}
        onError={onError}
      />
    )
  }
  // Fallback: simple placeholder box (same as non-web branch)
  return <View style={{ width: 64, height: 64, backgroundColor: c.wash2, borderRadius: 8 }} />
}

interface Props extends ProfileWindowProps {
  windowId: string
}

// Badge data type
interface Badge {
  id: string
  titleKey: string
  descriptionKey: string
  reasonKey: string
  imageUrl: string
  gradientColors: [string, string]
  borderColor: string
  backgroundColors: [string, string]
}

// Backend URL for static assets
const BACKEND_URL = backendUrl()

// Achievement badges - mapped to kawaii images
const BADGES: Badge[] = [
  // === Status Badges ===
  {
    id: "founder",
    titleKey: "badges.founder.title",
    descriptionKey: "badges.founder.description",
    reasonKey: "badges.founder.reason",
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/05-lion-rockstar.webp`,
    gradientColors: ["#8B5CF6", "#7C3AED"],
    borderColor: "rgba(139, 92, 246, 0.3)",
    backgroundColors: ["rgba(139, 92, 246, 0.1)", "rgba(124, 58, 237, 0.08)"],
  },
  {
    id: "early-adopter",
    titleKey: "badges.earlyAdopter.title",
    descriptionKey: "badges.earlyAdopter.description",
    reasonKey: "badges.earlyAdopter.reason",
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/02-fox-programmer.webp`,
    gradientColors: ["#F59E0B", "#D97706"],
    borderColor: "rgba(245, 158, 11, 0.3)",
    backgroundColors: ["rgba(245, 158, 11, 0.1)", "rgba(217, 119, 6, 0.08)"],
  },

  // === Usage Badges ===
  {
    id: "first-steps",
    titleKey: "badges.firstSteps.title",
    descriptionKey: "badges.firstSteps.description",
    reasonKey: "badges.firstSteps.reason",
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/01-koala-barista.webp`,
    gradientColors: ["#06B6D4", "#0891B2"],
    borderColor: "rgba(6, 182, 212, 0.3)",
    backgroundColors: ["rgba(6, 182, 212, 0.1)", "rgba(8, 145, 178, 0.08)"],
  },
  {
    id: "power-user",
    titleKey: "badges.powerUser.title",
    descriptionKey: "badges.powerUser.description",
    reasonKey: "badges.powerUser.reason",
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/04-octopus-dj.webp`,
    gradientColors: ["#EC4899", "#DB2777"],
    borderColor: "rgba(236, 72, 153, 0.3)",
    backgroundColors: ["rgba(236, 72, 153, 0.1)", "rgba(219, 39, 119, 0.08)"],
  },
  {
    id: "super-user",
    titleKey: "badges.superUser.title",
    descriptionKey: "badges.superUser.description",
    reasonKey: "badges.superUser.reason",
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/07-shark-surfer.webp`,
    gradientColors: ["#3B82F6", "#2563EB"],
    borderColor: "rgba(59, 130, 246, 0.3)",
    backgroundColors: ["rgba(59, 130, 246, 0.1)", "rgba(37, 99, 235, 0.08)"],
  },

  // === Contribution Badges ===
  {
    id: "bug-hunter",
    titleKey: "badges.bugHunter.title",
    descriptionKey: "badges.bugHunter.description",
    reasonKey: "badges.bugHunter.reason",
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/08-frog-scientist.webp`,
    gradientColors: ["#84CC16", "#65A30D"],
    borderColor: "rgba(132, 204, 22, 0.3)",
    backgroundColors: ["rgba(132, 204, 22, 0.1)", "rgba(101, 163, 13, 0.08)"],
  },
  {
    id: "feature-requester",
    titleKey: "badges.visionary.title",
    descriptionKey: "badges.visionary.description",
    reasonKey: "badges.visionary.reason",
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/03-owl-wizard.webp`,
    gradientColors: ["#8B5CF6", "#7C3AED"],
    borderColor: "rgba(139, 92, 246, 0.3)",
    backgroundColors: ["rgba(139, 92, 246, 0.1)", "rgba(124, 58, 237, 0.08)"],
  },
  {
    id: "beta-tester",
    titleKey: "badges.betaTester.title",
    descriptionKey: "badges.betaTester.description",
    reasonKey: "badges.betaTester.reason",
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/06-panda-chef.webp`,
    gradientColors: ["#10B981", "#059669"],
    borderColor: "rgba(16, 185, 129, 0.3)",
    backgroundColors: ["rgba(16, 185, 129, 0.1)", "rgba(5, 150, 105, 0.08)"],
  },
]

// Helper: calculate days since a date string
function daysSince(dateStr: string): number {
  const created = new Date(dateStr).getTime()
  const now = Date.now()
  return Math.floor((now - created) / (1000 * 60 * 60 * 24))
}
export function ProfileWindowContent({ windowId, onLogout, initialMode }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const { width } = useWindowDimensions()
  const narrow = width <= 620
  const theme = useUiPreferencesStore((s) => s.theme)
  const setTheme = useUiPreferencesStore((s) => s.setTheme)
  const { user, logout, updateProfile } = useAuthStore()
  const client = getTerosClient()
  const { openWindow } = useTilingStore()
  const [activeIndex, setActiveIndex] = useState(0)
  const carouselRef = useRef<ScrollView>(null)

  // View mode: 'view', 'edit' or 'plan' (billing). Can be opened straight on a
  // section via the initialMode prop (e.g. 'plan' from the hours-exhausted CTA).
  const [mode, setMode] = useState<"view" | "edit" | "plan">(initialMode ?? "view")
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  // Stats state
  const [channelCount, setChannelCount] = useState<number | null>(null)
  const [agentCount, setAgentCount] = useState<number | null>(null)

  // Badges from profile
  const [userBadges, setUserBadges] = useState<Array<"founding_partner" | "early_bird">>([])

  // "Help improve Teros" opt-in (anonymized conversation evaluation), default OFF
  const [evaluationOptIn, setEvaluationOptIn] = useState(false)

  // Form state for edit mode
  const [displayName, setDisplayName] = useState(user?.name || "")
  const [description, setDescription] = useState(user?.description || "")
  const [locale, setLocale] = useState(user?.locale || "")
  const [timezone, setTimezone] = useState(user?.timezone || "")

  // Load profile and stats on mount — each call is independent so a stats
  // failure never prevents the profile from rendering (and vice-versa).
  // If the WebSocket is not yet connected we wait for the "connected" event
  // before making the requests (handles hard-reload with profile open).
  useEffect(() => {
    let cancelled = false

    /** Wait until the WS client is connected, then resolve. */
    function waitForConnection(): Promise<void> {
      if (client.isConnected()) return Promise.resolve()
      return new Promise((resolve) => {
        const onConnected = () => {
          client.off("connected", onConnected)
          resolve()
        }
        client.on("connected", onConnected)
      })
    }

    async function loadProfile() {
      try {
        await waitForConnection()
        if (cancelled) return
        const profile = await client.profile.getProfile()
        if (cancelled) return
        updateProfile({
          name: profile.displayName,
          avatarUrl: profile.avatarUrl,
          description: profile.description,
          locale: profile.locale,
          timezone: profile.timezone,
          createdAt: profile.createdAt,
        })
        setDisplayName(profile.displayName || "")
        setDescription(profile.description || "")
        setLocale(profile.locale || "")
        setTimezone(profile.timezone || "")
        setUserBadges(profile.badges ?? [])
        setEvaluationOptIn(profile.consent?.evaluationOptIn ?? false)
      } catch (err) {
        console.error("Failed to load profile:", err)
      }
    }

    async function loadStats() {
      try {
        await waitForConnection()
        if (cancelled) return
        const stats = await client.profile.getStats()
        if (cancelled) return
        setChannelCount(stats.channelCount)
        setAgentCount(stats.agentCount)
      } catch (err) {
        console.error("Failed to load stats:", err)
      }
    }

    async function loadProfileAndStats() {
      // Run both independently — a failure in one does not affect the other.
      await Promise.all([loadProfile(), loadStats()])
      if (!cancelled) setIsLoading(false)
    }

    loadProfileAndStats()

    return () => {
      cancelled = true
    }
  }, [])

  // Sync form when entering edit mode
  useEffect(() => {
    if (mode === "edit" && user) {
      setDisplayName(user.name || "")
      setDescription(user.description || "")
      setLocale(user.locale || "")
      setTimezone(user.timezone || "")
    }
  }, [mode])

  const handleLogout = async () => {
    await logout()
    onLogout?.()
  }

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)

    // Capture original locale before saving to detect changes
    const originalLocale = user?.locale

    try {
      const profile = await client.profile.updateProfile({
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
        locale: locale.trim() || undefined,
        timezone: timezone.trim() || undefined,
      })

      updateProfile({
        name: profile.displayName,
        avatarUrl: profile.avatarUrl,
        description: profile.description,
        locale: profile.locale,
        timezone: profile.timezone,
      })

      setIsSaving(false)
      setSaveSuccess(true)

      // If locale changed, apply immediately via i18n and reload to flush all state
      if (profile.locale && profile.locale !== originalLocale) {
        i18n.changeLanguage(profile.locale)
        setTimeout(() => {
          if (Platform.OS === "web") {
            // Web: full page reload flushes all cached strings
            window.location.reload()
          } else {
            // Native: i18n.changeLanguage() is reactive — UI updates without reload.
            // expo-updates reloadAsync() is intentionally NOT used here: it would
            // restart the JS bundle and lose all in-memory state. The reactive
            // i18n update is sufficient for native.
            setSaveSuccess(false)
            setMode("view")
          }
        }, 500)
      } else {
        setTimeout(() => {
          setSaveSuccess(false)
          setMode("view")
        }, 1000)
      }
    } catch (err) {
      console.error("Failed to update profile:", err)
      setError(t("profile.saveError"))
      setIsSaving(false)
    }
  }

  if (!user) {
    return (
      <Page narrow>
        <T step="sm" tone="text2" center style={{ padding: 32 }}>
          {t("profile.noActiveSession")}
        </T>
      </Page>
    )
  }

  if (isLoading) {
    return <FullscreenLoader label={t("profile.loadingProfile")} />
  }

  const visibleBadges = BADGES.filter((badge) => {
    if (badge.id === "founder") return userBadges.includes("founding_partner")
    if (badge.id === "early-adopter") return userBadges.includes("early_bird")
    return false
  })

  const handleScroll = (event: any) => {
    const scrollX = event.nativeEvent.contentOffset.x
    const cardWidth = event.nativeEvent.layoutMeasurement.width - 48
    const newIndex = Math.round(scrollX / cardWidth)
    if (newIndex !== activeIndex && newIndex >= 0 && newIndex < visibleBadges.length) {
      setActiveIndex(newIndex)
    }
  }

  const scrollToIndex = (index: number) => {
    carouselRef.current?.scrollTo({ x: index * 320, animated: true })
    setActiveIndex(index)
  }

  const memberSince = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(i18n.language, { month: "long", year: "numeric" })
    : ""

  // Derived stats array with real data
  const daysOnPlatform = user.createdAt ? daysSince(user.createdAt) : 0
  const STATS = [
    {
      value: channelCount !== null ? String(channelCount) : "–",
      label: t("profile.statChats"),
      icon: "chats",
    },
    {
      value: agentCount !== null ? String(agentCount) : "–",
      label: t("profile.statAgents"),
      icon: "users-three",
    },
    { value: String(daysOnPlatform), label: t("profile.statDays"), icon: "clock" },
  ]

  const displayLabel = user.name || t("profile.fallbackName")

  // ========================================
  // PLAN / BILLING MODE
  // ========================================
  if (mode === "plan") {
    return <ProfilePlanSection onBack={() => setMode("view")} />
  }

  // ========================================
  // EDIT MODE
  // ========================================
  if (mode === "edit") {
    return (
      <Page narrow>
        <PageHead
          eyebrow={t("nav.account", { defaultValue: "Account" })}
          title={t("profile.editProfile")}
          lead={t("profile.editProfileSub")}
          actions={
            <>
              <Btn
                variant="ghost"
                icon="arrow-left"
                onPress={() => setMode("view")}
                disabled={isSaving}
              >
                {t("common.cancel")}
              </Btn>
              <Btn
                variant={saveSuccess ? "mint" : "primary"}
                icon={saveSuccess ? "check" : "floppy-disk"}
                onPress={handleSave}
                disabled={isSaving}
                loading={isSaving}
                testID="profile-save"
              >
                {saveSuccess ? t("common.saved") : t("common.save")}
              </Btn>
            </>
          }
        />

        {/* Error message */}
        {error && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              padding: 12,
              paddingHorizontal: 14,
              borderRadius: 10,
              backgroundColor: c.tint.r.bg,
              borderWidth: 1,
              borderColor: c.tint.r.bd,
              marginBottom: 16,
            }}
          >
            <Ph name="warning-circle" size={16} color={c.tint.r.tx} />
            <T step="sm" color={c.tint.r.tx} style={{ flex: 1 }}>
              {error}
            </T>
          </View>
        )}

        <Card pad>
          {/* Avatar preview */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 20 }}>
            <Avatar name={displayName || user.email} imageUrl={user.avatarUrl} size={64} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T step="hsm" ellipsis>
                {displayName || displayLabel}
              </T>
              <T step="12" tone="text3" ellipsis>
                {user.email}
              </T>
            </View>
          </View>

          <FieldLabel
            right={
              <T step="codenote" tone="text3">
                {displayName.length}/100
              </T>
            }
          >
            {t("profile.labelName")}
          </FieldLabel>
          <Field
            icon="user"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder={t("profile.namePlaceholder")}
            maxLength={100}
          />

          <View style={{ marginTop: 16 }}>
            <FieldLabel
              right={
                <T step="codenote" tone="text3">
                  {description.length}/1000
                </T>
              }
            >
              {t("profile.labelDescription")}
            </FieldLabel>
            <Field
              area
              minHeight={110}
              value={description}
              onChangeText={setDescription}
              placeholder={t("profile.descriptionPlaceholder")}
              maxLength={1000}
            />
            <FieldHelp>{t("profile.descriptionHint")}</FieldHelp>
          </View>

          {/* Language picker — fixed list of supported locales */}
          <View style={{ marginTop: 16 }}>
            <FieldLabel>{t("profile.labelLanguage")}</FieldLabel>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {SUPPORTED_LOCALES.map((loc) => (
                <ChipBtn
                  key={loc}
                  lg
                  icon={locale === loc ? "check" : "translate"}
                  on={locale === loc}
                  onPress={() => setLocale(loc as SupportedLocale)}
                >
                  {LOCALE_LABELS[loc]}
                </ChipBtn>
              ))}
            </View>
          </View>

          <View style={{ marginTop: 16 }}>
            <FieldLabel
              right={
                <T step="codenote" tone="text3">
                  {timezone.length}/50
                </T>
              }
            >
              {t("profile.labelTimezone")}
            </FieldLabel>
            <Field
              icon="clock"
              value={timezone}
              onChangeText={setTimezone}
              placeholder={t("profile.timezonePlaceholder")}
              maxLength={50}
            />
          </View>
        </Card>
      </Page>
    )
  }

  // ========================================
  // VIEW MODE
  // ========================================
  return (
    <View style={{ flex: 1 }}>
      <Page narrow>
        <PageHead
          eyebrow={t("nav.account", { defaultValue: "Account" })}
          title={displayLabel}
          lead={user.email}
          actions={
            <Btn variant="sec" icon="pencil-simple" onPress={() => setMode("edit")}>
              {t("profile.editProfile")}
            </Btn>
          }
        />

        {/* Identity card */}
        <Card pad={20} style={{ marginBottom: 16 }}>
          <View
            style={{
              flexDirection: narrow ? "column" : "row",
              alignItems: narrow ? "flex-start" : "center",
              gap: 18,
            }}
          >
            <Avatar name={displayLabel} imageUrl={user.avatarUrl} size={72} />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <T step="xl" ellipsis>
                {displayLabel}
              </T>
              <T step="sm" tone="text2" ellipsis>
                {user.email}
              </T>
              {memberSince ? (
                <T step="codenote" tone="text3">
                  {t("profile.memberSince", { date: memberSince })}
                </T>
              ) : null}
              {user.description ? (
                <T step="sm" tone="text2" numberOfLines={3} style={{ marginTop: 6 }}>
                  {user.description}
                </T>
              ) : null}
            </View>
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 6,
                alignSelf: narrow ? "flex-start" : "center",
              }}
            >
              {user.locale ? (
                <Badge mono icon="translate">
                  {LOCALE_LABELS[user.locale as SupportedLocale] ?? user.locale}
                </Badge>
              ) : null}
              {user.timezone ? (
                <Badge mono icon="clock">
                  {user.timezone}
                </Badge>
              ) : null}
            </View>
          </View>
        </Card>

        {/* Stats */}
        <Stats cols={3} style={{ marginBottom: 12 }}>
          {STATS.map((stat) => (
            <Stat key={stat.label} v={stat.value} label={stat.label} />
          ))}
        </Stats>

        {/* Achievement cards - shown only if user has badges */}
        {visibleBadges.length > 0 && (
          <View style={{ marginBottom: 20 }}>
            <SectionLabel
              label={t("windows.usersPanel.detail.meta.badges", { defaultValue: "Badges" })}
              count={visibleBadges.length}
            />
            <ScrollView
              ref={carouselRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              snapToInterval={320}
              decelerationRate="fast"
              contentContainerStyle={{ gap: 10, paddingVertical: 4 }}
              onScroll={handleScroll}
              scrollEventThrottle={16}
            >
              {visibleBadges.map((badge) => (
                <Card key={badge.id} pad={16} style={{ width: 310 }}>
                  <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-start" }}>
                    <View
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 16,
                        backgroundColor: c.wash,
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                        flexShrink: 0,
                      }}
                    >
                      <BadgeImage imageUrl={badge.imageUrl} alt={t(badge.titleKey)} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T step="hsm">{t(badge.titleKey)}</T>
                      <T step="12" tone="text2" style={{ marginTop: 4 }}>
                        {t(badge.descriptionKey)}
                      </T>
                    </View>
                  </View>
                  <View
                    style={{
                      marginTop: 12,
                      paddingTop: 10,
                      borderTopWidth: 1,
                      borderTopColor: c.border,
                    }}
                  >
                    <T step="codenote" tone="text3">
                      {t(badge.reasonKey)}
                    </T>
                  </View>
                </Card>
              ))}
            </ScrollView>

            {visibleBadges.length > 1 && (
              <View
                style={{ flexDirection: "row", justifyContent: "center", gap: 6, marginTop: 12 }}
              >
                {visibleBadges.map((_, index) => (
                  <View
                    key={index}
                    onTouchEnd={() => scrollToIndex(index)}
                    {...(Platform.OS === "web"
                      ? ({ onClick: () => scrollToIndex(index) } as any)
                      : {})}
                    style={[
                      {
                        width: activeIndex === index ? 20 : 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: activeIndex === index ? c.accent : c.borderStrong,
                      },
                      Platform.OS === "web"
                        ? ({ cursor: "pointer", transition: "width 0.3s" } as any)
                        : null,
                    ]}
                  />
                ))}
              </View>
            )}
          </View>
        )}

        {/* Account rows */}
        <SectionLabel label={t("nav.account", { defaultValue: "Account" })} />
        <LGroup style={{ marginBottom: 16 }}>
          <LRow hov onPress={() => setMode("edit")}>
            <Tile sm icon="pencil-simple" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T step="sm">{t("profile.editProfile")}</T>
              <T step="12" tone="text3">
                {t("profile.editProfileSub")}
              </T>
            </View>
            <Ph name="caret-right" size={14} color={c.text3} />
          </LRow>
          <LRow hov onPress={() => setMode("plan")} testID="profile-open-plan">
            <Tile sm icon="credit-card" tone="mint" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T step="sm">{t("profile.plan.entryTitle")}</T>
              <T step="12" tone="text3">
                {t("profile.plan.entrySub")}
              </T>
            </View>
            <Ph name="caret-right" size={14} color={c.text3} />
          </LRow>
          <LRow hov>
            <Tile sm icon="question" tone="amber" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T step="sm">{t("profile.help")}</T>
              <T step="12" tone="text3">
                {t("profile.helpSub")}
              </T>
            </View>
            <Ph name="caret-right" size={14} color={c.text3} />
          </LRow>
          <LRow>
            <Tile sm icon={theme === "dark" ? "moon" : "sun"} tone="muted" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T step="sm">{t("profile.theme", { defaultValue: "Theme" })}</T>
              <T step="12" tone="text3">
                {t("profile.themeSub", { defaultValue: "Light or dark interface" })}
              </T>
            </View>
            <Segmented
              value={theme}
              onChange={(k) => setTheme(k)}
              items={[
                {
                  key: "light",
                  label: t("profile.themeLight", { defaultValue: "Light" }),
                  icon: "sun",
                },
                {
                  key: "dark",
                  label: t("profile.themeDark", { defaultValue: "Dark" }),
                  icon: "moon",
                },
              ]}
              style={{ width: 170 }}
            />
          </LRow>
        </LGroup>

        {/* Conversations — the agent's summary on a new chat (CSUM-REQ-3) */}
        <View style={{ marginBottom: 16 }}>
          <SectionLabel label={t("profile.conversationSummary.section")} />
          <ProfileConversationSummarySection />
        </View>

        {/* Help improve Teros — anonymized evaluation opt-in (default OFF) */}
        <View style={{ marginBottom: 16 }}>
          <SectionLabel label={t("profile.improveTeros.section")} />
          <ProfileImproveTerosSection
            initialOptIn={evaluationOptIn}
            onOptInChange={setEvaluationOptIn}
          />
        </View>

        {/* Danger zone — sign out only, isolated at the bottom
          (Pablo, 2026-10-27): the sign-out used to sit directly under the
          evaluation opt-in, reading as if turning the opt-in off and
          leaving went together. It now lives in a zone of its own,
          clearly separated from everything above.
          (Pablo, 2026-10-27, review): delete account must NOT stand out
          and must NOT sit close to the sign-out — it is demoted to a
          quiet text link by the version footer, far from the logout. */}
        <View style={{ marginTop: 40 }}>
          <SectionLabel label={t("profile.dangerZone.section")} />
          <View style={{ gap: 12 }}>
            <DangerZone
              title={t("profile.signOut")}
              text={t("profile.dangerZone.signOutSub")}
              action={
                <Btn
                  variant="dangerSoft"
                  icon="sign-out"
                  onPress={handleLogout}
                  testID="profile-sign-out"
                >
                  {t("profile.signOut")}
                </Btn>
              }
            />
          </View>
        </View>

        {/* Version Footer — with the demoted delete-account link, kept as
          far from the sign-out as the panel allows (Pablo, 2026-10-27). */}
        <View style={{ padding: 16, alignItems: "center", gap: 8 }}>
          <T step="12" tone="text3">
            {t("profile.madeWith")}
          </T>
          <Pressable
            accessibilityRole="button"
            onPress={() => setDeleteOpen(true)}
            testID="profile-delete-account"
            style={Platform.OS === "web" ? ({ cursor: "pointer" } as any) : undefined}
          >
            <T step="12" tone="text3" style={{ textDecorationLine: "underline" }}>
              {t("profile.deleteAccount.open")}
            </T>
          </Pressable>
        </View>
      </Page>
      <DeleteAccountDialog
        open={deleteOpen}
        email={user.email}
        onCancel={() => setDeleteOpen(false)}
        onDeleted={handleLogout}
      />
    </View>
  )
}
