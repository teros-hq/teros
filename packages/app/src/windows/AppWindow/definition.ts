/**
 * App Window Type Definition
 *
 * Installed application configuration: auth, permissions, etc.
 */

import { Box } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const AppWindowContent = lazyWithRetry(() =>
  import("./AppWindowContent").then((m) => ({ default: m.AppWindowContent })),
)
import i18n from "../../i18n"

export interface AppWindowProps {
  context?: string
  appId: string
  workspaceId?: string
}

export const appWindowDefinition: WindowTypeDefinition<AppWindowProps> = {
  type: "app",
  audience: "user",
  displayName: "App",
  icon: Box,
  phIcon: "cube",
  color: "#7A54A6",
  component: AppWindowContent,

  defaultSize: { width: 550, height: 500 },
  minSize: { width: 400, height: 300 },

  getKey: (props) => props.appId,

  getTitle: () => i18n.t("windows.configureApp"),
  getSubtitle: (props) => props.appId,

  serialize: (props) => ({
    appId: props.appId,
    ...(props.workspaceId && { workspaceId: props.workspaceId }),
  }),
  deserialize: (data) => ({
    appId: data.appId,
    ...(data.workspaceId && { workspaceId: data.workspaceId }),
  }),
}
