/**
 * New Chat in Workspace Route - /workspace/[workspaceId]/chat/new/[agentId]
 *
 * Abre una nueva conversación (draft) con un agente específico en un workspace.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../../../../src/hooks';
import { useWorkspaceReady } from '../../../../_layout';

export default function NewWorkspaceChatRoute() {
  const { workspaceId, agentId } = useLocalSearchParams<{
    workspaceId: string;
    agentId: string;
  }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'chat',
    { agentId, workspaceId },
    // Match by agentId and workspaceId when there's no channelId (draft)
    (props) => !props.channelId && props.agentId === agentId && props.workspaceId === workspaceId,
    isReady && !!agentId && !!workspaceId,
  );

  return null;
}
