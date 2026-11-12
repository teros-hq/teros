/**
 * Flow List Window Type Definition
 *
 * Lists all saved flows in the current workspace.
 * Clicking a flow opens the FlowEditorWindow with that flow loaded.
 * Supports search and status filtering (draft, active, archived).
 */

import { Workflow } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const FlowListWindowContent = lazyWithRetry(() =>
  import("./FlowListWindowContent").then((m) => ({ default: m.FlowListWindowContent })),
)

export interface FlowListWindowProps {
  /** Pre-selected workspace ID (optional, falls back to active workspace) */
  workspaceId?: string
  /** Resolved appId for the mca.teros.workflows instance (set after backend lookup) */
  appId?: string
  /** Initial status filter */
  status?: "draft" | "active" | "archived"
  /** Initial search query */
  search?: string
}

export const flowListWindowDefinition: WindowTypeDefinition<FlowListWindowProps> = {
  type: "flowList",
  audience: "user",
  displayName: "Flows",
  icon: Workflow,
  phIcon: "flow-arrow",
  color: "#06B6D4", // Cyan — matches the Flow Editor

  component: FlowListWindowContent,

  defaultSize: { width: 700, height: 500 },
  minSize: { width: 400, height: 300 },

  isLauncher: true,
  featureFlag: "flows.enabled",

  getTitle: () => i18n.t("windows.flowList") || "Flows",

  serialize: (props) => ({
    workspaceId: props.workspaceId,
    appId: props.appId,
    status: props.status,
    search: props.search,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
    appId: data.appId,
    status: data.status,
    search: data.search,
  }),
}
