/**
 * useWindowDrag - Hook to drag floating windows
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseWindowDragOptions {
  /** Callback when the window moves */
  onDrag: (x: number, y: number) => void;
  /** Initial position */
  initialPosition: { x: number; y: number };
  /** Whether drag is enabled */
  enabled?: boolean;
}

interface UseWindowDragReturn {
  /** Props for the element that initiates the drag (title bar) */
  dragHandleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    onTouchStart: (e: React.TouchEvent) => void;
    style: { cursor: string; userSelect: string };
  };
  /** Whether it is being dragged */
  isDragging: boolean;
}

export function useWindowDrag({
  onDrag,
  initialPosition,
  enabled = true,
}: UseWindowDragOptions): UseWindowDragReturn {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const positionRef = useRef(initialPosition);

  // Update ref when initial position changes
  useEffect(() => {
    positionRef.current = initialPosition;
  }, [initialPosition.x, initialPosition.y]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;

      // Left button only
      if (e.button !== 0) return;

      e.preventDefault();
      e.stopPropagation();

      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX - positionRef.current.x,
        y: e.clientY - positionRef.current.y,
      };
    },
    [enabled],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled) return;
      if (e.touches.length !== 1) return;

      const touch = e.touches[0];

      setIsDragging(true);
      dragStartRef.current = {
        x: touch.clientX - positionRef.current.x,
        y: touch.clientY - positionRef.current.y,
      };
    },
    [enabled],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newX = e.clientX - dragStartRef.current.x;
      const newY = Math.max(0, e.clientY - dragStartRef.current.y); // No salir por arriba

      positionRef.current = { x: newX, y: newY };
      onDrag(newX, newY);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;

      const touch = e.touches[0];
      const newX = touch.clientX - dragStartRef.current.x;
      const newY = Math.max(0, touch.clientY - dragStartRef.current.y);

      positionRef.current = { x: newX, y: newY };
      onDrag(newX, newY);
    };

    const handleEnd = () => {
      setIsDragging(false);
    };

    // Mouse events
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);

    // Touch events
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleEnd);

    // Prevent text selection while dragging
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleEnd);
      document.body.style.userSelect = '';
    };
  }, [isDragging, onDrag]);

  return {
    dragHandleProps: {
      onMouseDown: handleMouseDown,
      onTouchStart: handleTouchStart,
      style: {
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none' as const,
      },
    },
    isDragging,
  };
}
