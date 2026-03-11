/**
 * Conversations Route - /conversations
 *
 * Abre/enfoca la ventana de lista de conversaciones.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

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
