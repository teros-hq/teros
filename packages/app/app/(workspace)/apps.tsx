/**
 * Apps Route - /apps
 *
 * Abre/enfoca la ventana de lista de aplicaciones.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function AppsRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'apps',
    {},
    () => true, // Solo puede haber una lista de apps
    isReady,
  );

  return null;
}
