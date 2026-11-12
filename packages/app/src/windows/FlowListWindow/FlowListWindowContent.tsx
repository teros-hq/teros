/**
 * Flow List Window Content
 *
 * Shows a searchable, filterable list of all saved flows in the current workspace.
 * Clicking a flow opens the FlowEditorWindow with that flow loaded.
 *
 * Uses the mca.teros.workflows MCA `list-flows` tool for data.
 * Presentation follows the OS prototype (design-testing): Page + PageHead,
 * filter chips, a grid of lifted cards.
 */

import React, { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useTilingStore } from "../../store/tilingStore"
import { useMcaTools } from "../../hooks/useMcaTools"
import { FullscreenLoader } from "../../components/ui"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  Btn,
  Card,
  ChipBtn,
  EmptyState,
  Field,
  Grid,
  IconBtn,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  T,
  Tile,
  type BadgeTone,
} from "../../components/ui/ds"
import type { FlowListWindowProps } from "./definition"
import { ConfirmDialog } from "../UsersWindow/detail/ConfirmDialog"

// ============================================================================
// TYPES
// ============================================================================

interface FlowListItem {
  flowId: string
  workspaceId: string
  name: string
  description: string
  status: "draft" | "active" | "archived"
  projectId: string | null
  nodeCount: number
  edgeCount: number
  triggerCount: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

interface FlowListWindowContentProps extends FlowListWindowProps {
  windowId: string
}

type FlowTab = "all" | "draft" | "active" | "archived"

// ============================================================================
// STATUS METADATA
// ============================================================================

const STATUS_META: Record<
  "draft" | "active" | "archived",
  { label: string; tone: BadgeTone; icon: string }
> = {
  draft: { label: "Draft", tone: "muted", icon: "pencil-simple-line" },
  active: { label: "Active", tone: "g", icon: "play" },
  archived: { label: "Archived", tone: "a", icon: "archive" },
}

// ============================================================================
// COMPONENT
// ============================================================================

export function FlowListWindowContent({
  windowId,
  appId: propAppId,
  workspaceId: propWorkspaceId,
  status: initialStatus,
  search: initialSearch,
}: FlowListWindowContentProps) {
  const { t } = useTranslation()
  const c = useColors()

  const client = getTerosClient()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { openWindow } = useTilingStore()

  // State — appId resolved from props or backend
  const [resolvedAppId, setResolvedAppId] = useState(propAppId ?? "")
  const { executeTool } = useMcaTools(resolvedAppId)

  // Data state
  const [flows, setFlows] = useState<FlowListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [appNotInstalled, setAppNotInstalled] = useState(false)

  // UI state
  const [activeTab, setActiveTab] = useState<FlowTab>(initialStatus || "all")
  const [searchQuery, setSearchQuery] = useState(initialSearch || "")

  // Delete confirmation state
  const [flowToDelete, setFlowToDelete] = useState<FlowListItem | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // ============================================================================
  // APP ID RESOLUTION + FLOW LOADING
  // ============================================================================

  const loadFlows = useCallback(async () => {
    if (!resolvedAppId) return
    setIsLoading(true)
    try {
      const wsId = propWorkspaceId || activeWorkspaceId
      const result = await executeTool<{ flows: FlowListItem[]; count: number }>("list-flows", {
        workspaceId: wsId,
      })
      if (result.success && result.result?.flows) {
        setFlows(result.result.flows)
      }
    } catch (err) {
      console.error("[FlowList] Failed to load flows:", err)
    } finally {
      setIsLoading(false)
    }
  }, [resolvedAppId, propWorkspaceId, activeWorkspaceId, executeTool])

  useEffect(() => {
    let cancelled = false

    const resolveAndLoad = async () => {
      // Resolve appId if not provided in props
      if (!resolvedAppId) {
        try {
          const wsId = activeWorkspaceId ?? undefined
          if (!wsId) {
            setAppNotInstalled(true)
            setIsLoading(false)
            return
          }
          const { apps: wsApps } = await client.workspace.listWorkspaceApps(wsId)
          if (cancelled) return
          const found = wsApps.find((a: any) => a.mcaId === "mca.teros.workflows")
          if (found) {
            setResolvedAppId(found.appId)
          } else {
            setAppNotInstalled(true)
            setIsLoading(false)
            return
          }
        } catch (err) {
          console.error("[FlowList] Failed to resolve appId:", err)
          setAppNotInstalled(true)
          setIsLoading(false)
          return
        }
      } else {
        loadFlows()
      }
    }

    resolveAndLoad()
    return () => {
      cancelled = true
    }
  }, [resolvedAppId, activeWorkspaceId, client])

  // Load flows when appId gets resolved
  useEffect(() => {
    if (resolvedAppId && !propAppId) {
      loadFlows()
    }
  }, [resolvedAppId, loadFlows, propAppId])

  // ============================================================================
  // OPEN FLOW IN EDITOR
  // ============================================================================

  const handleOpenFlow = useCallback(
    (flow: FlowListItem) => {
      openWindow(
        "flowEditor",
        {
          flowId: flow.flowId,
          flowName: flow.name,
          appId: resolvedAppId,
          workspaceId: propWorkspaceId || activeWorkspaceId,
        },
        false,
        windowId,
      )
    },
    [openWindow, resolvedAppId, propWorkspaceId, activeWorkspaceId, windowId],
  )

  const handleCreateFlow = useCallback(() => {
    openWindow(
      "flowEditor",
      {
        appId: resolvedAppId,
        workspaceId: propWorkspaceId || activeWorkspaceId,
      },
      false,
      windowId,
    )
  }, [openWindow, resolvedAppId, propWorkspaceId, activeWorkspaceId, windowId])

  // ==========================================================================
  // DELETE FLOW
  // ==========================================================================

  const handleDeleteFlow = useCallback(async () => {
    if (!flowToDelete) return
    setIsDeleting(true)
    try {
      const result = await executeTool("delete-flow", { flowId: flowToDelete.flowId })
      if (result.success) {
        // Remove from local state
        setFlows((prev) => prev.filter((f) => f.flowId !== flowToDelete.flowId))
      }
    } catch (err) {
      console.error("[FlowList] Failed to delete flow:", err)
    } finally {
      setIsDeleting(false)
      setFlowToDelete(null)
    }
  }, [flowToDelete, executeTool])

  // ============================================================================
  // FILTERING
  // ============================================================================

  const filteredFlows = flows.filter((flow) => {
    // Status filter
    if (activeTab !== "all" && flow.status !== activeTab) return false
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      return (
        flow.name.toLowerCase().includes(query) || flow.description?.toLowerCase().includes(query)
      )
    }
    return true
  })

  const allCount = flows.length
  const draftCount = flows.filter((f) => f.status === "draft").length
  const activeCount = flows.filter((f) => f.status === "active").length
  const archivedCount = flows.filter((f) => f.status === "archived").length

  // ============================================================================
  // HELPERS
  // ============================================================================

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    })
  }

  const title = t("windows.flowList") || "Flows"

  const tabLabel = (tab: FlowTab) =>
    tab === "all"
      ? t("flowList.tabs.all", { defaultValue: "All" })
      : tab === "draft"
        ? t("flowList.tabs.draft", { defaultValue: "Drafts" })
        : tab === "active"
          ? t("flowList.tabs.active", { defaultValue: "Active" })
          : t("flowList.tabs.archived", { defaultValue: "Archived" })

  const TABS: Array<{ tab: FlowTab; count: number; icon: string }> = [
    { tab: "all", count: allCount, icon: "flow-arrow" },
    { tab: "draft", count: draftCount, icon: "pencil-simple-line" },
    { tab: "active", count: activeCount, icon: "play" },
    { tab: "archived", count: archivedCount, icon: "archive" },
  ]

  // ============================================================================
  // RENDER: FLOW CARD
  // ============================================================================

  const renderFlowCard = (flow: FlowListItem) => {
    const statusMeta = STATUS_META[flow.status] ?? STATUS_META.draft
    const meta: string[] = [
      t("flowList.meta.nodes", { defaultValue: "{{count}} nodes", count: flow.nodeCount }),
      t("flowList.meta.edges", { defaultValue: "{{count}} edges", count: flow.edgeCount }),
    ]
    if (flow.triggerCount > 0) {
      meta.push(
        t("flowList.meta.triggers", {
          defaultValue: "{{count}} triggers",
          count: flow.triggerCount,
        }),
      )
    }
    meta.push(formatDate(flow.updatedAt))

    return (
      <Card
        key={flow.flowId}
        pad
        hov
        onPress={() => handleOpenFlow(flow)}
        style={{ minHeight: 150 }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <Tile sm icon="flow-arrow" />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T step="base" ellipsis>
              {flow.name}
            </T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
              <Badge tone={statusMeta.tone} dot sm>
                {t(`flowList.status.${flow.status}`, { defaultValue: statusMeta.label })}
              </Badge>
              {flow.projectId ? (
                <Badge tone="i" sm icon="kanban">
                  {t("flowList.linkedProject", { defaultValue: "Project" })}
                </Badge>
              ) : null}
            </View>
          </View>
          <IconBtn
            icon="trash"
            plain
            sm
            danger
            title={t("flowList.delete", { defaultValue: "Delete flow" })}
            onPress={(e: any) => {
              e?.stopPropagation?.()
              setFlowToDelete(flow)
            }}
          />
        </View>

        <T
          step="12"
          tone={flow.description ? "text2" : "text3"}
          numberOfLines={2}
          style={{ marginTop: 12, flex: 1 }}
        >
          {flow.description || t("flowList.noDescription", { defaultValue: "No description" })}
        </T>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12 }}>
          <Ph name="clock" size={11} color={c.text3} />
          <T step="codenote" tone="text3" ellipsis style={{ flex: 1 }}>
            {meta.join(" · ")}
          </T>
          <Ph name="caret-right" size={12} color={c.text3} />
        </View>
      </Card>
    )
  }

  // ============================================================================
  // RENDER: MAIN
  // ============================================================================

  if (appNotInstalled) {
    return (
      <Page>
        <EmptyState
          icon="package"
          title={t("flowList.notInstalled.title", { defaultValue: "Workflows app not installed" })}
          text={t("flowList.notInstalled.text", {
            defaultValue: "Install mca.teros.workflows from the catalog to use Flows",
          })}
        />
      </Page>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      <Page>
        <PageHead
          eyebrow={t("flowList.eyebrow", { defaultValue: "Flows" })}
          title={title}
          lead={
            isLoading
              ? undefined
              : t("flowList.lead", {
                  defaultValue: "{{count}} flows in this workspace",
                  count: allCount,
                })
          }
          actions={
            <>
              <Field
                icon="magnifying-glass"
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t("flowList.searchPlaceholder", { defaultValue: "Search flows…" })}
                containerStyle={{ width: 220 }}
              />
              <Btn variant="primary" icon="plus" onPress={handleCreateFlow}>
                {t("flowList.create", { defaultValue: "New flow" })}
              </Btn>
            </>
          }
        />

        {/* Filter chips */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {TABS.map(({ tab, count, icon }) => (
            <ChipBtn
              key={tab}
              on={activeTab === tab}
              icon={icon}
              count={count}
              onPress={() => setActiveTab(tab)}
            >
              {tabLabel(tab)}
            </ChipBtn>
          ))}
        </View>

        {/* Content */}
        {isLoading ? (
          <View style={{ minHeight: 240 }}>
            <FullscreenLoader
              variant="default"
              label={t("flowList.loading", { defaultValue: "Loading flows…" })}
            />
          </View>
        ) : filteredFlows.length > 0 ? (
          <>
            <SectionLabel label={tabLabel(activeTab)} count={filteredFlows.length} />
            <Grid cols={3}>{filteredFlows.map(renderFlowCard)}</Grid>
          </>
        ) : (
          <EmptyState
            icon="flow-arrow"
            title={
              searchQuery
                ? t("flowList.empty.searchTitle", { defaultValue: "No flows match your search" })
                : t("flowList.empty.title", { defaultValue: "No flows yet" })
            }
            text={
              searchQuery
                ? undefined
                : t("flowList.empty.text", {
                    defaultValue: "Create your first workflow to orchestrate agents and tasks.",
                  })
            }
            action={
              searchQuery ? undefined : (
                <Btn variant="primary" icon="plus" onPress={handleCreateFlow}>
                  {t("flowList.create", { defaultValue: "New flow" })}
                </Btn>
              )
            }
          />
        )}
      </Page>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={flowToDelete !== null}
        title={t("flowList.deleteDialog.title", { defaultValue: "Delete flow" })}
        body={t("flowList.deleteDialog.body", {
          defaultValue:
            'Are you sure you want to delete "{{name}}"? This action is irreversible — the flow and all its nodes, edges, and triggers will be permanently removed.',
          name: flowToDelete?.name ?? "",
        })}
        confirmLabel={t("flowList.deleteDialog.confirm", { defaultValue: "Delete" })}
        cancelLabel={t("flowList.deleteDialog.cancel", { defaultValue: "Cancel" })}
        tone="danger"
        busy={isDeleting}
        onConfirm={handleDeleteFlow}
        onCancel={() => {
          if (!isDeleting) setFlowToDelete(null)
        }}
      />
    </View>
  )
}
