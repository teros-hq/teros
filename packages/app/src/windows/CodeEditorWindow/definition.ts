/**
 * CodeEditorWindow — Window Type Definition
 *
 * Opens a CodeMirror 6 editor in a WebView for any supported code/text file.
 * Vim mode is always active. Saves via fs.write backend handler.
 *
 * Opened from:
 *   - File Browser: clicking any supported code file extension
 */

import { Code } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { CodeEditorWindowContent } from './CodeEditorWindowContent';

export interface CodeEditorWindowProps {
  /** Absolute path inside the workspace volume (e.g. '/workspace/src/index.ts') */
  filePath: string;
  /** Workspace ID — used to resolve the volume when opened from File Browser */
  workspaceId?: string;
  /** Channel ID — used when opened from a chat context */
  channelId?: string;
}

export const codeEditorWindowDefinition: WindowTypeDefinition<CodeEditorWindowProps> = {
  type: 'code-editor',
  displayName: 'Code Editor',
  icon: Code,
  color: '#10b981', // Emerald green

  component: CodeEditorWindowContent,

  defaultSize: { width: 900, height: 650 },
  minSize: { width: 400, height: 300 },

  // Same file path → same window (deduplication)
  getKey: (props) => props.filePath,

  getTitle: (props) => props.filePath.split('/').pop() ?? props.filePath,

  getSubtitle: (props) => props.filePath,

  serialize: (props) => ({
    filePath: props.filePath,
    workspaceId: props.workspaceId,
    channelId: props.channelId,
  }),

  deserialize: (data) => ({
    filePath: data.filePath as string,
    workspaceId: data.workspaceId as string | undefined,
    channelId: data.channelId as string | undefined,
  }),
};
