/**
 * New Chat Route - /chat/new/[agentId]
 *
 * Opens a new conversation (draft) with a specific agent.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../../src/hooks';
import { useWorkspaceReady } from '../../workspaceContext';

export default function NewChatRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'chat',
    { agentId },
    (props) => !props.channelId && props.agentId === agentId,
    isReady && !!agentId,
  );

  return null;
}
