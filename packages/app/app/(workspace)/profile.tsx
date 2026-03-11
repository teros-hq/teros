/**
 * Profile Route - /profile
 *
 * Abre/enfoca la ventana de perfil del usuario.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function ProfileRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'profile',
    {},
    () => true, // Solo puede haber una ventana de perfil
    isReady,
  );

  return null;
}
