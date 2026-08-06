/**
 * FileBrowser Window Type Definition
 *
 * Provides a read-only, navigable view of a workspace volume.
 * Opened from the Launcher or triggered by an agent via send-file-browser.
 *
 * Singleton per workspaceId: only one FileBrowserWindow per workspace
 * can be open at a time (getKey enforces this at the registry level).
 */

import { FolderOpen } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { FileBrowserWindowContent } from './FileBrowserWindowContent';

// ============================================================================
// Props
// ============================================================================

export interface FileBrowserWindowProps {
  /** Workspace ID — used to resolve the correct volume */
  workspaceId: string;
  /** Initial path inside the volume. Defaults to '/workspace' */
  initialPath?: string;
}

// ============================================================================
// Definition
// ============================================================================

export const fileBrowserWindowDefinition: WindowTypeDefinition<FileBrowserWindowProps> = {
  type: 'file-browser',
  displayName: 'File Browser',
  icon: FolderOpen,
  color: '#f59e0b', // Amber

  component: FileBrowserWindowContent,

  defaultSize: { width: 600, height: 500 },
  minSize: { width: 320, height: 240 },

  // Singleton per workspace: only one browser per workspaceId at a time
  getKey: (props) => props.workspaceId,

  isLauncher: true,

  getTitle: () => i18n.t("windows.fileBrowser"),
  getSubtitle: (props) => props.initialPath ?? '/workspace',

  serialize: (props) => ({
    workspaceId: props.workspaceId,
    initialPath: props.initialPath,
  }),

  deserialize: (data) => ({
    workspaceId: (data.workspaceId as string) ?? '',
    initialPath: data.initialPath as string | undefined,
  }),
};
