/**
 * Agent Route - /workspace/[workspaceId]/agent/[agentId]
 *
 * Abre/enfoca una ventana de configuración de agente dentro de un workspace.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../../../src/hooks';
import { useWorkspaceReady } from '../../../_layout';

export default function WorkspaceAgentRoute() {
  const { workspaceId, agentId } = useLocalSearchParams<{ workspaceId: string; agentId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'agent',
    { agentId, workspaceId },
    (props) => props.agentId === agentId,
    isReady && !!agentId && !!workspaceId,
  );

  return null;
}
