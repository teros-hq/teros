/**
 * File Browser Route - /files/[workspaceId]
 *
 * Opens/focuses the file browser for a specific workspace.
 * Optional `?path=` query sets the initial directory.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function FileBrowserRoute() {
  const { workspaceId, path } = useLocalSearchParams<{
    workspaceId: string;
    path?: string;
  }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'file-browser',
    { workspaceId, initialPath: path },
    (props) => props.workspaceId === workspaceId,
    isReady && !!workspaceId,
  );

  return null;
}
