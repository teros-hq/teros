/**
 * NewConversationModal - Centred card to start a new conversation
 *
 * Allows selecting an agent and creating a new conversation directly.
 * Used from the Navbar / Launcher / Conversations window.
 *
 * Look: the OS prototype's centred card (radius 24): serif title, a search
 * Field and an LGroup of agents (Avatar + "name · role").
 */

import React, { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, ScrollView, View } from "react-native"
import { Dialog } from "tamagui"
import { getTerosClient } from "../services/terosClientSingleton"
import { useWorkspaceStore } from "../store/workspaceStore"
import { AppSpinner } from "../components/ui"
import { Avatar } from "./Avatar"
import { useColors } from "./mca/primitives/useColors"
import { Btn, EmptyState, Field, IconBtn, LGroup, LRow, Ph, T } from "./ui/ds"

interface Agent {
  agentId: string
  name: string
  fullName: string
  role: string
  intro: string
  avatarUrl?: string
}

interface NewConversationModalProps {
  visible: boolean
  onClose: () => void
  onSelectAgent: (agent: Agent) => void
}

export function NewConversationModal({
  visible,
  onClose,
  onSelectAgent,
}: NewConversationModalProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId) ?? undefined

  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  // Load agents when modal opens
  useEffect(() => {
    if (visible && client) {
      loadAgents()
    }
  }, [visible, client, workspaceId])

  // Reset state when modal closes
  useEffect(() => {
    if (!visible) {
      setError(null)
      setQuery("")
    }
  }, [visible])

  const loadAgents = async () => {
    if (!client) return

    setLoading(true)
    setError(null)

    try {
      // listAgents(workspaceId) now returns workspace agents + superagents from backend
      const agentList = await client.agent.listAgents(workspaceId).then((r) => r.agents)
      const mappedAgents = agentList.map((a: any) => ({
        agentId: a.agentId,
        name: a.name,
        fullName: a.fullName,
        role: a.role,
        intro: a.intro,
        avatarUrl: a.avatarUrl,
      }))

      // If there's only one agent, select it automatically
      if (mappedAgents.length === 1) {
        setLoading(false)
        handleSelectAgent(mappedAgents[0])
        return
      }

      setAgents(mappedAgents)
    } catch (err) {
      console.error("Failed to load agents:", err)
      setError(t("conversation.failedToLoadAgents"))
    } finally {
      setLoading(false)
    }
  }

  const handleSelectAgent = (agent: Agent) => {
    onSelectAgent(agent)
    onClose()
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return agents
    return agents.filter(
      (a) =>
        a.name?.toLowerCase().includes(q) ||
        a.fullName?.toLowerCase().includes(q) ||
        a.role?.toLowerCase().includes(q),
    )
  }, [agents, query])

  return (
    <Dialog modal open={visible} onOpenChange={(open: boolean) => !open && onClose()}>
      <Dialog.Portal zIndex={100000}>
        <Dialog.Overlay
          key="overlay"
          animation="card"
          backgroundColor={c.bgFrame}
          opacity={0.6}
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
        />
        <Dialog.Content
          key="content"
          animation="card"
          enterStyle={{ opacity: 0, scale: 0.96 }}
          exitStyle={{ opacity: 0, scale: 0.96 }}
          transformOrigin="top"
          width={520}
          maxWidth="92%"
          padding={0}
          borderWidth={0}
          borderRadius={24}
          backgroundColor={c.bgStep}
          style={Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : undefined}
        >
          <View style={{ padding: 24, gap: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T step="xs" tone="accent">
                  {t("conversation.newChat")}
                </T>
                <Dialog.Title asChild>
                  <View>
                    <T step="xl">
                      {t("conversation.pickAgentTitle", { defaultValue: "¿Con quién hablamos?" })}
                    </T>
                  </View>
                </Dialog.Title>
              </View>
              <Dialog.Close asChild>
                <IconBtn icon="x" plain accessibilityLabel={t("common.close")} onPress={onClose} />
              </Dialog.Close>
            </View>

            {!loading && !error && agents.length > 1 ? (
              <Field
                icon="magnifying-glass"
                value={query}
                onChangeText={setQuery}
                placeholder={t("conversation.searchAgentPlaceholder", {
                  defaultValue: "Buscar agente…",
                })}
                autoFocus={Platform.OS === "web"}
              />
            ) : null}

            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
              {loading ? (
                <View style={{ padding: 32, alignItems: "center", gap: 12 }}>
                  <AppSpinner size="lg" variant="brand" />
                  <T step="sm" tone="text2">
                    {t("conversation.loadingAgents")}
                  </T>
                </View>
              ) : error ? (
                <EmptyState
                  icon="warning-circle"
                  title={error}
                  action={
                    <Btn variant="sec" icon="arrows-clockwise" onPress={loadAgents}>
                      {t("common.retry")}
                    </Btn>
                  }
                />
              ) : agents.length === 0 ? (
                <EmptyState
                  icon="users-three"
                  title={t("conversation.noAgentsAvailable")}
                  text={t("conversation.createAgentFirst")}
                />
              ) : filtered.length === 0 ? (
                <EmptyState icon="magnifying-glass" title={t("common.noResults")} />
              ) : (
                <LGroup>
                  {filtered.map((agent) => (
                    <LRow
                      key={agent.agentId}
                      onPress={() => handleSelectAgent(agent)}
                      padV={10}
                      padH={12}
                      gap={12}
                    >
                      <Avatar
                        name={agent.fullName || agent.name}
                        imageUrl={agent.avatarUrl}
                        size={36}
                        isAgent
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T step="base" ellipsis>
                          {agent.name || agent.fullName}
                          {agent.role ? <T step="base" tone="text3">{` · ${agent.role}`}</T> : null}
                        </T>
                        {agent.intro ? (
                          <T step="sm" tone="text3" ellipsis>
                            {agent.intro.split("\n")[0]}
                          </T>
                        ) : null}
                      </View>
                      <Ph name="caret-right" size={14} color={c.text3} />
                    </LRow>
                  ))}
                </LGroup>
              )}
            </ScrollView>
          </View>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
