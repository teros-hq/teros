/**
 * DragDropContext - Context for drag & drop of tabs between containers
 *
 * Handles:
 * - Current drag state (which tab is being dragged)
 * - Drop zones (center, right, bottom of each container)
 * - Drop indicator visualization
 */

import type React from 'react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { SplitDirection } from '../../store/tilingStore';

// ============================================
// TYPES
// ============================================

export type DropZone = 'left' | 'right' | 'bottom' | 'tabs' | 'center';

export interface DragState {
  /** ID de la ventana siendo arrastrada (o null si es grupo) */
  windowId: string | null;
  /** IDs de todas las ventanas siendo arrastradas (para grupo) */
  windowIds: string[];
  /** ID del container origen */
  sourceContainerId: string;
  /** Window title (for preview) */
  title: string;
  /** Si es un drag de grupo (todas las tabs del container) */
  isGroup: boolean;
}

export interface DropTarget {
  /** ID del container destino */
  containerId: string;
  /** Zona de drop */
  zone: DropZone;
  /** Insertion index for tabs (only when zone === 'tabs') */
  tabIndex?: number;
}

interface DragDropContextValue {
  /** Estado actual del drag */
  dragState: DragState | null;

  /** Target de drop actual (hover) */
  dropTarget: DropTarget | null;

  /** Iniciar drag de una ventana */
  startDrag: (windowId: string, sourceContainerId: string, title: string) => void;

  /** Iniciar drag de un grupo de ventanas (todas las tabs de un container) */
  startGroupDrag: (windowIds: string[], sourceContainerId: string, title: string) => void;

  /** Actualizar drop target (cuando el mouse entra en una zona) */
  setDropTarget: (target: DropTarget | null) => void;

  /** Finalizar drag (drop o cancel) */
  endDrag: () => void;

  /** Check whether a drag is in progress */
  isDragging: boolean;
}

// ============================================
// CONTEXT
// ============================================

const DragDropContext = createContext<DragDropContextValue | null>(null);

export function useDragDrop() {
  const context = useContext(DragDropContext);
  if (!context) {
    throw new Error('useDragDrop must be used within DragDropProvider');
  }
  return context;
}

// ============================================
// PROVIDER
// ============================================

interface Props {
  children: React.ReactNode;
  /** Callback cuando se completa un drop */
  onDrop?: (
    windowId: string | null,
    windowIds: string[],
    sourceContainerId: string,
    target: DropTarget,
    isGroup: boolean,
  ) => void;
}

export function DragDropProvider({ children, onDrop }: Props) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropTarget, setDropTargetState] = useState<DropTarget | null>(null);

  const startDrag = useCallback((windowId: string, sourceContainerId: string, title: string) => {
    console.log('[DragDrop] Start drag:', windowId, 'from', sourceContainerId);
    setDragState({
      windowId,
      windowIds: [windowId],
      sourceContainerId,
      title,
      isGroup: false,
    });

    // Change cursor on web
    if (Platform.OS === 'web') {
      document.body.style.cursor = 'grabbing';
    }
  }, []);

  const startGroupDrag = useCallback(
    (windowIds: string[], sourceContainerId: string, title: string) => {
      console.log(
        '[DragDrop] Start group drag:',
        windowIds.length,
        'windows from',
        sourceContainerId,
      );
      setDragState({
        windowId: null,
        windowIds,
        sourceContainerId,
        title,
        isGroup: true,
      });

      if (Platform.OS === 'web') {
        document.body.style.cursor = 'grabbing';
      }
    },
    [],
  );

  const setDropTarget = useCallback((target: DropTarget | null) => {
    setDropTargetState(target);
  }, []);

  const endDrag = useCallback(() => {
    if (dragState && dropTarget) {
      console.log(
        '[DragDrop] Drop:',
        dragState.isGroup ? 'group' : dragState.windowId,
        'to',
        dropTarget.containerId,
        dropTarget.zone,
      );
      onDrop?.(
        dragState.windowId,
        dragState.windowIds,
        dragState.sourceContainerId,
        dropTarget,
        dragState.isGroup,
      );
    }

    setDragState(null);
    setDropTargetState(null);

    // Restaurar cursor
    if (Platform.OS === 'web') {
      document.body.style.cursor = '';
    }
  }, [dragState, dropTarget, onDrop]);

  const value: DragDropContextValue = {
    dragState,
    dropTarget,
    startDrag,
    startGroupDrag,
    setDropTarget,
    endDrag,
    isDragging: dragState !== null,
  };

  return <DragDropContext.Provider value={value}>{children}</DragDropContext.Provider>;
}
