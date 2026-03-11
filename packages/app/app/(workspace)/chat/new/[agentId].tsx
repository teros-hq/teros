/**
 * New Chat Route - /chat/new/[agentId]
 *
 * Abre una nueva conversación (draft) con un agente específico.
 * No tiene channelId todavía - se creará cuando se envíe el primer mensaje.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../../src/hooks';
import { useWorkspaceReady } from '../../workspaceContext';

export default function NewChatRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const isReady = useWorkspaceReady();

  // Open a draft chat window with the agent
  useWindowLauncher(
    'chat',
    { agentId },
    // Match by agentId when there's no channelId (draft)
    (props) => !props.channelId && props.agentId === agentId,
    isReady && !!agentId,
  );

  return null;
}
