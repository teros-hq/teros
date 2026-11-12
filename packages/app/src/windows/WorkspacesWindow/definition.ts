/**
 * Workspace Window Type Definition (singular)
 *
 * Detail view of a specific workspace.
 * Muestra el volumen, apps instaladas y miembros.
 */

import { Folder } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const WorkspaceWindowContent = lazyWithRetry(() =>
  import("./WorkspaceWindowContent").then((m) => ({ default: m.WorkspaceWindowContent })),
)

export interface WorkspaceWindowProps {
  /** ID del workspace a mostrar */
  workspaceId: string
}

export const workspaceWindowDefinition: WindowTypeDefinition<WorkspaceWindowProps> = {
  type: "workspace",
  audience: "user",
  displayName: "Workspace",
  icon: Folder,
  phIcon: "buildings",
  color: "#C4923B",
  component: WorkspaceWindowContent,

  defaultSize: { width: 800, height: 600 },
  minSize: { width: 500, height: 400 },

  getKey: (props) => props.workspaceId,

  getTitle: () => i18n.t("windows.workspace"),

  serialize: (props) => ({
    workspaceId: props.workspaceId,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
  }),
}
