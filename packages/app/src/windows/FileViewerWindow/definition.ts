/**
 * FileViewer Window Type Definition
 *
 * Renders an HTML file in real time via WebSocket file watching.
 * Opened from the "Abrir en FileViewer" button in an html_file message bubble,
 * or directly from the launcher.
 */

import { FileCode } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { FileViewerWindowContent } from './FileViewerWindowContent';

export interface FileViewerWindowProps {
  /** Absolute path inside the agent's volume (e.g. '/workspace/mockup.html') */
  filePath: string;
  /** Channel ID — used to resolve the correct volume */
  channelId: string;
}

export const fileViewerWindowDefinition: WindowTypeDefinition<FileViewerWindowProps> = {
  type: 'file-viewer',
  displayName: 'File Viewer',
  icon: FileCode,
  color: '#10b981', // Emerald green

  component: FileViewerWindowContent,

  defaultSize: { width: 800, height: 600 },
  minSize: { width: 400, height: 300 },

  singleton: false,

  // Deduplicate by filePath so the same file only opens one viewer
  getKey: (props) => props.filePath,

  getTitle: (props) => {
    const filename = props.filePath.split('/').pop() ?? props.filePath;
    return filename;
  },

  getSubtitle: (props) => props.filePath,

  serialize: (props) => ({
    filePath: props.filePath,
    channelId: props.channelId,
  }),

  deserialize: (data) => ({
    filePath: data.filePath as string,
    channelId: data.channelId as string,
  }),
};
