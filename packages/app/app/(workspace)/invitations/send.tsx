/**
 * Invitations Send Route - /invitations/send
 *
 * Abre/enfoca la ventana de invitaciones en la tab de enviar.
 */

import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function InvitationsSendRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'invitations',
    { tab: 'send' },
    (props) => true, // Solo puede haber una ventana de invitaciones
    isReady,
  );

  return null;
}
