/**
 * App Route - /app/[appId]
 *
 * Opens/focuses an app configuration window.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function AppRoute() {
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'app',
    { appId },
    (props) => props.appId === appId,
    isReady && !!appId,
  );

  return null;
}
