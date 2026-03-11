/**
 * Workspaces List Route - /workspaces
 *
 * Abre la ventana de lista de workspaces.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function WorkspacesListRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'workspaces',
    {},
    () => true, // singleton
    isReady,
  );

  return null;
}
