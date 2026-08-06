/**
 * Launcher Route - /launcher
 *
 * Opens/focuses the launcher (new tab) window.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function LauncherRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'launcher',
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
