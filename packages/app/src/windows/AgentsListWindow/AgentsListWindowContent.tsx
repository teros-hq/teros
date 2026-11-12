/**
 * Agents list — the rows that used to be the Agents section of the navbar,
 * as a page: avatar, name, role; press opens the agent; "Create agent" opens
 * the create window. Live on agent.created/updated/deleted.
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
import { Avatar } from "../../components/Avatar"
import { FullscreenLoader } from "../../components/ui"
import { Btn, EmptyState, LGroup, LRow, Page, PageHead, T } from "../../components/ui/ds"
import type { AgentsListWindowProps } from "./definition"

interface Row {
  agentId: string
  name: string
  role?: string
  avatarUrl?: string
}

/** @spec NAV-REQ-12 */
export function AgentsListWindowContent({ windowId, workspaceId }: AgentsListWindowProps & { windowId: string }) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const { openWindow } = useTilingStore()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const wsId = workspaceId ?? activeWorkspaceId ?? undefined
  const wsName = useNavbarStore((s) => s.workspaces.find((w) => w.workspaceId === wsId)?.name)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const { agents } = await client.agent.listAgents(wsId)
      setRows(agents.map((a: any) => ({ agentId: a.agentId, name: a.fullName || a.name, role: a.role, avatarUrl: a.avatarUrl })))
    } catch (err) {
      console.warn("[AgentsList] load failed:", err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const refresh = () => void load()
    client.on("agent.created", refresh)
    client.on("agent.updated", refresh)
    client.on("agent.deleted", refresh)
    return () => {
      client.off("agent.created", refresh)
      client.off("agent.updated", refresh)
      client.off("agent.deleted", refresh)
    }
  }, [wsId])

  if (loading) return <FullscreenLoader />

  return (
    <Page>
      <PageHead
        eyebrow={wsName ?? t("nav.workspace")}
        title={t("windows.agents")}
        actions={
          <Btn variant="primary" icon="plus" onPress={() => openWindow("create-agent", { workspaceId: wsId }, false, windowId)} testID="agents-create">
            {t("nav.createAgent", { defaultValue: "Create agent" })}
          </Btn>
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon="robot" title={t("nav.noAgents")} />
      ) : (
        <LGroup>
          {rows.map((a) => (
            <LRow key={a.agentId} onPress={() => openWindow("agent", { agentId: a.agentId, workspaceId: wsId }, false, windowId)} testID={`agents-row-${a.agentId}`}>
              <Avatar name={a.name} imageUrl={a.avatarUrl} size={32} isAgent />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T step="sm">{a.name}</T>
                {a.role ? (
                  <T step="12" tone="text3">
                    {a.role}
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
