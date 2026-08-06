/**
 * Catalog Detail Window Content (TER-526)
 *
 * Pre-install detail view of one MCA — pixel-perfect port of
 * docs/mcas/catalog-detail-*.html. Loads the rich metadata via
 * app.get-catalog-mca (TER-524) and degrades every section gracefully when a
 * field is absent (no hero image → colour wash; no screenshots → single-column
 * body; no changelog → section hidden). All colour is theme-adaptive
 * (`useColors`), so dark/light follow the app theme.
 *
 * Known v1 gaps (data the catalog doesn't expose yet — follow-ups):
 *  - Tool descriptions/groups: the catalog stores tool *names* only, so the
 *    Actions panel lists names without the grouped descriptions of the mockup.
 *  - Permissions: not modelled in the catalog; the section is omitted.
 */

import { ArrowLeft, ArrowUpRight, Check, Download, Folder, Globe, Image as ImageIcon, MoreVertical, Plus, Shield, Zap } from "@tamagui/lucide-icons"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Image, Pressable, View } from "react-native"
import { Popover, ScrollView, Text, XStack, YStack } from "tamagui"
import { useToast } from "../../components/Toast"
import { FullscreenLoader } from "../../components/ui"
import { colors } from "../../components/mca/primitives/colors"
import { FONT_MONO, FONT_SANS } from "../../components/mca/primitives/fonts"
import { McaIcon } from '../../components/mca/McaIcon'
import { useColors } from "../../components/mca/primitives/useColors"
import { availabilityBadges } from "../../components/mca/availabilityBadges"
import { gradientFromColors } from "../../components/mca/heroWash"
import type { CatalogMcaDetail } from "../../services/AppApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { CatalogDetailWindowProps } from "./definition"
import { GOOGLE_SUITE_DETAILS } from "../CatalogWindow/googleSuite"


// ── MCA i18n helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the user's locale from i18n language.
 * i18n returns 'es-ES', 'en-US', 'ko-KR' — MCA i18n files use 'es', 'en', 'ko'.
 */
function mcaLocale(i18nLang: string): string {
  return i18nLang.split('-')[0]
}

/**
 * Get the translated MCA metadata for the current locale, falling back to English.
 * Returns undefined if no i18n data is available (the caller uses the raw fields).
 */
function getMcaTranslations(
  i18nData: CatalogMcaDetail['i18n'],
  locale: string,
) {
  if (!i18nData) return undefined
  const lang = mcaLocale(locale)
  return i18nData[lang] ?? i18nData['en']
}

function isImageUrl(str?: string | null): boolean {
  if (!str) return false
  return str.startsWith("http://") || str.startsWith("https://")
}

interface ToolRow {
  name: string
  description: string
  group?: string
}

/**
 * Group tools by their precomputed `group` (derived in the sync — TER-538).
 * Pure presentation: buckets with ≥2 tools become labelled groups; singletons
 * collapse into a trailing "Other"; if nothing groups cleanly, a single flat
 * unlabelled list (no noisy one-item headers).
 */
function buildToolGroups(tools: ToolRow[]): Array<{ label: string | null; items: ToolRow[] }> {
  const order: string[] = []
  const map = new Map<string, ToolRow[]>()
  for (const t of tools) {
    const g = t.group || "Other"
    if (!map.has(g)) {
      map.set(g, [])
      order.push(g)
    }
    map.get(g)?.push(t)
  }
  const groups: Array<{ label: string; items: ToolRow[] }> = []
  const other: ToolRow[] = []
  for (const g of order) {
    const items = map.get(g) ?? []
    if (g !== "Other" && items.length >= 2) groups.push({ label: g, items })
    else other.push(...items)
  }
  if (groups.length === 0) return [{ label: null, items: tools }]
  groups.sort((a, b) => a.label.localeCompare(b.label))
  if (other.length) groups.push({ label: "Other", items: other })
  return groups
}

function resolveIcon(icon?: string | null): string {
  if (!icon) return ""
  if (icon.startsWith("http://") || icon.startsWith("https://") || icon.startsWith("data:"))
    return icon
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL
  return backendUrl ? `${backendUrl}/static/mcas/${icon}` : ""
}

function authLabel(authType: string, t: (key: string) => string): string {
  switch (authType) {
    case "oauth2":
      return t("catalog.authOAuth2")
    case "api-key":
      return t("catalog.authApiKey")
    case "github-app":
      return t("catalog.authGithubApp")
    default:
      return t("catalog.authNone")
  }
}

interface Props extends CatalogDetailWindowProps {
  windowId: string
}

export function CatalogDetailWindowContent({ windowId, mcaId, workspaceId }: Props) {
  const c = useColors()
  const client = getTerosClient()
  const toast = useToast()
  const { t, i18n } = useTranslation()
  const openWindow = useTilingStore((s) => s.openWindow)
  const closeWindow = useTilingStore((s) => s.closeWindow)
  const activeWorkspaceId = workspaceId ?? useWorkspaceStore((s) => s.activeWorkspaceId)

  const [detail, setDetail] = useState<CatalogMcaDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [installedApps, setInstalledApps] = useState<Array<{ appId: string; name: string }>>([])
  // Actions list is capped by default so a long tool list (e.g. Notion's 32)
  // doesn't push the Events column far down the page (progressive disclosure).
  const [showAllTools, setShowAllTools] = useState(false)
  const [showInstancesMenu, setShowInstancesMenu] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // The four Google Suite apps not in the backend catalog ship their detail
      // in the frontend (see googleSuite.ts) — use it instead of fetching.
      const local = GOOGLE_SUITE_DETAILS[mcaId]
      const mca = local ?? (await client.app.getCatalogMca(mcaId)).mca
      setDetail(mca)
      // Cross-check installed instances by mcaId so the CTA survives a reload
      // (was the bug: state was local-only) and reflects multi vs single (TER-528).
      if (activeWorkspaceId) {
        const { apps } = await client.workspace.listWorkspaceApps(activeWorkspaceId)
        const mine = apps.filter((a) => a.mcaId === mcaId).map((a) => ({ appId: a.appId, name: a.name }))
        setInstalledApps(mine)
      }
    } catch (err) {
      console.error("Error loading Agent App detail:", err)
      toast.error(t("catalog.error"), t("catalog.detailLoadError"))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcaId, activeWorkspaceId])

  useEffect(() => {
    if (client.isConnected()) {
      load()
      return
    }
    const onConnected = () => {
      client.off("connected", onConnected)
      load()
    }
    client.on("connected", onConnected)
    return () => client.off("connected", onConnected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-read the workspace's instances after the wizard installs/changes one, so
  // the CTA (install → add-another / configure) and the instances list reflect
  // reality. Refetched (not appended) so an auto-named "<mca>-2" shows up right.
  const refreshInstances = useCallback(async () => {
    if (!activeWorkspaceId || !detail) return
    try {
      const { apps } = await client.workspace.listWorkspaceApps(activeWorkspaceId)
      const mine = apps.filter((a) => a.mcaId === detail.mcaId).map((a) => ({ appId: a.appId, name: a.name }))
      setInstalledApps(mine)
    } catch (err) {
      console.error("Error refreshing instances:", err)
    }
  }, [activeWorkspaceId, detail, client])

  // Install a new instance. The CTA then flips to "Add another"; per-instance
  // configuration UI is TBD, so nothing is expanded inline here yet.
  const handleInstall = useCallback(async () => {
    if (!activeWorkspaceId || !detail) return
    try {
      await client.installWorkspaceApp(activeWorkspaceId, detail.mcaId)
      await refreshInstances()
    } catch (err) {
      toast.error(t("catalog.error"), err instanceof Error ? err.message : t("catalog.detailInstallError"))
    }
  }, [activeWorkspaceId, detail, client, refreshInstances, toast])

  if (loading) {
    return (
      <YStack flex={1} backgroundColor={c.bgPage}>
        <FullscreenLoader variant="default" label={t("catalog.detailLoading")} />
      </YStack>
    )
  }

  if (!detail) {
    return (
      <YStack flex={1} backgroundColor={c.bgPage} alignItems="center" justifyContent="center" gap={10}>
        <Text fontFamily={FONT_SANS} fontSize={14} color={c.text3}>
          Agent App not found
        </Text>
      </YStack>
    )
  }

  const heroUrl = isImageUrl(detail.backgroundImage) ? (detail.backgroundImage as string) : ""
  const iconUrl = resolveIcon(detail.image ?? detail.icon)
  const accent = detail.color || colors.indigo
  const hasScreens = detail.screenshots.length > 0
  const isSystem = detail.availability.system
  // `multi` (Multi-instance) is dropped — it's the common case and adds noise.
  const availChips = availabilityBadges(detail.availability).filter((b) => b.key !== "multi")
  const installedCount = installedApps.length
  // Install CTA state: system → included; 0 instances → install; otherwise the
  // CTA installs another instance ("add another"). Per-instance configuration
  // lives in the instances list, not the hero.
  const installState: "included" | "install" | "add-another" = isSystem
    ? "included"
    : installedCount === 0
      ? "install"
      : "add-another"

  const metaItems: Array<{ label: string; value: string; href?: string }> = []
  if (detail.version) metaItems.push({ label: t("catalog.metaVersion"), value: detail.version })
  metaItems.push({ label: t("catalog.metaAuth"), value: authLabel(detail.authType, t) })
  metaItems.push({ label: t("catalog.metaActions"), value: String(detail.tools.length) })
  if (detail.keywords.length) metaItems.push({ label: t("catalog.metaTags"), value: detail.keywords.slice(0, 3).join(" · ") })
  // Homepage now renders as a dedicated tag chip (below), not a meta dot-item.
  const homepageHost = detail.homepage?.replace(/^https?:\/\//, "").replace(/\/$/, "")

  // Resolve MCA-level translations for the current locale
  const mcaTr = getMcaTranslations(detail.i18n, i18n.language)
  const trName = mcaTr?.name ?? detail.name
  const trDescription = mcaTr?.description ?? detail.description
  const trTagline = mcaTr?.tagline ?? detail.tagline
  const trChangelog = mcaTr?.changelog
    ? detail.changelog.map((entry, i) => ({
        ...entry,
        notes: mcaTr.changelog![i]?.notes ?? entry.notes,
      }))
    : detail.changelog

  const paragraphs = trDescription.split(/\n{2,}/).filter((p) => p.trim().length > 0)

  // Tool rows — the sync materialises name + human description + domain group
  // (TER-538). Fall back to names-only for catalog docs synced before that.
  const toolRows: ToolRow[] =
    detail.toolsDetailed && detail.toolsDetailed.length > 0
      ? detail.toolsDetailed.map((td) => {
          const trTool = mcaTr?.tools?.[td.name]
          return {
            name: trTool?.name ?? td.name,
            description: trTool?.description ?? td.description,
            group: td.group,
          }
        })
      : detail.tools.map((name) => ({ name, description: "" }))
  const TOOLS_PREVIEW = 8
  const toolGroups = buildToolGroups(toolRows)
  // Flatten to display rows (group headers + tools), capping the tool count at
  // TOOLS_PREVIEW unless expanded — keeps Events nearby (TER-537) while still
  // showing the grouping (TER-538).
  const displayRows: Array<{ kind: "header"; label: string } | { kind: "tool"; tool: ToolRow }> = []
  let shownToolCount = 0
  for (const g of toolGroups) {
    const slice = showAllTools ? g.items : g.items.slice(0, Math.max(0, TOOLS_PREVIEW - shownToolCount))
    if (slice.length === 0) continue
    if (g.label) displayRows.push({ kind: "header", label: g.label === "Other" ? t("catalog.groupOther") : g.label })
    for (const t of slice) displayRows.push({ kind: "tool", tool: t })
    shownToolCount += slice.length
    if (!showAllTools && shownToolCount >= TOOLS_PREVIEW) break
  }
  const hiddenToolCount = toolRows.length - shownToolCount

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bgPage }} contentContainerStyle={{ padding: 24 }}>
      {/* Breadcrumb */}
      <XStack alignItems="center" gap={6} marginBottom={12}>
        <Text
          fontFamily={FONT_SANS}
          fontSize={13}
          fontWeight="300"
          color={colors.indigoLight}
          cursor="pointer"
          onPress={() => openWindow("catalog", {}, false)}
        >
          Catalog
        </Text>
        <Text fontFamily={FONT_SANS} fontSize={13} color={c.text3}>
          ›
        </Text>
        <Text fontFamily={FONT_SANS} fontSize={13} color={c.text2}>
          {trName}
        </Text>
      </XStack>

      <YStack
        borderRadius={20}
        borderWidth={1}
        borderColor={c.border}
        backgroundColor={c.bgCard}
        overflow="hidden"
      >
        {/* Hero */}
        <View style={{ height: 200, position: "relative", overflow: "hidden", backgroundColor: accent }}>
          {/* Generated aurora wash from the accent — the base layer (and the
              whole background when there's no curated image). Web-only
              backgroundImage; native falls back to the flat accent above. */}
          <View
            style={{
              position: "absolute",
              inset: 0,
              // @ts-expect-error web-only gradient
              backgroundImage: gradientFromColors(detail.accentColors, accent),
            }}
          />
          {/* Curated background image, blurred + slightly scaled so it reads as
              ambient colour behind the identity (mockup parity). */}
          {heroUrl ? (
            <View
              style={{
                position: "absolute",
                inset: 0,
                // @ts-expect-error web-only background image + blur
                backgroundImage: `url(${heroUrl})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                filter: "blur(12px)",
                transform: [{ scale: 1.12 }],
              }}
            />
          ) : null}
          {/* Fade to surface so the identity reads over any image/wash */}
          <View
            style={{
              position: "absolute",
              inset: 0,
              // @ts-expect-error web-only gradient overlay — native falls back to the accent wash above
              backgroundImage: `linear-gradient(to bottom, transparent 0%, transparent 22%, ${c.bgCard}88 62%, ${c.bgCard} 100%)`,
            }}
          />
          {/* Back button */}
          <XStack
            position="absolute"
            top={16}
            left={16}
            width={32}
            height={32}
            borderRadius={10}
            alignItems="center"
            justifyContent="center"
            backgroundColor="rgba(0,0,0,0.32)"
            borderWidth={1}
            borderColor="rgba(255,255,255,0.18)"
            cursor="pointer"
            onPress={() => {
              // "Back" returns to the catalog. Close this detail FIRST, then open
              // the catalog — closeWindow resets the active container to the first
              // one (the index) when it empties a pane, so opening the catalog must
              // run last for its focus to win.
              closeWindow(windowId)
              openWindow("catalog", {}, false)
            }}
          >
            <ArrowLeft size={16} color="#FFFFFF" />
          </XStack>

          {/* Identity overlay */}
          <XStack position="absolute" bottom={0} left={0} right={0} padding={20} gap={16} alignItems="flex-end">
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 14,
                borderWidth: 2,
                borderColor: "rgba(255,255,255,0.18)",
                backgroundColor: "#FFFFFF",
                overflow: "hidden",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <McaIcon
                icon={detail.image ?? detail.icon}
                mcaId={detail.mcaId}
                size={44}
                color={accent}
                backgroundColor="transparent"
                borderRadius={0}
              />
            </View>
            <YStack flex={1} gap={2}>
              <Text fontFamily={FONT_SANS} fontSize={24} fontWeight="400" color="#FFFFFF">
                {trName}
              </Text>
            </YStack>
            <XStack gap={8} alignItems="center">
              {/* Installed instances — clickable pills to go configure each one */}
              {installState === "add-another" && installedApps.length > 0 && (
                <XStack gap={6} alignItems="center" maxWidth={280}>
                  {installedApps.slice(0, 3).map((app) => (
                    <Pressable
                      key={app.appId}
                      onPress={() => openWindow("app", { appId: app.appId }, false)}
                      style={{
                        paddingHorizontal: 10,
                        height: 28,
                        borderRadius: 6,
                        backgroundColor: "rgba(255,255,255,0.10)",
                        borderWidth: 1,
                        borderColor: "rgba(255,255,255,0.15)",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green }} />
                      <Text fontFamily={FONT_SANS} fontSize={12} fontWeight="400" color="rgba(255,255,255,0.85)" numberOfLines={1}>
                        {app.name}
                      </Text>
                    </Pressable>
                  ))}
                  {installedApps.length > 3 && (
                    <Text fontFamily={FONT_SANS} fontSize={12} color="rgba(255,255,255,0.5)">
                      +{installedApps.length - 3}
                    </Text>
                  )}
                </XStack>
              )}

              <InstallButton
                state={installState}
                onInstall={handleInstall}
                t={t}
                installedApps={installedApps}
                onOpenInstance={(appId) => openWindow("app", { appId }, false)}
                showInstancesMenu={showInstancesMenu}
                setShowInstancesMenu={setShowInstancesMenu}
              />
            </XStack>
          </XStack>
        </View>

        {/* Tagline */}
        {detail.tagline && (
          <Text
            fontFamily={FONT_SANS}
            fontSize={14}
            fontWeight="300"
            color={c.text2}
            paddingHorizontal={32}
            paddingTop={16}
          >
            {trTagline}
          </Text>
        )}

        {/* Meta strip */}
        <XStack flexWrap="wrap" alignItems="center" gap={16} paddingHorizontal={32} paddingVertical={14}>
          <View
            style={{
              paddingHorizontal: 9,
              paddingVertical: 3,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: c.borderStrong,
            }}
          >
            <Text
              fontFamily={FONT_SANS}
              fontSize={10.5}
              fontWeight="500"
              color={c.text2}
              textTransform="uppercase"
              letterSpacing={0.6}
            >
              {detail.category}
            </Text>
          </View>
          {availChips.map((b) => {
            const tint = c.badges[b.tint]
            return (
              <View
                key={b.key}
                style={{
                  backgroundColor: tint.bg,
                  borderColor: tint.border,
                  borderWidth: 1,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 20,
                }}
              >
                <Text fontFamily={FONT_SANS} fontSize={11} fontWeight="500" color={tint.text}>
                  {b.label}
                </Text>
              </View>
            )
          })}
          {metaItems.map((m) => (
            <XStack key={m.label} alignItems="center" gap={6}>
              <View style={{ width: 3, height: 3, borderRadius: 9999, backgroundColor: c.text3 }} />
              <Text fontFamily={FONT_SANS} fontSize={12} color={c.text3}>
                {m.label}
              </Text>
              {m.href ? (
                <Text
                  fontFamily={FONT_SANS}
                  fontSize={12}
                  fontWeight="500"
                  color={colors.indigoLight}
                  cursor="pointer"
                  onPress={() => m.href && openExternal(m.href)}
                >
                  {m.value} ↗
                </Text>
              ) : (
                <Text fontFamily={FONT_SANS} fontSize={12} fontWeight="500" color={c.text}>
                  {m.value}
                </Text>
              )}
            </XStack>
          ))}
          {/* Homepage — least important, so it sits last (no bullet): a "Web"
              label + the URL as a link with a compact arrow. */}
          {homepageHost && (
            <XStack
              alignItems="center"
              gap={6}
              cursor="pointer"
              onPress={() => detail.homepage && openExternal(detail.homepage)}
            >
              <Text fontFamily={FONT_SANS} fontSize={12} color={c.text3}>
                {t("catalog.webLabel")}
              </Text>
              <Text fontFamily={FONT_SANS} fontSize={12} fontWeight="500" color={colors.indigoLight}>
                {homepageHost}
              </Text>
              <ArrowUpRight size={13} color={colors.indigoLight} />
            </XStack>
          )}
        </XStack>

        <View style={{ height: 1, backgroundColor: c.border }} />

        {/* Body: left col (preview + permissions) + description */}
        <XStack padding={28} gap={28} flexWrap="wrap">
            <YStack width={240} gap={16}>
              {/* Preview — placeholder for now; will host a live MCA preview. */}
              <YStack gap={8}>
                <Text
                  fontFamily={FONT_SANS}
                  fontSize={10.5}
                  fontWeight="600"
                  color={c.text3}
                  textTransform="uppercase"
                  letterSpacing={0.8}
                >
                  Preview
                </Text>
                {hasScreens ? (
                  <View style={{ borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
                    <Image source={{ uri: detail.screenshots[0] }} style={{ width: "100%", height: 152 }} resizeMode="cover" />
                  </View>
                ) : (
                  <View
                    style={{
                      height: 152,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderStyle: "dashed",
                      borderColor: c.border,
                      backgroundColor: c.bgCardHover,
                      justifyContent: "center",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <ImageIcon size={22} color={c.text3} />
                    <Text fontFamily={FONT_SANS} fontSize={12} color={c.text3}>
                      Preview coming soon
                    </Text>
                  </View>
                )}
              </YStack>
              {detail.permissions.length > 0 && (
                <YStack gap={8}>
                  <Text
                    fontFamily={FONT_SANS}
                    fontSize={10.5}
                    fontWeight="600"
                    color={c.text3}
                    textTransform="uppercase"
                    letterSpacing={0.8}
                  >
                    Permissions
                  </Text>
                  {detail.permissions.map((perm) => {
                    const PermIcon = perm.type === "network" ? Globe : perm.type === "filesystem" ? Folder : Shield
                    return (
                      <XStack
                        key={perm.type}
                        alignItems="center"
                        gap={8}
                        paddingHorizontal={12}
                        paddingVertical={9}
                        borderRadius={10}
                        borderWidth={1}
                        borderColor={c.border}
                        backgroundColor={c.bgCard}
                      >
                        <PermIcon size={15} color={c.text3} />
                        <Text flex={1} fontFamily={FONT_SANS} fontSize={13} color={c.text}>
                          {perm.label}
                        </Text>
                        <Text fontFamily={FONT_MONO} fontSize={11} color={c.text3} numberOfLines={1}>
                          {perm.detail}
                        </Text>
                      </XStack>
                    )
                  })}
                </YStack>
              )}
            </YStack>
          <YStack flex={1} minWidth={280} gap={10}>
            <Text
              fontFamily={FONT_SANS}
              fontSize={10.5}
              fontWeight="600"
              color={c.text3}
              textTransform="uppercase"
              letterSpacing={0.8}
            >
              About
            </Text>
            {paragraphs.map((p, i) => (
              <Text
                key={`p-${i}`}
                fontFamily={FONT_SANS}
                fontSize={14}
                fontWeight="300"
                lineHeight={22}
                color={c.text2}
                maxWidth={620}
              >
                {p}
              </Text>
            ))}
          </YStack>
        </XStack>

        <View style={{ height: 1, backgroundColor: c.border }} />

        {/* Bottom: Actions + Events */}
        <XStack flexWrap="wrap">
          <YStack flex={1} minWidth={300} padding={28} gap={10} borderRightWidth={1} borderRightColor={c.border}>
            <Text fontFamily={FONT_SANS} fontSize={18} fontWeight="500" color={c.text}>
              {t("catalog.sectionActions")}
            </Text>
            <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="300" color={c.text3} marginBottom={4}>
              {detail.tools.length} tools this Agent App exposes to agents
            </Text>
            <YStack gap={4}>
              {displayRows.map((row, i) => {
                if (row.kind === "header") {
                  return (
                    <Text
                      key={`h-${row.label}`}
                      fontFamily={FONT_SANS}
                      fontSize={10.5}
                      fontWeight="600"
                      color={c.text3}
                      textTransform="uppercase"
                      letterSpacing={0.8}
                      paddingHorizontal={4}
                      paddingTop={i === 0 ? 0 : 10}
                      paddingBottom={2}
                    >
                      {row.label}
                    </Text>
                  )
                }
                const tool = row.tool
                // The catalog shows the action as a single short human sentence
                // (mockup) — not the technical tool name (TER-522 Pieza I).
                const label = tool.description || tool.name
                return (
                  <XStack
                    key={`t-${tool.name}`}
                    alignItems="center"
                    gap={10}
                    paddingHorizontal={12}
                    paddingVertical={9}
                    borderRadius={10}
                    borderWidth={1}
                    borderColor={c.border}
                    backgroundColor={c.bgCard}
                  >
                    <McaIcon
                      icon={detail.image ?? detail.icon}
                      mcaId={detail.mcaId}
                      size={18}
                      color={c.text2}
                      backgroundColor={c.bgCardHover}
                      borderRadius={4}
                    />
                    <Text
                      flex={1}
                      fontFamily={FONT_SANS}
                      fontSize={13}
                      fontWeight="300"
                      lineHeight={18}
                      color={c.text2}
                      numberOfLines={2}
                    >
                      {label}
                    </Text>
                  </XStack>
                )
              })}
              {(hiddenToolCount > 0 || showAllTools) && toolRows.length > TOOLS_PREVIEW && (
                <Text
                  fontFamily={FONT_SANS}
                  fontSize={12.5}
                  fontWeight="500"
                  color={colors.indigoLight}
                  cursor="pointer"
                  paddingVertical={6}
                  paddingHorizontal={12}
                  onPress={() => setShowAllTools((v) => !v)}
                >
                  {showAllTools ? t("catalog.showLess") : t("catalog.showAllActions", { count: toolRows.length })}
                </Text>
              )}
            </YStack>
          </YStack>

          <YStack flex={1} minWidth={300} padding={28} gap={12}>
            <Text fontFamily={FONT_SANS} fontSize={18} fontWeight="500" color={c.text}>
              Events
            </Text>
            <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="300" color={c.text3}>
              Subscribe agents to real-time triggers
            </Text>
            <YStack
              alignItems="center"
              justifyContent="center"
              gap={8}
              paddingVertical={40}
              borderRadius={12}
              borderWidth={1}
              borderColor={c.borderStrong}
              borderStyle="dashed"
            >
              <Zap size={24} color={c.text3} opacity={0.35} />
              <Text fontFamily={FONT_SANS} fontSize={15} fontWeight="500" color={c.text2}>
                No events defined yet
              </Text>
              <Text
                fontFamily={FONT_SANS}
                fontSize={13}
                fontWeight="300"
                color={c.text3}
                textAlign="center"
                maxWidth={220}
              >
                Events let agents react to things happening in {trName}.
              </Text>
            </YStack>
          </YStack>
        </XStack>

        {/* Changelog */}
        {trChangelog.length > 0 && (
          <YStack padding={28} gap={12} borderTopWidth={1} borderTopColor={c.border}>
            <Text
              fontFamily={FONT_SANS}
              fontSize={10.5}
              fontWeight="600"
              color={c.text3}
              textTransform="uppercase"
              letterSpacing={0.8}
            >
              {t("catalog.sectionChangelog")}
            </Text>
            {trChangelog.map((entry) => (
              <XStack key={entry.version} gap={16} alignItems="flex-start">
                <View
                  style={{
                    backgroundColor: colors.indigoGlow,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 6,
                  }}
                >
                  <Text fontFamily={FONT_MONO} fontSize={11} color={colors.indigoLight}>
                    v{entry.version}
                  </Text>
                </View>
                <YStack flex={1} gap={4}>
                  <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="300" lineHeight={20} color={c.text2}>
                    {entry.notes}
                  </Text>
                  <Text fontFamily={FONT_MONO} fontSize={11} color={c.text3}>
                    {entry.date}
                  </Text>
                </YStack>
              </XStack>
            ))}
          </YStack>
        )}
      </YStack>
    </ScrollView>
  )
}

function openExternal(url: string) {
  if (typeof window !== "undefined" && window.open) {
    window.open(url, "_blank", "noopener,noreferrer")
  }
}

function InstallButton({
  state,
  onInstall,
  installedApps,
  onOpenInstance,
  showInstancesMenu,
  setShowInstancesMenu,
  t,
}: {
  state: "included" | "install" | "add-another"
  onInstall: () => void
  installedApps: Array<{ appId: string; name: string }>
  onOpenInstance: (appId: string) => void
  showInstancesMenu: boolean
  setShowInstancesMenu: (v: boolean) => void
  t: (key: string) => string
}) {
  // System MCAs are auto-provisioned — no install action.
  if (state === "included") {
    return (
      <XStack
        alignItems="center"
        gap={6}
        paddingHorizontal={18}
        height={34}
        borderRadius={8}
        backgroundColor="rgba(255,255,255,0.08)"
      >
        <Check size={14} color={colors.green} />
        <Text fontFamily={FONT_SANS} fontSize={14} fontWeight="500" color="rgba(255,255,255,0.85)">
          {t("catalog.included")}
        </Text>
      </XStack>
    )
  }

  // Fresh install — full indigo CTA
  if (state === "install") {
    return (
      <XStack
        alignItems="center"
        gap={6}
        paddingHorizontal={20}
        height={34}
        borderRadius={8}
        backgroundColor={colors.indigo}
        cursor="pointer"
        onPress={onInstall}
      >
        <Download size={14} color="#FFFFFF" />
        <Text fontFamily={FONT_SANS} fontSize={14} fontWeight="500" color="#FFFFFF">
          {t("catalog.install")}
        </Text>
      </XStack>
    )
  }

  // Already installed — dots menu with "Add another" and instance list
  return (
    <Popover open={showInstancesMenu} onOpenChange={setShowInstancesMenu} placement="bottom-end">
      <Popover.Trigger asChild>
        <XStack
          alignItems="center"
          justifyContent="center"
          width={34}
          height={34}
          borderRadius={8}
          backgroundColor="rgba(255,255,255,0.10)"
          borderWidth={1}
          borderColor="rgba(255,255,255,0.15)"
          cursor="pointer"
        >
          <MoreVertical size={16} color="#FFFFFF" />
        </XStack>
      </Popover.Trigger>
      <Popover.Content
        backgroundColor="#16161D"
        borderWidth={1}
        borderColor="rgba(255,255,255,0.13)"
        borderRadius={10}
        padding={0}
        elevate
        animation="quick"
        enterStyle={{ opacity: 0, y: -6, scale: 0.97 }}
        exitStyle={{ opacity: 0, y: -6, scale: 0.97 }}
      >
        <YStack width={240} overflow="hidden">
          {/* Instances header */}
          <XStack
            paddingHorizontal={14}
            paddingVertical={10}
            borderBottomWidth={1}
            borderBottomColor="rgba(255,255,255,0.07)"
            alignItems="center"
            justifyContent="space-between"
          >
            <Text fontFamily={FONT_SANS} fontSize={12} fontWeight="600" color="rgba(255,255,255,0.85)">
              {t("catalog.instancesInstalled")}
            </Text>
            <Text fontFamily={FONT_SANS} fontSize={11} color="rgba(255,255,255,0.45)">
              {installedApps.length}
            </Text>
          </XStack>

          {/* Instance list */}
          <ScrollView maxHeight={200}>
            {installedApps.map((app) => (
              <Pressable
                key={app.appId}
                onPress={() => {
                  setShowInstancesMenu(false)
                  onOpenInstance(app.appId)
                }}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green }} />
                <Text fontFamily={FONT_SANS} fontSize={13} color="rgba(255,255,255,0.85)" numberOfLines={1} flex={1}>
                  {app.name}
                </Text>
                <ArrowUpRight size={13} color="rgba(255,255,255,0.35)" />
              </Pressable>
            ))}
          </ScrollView>

          {/* Add another — divider + action */}
          <View style={{ height: 1, backgroundColor: "rgba(255,255,255,0.07)" }} />
          <Pressable
            onPress={() => {
              setShowInstancesMenu(false)
              onInstall()
            }}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Plus size={14} color={colors.indigo} />
            <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color={colors.indigoLight}>
              {t("catalog.addAnother")}
            </Text>
          </Pressable>
        </YStack>
      </Popover.Content>
    </Popover>
  )
}
