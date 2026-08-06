/**
 * Chat Route - /chat/[channelId]
 *
 * Opens/focuses a chat window for a specific channel.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function ChatRoute() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'chat',
    { channelId },
    (props) => props.channelId === channelId,
    isReady && !!channelId,
  );

  return null;
}
