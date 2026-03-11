/**
 * Invitations Sent Route - /invitations/sent
 *
 * Abre/enfoca la ventana de invitaciones en la tab de enviadas.
 */

import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function InvitationsSentRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'invitations',
    { tab: 'sent' },
    (props) => true, // Solo puede haber una ventana de invitaciones
    isReady,
  );

  return null;
}
