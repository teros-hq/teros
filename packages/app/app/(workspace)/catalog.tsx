/**
 * Catalog Route - /catalog
 *
 * Abre/enfoca la ventana de catálogo de aplicaciones.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function CatalogRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'catalog',
    {},
    () => true, // Solo puede haber un catálogo
    isReady,
  );

  return null;
}
