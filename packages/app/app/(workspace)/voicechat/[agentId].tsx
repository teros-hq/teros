/**
 * Voice Chat Route - /voicechat/[agentId]
 *
 * Abre/enfoca una ventana de chat de voz con un agente.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function VoiceChatRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'voicechat',
    { agentId },
    (props) => props.agentId === agentId,
    isReady && !!agentId,
  );

  return null;
}
