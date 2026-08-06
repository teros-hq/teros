/**
 * Conversations Route - /conversations
 *
 * Abre/enfoca la ventana de lista de conversaciones.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './_layout';

export default function ConversationsRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'conversations',
    {},
    () => true, // Solo puede haber una ventana de conversaciones
    isReady,
  );

  return null;
}
