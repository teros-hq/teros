/**
 * Code Editor Route - /code-editor
 *
 * Opens/focuses the code editor window for a file.
 * Query params: ?path=<filePath>&workspaceId=<id>&channelId=<id>
 * The filePath is passed as a query param because it contains slashes.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function CodeEditorRoute() {
  const { path, workspaceId, channelId } = useLocalSearchParams<{
    path?: string;
    workspaceId?: string;
    channelId?: string;
  }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'code-editor',
    { filePath: path, workspaceId, channelId },
    (props) => props.filePath === path,
    isReady && !!path,
  );

  return null;
}
