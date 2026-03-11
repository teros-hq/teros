/**
 * App Route - /app/[appId]
 *
 * Abre/enfoca una ventana de configuración de aplicación.
 */

import { useGlobalSearchParams, useLocalSearchParams } from 'expo-router';
import { useClickModifiers, useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function AppRoute() {
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const globalParams = useGlobalSearchParams();
  const isReady = useWorkspaceReady();
  const { shouldOpenInNewTab } = useClickModifiers();

  // Check if we should open in new tab (Ctrl/Cmd+Click or middle-click)
  const inNewTab = globalParams.newTab === 'true' || false;

  useWindowLauncher(
    'app',
    { appId },
    (props) => props.appId === appId,
    isReady && !!appId,
    inNewTab,
  );

  return null;
}
