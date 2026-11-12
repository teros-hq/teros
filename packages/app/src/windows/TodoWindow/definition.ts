/**
 * To Do window — the tree of groups and tasks and the day plan. Task details
 * open in `todo-node` windows (node/definition.ts) as preview tabs beside it.
 * Uses the mca.teros.todo-list MCA for data operations.
 */

import { ListTodo } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const TodoWindowContent = lazyWithRetry(() =>
  import("./TodoWindowContent").then((m) => ({ default: m.TodoWindowContent })),
)
const TodoWidget = lazyWithRetry(() => import("./widget/TodoWidget").then((m) => ({ default: m.TodoWidget })))

export interface TodoWindowProps {
  /** Pre-selected workspace ID (optional, falls back to active workspace) */
  workspaceId?: string
  /** Resolved appId for the mca.teros.todo-list instance (set after backend lookup) */
  appId?: string
  /** The view the window shows; a pin captures it so the widget and the reopened tab match (NAV-REQ-20). */
  view?: "tree" | "day"
  /** The tree node in focus, if any (NAV-REQ-20). A focused pin is bound to this workspace (NAV-REQ-21). */
  focusId?: string
}

export const todoWindowDefinition: WindowTypeDefinition<TodoWindowProps> = {
  type: "todo",
  audience: "user",
  displayName: "Tasks",
  icon: ListTodo,
  phIcon: "list-checks",
  color: "#F97316", // Orange
  component: TodoWindowContent,

  defaultSize: { width: 960, height: 680 },
  minSize: { width: 480, height: 360 },

  isLauncher: true,

  getTitle: () => i18n.t("windows.todo"),

  serialize: (props) => ({ workspaceId: props.workspaceId, appId: props.appId, view: props.view, focusId: props.focusId }),
  deserialize: (data) => ({ workspaceId: data.workspaceId, appId: data.appId, view: data.view, focusId: data.focusId }),

  /** @spec NAV-REQ-20 */
  widget: TodoWidget,
  /** @spec NAV-REQ-21 — a focused branch belongs to this workspace; the plain tree or day view travels. */
  portable: (props) => (props.focusId ? null : { view: props.view }),
}
