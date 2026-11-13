import { Terminal } from "@tamagui/lucide-icons"
import type { Space } from "@teros/shared"
import i18n from "../../i18n"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
import type { WindowTypeDefinition } from "../../services/windowRegistry"

const TerminalWindowContent = lazyWithRetry(() =>
  import("./TerminalWindowContent").then((m) => ({ default: m.TerminalWindowContent })),
)

export interface TerminalWindowProps {
  workspaceId?: string
  terminalId?: string
  title?: string
  initialCwd?: string
  appId?: string
  preset?: "shell" | "claude"
  pendingCreate?: boolean
  space?: Space
}

export const terminalWindowDefinition: WindowTypeDefinition<TerminalWindowProps> = {
  type: "terminal",
  audience: "user",
  displayName: "Terminal",
  icon: Terminal,
  phIcon: "terminal",
  color: "#9C6BFF",
  isLauncher: true,
  noPreview: true,

  component: TerminalWindowContent,

  defaultSize: { width: 900, height: 560 },
  minSize: { width: 400, height: 250 },

  getKey: (props) => props.terminalId || undefined,

  getTitle: (props) => props.title || i18n.t("windows.terminal"),
  getSubtitle: (props) => props.initialCwd,

  serialize: (props) => ({
    workspaceId: props.workspaceId,
    terminalId: props.terminalId,
    title: props.title,
    initialCwd: props.initialCwd,
    appId: props.appId,
  }),

  deserialize: (data) => ({
    workspaceId: data.workspaceId as string | undefined,
    terminalId:
      (data.terminalId as string | undefined) ??
      (data.active as string | undefined) ??
      (data.sessionId as string | undefined),
    title: data.title as string | undefined,
    initialCwd: data.initialCwd as string | undefined,
    appId: data.appId as string | undefined,
  }),
}
