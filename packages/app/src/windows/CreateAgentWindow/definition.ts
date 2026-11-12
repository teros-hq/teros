/**
 * Create Agent Window Type Definition
 *
 * Shows role templates for creating a new agent.
 * When user selects a role, creates the agent and opens agent config.
 */

import { UserPlus } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const CreateAgentWindowContent = lazyWithRetry(() =>
  import("./CreateAgentWindowContent").then((m) => ({ default: m.CreateAgentWindowContent })),
)

export interface CreateAgentWindowProps {
  workspaceId?: string
}

export const createAgentWindowDefinition: WindowTypeDefinition<CreateAgentWindowProps> = {
  type: "create-agent",
  audience: "user",
  displayName: "Crear Agente",
  icon: UserPlus,
  phIcon: "user-plus",
  color: "#8B5CF6",
  component: CreateAgentWindowContent,

  defaultSize: { width: 600, height: 500 },
  minSize: { width: 400, height: 400 },

  isLauncher: true,

  getTitle: () => i18n.t("windows.createAgent"),

  serialize: (props) => ({ workspaceId: props.workspaceId }),
  deserialize: (data) => ({ workspaceId: data.workspaceId }),
}
