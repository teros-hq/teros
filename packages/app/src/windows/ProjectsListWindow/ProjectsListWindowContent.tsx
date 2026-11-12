/**
 * Projects list — the rows that used to be the Projects section of the navbar,
 * as a page: name, press opens the board; an inline field creates a project.
 * Live on project.created/updated/deleted.
 *
 * @spec NAV-REQ-12
 */
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useNavbarStore } from "../../store/navbarStore"
import { useToast } from "../../components/Toast"
import { FullscreenLoader } from "../../components/ui"
import { Btn, EmptyState, Field, LGroup, LRow, Page, PageHead, Ph, T } from "../../components/ui/ds"
import { useColors } from "../../components/mca/primitives/useColors"
import type { ProjectsListWindowProps } from "./definition"

interface Row {
  projectId: string
  name: string
  description?: string
}

/** @spec NAV-REQ-12 */
export function ProjectsListWindowContent({ windowId, workspaceId }: ProjectsListWindowProps & { windowId: string }) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const toast = useToast()
  const { openWindow } = useTilingStore()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const wsId = workspaceId ?? activeWorkspaceId ?? undefined
  const wsName = useNavbarStore((s) => s.workspaces.find((w) => w.workspaceId === wsId)?.name)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)

  const load = async () => {
    if (!wsId) {
      setLoading(false)
      return
    }
    try {
      const { projects } = await client.board.listProjects(wsId)
      setRows(projects.map((p: any) => ({ projectId: p.projectId, name: p.name, description: p.description })))
    } catch (err) {
      console.warn("[ProjectsList] load failed:", err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const refresh = () => void load()
    client.on("project.created", refresh)
    client.on("project.updated", refresh)
    client.on("project.deleted", refresh)
    return () => {
      client.off("project.created", refresh)
      client.off("project.updated", refresh)
      client.off("project.deleted", refresh)
    }
  }, [wsId])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || !wsId) return
    setCreating(true)
    try {
      const { project } = await client.board.createProject(wsId, trimmed)
      setName("")
      openWindow("board", { projectId: project.projectId, projectName: project.name, view: "mission" }, false, windowId)
    } catch (err: any) {
      toast.error(t("common.error"), err?.message ?? String(err))
    } finally {
      setCreating(false)
    }
  }

  if (loading) return <FullscreenLoader />

  return (
    <Page>
      <PageHead eyebrow={wsName ?? t("nav.workspace")} title={t("windows.projects")} />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <Field
          style={{ flex: 1 }}
          placeholder={t("nav.projectNamePlaceholder")}
          value={name}
          onChangeText={setName}
          onSubmitEditing={create}
          testID="projects-new-name"
        />
        <Btn variant="primary" icon="plus" disabled={!name.trim() || creating} onPress={create} testID="projects-create">
          {t("nav.newProject")}
        </Btn>
      </View>
      {rows.length === 0 ? (
        <EmptyState icon="kanban" title={t("nav.noProjects")} />
      ) : (
        <LGroup>
          {rows.map((p) => (
            <LRow
              key={p.projectId}
              onPress={() => openWindow("board", { projectId: p.projectId, projectName: p.name, view: "mission" }, false, windowId)}
              testID={`projects-row-${p.projectId}`}
            >
              <Ph name="kanban" size={16} color={c.text2} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T step="sm">{p.name}</T>
                {p.description ? (
                  <T step="12" tone="text3" numberOfLines={1}>
                    {p.description}
                  </T>
                ) : null}
              </View>
            </LRow>
          ))}
        </LGroup>
      )}
    </Page>
  )
}
