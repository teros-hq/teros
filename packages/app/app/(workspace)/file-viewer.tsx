/**
 * File Viewer Route - /file-viewer
 *
 * Opens/focuses the file viewer window for an HTML file.
 * Query params: ?path=<filePath>&workspaceId=<id>&channelId=<id>
 * The filePath is passed as a query param because it contains slashes.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function FileViewerRoute() {
  const { path, workspaceId, channelId } = useLocalSearchParams<{
    path?: string;
    workspaceId?: string;
    channelId?: string;
  }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'file-viewer',
    { filePath: path, workspaceId, channelId },
    (props) => props.filePath === path,
    isReady && !!path,
  );

  return null;
}
