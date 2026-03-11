/**
 * Users Route - /admin/users
 *
 * Abre/enfoca la ventana de gestión de usuarios.
 */

import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function UsersRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'users',
    {},
    () => true, // Solo puede haber una ventana de users
    isReady,
  );

  return null;
}
