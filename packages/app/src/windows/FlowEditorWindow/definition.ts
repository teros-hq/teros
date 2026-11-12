/**
 * Flow Editor Window Type Definition
 *
 * Visual flow editor using React Flow (@xyflow/react).
 * Drag & drop nodes, visual connections between gates,
 * node properties panel, and gate editor.
 * Uses the mca.teros.workflows MCA for flow persistence.
 *
 * Responsive: on mobile (<768px), sidebars become overlay drawers.
 * The minimum width is set low enough to allow mobile usage.
 */

import { Workflow } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const FlowEditorWindowContent = lazyWithRetry(() =>
  import("./FlowEditorWindowContent").then((m) => ({ default: m.FlowEditorWindowContent })),
)

export interface FlowEditorWindowProps {
  /** Pre-selected workspace ID (optional, falls back to active workspace) */
  workspaceId?: string
  /** Resolved appId for the mca.teros.workflows instance (set after backend lookup) */
  appId?: string
  /** Flow ID to edit (optional — if absent, starts with a blank canvas) */
  flowId?: string
  /** Flow name (used for tab title when a flow is loaded) */
  flowName?: string
}

export const flowEditorWindowDefinition: WindowTypeDefinition<FlowEditorWindowProps> = {
  type: "flowEditor",
  audience: "user",
  displayName: "Flow Editor",
  icon: Workflow,
  phIcon: "flow-arrow",
  color: "#06B6D4", // Cyan

  component: FlowEditorWindowContent,

  defaultSize: { width: 1200, height: 750 },
  // Reduced minimum width to support mobile/tablet usage.
  // On narrow screens, sidebars become overlay drawers instead of fixed columns.
  minSize: { width: 320, height: 400 },

  isLauncher: false, // Opened from FlowListWindow, not the launcher
  featureFlag: "flows.enabled",

  getTitle: (props) => props.flowName || i18n.t("windows.flowEditor"),

  getKey: (props) => props.flowId || undefined,

  serialize: (props) => ({
    workspaceId: props.workspaceId,
    appId: props.appId,
    flowId: props.flowId,
    flowName: props.flowName,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
    appId: data.appId,
    flowId: data.flowId,
    flowName: data.flowName,
  }),
}
