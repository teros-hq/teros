/**
 * MarkdownViewer Window Type Definition
 *
 * Renders a Markdown file from the workspace volume with full formatting:
 * headings, lists, tables (GFM), fenced code blocks with syntax highlighting,
 * blockquotes, links (open in new tab), and images (external ones blocked).
 *
 * Opened from:
 *   - File Browser: clicking a .md / .markdown file
 *   - Chat: "Open in Markdown Viewer" button in an html_file bubble whose
 *     filePath ends in .md or .markdown
 */

import { FileText } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { MarkdownViewerWindowContent } from './MarkdownViewerWindowContent';

export interface MarkdownViewerWindowProps {
  /** Absolute path inside the agent's volume (e.g. '/workspace/spec.md') */
  filePath: string;
  /**
   * Channel ID — used to resolve the correct workspace volume when opening from a chat context.
   * Mutually exclusive with workspaceId; at least one must be provided.
   */
  channelId?: string;
  /**
   * Workspace ID — used to resolve the workspace volume when opening from the File Browser
   * (which has no channelId). Mutually exclusive with channelId.
   */
  workspaceId?: string;
  /** Directory to return to when "← Back" is pressed. Omit when not opened from File Browser. */
  returnPath?: string;
}

export const markdownViewerWindowDefinition: WindowTypeDefinition<MarkdownViewerWindowProps> = {
  type: 'markdown-viewer',
  displayName: 'Markdown Viewer',
  icon: FileText,
  color: '#6366f1', // Indigo

  component: MarkdownViewerWindowContent,

  defaultSize: { width: 800, height: 700 },
  minSize: { width: 400, height: 300 },


  // Same file path → same window (deduplication)
  getKey: (props) => props.filePath,

  getTitle: (props) => props.filePath.split('/').pop() ?? props.filePath,

  getSubtitle: (props) => props.filePath,

  serialize: (props) => ({
    filePath: props.filePath,
    channelId: props.channelId,
    workspaceId: props.workspaceId,
    returnPath: props.returnPath,
  }),

  deserialize: (data) => ({
    filePath: data.filePath as string,
    channelId: data.channelId as string | undefined,
    workspaceId: data.workspaceId as string | undefined,
    returnPath: data.returnPath as string | undefined,
  }),
};
