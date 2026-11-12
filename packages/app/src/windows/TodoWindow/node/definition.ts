/**
 * todo-node — one task or group of the To Do, opened beside the tree as a
 * preview tab (docs/specs/ui/preview-tabs.md). The tab title and state dot
 * are published live by the window (windowTabMetaStore).
 */
import { ListChecks } from "@tamagui/lucide-icons"
import i18n from "../../../i18n"
import { lazyWithRetry } from "../../../lib/lazyWithRetry"
import type { WindowTypeDefinition } from "../../../services/windowRegistry"
import type { TodoNodeWindowProps } from "./TodoNodeWindowContent"

const TodoNodeWindowContent = lazyWithRetry(() =>
  import("./TodoNodeWindowContent").then((m) => ({ default: m.TodoNodeWindowContent })),
)

export const todoNodeWindowDefinition: WindowTypeDefinition<TodoNodeWindowProps> = {
  type: "todo-node",
  audience: "user",
  displayName: "Task",
  icon: ListChecks,
  phIcon: "file-text",
  color: "#6F27FF",
  component: TodoNodeWindowContent,
  defaultSize: { width: 880, height: 680 },
  minSize: { width: 360, height: 360 },
  isLauncher: false,
  getTitle: () => i18n.t("windows.todoNode"),
  serialize: (props) => ({ workspaceId: props.workspaceId, appId: props.appId, nodeId: props.nodeId }),
  deserialize: (data) => ({ workspaceId: data.workspaceId, appId: data.appId, nodeId: data.nodeId }),
}
