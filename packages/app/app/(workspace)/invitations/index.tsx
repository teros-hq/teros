/**
 * Invitations Route - /invitations
 *
 * Abre/enfoca la ventana de invitaciones en la tab de estado.
 */

import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function InvitationsRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'invitations',
    { tab: 'status' },
    (props) => true, // Solo puede haber una ventana de invitaciones
    isReady,
  );

  return null;
}
