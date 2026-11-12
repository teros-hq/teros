/**
 * Flow Execution Window Type Definition
 *
 * Real-time execution monitor for workflow executions.
 * Shows the flow graph with live node status updates,
 * step details, and associated board tasks.
 *
 * Uses the mca.teros.workflows MCA for execution data.
 */

import { Activity } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const FlowExecutionWindowContent = lazyWithRetry(() =>
  import("./FlowExecutionWindowContent").then((m) => ({ default: m.FlowExecutionWindowContent })),
)

export interface FlowExecutionWindowProps {
  /** Pre-selected workspace ID (optional, falls back to active workspace) */
  workspaceId?: string
  /** Resolved appId for the mca.teros.workflows instance (set after backend lookup) */
  appId?: string
  /** Execution ID to monitor (required — the window needs an execution to show) */
  executionId?: string
  /** Flow ID associated with the execution (used to load the graph) */
  flowId?: string
  /** Flow name (used for tab title) */
  flowName?: string
}

export const flowExecutionWindowDefinition: WindowTypeDefinition<FlowExecutionWindowProps> = {
  type: "flowExecution",
  audience: "user",
  displayName: "Execution Monitor",
  icon: Activity,
  phIcon: "play-circle",
  color: "#F59E0B", // Amber — distinct from the editor's cyan

  component: FlowExecutionWindowContent,

  defaultSize: { width: 1200, height: 750 },
  minSize: { width: 800, height: 500 },

  isLauncher: false, // Opened from the flow editor or execution list, not the launcher
  featureFlag: "flows.enabled",

  getTitle: (props) =>
    props.flowName
      ? `${props.flowName} — Execution`
      : i18n.t("windows.flowExecution") || "Execution Monitor",

  getKey: (props) => props.executionId || undefined,

  serialize: (props) => ({
    workspaceId: props.workspaceId,
    appId: props.appId,
    executionId: props.executionId,
    flowId: props.flowId,
    flowName: props.flowName,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
    appId: data.appId,
    executionId: data.executionId,
    flowId: data.flowId,
    flowName: data.flowName,
  }),
}
