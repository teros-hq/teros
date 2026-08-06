/**
 * Markdown Viewer Route - /markdown-viewer
 *
 * Opens/focuses the markdown viewer window for a .md file.
 * Query params: ?path=<filePath>&workspaceId=<id>&channelId=<id>
 * The filePath is passed as a query param because it contains slashes.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function MarkdownViewerRoute() {
  const { path, workspaceId, channelId } = useLocalSearchParams<{
    path?: string;
    workspaceId?: string;
    channelId?: string;
  }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'markdown-viewer',
    { filePath: path, workspaceId, channelId },
    (props) => props.filePath === path,
    isReady && !!path,
  );

  return null;
}
