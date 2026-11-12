/**
 * TerminalWindow — Window Type Definition
 *
 * The workspace's terminals as a crew: a rail of faces (one per session —
 * shells, Claude Code, any TUI — each with a seat showing who drives) beside
 * one terminal. Sessions run in the workspace's terminal host and outlive the
 * window, the browser tab and backend restarts; the window only remembers the
 * session it shows (active) and the rail's side, so reopening it — on any
 * device — reattaches it.
 *
 * Opened from:
 *   - The launcher / File Browser "Terminal" button
 *   - Programmatically: openWindow('terminal', { workspaceId, active })
 *   - A "needs you" toast (a coding agent waiting in a session)
 */

import { Terminal } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
import type { WindowTypeDefinition } from "../../services/windowRegistry"

const TerminalWindowContent = lazyWithRetry(() =>
  import("./TerminalWindowContent").then((m) => ({ default: m.TerminalWindowContent })),
)

export interface TerminalWindowProps {
  /** Working directory for new sessions (default: '/workspace') */
  initialCwd?: string
  /** App ID of the bash MCA to use — resolved by useBashApp if not provided */
  appId?: string
  /** Workspace ID — used to resolve the bash MCA app ID */
  workspaceId?: string
  /** Legacy: the session to show (older callers); `active` wins */
  sessionId?: string
  /** Session shown in the pane */
  active?: string
  /** Side of the crew rail (default right) */
  railSide?: "left" | "right"
}

export const terminalWindowDefinition: WindowTypeDefinition<TerminalWindowProps> = {
  type: "terminal",
  audience: "user",
  displayName: "Terminal",
  icon: Terminal,
  phIcon: "terminal",
  color: "#6F27FF",
  isLauncher: true,
  noPreview: true, // Live shell state — never a preview tab (preview-tabs.md)

  component: TerminalWindowContent,

  defaultSize: { width: 900, height: 560 },
  minSize: { width: 400, height: 250 },

  // One Terminal window: every session is a face in its rail (opening one by id reuses it)
  getKey: () => "default",

  getTitle: () => i18n.t("windows.terminal"),
  getSubtitle: (props) => props.initialCwd ?? "/workspace",

  serialize: (props) => ({
    initialCwd: props.initialCwd,
    appId: props.appId,
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    active: props.active,
    railSide: props.railSide,
  }),

  deserialize: (data) => ({
    initialCwd: data.initialCwd as string | undefined,
    appId: data.appId as string | undefined,
    workspaceId: data.workspaceId as string | undefined,
    sessionId: data.sessionId as string | undefined,
    // Older layouts kept tabs: their active tab is the session shown.
    active: (data.active as string | undefined) ?? (data.tabs as string[] | undefined)?.[0],
    // Validated where it is used (TerminalWindowContent): keep the round trip symmetric.
    railSide: data.railSide as "left" | "right" | undefined,
  }),
}
