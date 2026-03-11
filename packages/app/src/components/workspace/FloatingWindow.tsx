/**
 * FloatingWindow - Ventana flotante arrastrable y redimensionable
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { YStack } from 'tamagui';
import { useWindowDrag } from '../../hooks/useWindowDrag';
import { type ResizeDirection, useWindowResize } from '../../hooks/useWindowResize';
import { windowRegistry } from '../../services/windowRegistry';
import {
  type FloatingWindow as FloatingWindowType,
  useWorkspaceStore,
} from '../../store/workspaceStore';
import { WindowContent } from './WindowContent';
import { WindowTitleBar } from './WindowTitleBar';

interface Props {
  window: FloatingWindowType;
}

// Estilos para los resize handles
const HANDLE_SIZE = 6;
const CORNER_SIZE = 12;

export function FloatingWindow({ window }: Props) {
  const { focusWindow, moveWindow, resizeWindow, activeFloatingWindowId } = useWorkspaceStore();

  const definition = windowRegistry.get(window.type);
  const isActive = activeFloatingWindowId === window.id;

  // Drag hook
  const handleDrag = useCallback(
    (x: number, y: number) => {
      moveWindow(window.id, x, y);
    },
    [window.id, moveWindow],
  );

  const { dragHandleProps, isDragging } = useWindowDrag({
    onDrag: handleDrag,
    initialPosition: { x: window.x, y: window.y },
    enabled: !window.isMaximized,
  });

  // Resize hook
  const handleResize = useCallback(
    (width: number, height: number, deltaX?: number, deltaY?: number) => {
      resizeWindow(window.id, width, height);

      // If resizing from west or north, also move the window
      if (deltaX || deltaY) {
        const newX = window.x + (deltaX || 0);
        const newY = window.y + (deltaY || 0);
        moveWindow(window.id, newX, newY);
      }
    },
    [window.id, window.x, window.y, resizeWindow, moveWindow],
  );

  const { getResizeHandleProps, isResizing } = useWindowResize({
    onResize: handleResize,
    minSize: definition?.minSize ?? { width: 200, height: 150 },
    maxSize: definition?.maxSize,
    currentSize: { width: window.width, height: window.height },
    enabled: !window.isMaximized,
  });

  // Click para focus
  const handleFocus = () => {
    if (!isActive) {
      focusWindow(window.id);
    }
  };

  // Calculate position styles
  const positionStyle = useMemo(() => {
    if (window.isMaximized) {
      return {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: window.zIndex,
      };
    }

    return {
      position: 'absolute' as const,
      top: window.y,
      left: window.x,
      width: window.width,
      height: window.height,
      zIndex: window.zIndex,
    };
  }, [window.x, window.y, window.width, window.height, window.zIndex, window.isMaximized]);

  // Solo renderizar en web
  if (Platform.OS !== 'web') {
    return null;
  }

  return (
    <YStack
      style={positionStyle}
      backgroundColor="$gray1"
      borderRadius={window.isMaximized ? 0 : '$3'}
      borderWidth={1}
      borderColor={isActive ? '$cyan8' : '$gray6'}
      overflow="hidden"
      elevation={isActive ? 10 : 5}
      onPress={handleFocus}
      opacity={isDragging || isResizing ? 0.9 : 1}
    >
      {/* Title Bar */}
      <WindowTitleBar window={window} isActive={isActive} dragHandleProps={dragHandleProps} />

      {/* Content */}
      <YStack flex={1} overflow="hidden">
        <WindowContent window={window} />
      </YStack>

      {/* Resize Handles (only when not maximized) */}
      {!window.isMaximized && (
        <>
          {/* Edges */}
          <ResizeHandle direction="n" getProps={getResizeHandleProps} />
          <ResizeHandle direction="s" getProps={getResizeHandleProps} />
          <ResizeHandle direction="e" getProps={getResizeHandleProps} />
          <ResizeHandle direction="w" getProps={getResizeHandleProps} />

          {/* Corners */}
          <ResizeHandle direction="ne" getProps={getResizeHandleProps} />
          <ResizeHandle direction="nw" getProps={getResizeHandleProps} />
          <ResizeHandle direction="se" getProps={getResizeHandleProps} />
          <ResizeHandle direction="sw" getProps={getResizeHandleProps} />
        </>
      )}
    </YStack>
  );
}

// ============================================
// Resize Handle Component
// ============================================

interface ResizeHandleProps {
  direction: ResizeDirection;
  getProps: (direction: ResizeDirection) => {
    onMouseDown: (e: React.MouseEvent) => void;
    onTouchStart: (e: React.TouchEvent) => void;
    style: React.CSSProperties;
  };
}

function ResizeHandle({ direction, getProps }: ResizeHandleProps) {
  const props = getProps(direction);

  const style = useMemo((): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      zIndex: 10,
      ...props.style,
    };

    switch (direction) {
      case 'n':
        return { ...base, top: 0, left: CORNER_SIZE, right: CORNER_SIZE, height: HANDLE_SIZE };
      case 's':
        return { ...base, bottom: 0, left: CORNER_SIZE, right: CORNER_SIZE, height: HANDLE_SIZE };
      case 'e':
        return { ...base, right: 0, top: CORNER_SIZE, bottom: CORNER_SIZE, width: HANDLE_SIZE };
      case 'w':
        return { ...base, left: 0, top: CORNER_SIZE, bottom: CORNER_SIZE, width: HANDLE_SIZE };
      case 'ne':
        return { ...base, top: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE };
      case 'nw':
        return { ...base, top: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE };
      case 'se':
        return { ...base, bottom: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE };
      case 'sw':
        return { ...base, bottom: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE };
      default:
        return base;
    }
  }, [direction, props.style]);

  return <div style={style} onMouseDown={props.onMouseDown} onTouchStart={props.onTouchStart} />;
}
