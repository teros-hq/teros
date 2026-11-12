/**
 * Agent Window Type Definition
 *
 * Agent configuration: permissions, apps, avatar, etc.
 */

import { Bot } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const AgentWindowContent = lazyWithRetry(() =>
  import("./AgentWindowContent").then((m) => ({ default: m.AgentWindowContent })),
)
import i18n from "../../i18n"

export interface AgentWindowProps {
  agentId: string
  workspaceId?: string
}

export const agentWindowDefinition: WindowTypeDefinition<AgentWindowProps> = {
  type: "agent",
  audience: "user",
  displayName: "Agente",
  icon: Bot,
  phIcon: "identification-badge",
  color: "#4A9E5B",
  component: AgentWindowContent,

  defaultSize: { width: 600, height: 500 },
  minSize: { width: 400, height: 300 },

  getKey: (props) => props.agentId,

  getTitle: () => i18n.t("windows.configureAgent"),
  getSubtitle: (props) => props.agentId,

  serialize: (props) => ({ agentId: props.agentId, workspaceId: props.workspaceId }),
  deserialize: (data) => ({ agentId: data.agentId, workspaceId: data.workspaceId }),
}
