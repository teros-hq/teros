/**
 * Browserbase Live View Route - /browserbase/[sessionId]
 *
 * Opens/focuses the Browserbase live view window for a specific session.
 * Note: the liveViewUrl is ephemeral and not included in the URL — the
 * window content fetches it from the session state on restore.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function BrowserbaseRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'browserbase-live-view',
    { sessionId, liveViewUrl: '' },
    (props) => props.sessionId === sessionId,
    isReady && !!sessionId,
  );

  return null;
}
