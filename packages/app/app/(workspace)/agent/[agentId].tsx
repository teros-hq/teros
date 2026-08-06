/**
 * Agent Route - /agent/[agentId]
 *
 * Opens/focuses an agent configuration window.
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
