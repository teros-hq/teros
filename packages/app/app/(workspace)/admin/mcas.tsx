/**
 * MCAs Route - /admin/mcas
 *
 * Abre/enfoca la ventana del catálogo de MCAs.
 */

import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function McasRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'mcas',
    {},
    () => true, // Solo puede haber una ventana de MCAs
    isReady,
  );

  return null;
}
