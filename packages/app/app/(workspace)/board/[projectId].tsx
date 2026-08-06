/**
 * Board Route - /board/[projectId]
 *
 * Opens/focuses the board window for a specific project.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';
import { useWorkspaceStore } from '../../../src/store/workspaceStore';

export default function BoardRoute() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const isReady = useWorkspaceReady();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  useWindowLauncher(
    'board',
    { projectId, workspaceId: activeWorkspaceId ?? undefined },
    (props) => props.projectId === projectId,
    isReady && !!projectId,
  );

  return null;
}
