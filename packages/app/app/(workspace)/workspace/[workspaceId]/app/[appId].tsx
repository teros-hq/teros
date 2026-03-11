/**
 * App Route - /workspace/[workspaceId]/app/[appId]
 *
 * Abre/enfoca una ventana de configuración de aplicación dentro de un workspace.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../../../src/hooks';
import { useWorkspaceReady } from '../../../_layout';

export default function WorkspaceAppRoute() {
  const { workspaceId, appId } = useLocalSearchParams<{ workspaceId: string; appId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'app',
    { appId, workspaceId },
    (props) => props.appId === appId,
    isReady && !!appId && !!workspaceId,
  );

  return null;
}
