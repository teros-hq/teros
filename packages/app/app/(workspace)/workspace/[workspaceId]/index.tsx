/**
 * Workspace Route - /workspace/[workspaceId]
 *
 * Abre la ventana de un workspace específico.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../../src/hooks';
import { useWorkspaceReady } from '../../workspaceContext';

export default function WorkspaceRoute() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'workspace',
    { workspaceId },
    (props) => props.workspaceId === workspaceId,
    isReady && !!workspaceId,
  );

  return null;
}
