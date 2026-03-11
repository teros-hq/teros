/**
 * Workspace Index - Ruta raíz (/)
 *
 * Solo carga el estado guardado del workspace.
 * Si no hay estado guardado, abre la ventana de conversaciones por defecto.
 *
 * El layout ya renderiza el TilingLayout, esta ruta solo
 * maneja la lógica de "primera carga".
 */

import { useEffect, useRef } from 'react';
import { useTilingStore } from '../../src/store/tilingStore';
import { useWorkspaceReady } from './workspaceContext';

export default function WorkspaceIndex() {
  const isReady = useWorkspaceReady();
  const openWindow = useTilingStore((state) => state.openWindow);
  const getActiveDesktop = useTilingStore((state) => state.getActiveDesktop);
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (!isReady || hasInitialized.current) return;
    hasInitialized.current = true;

    // Si no hay ninguna ventana abierta en el desktop activo, abrir conversaciones por defecto
    const activeDesktop = getActiveDesktop();
    if (!activeDesktop?.layout) {
      console.log('[WorkspaceIndex] No saved state, opening default conversations window');
      openWindow('conversations', {});
    }
  }, [isReady]);

  // No renderiza nada - el layout ya muestra el TilingLayout
  return null;
}
