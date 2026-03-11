/**
 * Archived Conversations Route - /archived
 *
 * Abre/enfoca la ventana de conversaciones archivadas.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function ArchivedConversationsRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'archived-conversations',
    {},
    () => true, // Solo puede haber una ventana de archivados
    isReady,
  );

  return null;
}
