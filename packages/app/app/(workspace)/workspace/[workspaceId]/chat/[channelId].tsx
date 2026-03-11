/**
 * Chat Route with Workspace - /workspace/[workspaceId]/chat/[channelId]
 *
 * Opens/focuses a chat window for a specific channel within a workspace context.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../../../src/hooks';
import { useWorkspaceReady } from '../../../workspaceContext';

export default function WorkspaceChatRoute() {
  const { workspaceId, channelId } = useLocalSearchParams<{
    workspaceId: string;
    channelId: string;
  }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'chat',
    { channelId, workspaceId },
    (props) => props.channelId === channelId,
    isReady && !!channelId && !!workspaceId,
  );

  return null;
}
