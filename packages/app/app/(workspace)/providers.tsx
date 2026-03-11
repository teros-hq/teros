/**
 * User Providers Route - /providers
 *
 * Abre/enfoca la ventana de providers del usuario (API keys personales).
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function ProvidersRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'providers',
    {},
    () => true, // Solo puede haber una ventana de providers
    isReady,
  );

  return null;
}
