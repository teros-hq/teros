/**
 * TerminalWindow — Window Type Definition
 *
 * Opens an xterm.js terminal in a WebView.
 * Executes commands via the existing `execute_tool` WebSocket handler
 * targeting the workspace's installed `mca.teros.bash` app.
 *
 * Opened from:
 *   - File Browser: "Terminal" button in the toolbar (opens in current directory)
 *   - Programmatically: openWindow('terminal', { initialCwd, workspaceId })
 */

import { Terminal } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { TerminalWindowContent } from './TerminalWindowContent';

export interface TerminalWindowProps {
  /** Working directory to start in (default: '/workspace') */
  initialCwd?: string;
  /** App ID of the bash MCA to use — resolved by useBashApp if not provided */
  appId?: string;
  /** Workspace ID — used to resolve the bash MCA app ID */
  workspaceId?: string;
  /** Session identifier for deduplication — same sessionId → same window */
  sessionId?: string;
}

export const terminalWindowDefinition: WindowTypeDefinition<TerminalWindowProps> = {
  type: 'terminal',
  displayName: 'Terminal',
  icon: Terminal,
  color: '#10b981', // Emerald — same as CodeEditorWindow
  isLauncher: true,

  component: TerminalWindowContent,

  defaultSize: { width: 800, height: 500 },
  minSize: { width: 400, height: 250 },

  // Same sessionId → same window (allows multiple independent terminals)
  getKey: (props) => props.sessionId ?? 'default',

  getTitle: () => i18n.t("windows.terminal"),
  getSubtitle: (props) => props.initialCwd ?? '/workspace',

  serialize: (props) => ({
    initialCwd: props.initialCwd,
    appId: props.appId,
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
  }),

  deserialize: (data) => ({
    initialCwd: data.initialCwd as string | undefined,
    appId: data.appId as string | undefined,
    workspaceId: data.workspaceId as string | undefined,
    sessionId: data.sessionId as string | undefined,
  }),
};
