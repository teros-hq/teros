/**
 * Agent Route - /agent/[agentId]
 *
 * Abre/enfoca una ventana de configuración de agente.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function AgentRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'agent',
    { agentId },
    (props) => props.agentId === agentId,
    isReady && !!agentId,
  );

  return null;
}
