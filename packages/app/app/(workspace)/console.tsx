/**
 * Console Route - /console
 *
 * Abre/enfoca la ventana de consola de desarrollo.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function ConsoleRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'console',
    {},
    () => true, // Solo puede haber una consola
    isReady,
  );

  return null;
}
