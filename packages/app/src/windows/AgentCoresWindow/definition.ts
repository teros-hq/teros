/**
 * Agent Cores Window Type Definition
 *
 * Admin window to view and manage agent cores (base personalities/engines).
 */

import { Cpu } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const AgentCoresWindowContent = lazyWithRetry(() =>
  import("./AgentCoresWindowContent").then((m) => ({ default: m.AgentCoresWindowContent })),
)
import i18n from "../../i18n"

export type AgentCoresWindowProps = {}

export const agentCoresWindowDefinition: WindowTypeDefinition<AgentCoresWindowProps> = {
  type: "agent-cores",
  audience: "admin",
  displayName: "Agent Cores",
  icon: Cpu,
  phIcon: "cpu",
  color: "#6F27FF",
  component: AgentCoresWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 500, height: 400 },

  getTitle: () => i18n.t("windows.agentCores"),
  getSubtitle: () => i18n.t("windows.agentCoresSub"),

  serialize: () => ({}),
  deserialize: () => ({}),
}
