/**
 * Catalog Window Content — the Agent App marketplace, in the OS prototype's
 * language: page head (eyebrow · serif headline · mono stats · search +
 * All/Installed tabs), a scrollable category chip bar, and per-category grids
 * of `.appc` cards (Tile · category pill · name · description · id · install).
 * Clicking a card (or its Install link) opens the catalog detail window —
 * install itself lives there (TER-526). Filters, counts and grouping are the
 * same pure derivation as before.
 */

import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Platform, Pressable, ScrollView, View } from "react-native"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useToast } from "../../components/Toast"
import { FullscreenLoader } from "../../components/ui"
import { McaIcon } from "../../components/mca/McaIcon"
import { useColors } from "../../components/mca/primitives/useColors"
import { availabilityBadges } from "../../components/mca/availabilityBadges"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import {
  Badge,
  type BadgeTone,
  Card,
  Chip,
  EmptyState,
  Field,
  Grid,
  IconBtn,
  Page,
  PageHead,
  Ph,
  PTabs,
  SectionLabel,
  T,
  Tile,
} from "../../components/ui/ds"
import type { CatalogWindowProps } from "./definition"
import { CAT_ORDER, CAT_ICONS, categoryLabel } from "./catalogCategories"

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
  i18n?: Record<
    string,
    {
      name?: string
      description?: string
      tagline?: string
      tools?: Record<
        string,
        {
          name?: string
          description?: string
          params?: Record<string, string>
        }
      >
    }
  >
}

interface InstalledApp {
  appId: string
  mcaId: string
  name: string
}

// ── MCA i18n helpers ──────────────────────────────────────────────────────────

function mcaLocale(i18nLang: string): string {
  return i18nLang.split("-")[0]
}

function getMcaTranslations(i18nData: CatalogMca["i18n"], locale: string) {
  if (!i18nData) return undefined
  const lang = mcaLocale(locale)
  return i18nData[lang] ?? i18nData["en"]
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
  const { t } = useTranslation()
  const client = getTerosClient()
  const toast = useToast()
  const openWindow = useTilingStore((s) => s.openWindow)
  const activeWorkspaceId = workspaceId ?? useWorkspaceStore((s) => s.activeWorkspaceId)

  const [catalog, setCatalog] = useState<CatalogMca[]>([])
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState(initialSearch || "")
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
      setCatalog(catalogResult.catalog as CatalogMca[])
      if (activeWorkspaceId) {
        const { apps } = await client.workspace.listWorkspaceApps(activeWorkspaceId)
        const mine = apps.map((a) => ({ appId: a.appId, mcaId: a.mcaId, name: a.name }))
        setInstalledApps(mine)
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
  const { scopedCatalog, counts, presentCats, filtered, grouped, sections, ctxTitle, ctxStats } =
    deriveCatalogView(catalog, isInstalled, scope, activeCat, q, {
      all: t("catalog.allMcas"),
      installed: t("catalog.scopeInstalled"),
      category: (cat) => categoryLabel(cat, t),
    })

  if (isLoading) {
    return <FullscreenLoader variant="default" label={t("common.loading")} />
  }

  return (
    <Page>
      <PageHead
        eyebrow={t("catalog.title")}
        title={t("catalog.headline", { defaultValue: "Where your agents get work done." })}
        accent={t("catalog.headlineAccent", { defaultValue: "get work done." })}
        lead={
          <T step="code" tone="text3">
            {ctxStats}
          </T>
        }
        actions={
          <>
            <Field
              icon="magnifying-glass"
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t("catalog.searchPlaceholder", { defaultValue: "Search apps…" })}
              containerStyle={{ width: 240 }}
            />
            <PTabs<"all" | "installed">
              value={scope}
              onChange={setScope}
              items={[
                { key: "all", label: t("catalog.scopeAll") },
                {
                  key: "installed",
                  label: t("catalog.scopeInstalled"),
                  count: installedApps.length,
                },
              ]}
            />
          </>
        }
      />

      {/* Category chips — horizontal scroll with wheel-to-horizontal + arrows
          so the row is reachable without a trackpad. */}
      <CategoryChipBar>
        <Chip
          icon="squares-four"
          count={scopedCatalog.length}
          on={activeCat === "all"}
          onPress={() => setActiveCat("all")}
        >
          {t("catalog.allMcas")}
        </Chip>
        {presentCats.map((cat) => (
          <Chip
            key={cat}
            icon={CAT_ICONS[cat] ?? "dots-three"}
            count={counts[cat] ?? 0}
            on={activeCat === cat}
            onPress={() => setActiveCat(cat)}
          >
            {categoryLabel(cat, t)}
          </Chip>
        ))}
      </CategoryChipBar>

      {filtered.length === 0 ? (
        <EmptyState
          icon="magnifying-glass"
          title={t("catalog.noAppsFound")}
          text={q ? `“${searchQuery}”` : undefined}
        />
      ) : (
        sections.map(({ cat, items }) => (
          <View key={cat} style={{ marginBottom: 24 }}>
            <SectionLabel label={grouped ? categoryLabel(cat, t) : ctxTitle} count={items.length} />
            <Grid cols={3}>
              {items.map((mca) => (
                <CatalogCard
                  key={mca.mcaId}
                  mca={mca}
                  categoryName={categoryLabel(mca.category, t)}
                  installCount={installedApps.filter((a) => a.mcaId === mca.mcaId).length}
                  onPress={() => openDetail(mca.mcaId)}
                />
              ))}
            </Grid>
          </View>
        ))
      )}
    </Page>
  )
}

// Minimal shape of the DOM scroll node we drive (web). Kept structural so the
// file doesn't depend on DOM lib types.
type ScrollNode = {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
  addEventListener: (
    type: string,
    handler: (e: { deltaY: number; preventDefault: () => void }) => void,
    opts?: { passive: boolean },
  ) => void
  removeEventListener: (
    type: string,
    handler: (e: { deltaY: number; preventDefault: () => void }) => void,
  ) => void
  scrollBy?: (opts: { left: number; behavior?: "smooth" | "auto" }) => void
}

/**
 * Horizontally-scrolling chip bar reachable without a trackpad: the vertical
 * mouse wheel is translated to horizontal scroll, and ‹ › buttons scroll on
 * click (enabled only when there's more in that direction). Falls back to a
 * plain scroller if the platform doesn't expose a DOM node.
 */
function CategoryChipBar({ children }: { children: React.ReactNode }) {
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 24 }}>
      <IconBtn icon="caret-left" plain sm disabled={!canLeft} onPress={() => scrollByX(-220)} />
      <ScrollView
        ref={scrollRef as never}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingVertical: 2, gap: 8, alignItems: "center" }}
        onContentSizeChange={updateArrows}
      >
        {children}
      </ScrollView>
      <IconBtn icon="caret-right" plain sm disabled={!canRight} onPress={() => scrollByX(220)} />
    </View>
  )
}

/** Category pill of a card — tinted with the MCA category colour (`categoryBadges`). */
function CategoryPill({ category, label }: { category: string; label: string }) {
  const c = useColors()
  const tint = c.categoryBadges[category as keyof typeof c.categoryBadges] ?? c.categoryBadges.other
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        height: 22,
        paddingHorizontal: 9,
        borderRadius: 100,
        backgroundColor: tint.bg,
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      <Ph name={CAT_ICONS[category] ?? "dots-three"} size={11} color={tint.text} />
      <T step="xxs" color={tint.text} numberOfLines={1} style={{ fontSize: 9.5, lineHeight: 12 }}>
        {label}
      </T>
    </View>
  )
}

const AVAIL_TONE: Record<"gray" | "info" | "warn", BadgeTone> = {
  gray: "muted",
  info: "i",
  warn: "a",
}

/** A single MCA tile: Tile + category pill, name, description, availability chips, id + install. */
function CatalogCard({
  mca,
  categoryName,
  installCount,
  onPress,
}: {
  mca: CatalogMca
  categoryName: string
  installCount: number
  onPress: () => void
}) {
  const c = useColors()
  const { t, i18n } = useTranslation()
  const mcaTr = getMcaTranslations(mca.i18n, i18n.language)
  const trName = mcaTr?.name ?? mca.name
  const trDescription = mcaTr?.description ?? mca.description
  // Card shows only the distinctive availability chips (System / Admin only).
  // `multi` is the common case for third-party MCAs, so it would add a chip
  // on nearly every tile — it lives in the detail view instead.
  const availChips = availabilityBadges(mca.availability).filter((b) => b.key !== "multi")
  return (
    <Card hov pad={20} onPress={onPress} style={{ minHeight: 176, width: "100%" }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Tile>
          <McaIcon
            icon={mca.icon}
            mcaId={mca.mcaId}
            size={24}
            color={c.accent}
            backgroundColor="transparent"
            borderRadius={0}
          />
        </Tile>
        <CategoryPill category={mca.category} label={categoryName} />
      </View>
      <T step="base" ellipsis style={{ marginTop: 14 }}>
        {trName}
      </T>
      <T step="sm" tone="text2" numberOfLines={2} style={{ marginTop: 4, flex: 1 }}>
        {trDescription}
      </T>
      {availChips.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
          {availChips.map((b) => (
            <Badge key={b.key} tone={AVAIL_TONE[b.tint]} sm pill>
              {b.label}
            </Badge>
          ))}
        </View>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 14,
        }}
      >
        <T step="code" tone="text3" ellipsis style={{ flex: 1, fontSize: 10.5 }}>
          {mca.mcaId}
        </T>
        {installCount > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Badge tone="g" dot sm pill>
              {installCount > 1
                ? `${t("catalog.installedBadge")} ×${installCount}`
                : t("catalog.installedBadge")}
            </Badge>
            <InstallLink iconOnly onPress={onPress} label={t("catalog.addAnother")} />
          </View>
        ) : (
          <InstallLink onPress={onPress} label={t("catalog.install")} />
        )}
      </View>
    </Card>
  )
}

/** `.ap-inst` — the quiet accent "＋ Install" link at a card's foot. */
function InstallLink({
  onPress,
  label,
  iconOnly,
}: {
  onPress: () => void
  label: string
  iconOnly?: boolean
}) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          height: 26,
          paddingHorizontal: iconOnly ? 0 : 10,
          width: iconOnly ? 26 : undefined,
          justifyContent: "center",
          borderRadius: 100,
          marginRight: -6,
          backgroundColor: hover ? c.navActive : "transparent",
        },
        Platform.OS === "web"
          ? ({ cursor: "pointer", transition: "background 0.2s" } as any)
          : null,
      ]}
    >
      <Ph name="plus" size={13} color={c.accent} />
      {iconOnly ? null : (
        <T step="12" tone="accent">
          {label}
        </T>
      )}
    </Pressable>
  )
}
