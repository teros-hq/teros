/**
 * Board Window Type Definition
 *
 * Kanban board for project task management.
 * Shows columns with draggable task cards.
 */

import { SquareKanban } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const BoardWindowContent = lazyWithRetry(() =>
  import("./BoardWindowContent").then((m) => ({ default: m.BoardWindowContent })),
)
import i18n from "../../i18n"

export interface BoardWindowProps {
  /** Workspace to show projects from */
  workspaceId?: string
  /** Pre-selected project */
  projectId?: string
  /** Name of the selected project (used for tab title) */
  projectName?: string
  /** Active view: 'mission' (default), 'kanban', or 'settings' */
  view?: string
}

export const boardWindowDefinition: WindowTypeDefinition<BoardWindowProps> = {
  type: "board",
  audience: "user",
  displayName: "Board",
  icon: SquareKanban,
  phIcon: "kanban",
  color: "#8B5CF6", // Purple

  component: BoardWindowContent,

  defaultSize: { width: 900, height: 600 },
  minSize: { width: 600, height: 400 },

  isLauncher: true,

  getTitle: (props) => props.projectName || i18n.t("windows.board"),

  getKey: (props) => props.projectId || undefined,

  serialize: (props) => ({
    workspaceId: props.workspaceId,
    projectId: props.projectId,
    projectName: props.projectName,
    view: props.view,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
    projectId: data.projectId,
    projectName: data.projectName,
    view: data.view,
  }),
}
