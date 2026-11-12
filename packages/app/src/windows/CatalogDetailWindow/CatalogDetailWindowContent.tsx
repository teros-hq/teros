/**
 * Catalog Detail Window Content (TER-526)
 *
 * Pre-install detail view of one MCA, in the OS prototype's language: a hero
 * Card (Tile lg · serif name · tagline · badges · install CTA + installed
 * instances), then PTabs — Overview (about / preview / permissions / events),
 * Tools (grouped LGroup rows) and Changelog. Loads the rich metadata via
 * app.get-catalog-mca (TER-524) and degrades every section gracefully when a
 * field is absent. All colour is theme-adaptive (`useColors`).
 *
 * Known v1 gaps (data the catalog doesn't expose yet — follow-ups):
 *  - Tool descriptions/groups: the catalog stores tool *names* only, so the
 *    Tools tab lists names without descriptions for catalog docs synced
 *    before TER-538.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Image, Platform, Pressable, View } from "react-native"
import { useToast } from "../../components/Toast"
import { FullscreenLoader } from "../../components/ui"
import { McaIcon } from "../../components/mca/McaIcon"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors } from "../../components/mca/primitives/colors"
import { availabilityBadges } from "../../components/mca/availabilityBadges"
import type { CatalogMcaDetail } from "../../services/AppApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import {
  Badge,
  type BadgeTone,
  Btn,
  Card,
  ChipBtn,
  EmptyState,
  LGroup,
  LRow,
  Page,
  Ph,
  PTabs,
  SectionLabel,
  T,
  Tile,
} from "../../components/ui/ds"
import { CAT_ICONS, categoryLabel } from "../CatalogWindow/catalogCategories"
import type { CatalogDetailWindowProps } from "./definition"

// ── MCA i18n helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the user's locale from i18n language.
 * i18n returns 'es-ES', 'en-US', 'ko-KR' — MCA i18n files use 'es', 'en', 'ko'.
 */
function mcaLocale(i18nLang: string): string {
  return i18nLang.split("-")[0]
}

/**
 * Get the translated MCA metadata for the current locale, falling back to English.
 * Returns undefined if no i18n data is available (the caller uses the raw fields).
 */
function getMcaTranslations(i18nData: CatalogMcaDetail["i18n"], locale: string) {
  if (!i18nData) return undefined
  const lang = mcaLocale(locale)
  return i18nData[lang] ?? i18nData["en"]
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

const AVAIL_TONE: Record<"gray" | "info" | "warn", BadgeTone> = {
  gray: "muted",
  info: "i",
  warn: "a",
}

type DetailTab = "overview" | "tools" | "changelog"

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
  const [installing, setInstalling] = useState(false)
  const [installingDep, setInstallingDep] = useState<string | null>(null)
  const [installedApps, setInstalledApps] = useState<Array<{ appId: string; name: string }>>([])
  // All workspace apps (any mcaId) — used to check whether declared
  // dependencies (manifest `dependencies`, T-002) are satisfied.
  const [workspaceMcaIds, setWorkspaceMcaIds] = useState<Set<string>>(new Set())
  // Catalog names of declared dependencies, keyed by mcaId (for the warning copy).
  const [depNames, setDepNames] = useState<Record<string, string>>({})
  // Tools list is capped by default so a long tool list (e.g. Notion's 32)
  // doesn't dominate the tab (progressive disclosure).
  const [showAllTools, setShowAllTools] = useState(false)
  const [tab, setTab] = useState<DetailTab>("overview")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const mca = (await client.app.getCatalogMca(mcaId)).mca
      setDetail(mca)
      // Cross-check installed instances by mcaId so the CTA survives a reload
      // (was the bug: state was local-only) and reflects multi vs single (TER-528).
      if (activeWorkspaceId) {
        const { apps } = await client.workspace.listWorkspaceApps(activeWorkspaceId)
        const mine = apps
          .filter((a) => a.mcaId === mcaId)
          .map((a) => ({ appId: a.appId, name: a.name }))
        setInstalledApps(mine)
        setWorkspaceMcaIds(new Set(apps.map((a) => a.mcaId)))
      }
      // Resolve catalog names of declared dependencies for the warning copy
      // (best-effort: fall back to the raw mcaId when a dependency is not in
      // the catalog or the fetch fails).
      const deps = mca.dependencies ?? []
      if (deps.length > 0) {
        const names: Record<string, string> = {}
        await Promise.all(
          deps.map(async (depId) => {
            try {
              const depDetail = (await client.app.getCatalogMca(depId)).mca
              names[depId] = depDetail.name
            } catch {
              names[depId] = depId
            }
          }),
        )
        setDepNames(names)
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
      const mine = apps
        .filter((a) => a.mcaId === detail.mcaId)
        .map((a) => ({ appId: a.appId, name: a.name }))
      setInstalledApps(mine)
      setWorkspaceMcaIds(new Set(apps.map((a) => a.mcaId)))
    } catch (err) {
      console.error("Error refreshing instances:", err)
    }
  }, [activeWorkspaceId, detail, client])

  // Install a declared dependency (e.g. Bash for Terminal) from the warning
  // banner. Refreshes workspace apps so the banner clears when satisfied.
  const handleInstallDep = useCallback(
    async (depMcaId: string) => {
      if (!activeWorkspaceId) return
      setInstallingDep(depMcaId)
      try {
        await client.installWorkspaceApp(activeWorkspaceId, depMcaId)
        await refreshInstances()
      } catch (err) {
        toast.error(
          t("catalog.error"),
          err instanceof Error ? err.message : t("catalog.detailInstallError"),
        )
      } finally {
        setInstallingDep(null)
      }
    },
    [activeWorkspaceId, client, refreshInstances, toast, t],
  )

  // Install a new instance. The CTA then flips to "Add another"; per-instance
  // configuration lives in the instance pills (→ app window).
  const handleInstall = useCallback(async () => {
    if (!activeWorkspaceId || !detail) return
    setInstalling(true)
    try {
      await client.installWorkspaceApp(activeWorkspaceId, detail.mcaId)
      await refreshInstances()
    } catch (err) {
      toast.error(
        t("catalog.error"),
        err instanceof Error ? err.message : t("catalog.detailInstallError"),
      )
    } finally {
      setInstalling(false)
    }
  }, [activeWorkspaceId, detail, client, refreshInstances, toast])

  if (loading) {
    return <FullscreenLoader variant="default" label={t("catalog.detailLoading")} />
  }

  if (!detail) {
    return (
      <Page>
        <EmptyState icon="storefront" title={t("catalog.notFound")} />
      </Page>
    )
  }

  const hasScreens = detail.screenshots.length > 0
  const isSystem = detail.availability.system
  // `multi` (Multi-instance) is dropped — it's the common case and adds noise.
  const availChips = availabilityBadges(detail.availability).filter((b) => b.key !== "multi")
  const installedCount = installedApps.length
  // Install CTA state: system → included; 0 instances → install; otherwise the
  // CTA installs another instance ("add another").
  const installState: "included" | "install" | "add-another" = isSystem
    ? "included"
    : installedCount === 0
      ? "install"
      : "add-another"

  // Declared dependencies not satisfied in this workspace (T-002). The banner
  // below the hero warns before install — Terminal without Bash is the case
  // that motivated the field (audit 2026-10-18).
  const missingDeps = (detail.dependencies ?? []).filter((d) => !workspaceMcaIds.has(d))

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
  // TOOLS_PREVIEW unless expanded.
  const displayRows: Array<{ kind: "header"; label: string } | { kind: "tool"; tool: ToolRow }> = []
  let shownToolCount = 0
  for (const g of toolGroups) {
    const slice = showAllTools
      ? g.items
      : g.items.slice(0, Math.max(0, TOOLS_PREVIEW - shownToolCount))
    if (slice.length === 0) continue
    if (g.label)
      displayRows.push({
        kind: "header",
        label: g.label === "Other" ? t("catalog.groupOther") : g.label,
      })
    for (const t of slice) displayRows.push({ kind: "tool", tool: t })
    shownToolCount += slice.length
    if (!showAllTools && shownToolCount >= TOOLS_PREVIEW) break
  }
  const hiddenToolCount = toolRows.length - shownToolCount

  const goBack = () => {
    // "Back" returns to the catalog. Close this detail FIRST, then open the
    // catalog — closeWindow resets the active container to the first one (the
    // index) when it empties a pane, so opening the catalog must run last for
    // its focus to win.
    closeWindow(windowId)
    openWindow("catalog", {}, false)
  }

  const tabs: Array<{ key: DetailTab; label: string; icon: string; count?: number }> = [
    {
      key: "overview",
      label: t("catalog.tabOverview", { defaultValue: "Overview" }),
      icon: "info",
    },
    { key: "tools", label: t("catalog.sectionActions"), icon: "wrench", count: toolRows.length },
  ]
  if (trChangelog.length > 0) {
    tabs.push({
      key: "changelog",
      label: t("catalog.sectionChangelog"),
      icon: "clock-counter-clockwise",
      count: trChangelog.length,
    })
  }

  const catTint =
    c.categoryBadges[detail.category as keyof typeof c.categoryBadges] ?? c.categoryBadges.other

  return (
    <Page>
      {/* Breadcrumb */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 16 }}>
        <Btn variant="ghost" size="sm" icon="arrow-left" onPress={goBack}>
          {t("catalog.breadcrumb")}
        </Btn>
        <T step="sm" tone="text3">
          ›
        </T>
        <T step="sm" tone="text2" ellipsis>
          {trName}
        </T>
      </View>

      {/* Hero */}
      <Card xl pad={32} style={{ marginBottom: 24 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
          <Tile lg>
            <McaIcon
              icon={detail.image ?? detail.icon}
              mcaId={detail.mcaId}
              size={40}
              color={c.accent}
              backgroundColor="transparent"
              borderRadius={0}
            />
          </Tile>
          <View style={{ flex: 1, minWidth: 240 }}>
            <T step="2xl">{trName}</T>
            {trTagline ? (
              <T step="lg" tone="text2" style={{ marginTop: 6 }}>
                {trTagline}
              </T>
            ) : null}
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 6,
                marginTop: 14,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  height: 22,
                  paddingHorizontal: 9,
                  borderRadius: 100,
                  backgroundColor: catTint.bg,
                }}
              >
                <Ph
                  name={CAT_ICONS[detail.category] ?? "dots-three"}
                  size={11}
                  color={catTint.text}
                />
                <T step="xxs" color={catTint.text} style={{ fontSize: 9.5, lineHeight: 12 }}>
                  {categoryLabel(detail.category, t)}
                </T>
              </View>
              {availChips.map((b) => (
                <Badge key={b.key} tone={AVAIL_TONE[b.tint]} pill>
                  {b.label}
                </Badge>
              ))}
              {detail.version ? <Badge mono pill>{`v${detail.version}`}</Badge> : null}
              <Badge pill icon="key">
                {authLabel(detail.authType, t)}
              </Badge>
              <Badge pill icon="wrench">
                {t("catalog.toolCount", { count: detail.tools.length })}
              </Badge>
              {detail.keywords.length > 0 ? (
                <T step="12" tone="text3">
                  {detail.keywords.slice(0, 3).join(" · ")}
                </T>
              ) : null}
              {homepageHost ? (
                <Pressable
                  accessibilityRole="link"
                  onPress={() => detail.homepage && openExternal(detail.homepage)}
                  style={[
                    { flexDirection: "row", alignItems: "center", gap: 4 },
                    Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                  ]}
                >
                  <T step="12" tone="accent">
                    {homepageHost}
                  </T>
                  <Ph name="arrow-up-right" size={12} color={c.accent} />
                </Pressable>
              ) : null}
            </View>
          </View>

          <View style={{ alignItems: "flex-end", gap: 10, maxWidth: 320 }}>
            {installState === "included" ? (
              <Badge tone="g" dot lg pill>
                {t("catalog.included")}
              </Badge>
            ) : installState === "install" ? (
              <Btn
                variant="primary"
                icon="download-simple"
                loading={installing}
                onPress={handleInstall}
              >
                {t("catalog.install")}
              </Btn>
            ) : (
              <Btn variant="sec" icon="plus" loading={installing} onPress={handleInstall}>
                {t("catalog.addAnother")}
              </Btn>
            )}
            {installState === "add-another" && installedApps.length > 0 ? (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  gap: 6,
                }}
              >
                {installedApps.map((app) => (
                  <ChipBtn
                    key={app.appId}
                    icon="arrow-up-right"
                    onPress={() => openWindow("app", { appId: app.appId }, false)}
                  >
                    {app.name}
                  </ChipBtn>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </Card>

      {/* Unsatisfied dependencies warning (T-002) — suggests installing the
          missing apps (e.g. Bash for Terminal) before/after installing this one. */}
      {missingDeps.length > 0 ? (
        <Card pad style={{ marginBottom: 24, borderColor: semanticColors.amber, borderWidth: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
            <Ph name="warning" size={20} color={semanticColors.amber} style={{ marginTop: 2 }} />
            <View style={{ flex: 1, gap: 10 }}>
              <T step="base" style={{ fontWeight: "600" }}>
                {t("catalog.dependenciesTitle", {
                  count: missingDeps.length,
                  defaultValue: "Missing dependencies",
                })}
              </T>
              <T step="sm" tone="text2">
                {t("catalog.dependenciesBody", {
                  name: trName,
                  defaultValue:
                    "{{name}} needs the following apps installed in this workspace to work properly:",
                })}
              </T>
              {missingDeps.map((depId) => (
                <View
                  key={depId}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                    <Ph name="cube" size={15} color={c.text3} />
                    <T step="sm" style={{ fontWeight: "600" }}>
                      {depNames[depId] ?? depId}
                    </T>
                    <T step="code" tone="text3">
                      {depId}
                    </T>
                  </View>
                  <Btn
                    variant="sec"
                    size="sm"
                    icon="download-simple"
                    loading={installingDep === depId}
                    onPress={() => handleInstallDep(depId)}
                  >
                    {t("catalog.installDependency", {
                      name: depNames[depId] ?? depId,
                      defaultValue: "Install {{name}}",
                    })}
                  </Btn>
                </View>
              ))}
            </View>
          </View>
        </Card>
      ) : null}

      <PTabs<DetailTab> value={tab} onChange={setTab} items={tabs} style={{ marginBottom: 20 }} />

      {tab === "overview" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 28 }}>
          <View style={{ flex: 1, minWidth: 280 }}>
            <SectionLabel label={t("catalog.sectionAbout")} />
            <View style={{ gap: 12, maxWidth: 620 }}>
              {paragraphs.map((p, i) => (
                <T key={`p-${i}`} step="base" tone="text2">
                  {p}
                </T>
              ))}
            </View>

            <SectionLabel label={t("catalog.sectionEvents")} style={{ marginTop: 32 }} />
            <T step="sm" tone="text3" style={{ marginBottom: 8 }}>
              {t("catalog.eventsSubtitle")}
            </T>
            <Card pad>
              <EmptyState
                icon="lightning"
                title={t("catalog.noEvents")}
                text={t("catalog.eventsDescription", { name: trName })}
                style={{ paddingVertical: 24 }}
              />
            </Card>
          </View>

          <View style={{ width: 260 }}>
            <SectionLabel label={t("catalog.sectionPreview")} />
            {hasScreens ? (
              <Card>
                <Image
                  source={{ uri: detail.screenshots[0] }}
                  style={{ width: "100%", height: 152 }}
                  resizeMode="cover"
                />
              </Card>
            ) : (
              <View
                style={{
                  height: 152,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: c.borderStrong,
                  backgroundColor: c.wash,
                  justifyContent: "center",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Ph name="image" size={22} color={c.text3} />
                <T step="12" tone="text3">
                  {t("catalog.previewComingSoon")}
                </T>
              </View>
            )}

            {detail.permissions.length > 0 ? (
              <>
                <SectionLabel
                  label={t("catalog.sectionPermissions")}
                  count={detail.permissions.length}
                  style={{ marginTop: 24 }}
                />
                <LGroup>
                  {detail.permissions.map((perm) => (
                    <LRow key={perm.type} gap={10}>
                      <Ph
                        name={
                          perm.type === "network"
                            ? "globe"
                            : perm.type === "filesystem"
                              ? "folder"
                              : "shield-check"
                        }
                        size={15}
                        color={c.text3}
                      />
                      <T step="sm" style={{ flex: 1 }}>
                        {perm.label}
                      </T>
                      <T step="code" tone="text3" ellipsis style={{ maxWidth: 110 }}>
                        {perm.detail}
                      </T>
                    </LRow>
                  ))}
                </LGroup>
              </>
            ) : null}
          </View>
        </View>
      ) : null}

      {tab === "tools" ? (
        <View>
          <SectionLabel label={t("catalog.sectionActions")} count={detail.tools.length} />
          <T step="sm" tone="text3" style={{ marginBottom: 12 }}>
            {t("catalog.toolsCount", { count: detail.tools.length })}
          </T>
          <LGroup>
            {displayRows.map((row) => {
              if (row.kind === "header") {
                return (
                  <View
                    key={`h-${row.label}`}
                    style={{
                      paddingHorizontal: 16,
                      paddingTop: 12,
                      paddingBottom: 6,
                      backgroundColor: c.wash,
                    }}
                  >
                    <T step="xs" tone="text3">
                      {row.label}
                    </T>
                  </View>
                )
              }
              const tool = row.tool
              return (
                <LRow key={`t-${tool.name}`} gap={12}>
                  <Badge mono>{tool.name}</Badge>
                  <T step="sm" tone="text2" numberOfLines={2} style={{ flex: 1 }}>
                    {tool.description || tool.name}
                  </T>
                </LRow>
              )
            })}
          </LGroup>
          {(hiddenToolCount > 0 || showAllTools) && toolRows.length > TOOLS_PREVIEW ? (
            <Btn
              variant="ghost"
              size="sm"
              iconRight={showAllTools ? "caret-up" : "caret-down"}
              onPress={() => setShowAllTools((v) => !v)}
              style={{ marginTop: 10, alignSelf: "flex-start" }}
            >
              {showAllTools
                ? t("catalog.showLess")
                : t("catalog.showAllActions", { count: toolRows.length })}
            </Btn>
          ) : null}
        </View>
      ) : null}

      {tab === "changelog" ? (
        <View>
          <SectionLabel label={t("catalog.sectionChangelog")} count={trChangelog.length} />
          <LGroup>
            {trChangelog.map((entry) => (
              <LRow key={entry.version} gap={14} style={{ alignItems: "flex-start" }}>
                <Badge mono tone="i">{`v${entry.version}`}</Badge>
                <View style={{ flex: 1, gap: 4 }}>
                  <T step="sm" tone="text2">
                    {entry.notes}
                  </T>
                  <T step="code" tone="text3">
                    {entry.date}
                  </T>
                </View>
              </LRow>
            ))}
          </LGroup>
        </View>
      ) : null}
    </Page>
  )
}

function openExternal(url: string) {
  if (typeof window !== "undefined" && window.open) {
    window.open(url, "_blank", "noopener,noreferrer")
  }
}
