/**
 * Workspaces List Window Content
 *
 * Shows list of user's workspaces with ability to create new ones.
 *
 * Look: the OS prototype's "Workspaces" page (eyebrow CUENTA, serif title,
 * lead) — a search Field + PTabs (Activos / Archivados), an LGroup of
 * workspace rows (tile, name + "Actual" badge, "Privado · n miembros · rol")
 * and a "Crear workspace" secondary pill. The create form is a centred card.
 */

import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useToast } from "../../components/Toast"
import { useNavbarStore } from "../../store/navbarStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { WorkspacesListWindowProps } from "./definition"
import { FullscreenLoader } from "../../components/ui"
import { WorkspaceIcon } from "../../components/WorkspaceIcon"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  Btn,
  EmptyState,
  Field,
  FieldGroup,
  FieldHelp,
  FieldLabel,
  IconBtn,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  PTabs,
  T,
} from "../../components/ui/ds"

interface WorkspaceListItem {
  workspaceId: string
  name: string
  description?: string
  volumeId: string
  role: "owner" | "admin" | "write" | "read"
  status: "active" | "archived"
  memberCount: number
  appCount: number
  createdAt: string
  updatedAt: string
  /** Workspace type — 'private' is the user's personal workspace and cannot be deleted/archived */
  type?: "private" | "shared"
  appearance?: { color?: string; icon?: string }
}

interface WorkspacesListWindowContentProps extends WorkspacesListWindowProps {
  windowId: string
}

export function WorkspacesListWindowContent({
  windowId,
  status: initialStatus,
  search: initialSearch,
}: WorkspacesListWindowContentProps) {
  const { t } = useTranslation()
  const c = useColors()

  const [activeTab, setActiveTab] = useState<"active" | "archived">(
    initialStatus === "archived" ? "archived" : "active",
  )
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState(initialSearch || "")
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [newWorkspaceName, setNewWorkspaceName] = useState("")
  const [newWorkspaceDescription, setNewWorkspaceDescription] = useState("")

  const client = getTerosClient()
  const toast = useToast()
  const { openWindow } = useTilingStore()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  // Load workspaces on mount
  useEffect(() => {
    const loadData = async () => {
      if (client.isConnected()) {
        await loadWorkspaces()
      } else {
        const onConnected = () => {
          client.off("connected", onConnected)
          loadWorkspaces()
        }
        client.on("connected", onConnected)
        return () => {
          client.off("connected", onConnected)
        }
      }
    }
    loadData()
  }, [])

  const loadWorkspaces = async () => {
    setIsLoading(true)
    try {
      const { workspaces: data } = await client.workspace.listWorkspaces()
      setWorkspaces(data as any)
    } catch (err: any) {
      console.error("Error loading workspaces:", err)
      toast.error(t("common.error"), t("workspaces.loadError"))
    } finally {
      setIsLoading(false)
    }
  }

  // Realtime: when a workspace is created from anywhere (this window, the
  // Navbar, or an agent via the MCA tool), upsert it into the local list.
  // Idempotent by workspaceId — the optimistic insert in handleCreateWorkspace
  // and the backend broadcast may both arrive.
  useEffect(() => {
    const handleWorkspaceCreated = (data: any) => {
      const ws = data?.workspace
      if (!ws?.workspaceId) return
      setWorkspaces((prev) => {
        if (prev.some((w) => w.workspaceId === ws.workspaceId)) return prev
        return [
          {
            workspaceId: ws.workspaceId,
            name: ws.name,
            description: ws.description,
            volumeId: ws.volumeId,
            role: ws.role ?? "owner",
            status: ws.status ?? "active",
            memberCount: ws.memberCount ?? 1,
            appCount: ws.appCount ?? 0,
            createdAt: ws.createdAt ?? new Date().toISOString(),
            updatedAt: ws.updatedAt ?? ws.createdAt ?? new Date().toISOString(),
            type: ws.type,
            appearance: ws.appearance,
          },
          ...prev,
        ]
      })
    }
    client.on("workspace.created", handleWorkspaceCreated)
    return () => {
      client.off("workspace.created", handleWorkspaceCreated)
    }
  }, [])

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim()) {
      toast.error(t("common.error"), t("workspaces.nameRequired"))
      return
    }

    setIsCreating(true)
    try {
      const { workspace } = await client.workspace.createWorkspace({
        name: newWorkspaceName.trim(),
        description: newWorkspaceDescription.trim() || undefined,
      })

      // Add to list — idempotent: the backend broadcasts workspace.created
      // while it handles the request, so the realtime handler above usually
      // inserts the row BEFORE this response resolves (it showed up twice).
      setWorkspaces((prev) =>
        prev.some((w) => w.workspaceId === workspace.workspaceId)
          ? prev.map((w) => (w.workspaceId === workspace.workspaceId ? { ...w, ...(workspace as any) } : w))
          : [workspace as any, ...prev],
      )

      // Mirror into navbarStore so the sidebar reflects the new workspace
      // immediately. The WS event from backend will arrive shortly after with
      // the same id — addWorkspace is idempotent and absorbs the duplicate.
      useNavbarStore.getState().addWorkspace({
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        role: "owner",
        volumeId: (workspace as any).volumeId,
        appearance: (workspace as any).appearance,
        type: (workspace as any).type,
      })

      // Reset form
      setNewWorkspaceName("")
      setNewWorkspaceDescription("")
      setShowCreateModal(false)

      toast.success(t("common.created"), t("workspaces.workspaceCreated", { name: workspace.name }))

      // Open the new workspace
      openWindow("workspace", { workspaceId: workspace.workspaceId }, false, windowId)
    } catch (err: any) {
      console.error("Error creating workspace:", err)
      toast.error(t("common.error"), err.message || t("workspaces.createError"))
    } finally {
      setIsCreating(false)
    }
  }

  const handleOpenWorkspace = (workspace: WorkspaceListItem) => {
    openWindow("workspace", { workspaceId: workspace.workspaceId }, false, windowId)
  }

  const closeCreateModal = () => {
    setShowCreateModal(false)
    setNewWorkspaceName("")
    setNewWorkspaceDescription("")
  }

  // Filter workspaces
  const filteredWorkspaces = workspaces
    .filter((ws) => {
      // Status filter
      if (activeTab === "active" && ws.status !== "active") return false
      if (activeTab === "archived" && ws.status !== "archived") return false

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        return (
          ws.name.toLowerCase().includes(query) || ws.description?.toLowerCase().includes(query)
        )
      }
      return true
    })
    .sort((a, b) => {
      if (a.type === "private") return -1
      if (b.type === "private") return 1
      return 0
    })

  const activeCount = workspaces.filter((ws) => ws.status === "active").length
  const archivedCount = workspaces.filter((ws) => ws.status === "archived").length

  // Format date
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    if (Number.isNaN(date.getTime())) return ""
    return date.toLocaleDateString("es-ES", {
      day: "numeric",
      month: "short",
      year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    })
  }

  // Render workspace row
  const renderWorkspaceRow = (workspace: WorkspaceListItem) => {
    const isPrivate = workspace.type === "private"
    const isCurrent = workspace.workspaceId === activeWorkspaceId
    const kind = isPrivate
      ? t("workspaces.private")
      : t("workspaces.sharedKind", { defaultValue: "Compartido" })
    const sub = [
      kind,
      typeof workspace.memberCount === "number"
        ? t("workspaces.memberCount", { count: workspace.memberCount })
        : null,
      t(`workspaces.role.${workspace.role}`),
    ]
      .filter(Boolean)
      .join(" · ")
    const updated = workspace.updatedAt ? formatDate(workspace.updatedAt) : ""

    return (
      <LRow
        key={workspace.workspaceId}
        onPress={() => handleOpenWorkspace(workspace)}
        padV={12}
        padH={14}
        gap={14}
        testID={`workspace-row-${workspace.workspaceId}`}
      >
        <WorkspaceIcon
          icon={isPrivate ? "lock" : workspace.appearance?.icon || "folder"}
          color={isPrivate ? "gray" : workspace.appearance?.color || "amber"}
          size={18}
          containerSize={36}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <T step="base" ellipsis style={{ flexShrink: 1 }}>
              {workspace.name}
            </T>
            {isCurrent ? (
              <Badge tone="i" pill>
                {t("workspaces.current", { defaultValue: "Actual" })}
              </Badge>
            ) : null}
            {workspace.status === "archived" ? (
              <Badge tone="muted" pill>
                {t("workspaces.archived")}
              </Badge>
            ) : null}
          </View>
          <T step="sm" tone="text3" ellipsis style={{ marginTop: 2 }}>
            {workspace.description ? `${workspace.description} · ` : ""}
            {sub}
          </T>
        </View>
        {updated || typeof workspace.appCount === "number" ? (
          <View style={{ alignItems: "flex-end", gap: 4 }}>
            {updated ? (
              <T step="codenote" tone="text3">
                {updated}
              </T>
            ) : null}
            {typeof workspace.appCount === "number" ? (
              <T step="codenote" tone="text3">
                {t("workspaces.appCount", { count: workspace.appCount })}
              </T>
            ) : null}
          </View>
        ) : null}
        <Ph name="caret-right" size={14} color={c.text3} />
      </LRow>
    )
  }

  return (
    <View style={{ flex: 1 }}>
      <Page narrow>
        <PageHead
          eyebrow={t("nav.account")}
          title={t("windows.workspaces")}
          lead={t("workspaces.lead", {
            defaultValue:
              "Todo en Teros vive dentro de un workspace: chats, agentes, apps, skills y proyectos.",
          })}
          actions={
            <Btn
              variant="primary"
              icon="plus"
              onPress={() => setShowCreateModal(true)}
              testID="workspaces-create"
            >
              {t("workspaces.createWorkspace", { defaultValue: "Crear workspace" })}
            </Btn>
          }
        />

        {/* Toolbar */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          <Field
            icon="magnifying-glass"
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t("common.search")}
            containerStyle={{ width: 260, maxWidth: "100%", flexShrink: 1 }}
            right={
              searchQuery.length > 0 ? (
                <IconBtn
                  icon="x"
                  plain
                  sm
                  onPress={() => setSearchQuery("")}
                  accessibilityLabel={t("common.close")}
                />
              ) : undefined
            }
          />
          <PTabs
            value={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: "active",
                label: t("workspaces.active"),
                icon: "buildings",
                count: activeCount,
              },
              {
                key: "archived",
                label: t("workspaces.archived"),
                icon: "archive",
                count: archivedCount,
              },
            ]}
          />
        </View>

        {/* Content */}
        {isLoading ? (
          <FullscreenLoader variant="default" label={t("common.loading")} />
        ) : filteredWorkspaces.length > 0 ? (
          <View style={{ gap: 12 }}>
            <View testID="workspaces-list">
              <LGroup>{filteredWorkspaces.map(renderWorkspaceRow)}</LGroup>
            </View>
            {activeTab === "active" ? (
              <Btn variant="sec" icon="plus" full onPress={() => setShowCreateModal(true)}>
                {t("workspaces.createWorkspace", { defaultValue: "Crear workspace" })}
              </Btn>
            ) : null}
          </View>
        ) : (
          <LGroup>
            <EmptyState
              icon={activeTab === "archived" ? "archive" : "buildings"}
              title={
                activeTab === "archived"
                  ? searchQuery
                    ? t("workspaces.noArchivedFound")
                    : t("workspaces.noArchived")
                  : searchQuery
                    ? t("workspaces.noWorkspacesFound")
                    : t("workspaces.noWorkspaces")
              }
              text={
                activeTab === "active" && !searchQuery ? t("workspaces.createFirst") : undefined
              }
              action={
                activeTab === "active" && !searchQuery ? (
                  <Btn variant="primary" icon="plus" onPress={() => setShowCreateModal(true)}>
                    {t("workspaces.newWorkspace")}
                  </Btn>
                ) : undefined
              }
            />
          </LGroup>
        )}
      </Page>

      {/* Create Modal */}
      {showCreateModal && (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            justifyContent: "center",
            alignItems: "center",
            padding: 20,
          }}
        >
          <Pressable
            onPress={closeCreateModal}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: c.bgFrame,
              opacity: 0.6,
            }}
          />
          <View
            style={[
              {
                backgroundColor: c.bgStep,
                borderRadius: 24,
                padding: 24,
                width: "100%",
                maxWidth: 440,
                gap: 4,
              },
              Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : null,
            ]}
          >
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T step="xs" tone="accent">
                  {t("nav.account")}
                </T>
                <T step="xl">{t("workspaces.newWorkspace")}</T>
              </View>
              <IconBtn
                icon="x"
                plain
                onPress={closeCreateModal}
                accessibilityLabel={t("common.cancel")}
              />
            </View>

            {/* Name input */}
            <FieldGroup>
              <FieldLabel required>{t("nav.nameLabel")}</FieldLabel>
              <Field
                value={newWorkspaceName}
                onChangeText={setNewWorkspaceName}
                placeholder={t("workspaces.projectPlaceholder")}
                autoFocus
                testID="workspace-name-input"
              />
            </FieldGroup>

            {/* Description input */}
            <FieldGroup>
              <FieldLabel>{t("nav.descriptionLabel")}</FieldLabel>
              <Field
                area
                minHeight={84}
                value={newWorkspaceDescription}
                onChangeText={setNewWorkspaceDescription}
                placeholder={t("workspaces.descriptionPlaceholder")}
                testID="workspace-description-input"
              />
              <FieldHelp>{t("workspaces.storageVolumeInfo")}</FieldHelp>
            </FieldGroup>

            {/* Buttons */}
            <View
              style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 20 }}
            >
              <Btn variant="ghost" onPress={closeCreateModal}>
                {t("common.cancel")}
              </Btn>
              <Btn
                variant="primary"
                icon="plus"
                loading={isCreating}
                disabled={!newWorkspaceName.trim()}
                onPress={handleCreateWorkspace}
                testID="workspace-create-submit"
              >
                {t("common.create")}
              </Btn>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}
