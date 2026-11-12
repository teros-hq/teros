/**
 * Workspaces List Window Type Definition
 *
 * User workspaces list with the option to create new ones.
 * Opened from the "Projects" button in the Navbar.
 */

import { Folder } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const WorkspacesListWindowContent = lazyWithRetry(() =>
  import("./WorkspacesListWindowContent").then((m) => ({ default: m.WorkspacesListWindowContent })),
)

export interface WorkspacesListWindowProps {
  /** Initial status filter */
  status?: "active" | "archived"
  /** Initial search query */
  search?: string
}

export const workspacesListWindowDefinition: WindowTypeDefinition<WorkspacesListWindowProps> = {
  type: "workspaces",
  audience: "user",
  displayName: "Workspaces",
  icon: Folder,
  phIcon: "buildings",
  color: "#C4923B",
  component: WorkspacesListWindowContent,

  defaultSize: { width: 700, height: 500 },
  minSize: { width: 400, height: 300 },

  isLauncher: true,

  getTitle: () => i18n.t("windows.workspaces"),

  serialize: (props) => ({
    status: props.status,
    search: props.search,
  }),
  deserialize: (data) => ({
    status: data.status,
    search: data.search,
  }),
}
