/**
 * UI Test Route - /uitest
 *
 * Opens/focuses the UI test window (theme/color tester).
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function UITestRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'uitest',
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
