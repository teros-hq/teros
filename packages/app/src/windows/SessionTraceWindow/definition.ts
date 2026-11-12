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
import { lazyWithRetry } from "../../lib/lazyWithRetry"
import type { SessionTraceWindowProps } from "./SessionTraceWindowContent"
const SessionTraceWindowContent = lazyWithRetry(() =>
  import("./SessionTraceWindowContent").then((m) => ({ default: m.SessionTraceWindowContent })),
)

export const sessionTraceWindowDefinition: WindowTypeDefinition<SessionTraceWindowProps> = {
  type: "session-trace",
  audience: "admin",
  displayName: "Session Trace",
  icon: ListTree,
  phIcon: "tree-structure",
  color: "#6F27FF",
  // Drill-only: reached from Agent Activity / the Monitoring hub's Recent Traces,
  // never opened context-free from the launcher (the paste-an-id empty state was
  // a dead entry point). The in-window id input stays for power users.
  isLauncher: false,
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
