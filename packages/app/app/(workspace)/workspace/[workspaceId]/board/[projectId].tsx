/**
 * Board Route - /workspace/[workspaceId]/board/[projectId]
 *
 * Abre/enfoca una ventana de board para un proyecto específico dentro de un workspace.
 * Permite deep linking y compartir URLs directas a boards.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../../../src/hooks';
import { useWorkspaceReady } from '../../../workspaceContext';

export default function WorkspaceBoardRoute() {
  const { workspaceId, projectId } = useLocalSearchParams<{
    workspaceId: string;
    projectId: string;
  }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'board',
    { workspaceId, projectId },
    (props) => props.projectId === projectId,
    isReady && !!workspaceId && !!projectId,
  );

  return null;
}
