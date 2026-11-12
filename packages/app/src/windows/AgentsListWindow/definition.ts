/**
 * Agents list window — the workspace's agents with "Create agent", as a window
 * (NAV-REQ-12): the access that left the rail stays one click away and pinnable.
 *
 * @spec NAV-REQ-12
 */
import { Bot } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const AgentsListWindowContent = lazyWithRetry(() =>
  import("./AgentsListWindowContent").then((m) => ({ default: m.AgentsListWindowContent })),
)

export interface AgentsListWindowProps {
  workspaceId?: string
}

/** @spec NAV-REQ-12 */
export const agentsListWindowDefinition: WindowTypeDefinition<AgentsListWindowProps> = {
  type: "agents",
  audience: "user",
  displayName: "Agents",
  icon: Bot,
  phIcon: "robot",
  color: "#6F27FF",
  component: AgentsListWindowContent,
  defaultSize: { width: 640, height: 520 },
  minSize: { width: 400, height: 300 },
  isLauncher: true,
  getTitle: () => i18n.t("windows.agents"),
  getKey: (props) => `agents:${props.workspaceId ?? ""}`,
  serialize: (props) => ({ workspaceId: props.workspaceId }),
  deserialize: (data) => ({ workspaceId: data.workspaceId }),
  /** @spec NAV-REQ-21 */
  portable: () => ({}),
}
