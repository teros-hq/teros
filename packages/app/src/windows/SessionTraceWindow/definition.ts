/**
 * Session Trace Window Definition (F2 / TER-643).
 *
 * Admin window to drill into one turn (session) — LLM calls + tool executions +
 * message text + subagents — inside Teros. Complements ModelHealthWindow
 * (aggregate health) and AgentUsageWindow (activity): this one is per-turn.
 *
 * Backend action consumed: admin-api.agent-usage-session-detail
 * Auth: requireSystemAdmin enforced server-side.
 */

import { ListTree } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { SessionTraceWindowContent, type SessionTraceWindowProps } from "./SessionTraceWindowContent"

export const sessionTraceWindowDefinition: WindowTypeDefinition<SessionTraceWindowProps> = {
  type: "session-trace",
  displayName: "Session Trace",
  icon: ListTree,
  color: "#06B6D4",
  // Drill-only: reached from Agent Activity / the Monitoring hub's Recent Traces,
  // never opened context-free from the launcher (the paste-an-id empty state was
  // a dead entry point). The in-window id input stays for power users.
  isLauncher: false,
  adminOnly: true,
  component: SessionTraceWindowContent,

  defaultSize: { width: 1000, height: 800 },
  minSize: { width: 640, height: 480 },

  getTitle: (props) => (props.sessionUsageId ? `Trace · ${props.sessionUsageId}` : "Session Trace"),
  getSubtitle: () => "Turn drill-down",

  serialize: (props) => (props.sessionUsageId ? { sessionUsageId: props.sessionUsageId } : {}),
  deserialize: (data) => ({
    sessionUsageId: typeof data.sessionUsageId === "string" ? data.sessionUsageId : undefined,
  }),
}
