/**
 * Chat Route - /chat/[channelId]
 *
 * Abre/enfoca una ventana de chat específica.
 * Si el canal pertenece a un workspace, redirige a /workspace/[workspaceId]/chat/[channelId]
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useWindowLauncher } from '../../../src/hooks';
import { useChatStore } from '../../../src/store/chatStore';
import { getTerosClient } from '../../_layout';
import { useWorkspaceReady } from '../workspaceContext';

export default function ChatRoute() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const isReady = useWorkspaceReady();
  const router = useRouter();
  const [shouldLaunch, setShouldLaunch] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  // Check if channel belongs to a workspace and redirect if needed
  useEffect(() => {
    if (!isReady || !channelId) return;

    const checkAndRedirect = async () => {
      try {
        const client = getTerosClient();
        if (!client) {
          // Client not ready, proceed with normal launch
          setShouldLaunch(true);
          setIsChecking(false);
          return;
        }

        // First check if we have the channel in the store
        const cachedChannel = useChatStore.getState().channels[channelId];

        if (cachedChannel?.workspaceId) {
          // Redirect to workspace URL
          console.log('[ChatRoute] Redirecting to workspace URL:', cachedChannel.workspaceId);
          router.replace(`/workspace/${cachedChannel.workspaceId}/chat/${channelId}`);
          return;
        }

        // If not in cache, fetch from server
        const channels = await client.listChannels();
        const channel = channels.find((ch: any) => ch.channelId === channelId);

        if (channel?.workspaceId) {
          // Redirect to workspace URL
          console.log('[ChatRoute] Redirecting to workspace URL:', channel.workspaceId);
          router.replace(`/workspace/${channel.workspaceId}/chat/${channelId}`);
          return;
        }

        // No workspace, proceed with normal launch
        setShouldLaunch(true);
      } catch (error) {
        console.error('[ChatRoute] Error checking channel workspace:', error);
        // On error, proceed with normal launch
        setShouldLaunch(true);
      } finally {
        setIsChecking(false);
      }
    };

    checkAndRedirect();
  }, [isReady, channelId, router]);

  // Only launch window if channel doesn't belong to a workspace
  useWindowLauncher(
    'chat',
    { channelId },
    (props) => props.channelId === channelId,
    shouldLaunch && !!channelId,
  );

  return null;
}
