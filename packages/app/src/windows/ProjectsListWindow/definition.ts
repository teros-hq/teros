/**
 * Projects list window — the workspace's projects with "New project", as a
 * window (NAV-REQ-12): the list that used to live only in the navbar.
 *
 * @spec NAV-REQ-12
 */
import { KanbanSquare } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const ProjectsListWindowContent = lazyWithRetry(() =>
  import("./ProjectsListWindowContent").then((m) => ({ default: m.ProjectsListWindowContent })),
)
const ProjectsWidget = lazyWithRetry(() => import("./ProjectsWidget").then((m) => ({ default: m.ProjectsWidget })))

export interface ProjectsListWindowProps {
  workspaceId?: string
}

/** @spec NAV-REQ-12 */
export const projectsListWindowDefinition: WindowTypeDefinition<ProjectsListWindowProps> = {
  type: "projects",
  audience: "user",
  displayName: "Projects",
  icon: KanbanSquare,
  phIcon: "kanban",
  color: "#C4923B",
  component: ProjectsListWindowContent,
  defaultSize: { width: 640, height: 520 },
  minSize: { width: 400, height: 300 },
  isLauncher: true,
  getTitle: () => i18n.t("windows.projects"),
  getKey: (props) => `projects:${props.workspaceId ?? ""}`,
  serialize: (props) => ({ workspaceId: props.workspaceId }),
  deserialize: (data) => ({ workspaceId: data.workspaceId }),
  /** @spec NAV-REQ-20 */
  widget: ProjectsWidget,
  /** @spec NAV-REQ-21 */
  portable: () => ({}),
}
