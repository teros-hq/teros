/**
 * useWindowResize - Hook to resize floating windows
 *
 * Unified Pointer Events + `setPointerCapture`: while a resize drag is active,
 * every subsequent pointer event routes to the handle element even when the
 * pointer passes over an iframe (Terminal, Code Editor, HTML previews) — those
 * used to swallow the document-level mousemove/mouseup and freeze the resize.
 * `beginResizeDrag()` additionally disables pointer events on all iframes for
 * the duration of the drag (belt-and-suspenders for lost capture).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { beginResizeDrag, endResizeDrag } from '../lib/resizeGuard';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface UseWindowResizeOptions {
  /** Callback when resized */
  onResize: (width: number, height: number, deltaX?: number, deltaY?: number) => void;
  /** Minimum size */
  minSize: { width: number; height: number };
  /** Maximum size (optional) */
  maxSize?: { width: number; height: number };
  /** Current size */
  currentSize: { width: number; height: number };
  /** Whether resize is enabled */
  enabled?: boolean;
}

interface ResizeHandleProps {
  onPointerDown: (e: ReactPointerEvent) => void;
  style: React.CSSProperties;
}

interface UseWindowResizeReturn {
  /** Function to get props for a specific handle */
  getResizeHandleProps: (direction: ResizeDirection) => ResizeHandleProps;
  /** Whether it is being resized */
  isResizing: boolean;
  /** Current resize direction */
  resizeDirection: ResizeDirection | null;
}

const CURSOR_MAP: Record<ResizeDirection, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

export function useWindowResize({
  onResize,
  minSize,
  maxSize,
  currentSize,
  enabled = true,
}: UseWindowResizeOptions): UseWindowResizeReturn {
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDirection, setResizeDirection] = useState<ResizeDirection | null>(null);

  const startRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const pointerIdRef = useRef<number | null>(null);

  const handleStart = useCallback(
    (direction: ResizeDirection, e: ReactPointerEvent) => {
      if (!enabled) return;
      // Primary button / single contact only — ignore right-click and extra fingers.
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      e.preventDefault();
      e.stopPropagation();

      pointerIdRef.current = e.pointerId;
      setIsResizing(true);
      setResizeDirection(direction);
      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        width: currentSize.width,
        height: currentSize.height,
      };

      // Route ALL subsequent pointer events to this handle — even when the
      // pointer moves over an iframe, which would otherwise swallow them.
      // (Capture must be taken synchronously inside the handler.)
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // jsdom / browsers without capture support: the document-level
        // fallback listeners below still track the pointer, and the
        // resizeGuard's pointer-events:none shield keeps iframes from
        // eating the events.
      }
    },
    [enabled, currentSize],
  );

  const getResizeHandleProps = useCallback(
    (direction: ResizeDirection): ResizeHandleProps => ({
      onPointerDown: (e) => handleStart(direction, e),
      style: {
        cursor: CURSOR_MAP[direction],
        touchAction: 'none',
      },
    }),
    [handleStart],
  );

  useEffect(() => {
    if (!isResizing || !resizeDirection) return;

    const handleMove = (clientX: number, clientY: number) => {
      const deltaX = clientX - startRef.current.x;
      const deltaY = clientY - startRef.current.y;

      let newWidth = startRef.current.width;
      let newHeight = startRef.current.height;
      let positionDeltaX = 0;
      let positionDeltaY = 0;

      // Calculate new size based on direction
      if (resizeDirection.includes('e')) {
        newWidth = startRef.current.width + deltaX;
      }
      if (resizeDirection.includes('w')) {
        newWidth = startRef.current.width - deltaX;
        positionDeltaX = deltaX;
      }
      if (resizeDirection.includes('s')) {
        newHeight = startRef.current.height + deltaY;
      }
      if (resizeDirection.includes('n')) {
        newHeight = startRef.current.height - deltaY;
        positionDeltaY = deltaY;
      }

      // Apply limits
      newWidth = Math.max(minSize.width, newWidth);
      newHeight = Math.max(minSize.height, newHeight);

      if (maxSize) {
        newWidth = Math.min(maxSize.width, newWidth);
        newHeight = Math.min(maxSize.height, newHeight);
      }

      // Adjust position delta if minimum limit was reached
      if (resizeDirection.includes('w')) {
        const actualWidthChange = startRef.current.width - newWidth;
        positionDeltaX = actualWidthChange;
      }
      if (resizeDirection.includes('n')) {
        const actualHeightChange = startRef.current.height - newHeight;
        positionDeltaY = actualHeightChange;
      }

      onResize(newWidth, newHeight, positionDeltaX, positionDeltaY);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return;
      handleMove(e.clientX, e.clientY);
    };

    const handleEnd = (e: PointerEvent) => {
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return;
      pointerIdRef.current = null;
      setIsResizing(false);
      setResizeDirection(null);
    };

    // Fallback listeners on document — with pointer capture the events still
    // bubble here from the handle; without capture (or if it is lost) they
    // keep the drag alive as long as no iframe sits under the pointer, which
    // the resizeGuard shield covers.
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handleEnd);
    document.addEventListener('pointercancel', handleEnd);

    document.body.style.userSelect = 'none';
    document.body.style.cursor = CURSOR_MAP[resizeDirection];
    beginResizeDrag();

    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handleEnd);
      document.removeEventListener('pointercancel', handleEnd);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      endResizeDrag();
      pointerIdRef.current = null;
    };
  }, [isResizing, resizeDirection, minSize, maxSize, onResize]);

  return {
    getResizeHandleProps,
    isResizing,
    resizeDirection,
  };
}
