/**
 * Create Agent Window Content
 *
 * Shows the role-template grid. When the user selects a role, creates the
 * agent and replaces this window with the agent config.
 *
 * OS prototype vocabulary (design-testing): a Page on the sheet, PageHead
 * (eyebrow · serif title · lead), a 2-column grid of role Cards (tinted
 * Phosphor tile + name + sub), a ghost "custom" action underneath.
 */

import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { generateRandomPersonality } from "../../data/agentPersonalities"
import { useNavbarStore } from "../../store/navbarStore"
import { useTilingStore } from "../../store/tilingStore"
import { useColors } from "../../components/mca/primitives/useColors"
import { Btn, Grid, Page, PageHead, Ph, SectionLabel, T } from "../../components/ui/ds"
import {
  AGENT_ROLE_TEMPLATES,
  RoleTemplateCard,
  type AgentRoleTemplate,
} from "../../components/SelectAgentRoleModal"

// ============================================================================
// COMPONENT
// ============================================================================

interface Props {
  windowId: string
  workspaceId?: string
}

export function CreateAgentWindowContent({ windowId, workspaceId }: Props) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const { replaceWindow, closeWindow } = useTilingStore()
  const { addAgent } = useNavbarStore()
  const c = useColors()

  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [existingNames, setExistingNames] = useState<string[]>([])

  // Load existing agent names on mount
  useEffect(() => {
    if (client) {
      client.agent
        .listAgents()
        .then(({ agents }) => {
          setExistingNames(agents.map((a) => a.name.split(" ")[0]))
        })
        .catch(console.error)
    }
  }, [client])

  const handleSelectRole = async (template: AgentRoleTemplate) => {
    if (!client || creating) return

    setCreating(template.id)
    setError(null)

    try {
      // Generate random personality (name + avatar)
      const personality = generateRandomPersonality(existingNames)

      // Create the agent (core assigned server-side by scope)
      const createdAgent = await client.createAgent({
        name: personality.firstName,
        fullName: personality.fullName,
        role: template.role,
        intro: template.intro,
        avatarUrl: personality.avatar,
        workspaceId,
        context: template.responseStyle,
      })


      // Add to navbar
      addAgent({
        agentId: createdAgent.agentId,
        name: createdAgent.fullName || createdAgent.name,
        avatarUrl: createdAgent.avatarUrl,
        coreId: createdAgent.coreId,
        workspaceId: createdAgent.workspaceId,
      })

      // Replace this window with agent config
      replaceWindow(windowId, "agent", {
        agentId: createdAgent.agentId,
        workspaceId: createdAgent.workspaceId,
      })
    } catch (err: any) {
      console.error("Failed to create agent:", err)
      setError(err.message || t("agent.failedToCreateAgent"))
      setCreating(null)
    }
  }

  const handleCustom = () => {
    // TODO: Open a form for custom agent creation
    // For now, just create a Personal Assistant
    handleSelectRole(AGENT_ROLE_TEMPLATES[0])
  }

  return (
    <Page>
      <PageHead
        eyebrow={t("nav.agents", { defaultValue: "Agentes" })}
        title={t("windows.createAgent")}
        lead={t("agent.chooseRole")}
      />

      {error && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            padding: 12,
            paddingHorizontal: 14,
            borderRadius: 10,
            backgroundColor: c.tint.r.bg,
            borderWidth: 1,
            borderColor: c.tint.r.bd,
            marginBottom: 16,
          }}
        >
          <Ph name="warning-circle" size={16} color={c.tint.r.tx} />
          <T step="sm" color={c.tint.r.tx} style={{ flex: 1 }}>
            {error}
          </T>
        </View>
      )}

      <SectionLabel label={t("agent.selectEngineSubtitle")} count={AGENT_ROLE_TEMPLATES.length} />

      <Grid cols={2} min={260}>
        {AGENT_ROLE_TEMPLATES.map((template) => (
          <RoleTemplateCard
            key={template.id}
            template={template}
            busy={creating === template.id}
            disabled={!!creating}
            onPress={() => handleSelectRole(template)}
          />
        ))}
      </Grid>

      {/* Custom option */}
      <View style={{ alignItems: "center", marginTop: 12 }}>
        <Btn variant="ghost" icon="sparkle" disabled={!!creating} onPress={handleCustom}>
          {t("agent.createAgent")}
        </Btn>
      </View>
    </Page>
  )
}
