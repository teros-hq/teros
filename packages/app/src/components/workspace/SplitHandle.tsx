/**
 * SplitHandle - Handle para redimensionar splits
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, type View } from 'react-native';
import { XStack, YStack } from 'tamagui';
import type { SplitDirection } from '../../store/tilingStore';

interface Props {
  direction: SplitDirection;
  onDrag: (delta: number, totalSize: number) => void;
}

export function SplitHandle({ direction, onDrag }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const parentSizeRef = useRef(1000);
  const draggingRef = useRef(false);

  const isHorizontal = direction === 'horizontal';

  const getPosition = useCallback(
    (e: PointerEvent | TouchEvent | MouseEvent): number => {
      if ('touches' in e && e.touches.length > 0) {
        return isHorizontal ? e.touches[0].clientX : e.touches[0].clientY;
      }
      if ('clientX' in e) {
        return isHorizontal ? e.clientX : e.clientY;
      }
      return 0;
    },
    [isHorizontal],
  );

  const measureParent = useCallback(() => {
    const el = handleRef.current;
    if (el?.parentElement) {
      parentSizeRef.current = isHorizontal
        ? el.parentElement.offsetWidth
        : el.parentElement.offsetHeight;
    }
  }, [isHorizontal]);

  // Handlers como refs para evitar recrearlos
  const onMoveRef = useRef<(e: TouchEvent | MouseEvent) => void>();
  const onEndRef = useRef<(e: TouchEvent | MouseEvent) => void>();

  useEffect(() => {
    onMoveRef.current = (e: TouchEvent | MouseEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();

      console.log('[SplitHandle] move event');

      const currentPos = getPosition(e);
      const delta = currentPos - startPosRef.current;
      startPosRef.current = currentPos;

      onDrag(delta, parentSizeRef.current);
    };

    onEndRef.current = (e: TouchEvent | MouseEvent) => {
      console.log('[SplitHandle] end event', e.type);
      if (!draggingRef.current) return;

      draggingRef.current = false;
      setIsDragging(false);

      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      document.removeEventListener('touchmove', onMoveRef.current!);
      document.removeEventListener('touchend', onEndRef.current!);
      document.removeEventListener('touchcancel', onEndRef.current!);
      document.removeEventListener('mousemove', onMoveRef.current!);
      document.removeEventListener('mouseup', onEndRef.current!);
    };
  }, [getPosition, onDrag]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const element = handleRef.current;
    if (!element) return;

    const onStart = (e: TouchEvent | MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      console.log('[SplitHandle] start event', e.type);

      draggingRef.current = true;
      setIsDragging(true);
      startPosRef.current = getPosition(e);
      measureParent();

      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      // Registrar en document para capturar movimiento fuera del elemento
      document.addEventListener('touchmove', onMoveRef.current!, { passive: false });
      document.addEventListener('touchend', onEndRef.current!);
      document.addEventListener('touchcancel', onEndRef.current!);
      document.addEventListener('mousemove', onMoveRef.current!);
      document.addEventListener('mouseup', onEndRef.current!);
    };

    element.addEventListener('touchstart', onStart, { passive: false });
    element.addEventListener('mousedown', onStart);

    return () => {
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('mousedown', onStart);
      // Cleanup in case it's still dragging
      if (draggingRef.current && onEndRef.current) {
        onEndRef.current(new MouseEvent('mouseup'));
      }
    };
  }, [isHorizontal, getPosition, measureParent]);

  const setRef = useCallback((node: View | null) => {
    if (Platform.OS === 'web' && node) {
      handleRef.current = node as unknown as HTMLDivElement;
    }
  }, []);

  const Container = isHorizontal ? YStack : XStack;
  const Indicator = isHorizontal ? YStack : XStack;

  return (
    <Container
      ref={setRef as any}
      {...(isHorizontal ? { width: 12 } : { height: 12 })}
      flexShrink={0}
      backgroundColor={isDragging ? 'rgba(6, 182, 212, 0.3)' : 'transparent'}
      cursor={isHorizontal ? 'col-resize' : 'row-resize'}
      hoverStyle={{ backgroundColor: 'rgba(6, 182, 212, 0.2)' }}
      justifyContent="center"
      alignItems="center"
      // @ts-expect-error
      style={{ touchAction: 'none', userSelect: 'none' }}
    >
      <Indicator
        {...(isHorizontal ? { width: 3, height: 50 } : { width: 50, height: 3 })}
        backgroundColor={isDragging ? '#06B6D4' : '#444'}
        borderRadius={2}
        pointerEvents="none"
      />
    </Container>
  );
}
