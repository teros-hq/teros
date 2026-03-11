/**
 * useWindowResize - Hook to resize floating windows
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
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

  const handleStart = useCallback(
    (direction: ResizeDirection, clientX: number, clientY: number) => {
      if (!enabled) return;

      setIsResizing(true);
      setResizeDirection(direction);
      startRef.current = {
        x: clientX,
        y: clientY,
        width: currentSize.width,
        height: currentSize.height,
      };
    },
    [enabled, currentSize],
  );

  const handleMouseDown = useCallback(
    (direction: ResizeDirection) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handleStart(direction, e.clientX, e.clientY);
    },
    [handleStart],
  );

  const handleTouchStart = useCallback(
    (direction: ResizeDirection) => (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      handleStart(direction, touch.clientX, touch.clientY);
    },
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

    const handleMouseMove = (e: MouseEvent) => {
      handleMove(e.clientX, e.clientY);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      handleMove(touch.clientX, touch.clientY);
    };

    const handleEnd = () => {
      setIsResizing(false);
      setResizeDirection(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleEnd);

    document.body.style.userSelect = 'none';
    document.body.style.cursor = CURSOR_MAP[resizeDirection];

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleEnd);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, resizeDirection, minSize, maxSize, onResize]);

  const getResizeHandleProps = useCallback(
    (direction: ResizeDirection): ResizeHandleProps => {
      return {
        onMouseDown: handleMouseDown(direction),
        onTouchStart: handleTouchStart(direction),
        style: {
          cursor: CURSOR_MAP[direction],
          touchAction: 'none',
        },
      };
    },
    [handleMouseDown, handleTouchStart],
  );

  return {
    getResizeHandleProps,
    isResizing,
    resizeDirection,
  };
}
