/**
 * Catalog Window Content — MCA marketplace (TER-525).
 *
 * Pixel-perfect port of docs/mcas/catalog-window.html: a left sidebar of
 * categories with live counts, a stats strip, and a grid of minimal cards
 * (icon · name+badge · description · id). Clicking a card opens the catalog
 * detail window (install moved there in TER-526). All colour comes from the
 * theme-adaptive token system (`useColors`) so dark/light switch for free.
 */

import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Chrome,
  Code2,
  Cog,
  Database,
  HardDrive,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Search,
  Sparkles,
  Wrench,
} from "@tamagui/lucide-icons"
import type { TFunction } from "i18next"
import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Image, TextInput, View, useWindowDimensions } from "react-native"
import { ScrollView, Text, XStack, YStack } from "tamagui"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useToast } from "../../components/Toast"
import { FullscreenLoader } from "../../components/ui"
import { McaIcon } from '../../components/mca/McaIcon'
import { useColors } from "../../components/mca/primitives/useColors"
import { availabilityBadges } from "../../components/mca/availabilityBadges"
import { FONT_MONO, FONT_SANS } from "../../components/mca/primitives/fonts"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { CatalogWindowProps } from "./definition"
import { GOOGLE_FAKE_INSTALLS, GOOGLE_PLACEHOLDER_CARDS, GOOGLE_SUITE_ORDER } from "./googleSuite"

interface CatalogMca {
  mcaId: string
  name: string
  description: string
  icon?: string
  color?: string
  category: string
  tools: string[]
  availability: {
    enabled: boolean
    multi: boolean
    system: boolean
    hidden: boolean
    role: "user" | "admin" | "super"
  }
  i18n?: Record<string, {
    name?: string
    description?: string
    tagline?: string
    tools?: Record<string, {
      name?: string
      description?: string
      params?: Record<string, string>
    }>
  }>
}

interface InstalledApp {
  appId: string
  mcaId: string
  name: string
}

// Cards for the four Google apps not yet in the backend catalog (see
// googleSuite.ts) — a shared source of truth so the list, detail and My Apps
// agree, already re-tagged into the `google` category.

// ── MCA i18n helpers ──────────────────────────────────────────────────────────

function mcaLocale(i18nLang: string): string {
  return i18nLang.split("-")[0]
}

function getMcaTranslations(
  i18nData: CatalogMca["i18n"],
  locale: string,
) {
  if (!i18nData) return undefined
  const lang = mcaLocale(locale)
  return i18nData[lang] ?? i18nData["en"]
}

const GOOGLE_PLACEHOLDERS = GOOGLE_PLACEHOLDER_CARDS as CatalogMca[]

/**
 * Fold the curated Google Suite into the raw catalog: re-tag the real Google
 * apps into the `google` category, drop in the placeholder cards, and place all
 * nine first in GOOGLE_SUITE_ORDER so the group renders in a fixed order.
 */
function withGoogleSuite(raw: CatalogMca[]): CatalogMca[] {
  const ids = new Set<string>(GOOGLE_SUITE_ORDER)
  const byId = new Map<string, CatalogMca>()
  for (const m of raw) if (ids.has(m.mcaId)) byId.set(m.mcaId, { ...m, category: "google" })
  for (const p of GOOGLE_PLACEHOLDERS) if (!byId.has(p.mcaId)) byId.set(p.mcaId, p)
  const suite = GOOGLE_SUITE_ORDER.map((id) => byId.get(id)).filter((m): m is CatalogMca => !!m)
  const rest = raw.filter((m) => !ids.has(m.mcaId))
  return [...suite, ...rest]
}

// Display order + label for the sidebar categories (mirrors the mockup).
// "google" (Google Suite) is a curated group that always sits first.
const CAT_ORDER = [
  "google",
  "communication",
  "productivity",
  "development",
  "ai",
  "media",
  "design",
  "storage",
  "system",
  "data",
  "utility",
  "other",
] as const

// Category → i18n key. Labels are resolved at render time via `t()` so they
// follow the active locale (es/en/ko). `ai` and `media` share one label because
// the catalog presents them as a single "AI & Media" group (see CAT_ICONS).
const CAT_I18N: Record<string, string> = {
  google: "catalog.categoryGoogleSuite",
  communication: "catalog.categoryCommunication",
  productivity: "catalog.categoryProductivity",
  development: "catalog.categoryDevelopment",
  ai: "catalog.categoryAiMedia",
  media: "catalog.categoryAiMedia",
  design: "catalog.categoryDesign",
  storage: "catalog.categoryStorage",
  system: "catalog.categorySystem",
  data: "catalog.categoryData",
  utility: "catalog.categoryUtility",
  other: "catalog.categoryOther",
}

/** Localised label for a category key, falling back to the raw key. */
function categoryLabel(cat: string, t: TFunction): string {
  const key = CAT_I18N[cat]
  return key ? t(key) : cat
}

const CAT_ICONS: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  google: Chrome,
  communication: MessageSquare,
  productivity: CheckSquare,
  development: Code2,
  ai: Sparkles,
  media: Sparkles,
  design: Palette,
  storage: HardDrive,
  system: Cog,
  data: Database,
  utility: Wrench,
  other: MoreHorizontal,
}

function isImageUrl(str?: string): boolean {
  if (!str) return false
  return (
    str.startsWith("http://") ||
    str.startsWith("https://") ||
    str.startsWith("data:") ||
    str.endsWith(".png") ||
    str.endsWith(".jpg") ||
    str.endsWith(".jpeg") ||
    str.endsWith(".svg")
  )
}

function getIconUrl(icon?: string): string {
  if (!icon) return ""
  if (icon.startsWith("http://") || icon.startsWith("https://") || icon.startsWith("data:"))
    return icon
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL
  if (!backendUrl) return ""
  return `${backendUrl}/static/mcas/${icon}`
}

/** 2-char fallback from the mca id, e.g. mca.teros.bash → "TE" (mockup behaviour). */
function fallbackInitials(mcaId: string): string {
  return mcaId.replace(/^mca\./, "").slice(0, 2).toUpperCase()
}

interface CatalogWindowContentProps extends CatalogWindowProps {
  windowId: string
}

/** Whether an MCA passes the active scope + category + search filters. */
function matchesFilters(
  mca: CatalogMca,
  opts: { scope: "all" | "installed"; activeCat: string; q: string; installed: boolean },
): boolean {
  const scopeOk = opts.scope !== "installed" || opts.installed
  const catOk = opts.activeCat === "all" || mca.category === opts.activeCat
  const qOk =
    !opts.q ||
    mca.name.toLowerCase().includes(opts.q) ||
    mca.description.toLowerCase().includes(opts.q) ||
    mca.mcaId.toLowerCase().includes(opts.q)
  return scopeOk && catOk && qOk
}

/**
 * Pure derivation of everything the view renders from the raw catalog + filter
 * state. Lives outside the component so the component body stays simple.
 *
 * - `scopedCatalog`: catalog narrowed to the scope (drives truthful chip counts).
 * - `ctxTitle`/`ctxStats`: contextual header — the "categories" count only shows
 *   in the "All" view, since it's meaningless once a single category is active.
 * - `grouped`/`sections`: grouped-by-category when browsing everything, otherwise
 *   a single flat section.
 */
function deriveCatalogView(
  catalog: CatalogMca[],
  isInstalled: (mcaId: string) => boolean,
  scope: "all" | "installed",
  activeCat: string,
  q: string,
  labels: { all: string; installed: string; category: (cat: string) => string },
) {
  const scopedCatalog =
    scope === "installed" ? catalog.filter((m) => isInstalled(m.mcaId)) : catalog
  const counts: Record<string, number> = {}
  for (const mca of scopedCatalog) counts[mca.category] = (counts[mca.category] ?? 0) + 1
  const presentCats = CAT_ORDER.filter((cat) => (counts[cat] ?? 0) > 0)

  const filtered = catalog.filter((mca) =>
    matchesFilters(mca, { scope, activeCat, q, installed: isInstalled(mca.mcaId) }),
  )
  const filteredTools = filtered.reduce((n, m) => n + (m.tools?.length ?? 0), 0)
  const filteredCats = new Set(filtered.map((m) => m.category)).size

  const allTitle = scope === "installed" ? labels.installed : labels.all
  const ctxTitle = activeCat === "all" ? allTitle : labels.category(activeCat)
  const ctxStats =
    activeCat === "all"
      ? `${filtered.length} Agent Apps · ${filteredCats} categories · ${filteredTools} tools`
      : `${filtered.length} Agent Apps · ${filteredTools} tools`

  const grouped = activeCat === "all" && !q
  const sections = grouped
    ? CAT_ORDER.map((cat) => ({ cat, items: filtered.filter((m) => m.category === cat) })).filter(
        (s) => s.items.length > 0,
      )
    : [{ cat: activeCat, items: filtered }]

  return { scopedCatalog, counts, presentCats, filtered, grouped, sections, ctxTitle, ctxStats }
}

export function CatalogWindowContent({
  windowId,
  workspaceId,
  category: initialCategory,
  search: initialSearch,
}: CatalogWindowContentProps) {
  const c = useColors()
  const { t } = useTranslation()
  const client = getTerosClient()
  const toast = useToast()
  const openWindow = useTilingStore((s) => s.openWindow)
  const activeWorkspaceId = workspaceId ?? useWorkspaceStore((s) => s.activeWorkspaceId)

  const [catalog, setCatalog] = useState<CatalogMca[]>([])
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState(initialSearch || "")
  const [searchFocused, setSearchFocused] = useState(false)
  // Scope (All / Installed) is orthogonal to the category filter: you can be in
  // "Installed" and still narrow down by category. `activeCat` is category-only
  // ("all" = no category filter); the legacy "installed" category maps to scope.
  const [scope, setScope] = useState<"all" | "installed">(
    initialCategory === "installed" ? "installed" : "all",
  )
  const [activeCat, setActiveCat] = useState<string>(
    initialCategory && initialCategory !== "installed" ? initialCategory : "all",
  )

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      const catalogResult = await client.app.listCatalog()
      setCatalog(withGoogleSuite(catalogResult.catalog as CatalogMca[]))
      if (activeWorkspaceId) {
        const { apps } = await client.workspace.listWorkspaceApps(activeWorkspaceId)
        const mine = apps.map((a) => ({ appId: a.appId, mcaId: a.mcaId, name: a.name }))
        // Prototype: the Google Suite apps have no backend, so their installs are
        // simulated (see googleSuite.ts).
        setInstalledApps([...GOOGLE_FAKE_INSTALLS, ...mine])
      }
    } catch (err) {
      console.error("Error loading catalog:", err)
      toast.error(t("catalog.error"), t("catalog.loadError"))
    } finally {
      setIsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId])

  useEffect(() => {
    if (client.isConnected()) {
      loadData()
      return
    }
    const onConnected = () => {
      client.off("connected", onConnected)
      loadData()
    }
    client.on("connected", onConnected)
    return () => client.off("connected", onConnected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isInstalled = (mcaId: string) => installedApps.some((a) => a.mcaId === mcaId)

  const openDetail = (mcaId: string) => {
    openWindow("catalog-detail", { mcaId, workspaceId: activeWorkspaceId }, false)
  }

  // ── Derived data ──────────────────────────────────────────────────────────
  const q = searchQuery.toLowerCase().trim()
  const { width: windowWidth } = useWindowDimensions()
  // Card width: 210px on desktop, but on narrow screens (mobile) compute
  // so exactly 2 cards fit: (containerWidth - gap) / 2.
  // ScrollView padding is 20px each side = 40px total.
  const containerWidth = windowWidth - 40
  const GAP = 10
  const cardWidth = containerWidth < 430
    ? Math.floor((containerWidth - GAP) / 2)  // 2 cards on mobile
    : 210                                      // fixed on desktop
  const { scopedCatalog, counts, presentCats, filtered, grouped, sections, ctxTitle, ctxStats } =
    deriveCatalogView(catalog, isInstalled, scope, activeCat, q, {
      all: t("catalog.allMcas"),
      installed: t("catalog.scopeInstalled"),
      category: (cat) => categoryLabel(cat, t),
    })

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Header — title + search (titlebar chrome comes from the window manager) */}
      <XStack
        alignItems="center"
        justifyContent="space-between"
        paddingHorizontal={16}
        height={44}
        borderBottomWidth={1}
        borderBottomColor={c.border}
        backgroundColor={c.bgCard}
      >
        <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color={c.text}>
          {t("catalog.title")}
        </Text>
        <XStack
          alignItems="center"
          gap={8}
          paddingHorizontal={10}
          height={28}
          width={220}
          borderRadius={6}
          borderWidth={1}
          backgroundColor={c.bgPage}
          borderColor={searchFocused ? "#5E6AD2" : c.border}
        >
          <Search size={13} color={c.text3} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder={t("common.search")}
            placeholderTextColor={c.text3}
            style={{ flex: 1, color: c.text, fontSize: 13, fontFamily: FONT_SANS }}
          />
        </XStack>
      </XStack>

      {/* Context bar — contextual title + stats (left), scope toggle (right) */}
      <XStack
        alignItems="center"
        justifyContent="space-between"
        gap={12}
        paddingHorizontal={24}
        height={56}
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        <XStack alignItems="baseline" gap={10} flex={1} minWidth={0}>
          <Text fontFamily={FONT_SANS} fontSize={15} fontWeight="600" color={c.text} numberOfLines={1}>
            {ctxTitle}
          </Text>
          <Text fontFamily={FONT_MONO} fontSize={12} color={c.text3} numberOfLines={1}>
            {ctxStats}
          </Text>
        </XStack>
        <XStack
          borderWidth={1}
          borderColor={c.borderStrong}
          borderRadius={6}
          overflow="hidden"
          flexShrink={0}
        >
          <ScopeButton
            label={t("catalog.scopeAll")}
            active={scope === "all"}
            c={c}
            onPress={() => setScope("all")}
          />
          <ScopeButton
            label={t("catalog.scopeInstalled")}
            active={scope === "installed"}
            c={c}
            onPress={() => setScope("installed")}
          />
        </XStack>
      </XStack>

      {/* Category chips — horizontal scroll with wheel-to-horizontal + arrows
          so the row is reachable without a trackpad. */}
      <CategoryChipBar c={c}>
        <CatChip
          label={t("catalog.allMcas")}
          Icon={LayoutGrid}
          count={scopedCatalog.length}
          active={activeCat === "all"}
          c={c}
          onPress={() => setActiveCat("all")}
        />
        {presentCats.map((cat) => (
          <CatChip
            key={cat}
            label={categoryLabel(cat, t)}
            Icon={CAT_ICONS[cat] ?? MoreHorizontal}
            count={counts[cat] ?? 0}
            active={activeCat === cat}
            c={c}
            onPress={() => setActiveCat(cat)}
          />
        ))}
      </CategoryChipBar>

      {/* Grid */}
      {isLoading ? (
        <FullscreenLoader variant="default" label={t("common.loading")} />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 32 }}>
          {filtered.length === 0 ? (
            <YStack alignItems="center" paddingVertical={60} gap={10}>
              <Search size={32} color={c.text3} opacity={0.4} />
              <Text fontFamily={FONT_SANS} fontSize={13.5} color={c.text3}>
                {q
                  ? t("catalog.noAppsFound", { defaultValue: `No Agent Apps found for "${searchQuery}"` })
                  : t("catalog.noAppsFound")}
              </Text>
            </YStack>
          ) : (
            sections.map(({ cat, items }) => (
              <YStack key={cat} marginBottom={20}>
                {grouped && (
                  <XStack alignItems="center" gap={10} marginBottom={12} marginTop={4}>
                    <Text
                      fontFamily={FONT_SANS}
                      fontSize={10.5}
                      fontWeight="600"
                      color={c.text3}
                      textTransform="uppercase"
                      letterSpacing={0.8}
                    >
                      {categoryLabel(cat, t)}
                    </Text>
                    <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
                    <Text fontFamily={FONT_MONO} fontSize={11} color={c.text3}>
                      {items.length}
                    </Text>
                  </XStack>
                )}
                <XStack flexWrap="wrap" gap={10}>
                  {items.map((mca) => (
                    <CatalogCard
                      key={mca.mcaId}
                      mca={mca}
                      c={c}
                      categoryName={categoryLabel(mca.category, t)}
                      installCount={installedApps.filter((a) => a.mcaId === mca.mcaId).length}
                      cardWidth={cardWidth}
                      onPress={() => openDetail(mca.mcaId)}
                    />
                  ))}
                </XStack>
              </YStack>
            ))
          )}
        </ScrollView>
      )}
    </YStack>
  )
}

type Colors = ReturnType<typeof useColors>
const ACCENT = "#5E6AD2"
// Green for the installed-instances count dot (matches the "Ready" dot in My Apps).
const ACCENT_GREEN = "#10B981"

// Minimal shape of the DOM scroll node we drive (web). Kept structural so the
// file doesn't depend on DOM lib types.
type ScrollNode = {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
  addEventListener: (type: string, handler: (e: { deltaY: number; preventDefault: () => void }) => void, opts?: { passive: boolean }) => void
  removeEventListener: (type: string, handler: (e: { deltaY: number; preventDefault: () => void }) => void) => void
  scrollBy?: (opts: { left: number; behavior?: "smooth" | "auto" }) => void
}

/** Left/right scroll affordance for the chip bar. Dimmed + inert at the ends. */
function ChipArrow({
  dir,
  enabled,
  c,
  onPress,
}: {
  dir: "left" | "right"
  enabled: boolean
  c: Colors
  onPress: () => void
}) {
  const Icon = dir === "left" ? ChevronLeft : ChevronRight
  return (
    <XStack
      width={30}
      height={30}
      marginHorizontal={4}
      borderRadius={8}
      alignItems="center"
      justifyContent="center"
      opacity={enabled ? 1 : 0.25}
      cursor={enabled ? "pointer" : "default"}
      hoverStyle={enabled ? { backgroundColor: c.bgCardHover } : {}}
      onPress={enabled ? onPress : undefined}
    >
      <Icon size={16} color={c.text2} />
    </XStack>
  )
}

/**
 * Horizontally-scrolling chip bar reachable without a trackpad: the vertical
 * mouse wheel is translated to horizontal scroll, and ‹ › buttons scroll on
 * click (enabled only when there's more in that direction). Falls back to a
 * plain scroller if the platform doesn't expose a DOM node.
 */
function CategoryChipBar({ c, children }: { c: Colors; children: React.ReactNode }) {
  const scrollRef = useRef<{ getScrollableNode?: () => ScrollNode } | null>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const getNode = useCallback((): ScrollNode | null => {
    const r = scrollRef.current
    return r && typeof r.getScrollableNode === "function" ? r.getScrollableNode() : null
  }, [])

  const updateArrows = useCallback(() => {
    const node = getNode()
    if (!node) return
    setCanLeft(node.scrollLeft > 1)
    setCanRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 1)
  }, [getNode])

  useEffect(() => {
    const node = getNode()
    if (!node || typeof node.addEventListener !== "function") return
    const onWheel = (e: { deltaY: number; preventDefault: () => void }) => {
      if (e.deltaY === 0) return
      node.scrollLeft += e.deltaY
      e.preventDefault()
    }
    node.addEventListener("wheel", onWheel, { passive: false })
    node.addEventListener("scroll", updateArrows)
    updateArrows()
    return () => {
      node.removeEventListener("wheel", onWheel)
      node.removeEventListener("scroll", updateArrows)
    }
  }, [getNode, updateArrows])

  const scrollByX = (dx: number) => {
    const node = getNode()
    if (!node) return
    if (typeof node.scrollBy === "function") node.scrollBy({ left: dx, behavior: "smooth" })
    else node.scrollLeft += dx
  }

  return (
    <XStack alignItems="center" borderBottomWidth={1} borderBottomColor={c.border}>
      <ChipArrow dir="left" enabled={canLeft} c={c} onPress={() => scrollByX(-220)} />
      <ScrollView
        ref={scrollRef as never}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 12, gap: 7, alignItems: "center" }}
        onContentSizeChange={updateArrows}
      >
        {children}
      </ScrollView>
      <ChipArrow dir="right" enabled={canRight} c={c} onPress={() => scrollByX(220)} />
    </XStack>
  )
}

/**
 * Category filter pill (horizontal scroller). `active` swaps the whole colour
 * set in one shot so there's a single decision point instead of one ternary
 * per styled prop.
 */
function CatChip({
  label,
  Icon,
  count,
  active,
  c,
  onPress,
}: {
  label: string
  Icon: React.ComponentType<{ size?: number; color?: string }>
  count: number
  active: boolean
  c: Colors
  onPress: () => void
}) {
  const s = active
    ? { border: ACCENT, bg: ACCENT, hoverBg: ACCENT, fg: "#FFFFFF", count: "rgba(255,255,255,0.85)" }
    : { border: c.border, bg: "transparent", hoverBg: c.bgCardHover, fg: c.text2, count: c.text3 }
  return (
    <XStack
      alignItems="center"
      gap={6}
      paddingHorizontal={11}
      paddingVertical={5}
      borderRadius={20}
      borderWidth={1}
      borderColor={s.border}
      backgroundColor={s.bg}
      hoverStyle={{ backgroundColor: s.hoverBg, borderColor: active ? ACCENT : c.borderStrong }}
      cursor="pointer"
      onPress={onPress}
    >
      <Icon size={13} color={active ? "#FFFFFF" : c.text3} />
      <Text
        fontFamily={FONT_SANS}
        fontSize={12}
        fontWeight={active ? "500" : "400"}
        color={s.fg}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text fontFamily={FONT_MONO} fontSize={11} color={s.count}>
        {count}
      </Text>
    </XStack>
  )
}

/** Scope toggle segment (All / Installed). */
function ScopeButton({
  label,
  active,
  c,
  onPress,
}: {
  label: string
  active: boolean
  c: Colors
  onPress: () => void
}) {
  return (
    <XStack
      paddingHorizontal={12}
      paddingVertical={5}
      backgroundColor={active ? ACCENT : "transparent"}
      hoverStyle={{ backgroundColor: active ? ACCENT : c.bgCardHover }}
      cursor="pointer"
      onPress={onPress}
    >
      <Text
        fontFamily={FONT_SANS}
        fontSize={12}
        fontWeight={active ? "500" : "400"}
        color={active ? "#FFFFFF" : c.text2}
      >
        {label}
      </Text>
    </XStack>
  )
}

/** A single MCA tile: icon, name + category badge, description, availability chips, id. */
function CatalogCard({
  mca,
  c,
  categoryName,
  installCount,
  cardWidth,
  onPress,
}: {
  mca: CatalogMca
  c: Colors
  categoryName: string
  installCount: number
  cardWidth: number
  onPress: () => void
}) {
  const { t, i18n } = useTranslation()
  const CatIcon = CAT_ICONS[mca.category] ?? MoreHorizontal
  const mcaTr = getMcaTranslations(mca.i18n, i18n.language)
  const trName = mcaTr?.name ?? mca.name
  const trDescription = mcaTr?.description ?? mca.description
  // Card shows only the distinctive availability chips (System / Admin only).
  // `multi` is the common case for third-party MCAs, so it would add a chip
  // on nearly every tile — it lives in the detail view instead.
  const availChips = availabilityBadges(mca.availability).filter((b) => b.key !== "multi")
  return (
    <YStack
      width={cardWidth}
      flexGrow={0}
      flexShrink={0}
      gap={9}
      padding={14}
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      backgroundColor={c.bgCard}
      cursor="pointer"
      animation="quick"
      enterStyle={{ opacity: 0, y: 8 }}
      hoverStyle={{ y: -2, backgroundColor: c.bgCardHover, borderColor: c.borderStrong }}
      onPress={onPress}
    >
      {/* Top row: logo (left) + category pill (right) — outline style with the
          category icon + uppercase label, matching the detail view's tag. */}
      <XStack alignItems="center" justifyContent="space-between" gap={8}>
        <CardIcon mca={mca} />
        <XStack
          alignItems="center"
          gap={5}
          paddingHorizontal={8}
          paddingVertical={3}
          borderRadius={20}
          borderWidth={1}
          borderColor={c.border}
          flexShrink={1}
        >
          <CatIcon size={11} color={c.text3} />
          <Text
            fontFamily={FONT_SANS}
            fontSize={9.5}
            fontWeight="500"
            color={c.text2}
            textTransform="uppercase"
            letterSpacing={0.5}
            numberOfLines={1}
          >
            {categoryName}
          </Text>
        </XStack>
      </XStack>
      <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="600" color={c.text} numberOfLines={1}>
        {trName}
      </Text>
      <Text fontFamily={FONT_SANS} fontSize={11.5} lineHeight={18} color={c.text2} numberOfLines={2}>
        {trDescription}
      </Text>
      {availChips.length > 0 && (
        <XStack gap={5} flexWrap="wrap">
          {availChips.map((b) => {
            const tint = c.badges[b.tint]
            return (
              <View
                key={b.key}
                style={{
                  backgroundColor: tint.bg,
                  borderColor: tint.border,
                  borderWidth: 1,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 20,
                }}
              >
                <Text fontFamily={FONT_SANS} fontSize={9} fontWeight="500" color={tint.text}>
                  {b.label}
                </Text>
              </View>
            )
          })}
        </XStack>
      )}
      <XStack alignItems="center" justifyContent="space-between" gap={6}>
        <Text flex={1} fontFamily={FONT_MONO} fontSize={9.5} color={c.text3} numberOfLines={1}>
          {mca.mcaId}
        </Text>
        {installCount > 0 && (
          <XStack alignItems="center" gap={5} flexShrink={0}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: ACCENT_GREEN }} />
            <Text fontFamily={FONT_SANS} fontSize={10.5} fontWeight="500" color={c.text2}>
              {t("catalog.appCount", { count: installCount })}
            </Text>
          </XStack>
        )}
      </XStack>
    </YStack>
  )
}

/** Card icon — theme-aware via McaIcon (SVG inline on web, PNG fallback). */
function CardIcon({ mca }: { mca: CatalogMca }) {
  const c = useColors()
  return (
    <View
      style={{
        width: 38,
        height: 38,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.bgCardHover,
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <McaIcon
        icon={mca.icon}
        mcaId={mca.mcaId}
        size={30}
        color={c.text3}
        backgroundColor="transparent"
        borderRadius={0}
      />
    </View>
  )
}
