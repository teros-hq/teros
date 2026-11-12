/**
 * Apps Window Content — "Mis apps" of the OS prototype.
 *
 * Page head (eyebrow · serif title · lead · search + "Explore catalog"), an
 * attention banner when some apps can't be used yet, status filter tabs, and
 * the installed / system grids of `AppCard`s. Data loading, auth status
 * polling and navigation are unchanged — only the presentation moved to the
 * `ui/ds` primitives.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { AppCard, appStatusMeta } from "../../components/AppCard"
import type { AppAuthInfo } from "../../components/apps"
import { useToast } from "../../components/Toast"
import { useClickModifiers } from "../../hooks/useClickModifiers"
import type { AppsWindowProps } from "./definition"
import { useTilingStore } from "../../store/tilingStore"
import { FullscreenLoader } from "../../components/ui"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useColors } from "../../components/mca/primitives/useColors"
import { SystemCapabilitiesSection } from "../../components/SystemCapabilitiesSection"
import {
  Btn,
  Card,
  EmptyState,
  Field,
  Grid,
  Page,
  PageHead,
  Ph,
  PTabs,
  SectionLabel,
  T,
} from "../../components/ui/ds"

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
}

interface InstalledApp {
  appId: string
  mcaId: string
  name: string
  /** Icon path from workspace.list-apps — resolved from the FULL catalog (no hidden
   * filter), so hidden system MCAs (scheduler, messaging, …) still get their icon. */
  icon?: string
  color?: string
  category?: string
}

type Filter = "all" | "ready" | "attention" | "idle"

interface AppsWindowContentProps extends AppsWindowProps {
  windowId: string
}

export function AppsWindowContent({
  windowId,
  workspaceId,
  search: initialSearch,
}: AppsWindowContentProps) {
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<CatalogMca[]>([])
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState(initialSearch || "")
  const [filter, setFilter] = useState<Filter>("all")
  const [authStatuses, setAuthStatuses] = useState<Record<string, AppAuthInfo | null>>({})
  const [loadingAuthStatus, setLoadingAuthStatus] = useState<Record<string, boolean>>({})

  const { openWindow } = useTilingStore()
  const client = getTerosClient()
  const toast = useToast()
  const { shouldOpenInNewTab } = useClickModifiers()
  const activeWorkspaceId = workspaceId ?? useWorkspaceStore((s) => s.activeWorkspaceId)
  const c = useColors()

  useEffect(() => {
    const tryLoadData = async () => {
      if (client.isConnected()) {
        loadData()
      } else {
        const onConnected = () => {
          client.off("connected", onConnected)
          loadData()
        }
        client.on("connected", onConnected)
        return () => {
          client.off("connected", onConnected)
        }
      }
    }
    tryLoadData()
  }, [])

  const loadAuthStatus = useCallback(
    async (appId: string) => {
      setLoadingAuthStatus((prev) => ({ ...prev, [appId]: true }))
      try {
        const authInfo = (await client.app.getAuthStatus(appId)).auth
        setAuthStatuses((prev) => ({ ...prev, [appId]: authInfo as any }))
      } catch (err) {
        console.error(`Error loading auth status for ${appId}:`, err)
        setAuthStatuses((prev) => ({ ...prev, [appId]: null }))
      } finally {
        setLoadingAuthStatus((prev) => ({ ...prev, [appId]: false }))
      }
    },
    [client],
  )

  const loadAllAuthStatuses = useCallback(
    async (apps: InstalledApp[]) => {
      await Promise.all(apps.map((app) => loadAuthStatus(app.appId)))
    },
    [loadAuthStatus],
  )

  const loadData = async () => {
    setIsLoading(true)
    try {
      const catalogResult = await client.app.listCatalog()
      setCatalog(catalogResult.catalog as CatalogMca[])

      if (activeWorkspaceId) {
        const { apps: wsApps } = await client.workspace.listWorkspaceApps(activeWorkspaceId)
        // Keep icon/color/category from the backend response — it resolves them
        // from the FULL catalog (no hidden filter), unlike app.list-catalog which
        // excludes hidden system MCAs. The catalog below is only a fallback.
        const real = wsApps.map((a) => ({
          appId: a.appId,
          mcaId: a.mcaId,
          name: a.name,
          icon: a.icon,
          color: a.color,
          category: a.category,
        }))
        setInstalledApps(real)
        loadAllAuthStatuses(real)
      }
    } catch (err: any) {
      console.error("Error loading apps:", err)
      toast.error(t("common.error"), t("apps.couldNotLoadApps"))
    } finally {
      setIsLoading(false)
    }
  }

  // MUW-REQ-13: keep the list live. Installs, scope/rename changes and
  // uninstalls are pushed to every member of the workspace; the server-side
  // list is the only thing that knows what THIS member may see, so re-fetch
  // it (coalesced) instead of patching rows from the payload.
  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        loadDataRef.current()
      }, 250)
    }
    client.on("app.installed", refresh)
    client.on("app.updated", refresh)
    client.on("app.uninstalled", refresh)
    return () => {
      if (timer) clearTimeout(timer)
      client.off("app.installed", refresh)
      client.off("app.updated", refresh)
      client.off("app.uninstalled", refresh)
    }
  }, [client])

  const getMcaForApp = (mcaId: string): CatalogMca | undefined => {
    return catalog.find((mca) => mca.mcaId === mcaId)
  }

  // ── Derived rows: status kind per app ────────────────────────────────────
  // v1.4.4: system capabilities are no longer "apps" — they render in their
  // own SystemCapabilitiesSection below, so rows here are user apps only.
  const rows = useMemo(() => {
    return installedApps
      .map((app) => {
        const mca = getMcaForApp(app.mcaId)
        const meta = appStatusMeta(authStatuses[app.appId], loadingAuthStatus[app.appId], t)
        return { app, mca, kind: meta.kind }
      })
      .sort((a, b) => a.app.name.localeCompare(b.app.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedApps, catalog, authStatuses, loadingAuthStatus, t])

  const counts = useMemo(() => {
    const n = { all: rows.length, ready: 0, attention: 0, idle: 0, usable: 0 }
    for (const r of rows) {
      if (r.kind === "ready") n.ready++
      else if (r.kind === "attention") n.attention++
      else if (r.kind === "idle") n.idle++
      // "Usable" = an agent can call it right now: connected, or needs no credentials.
      if (r.kind === "ready" || r.kind === "idle") n.usable++
    }
    return n
  }, [rows])

  const attentionBreakdown = useMemo(() => {
    const b = { connect: 0, error: 0, admin: 0, expired: 0 }
    for (const r of rows) {
      const s = authStatuses[r.app.appId]?.status
      if (s === "needs_user_auth") b.connect++
      else if (s === "error") b.error++
      else if (s === "needs_system_setup") b.admin++
      else if (s === "expired") b.expired++
    }
    return b
  }, [rows, authStatuses])

  // Filter by search + status tab
  const q = searchQuery.toLowerCase().trim()
  const visible = rows.filter(({ app, mca, kind }) => {
    if (q) {
      const hit =
        app.name.toLowerCase().includes(q) ||
        mca?.name.toLowerCase().includes(q) ||
        mca?.description.toLowerCase().includes(q)
      if (!hit) return false
    }
    switch (filter) {
      case "ready":
        return kind === "ready"
      case "attention":
        return kind === "attention"
      case "idle":
        return kind === "idle"
      default:
        return true
    }
  })
  const installedRows = visible

  const renderInstalledAppCard = (app: InstalledApp) => {
    const mca = getMcaForApp(app.mcaId)
    const authInfo = authStatuses[app.appId]
    const loading = loadingAuthStatus[app.appId]

    return (
      <AppCard
        key={app.appId}
        appId={app.appId}
        name={app.name}
        icon={app.icon ?? mca?.icon}
        color={app.color ?? mca?.color}
        mcaId={app.mcaId}
        category={app.category ?? mca?.category}
        authInfo={authInfo}
        loading={loading}
        layout="fill"
        onPress={(e?: any) => {
          openWindow("app", { appId: app.appId }, shouldOpenInNewTab(e))
        }}
      />
    )
  }

  const openCatalog = () => openWindow("catalog", {}, false)

  if (isLoading) {
    return <FullscreenLoader variant="default" label={t("common.loading")} />
  }

  const breakdownParts = [
    attentionBreakdown.connect > 0 &&
      t("apps.attentionConnect", {
        count: attentionBreakdown.connect,
        defaultValue: "{{count}} to connect",
      }),
    attentionBreakdown.expired > 0 &&
      t("apps.attentionExpired", {
        count: attentionBreakdown.expired,
        defaultValue: "{{count}} expired",
      }),
    attentionBreakdown.error > 0 &&
      t("apps.attentionError", {
        count: attentionBreakdown.error,
        defaultValue: "{{count}} with errors",
      }),
    attentionBreakdown.admin > 0 &&
      t("apps.attentionAdmin", {
        count: attentionBreakdown.admin,
        defaultValue: "{{count}} waiting for an admin",
      }),
  ].filter(Boolean) as string[]

  const tabs: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: t("apps.filterAll", { defaultValue: "All" }), count: counts.all },
    { key: "ready", label: t("apps.filterReady", { defaultValue: "Ready" }), count: counts.ready },
    {
      key: "attention",
      label: t("apps.filterAttention", { defaultValue: "Need attention" }),
      count: counts.attention,
    },
    { key: "idle", label: t("apps.filterIdle", { defaultValue: "Idle" }), count: counts.idle },
  ]

  return (
    <Page>
      <PageHead
        eyebrow={t("apps.eyebrow", { defaultValue: "Apps" })}
        title={t("windows.myApps")}
        lead={t("apps.lead", {
          count: counts.all,
          ready: counts.usable,
          defaultValue: "{{count}} installed · {{ready}} ready for your agents.",
        })}
        actions={
          <>
            <Field
              icon="magnifying-glass"
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t("apps.searchPlaceholder")}
              containerStyle={{ width: 240 }}
            />
            <Btn variant="ink" icon="storefront" onPress={openCatalog}>
              {t("apps.exploreCatalog", { defaultValue: "Explore catalog" })}
            </Btn>
          </>
        }
      />

      {counts.attention > 0 && filter !== "attention" ? (
        <Card
          pad
          bg={c.tint.a.bg}
          style={{
            borderColor: c.tint.a.bd,
            marginBottom: 20,
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <Ph name="plugs" size={20} color={c.tint.a.tx} />
          <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
            <T step="sm" color={c.tint.a.tx}>
              {t("apps.attentionTitle", {
                count: counts.attention,
                defaultValue: "{{count}} apps need your attention so your agents can use them.",
              })}
            </T>
            {breakdownParts.length > 0 ? (
              <T step="12" color={c.tint.a.tx} style={{ opacity: 0.85 }}>
                {breakdownParts.join(" · ")}
              </T>
            ) : null}
          </View>
          <Btn
            variant="sec"
            onPress={() => setFilter("attention")}
            style={{ borderColor: c.tint.a.bd }}
          >
            {t("apps.seeWhich", { defaultValue: "See which" })}
          </Btn>
        </Card>
      ) : null}

      <PTabs<Filter>
        sm
        value={filter}
        onChange={setFilter}
        items={tabs.map((tab) => ({ key: tab.key, label: tab.label, count: tab.count }))}
        style={{ marginBottom: 20 }}
      />

      {visible.length === 0 && installedRows.length === 0 ? (
        <EmptyState
          icon="cube"
          title={q || filter !== "all" ? t("apps.noAppsFound") : t("apps.noAppsInstalled")}
          text={
            q || filter !== "all"
              ? undefined
              : t("apps.noAppsInstalledHint", {
                  defaultValue: "Install apps from the catalog so your agents can use them.",
                })
          }
          action={
            q || filter !== "all" ? undefined : (
              <Btn variant="ink" icon="storefront" onPress={openCatalog}>
                {t("apps.exploreCatalog", { defaultValue: "Explore catalog" })}
              </Btn>
            )
          }
        />
      ) : (
        <>
          {installedRows.length > 0 ? (
            <View style={{ marginBottom: 24 }}>
              <SectionLabel
                label={t("apps.sectionInstalled", { defaultValue: "Installed" })}
                count={installedRows.length}
              />
              <Grid cols={3}>{installedRows.map((r) => renderInstalledAppCard(r.app))}</Grid>
            </View>
          ) : null}
        </>
      )}

      {/* System capabilities (v1.4.4) — ONE section, completely isolated from
          third-party apps. Workspace mode: read-only defaults + window links;
          per-agent toggles live in the Agent window's Apps tab. */}
      {filter === "all" && !q ? (
        <SystemCapabilitiesSection style={{ marginBottom: 24 }} />
      ) : null}

      {/* CTA to the catalog — the natural next step after browsing apps. */}
      {filter === "all" && !q ? (
        <Card
          pad
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <Ph name="storefront" size={20} color={c.text2} />
          <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
            <T step="sm">{t("apps.moreAppsTitle", { defaultValue: "Looking for more apps?" })}</T>
            <T step="12" tone="text3">
              {t("apps.moreAppsHint", {
                defaultValue: "Gmail, Notion, HubSpot, Linear and more — connect them in seconds.",
              })}
            </T>
          </View>
          <Btn variant="ink" icon="storefront" onPress={openCatalog}>
            {t("apps.moreAppsCta", { defaultValue: "Browse catalog" })}
          </Btn>
        </Card>
      ) : null}
    </Page>
  )
}
