/**
 * TilingLayout - Renders the tiling layout tree
 *
 * Renderiza recursivamente splits y containers.
 * En mobile, usa MobileTilingLayout que consolida todas las tabs.
 */

import { Plus } from '@tamagui/lucide-icons';
import React, { useCallback } from 'react';
import { useWindowDimensions } from 'react-native';
import { Button, XStack, YStack } from 'tamagui';
import { type LayoutNode, type SplitNode, useTilingStore } from '../../store/tilingStore';
import { DragDropProvider, type DropTarget } from './DragDropContext';
import { MobileTilingLayout } from './MobileTilingLayout';
import { SplitHandle } from './SplitHandle';
import { TilingContainer } from './TilingContainer';

const MOBILE_BREAKPOINT = 768;

/**
 * TilingLayout - Wrapper que decide entre mobile y desktop
 */
export function TilingLayout() {
  const { width } = useWindowDimensions();
  const isMobile = width < MOBILE_BREAKPOINT;

  // Render the appropriate component based on size
  // Cada uno tiene sus propios hooks internos
  if (isMobile) {
    return <MobileTilingLayout />;
  }

  return <DesktopTilingLayout />;
}

/**
 * DesktopTilingLayout - Layout de escritorio con splits
 */
function DesktopTilingLayout() {
  const layout = useTilingStore((state) => state.desktops[state.activeDesktopIndex]?.layout);
  const moveWindowToContainer = useTilingStore((state) => state.moveWindowToContainer);
  const moveWindowToNewSplit = useTilingStore((state) => state.moveWindowToNewSplit);

  const swapWindows = useTilingStore((state) => state.swapWindows);
  const moveWindowsToContainer = useTilingStore((state) => state.moveWindowsToContainer);
  const moveWindowsToNewSplit = useTilingStore((state) => state.moveWindowsToNewSplit);
  const swapContainerWindows = useTilingStore((state) => state.swapContainerWindows);

  const handleDrop = useCallback(
    (
      windowId: string | null,
      windowIds: string[],
      sourceContainerId: string,
      target: DropTarget,
      isGroup: boolean,
    ) => {
      if (isGroup) {
        // Drag de grupo (todas las tabs)
        if (target.zone === 'tabs') {
          moveWindowsToContainer(windowIds, target.containerId);
        } else if (target.zone === 'center') {
          swapContainerWindows(sourceContainerId, target.containerId);
        } else if (target.zone === 'left') {
          moveWindowsToNewSplit(windowIds, target.containerId, 'horizontal', 'before');
        } else if (target.zone === 'right') {
          moveWindowsToNewSplit(windowIds, target.containerId, 'horizontal', 'after');
        } else if (target.zone === 'bottom') {
          moveWindowsToNewSplit(windowIds, target.containerId, 'vertical', 'after');
        }
      } else if (windowId) {
        // Drag de una sola tab
        if (target.zone === 'tabs') {
          moveWindowToContainer(windowId, target.containerId, target.tabIndex);
        } else if (target.zone === 'center') {
          swapWindows(windowId, target.containerId);
        } else if (target.zone === 'left') {
          moveWindowToNewSplit(windowId, target.containerId, 'horizontal', 'before');
        } else if (target.zone === 'right') {
          moveWindowToNewSplit(windowId, target.containerId, 'horizontal', 'after');
        } else if (target.zone === 'bottom') {
          moveWindowToNewSplit(windowId, target.containerId, 'vertical', 'after');
        }
      }
    },
    [
      moveWindowToContainer,
      moveWindowToNewSplit,
      swapWindows,
      moveWindowsToContainer,
      moveWindowsToNewSplit,
      swapContainerWindows,
    ],
  );

  if (!layout) {
    return <EmptyLayout />;
  }

  return (
    <DragDropProvider onDrop={handleDrop}>
      <YStack flex={1} backgroundColor="#0a0a0a" overflow="visible">
        <LayoutNodeRenderer node={layout} />
      </YStack>
    </DragDropProvider>
  );
}

/**
 * Renderiza un nodo del layout recursivamente
 */
function LayoutNodeRenderer({ node }: { node: LayoutNode }) {
  if (node.type === 'container') {
    return <TilingContainer container={node} />;
  }

  // Split node
  return <SplitRenderer split={node} />;
}

/** Handle width/height in pixels */
const HANDLE_SIZE = 12;

/**
 * Renderiza un split con sus dos hijos y el handle
 */
function SplitRenderer({ split }: { split: SplitNode }) {
  const setRatio = useTilingStore((state) => state.setRatio);
  const isHorizontal = split.direction === 'horizontal';

  // Usar ref para tener siempre el ratio actual
  const ratioRef = React.useRef(split.ratio);
  ratioRef.current = split.ratio;

  const handleDrag = React.useCallback(
    (delta: number, totalSize: number) => {
      // totalSize includes the handle, so we subtract it for the calculation
      const availableSize = totalSize - HANDLE_SIZE;
      const ratioDelta = delta / availableSize;
      const newRatio = Math.max(0.1, Math.min(0.9, ratioRef.current + ratioDelta));
      setRatio(split.id, newRatio);
    },
    [split.id, setRatio],
  );

  const Container = isHorizontal ? XStack : YStack;

  // Usar calc() para que los paneles ocupen exactamente el espacio disponible
  // minus the 12px handle, distributed according to the ratio
  // Ejemplo con ratio 0.5: primer panel = calc(50% - 6px), segundo = calc(50% - 6px)
  const firstSize = `calc(${split.ratio * 100}% - ${HANDLE_SIZE * split.ratio}px)`;
  const secondSize = `calc(${(1 - split.ratio) * 100}% - ${HANDLE_SIZE * (1 - split.ratio)}px)`;

  return (
    <Container flex={1}>
      {/* First child */}
      <YStack
        flexGrow={0}
        flexShrink={0}
        {...(isHorizontal
          ? { flexBasis: firstSize, minWidth: 100 }
          : { flexBasis: firstSize, minHeight: 100 })}
        overflow="visible"
      >
        <LayoutNodeRenderer node={split.first} />
      </YStack>

      {/* Split handle - fixed size */}
      <SplitHandle direction={split.direction} onDrag={handleDrag} />

      {/* Second child */}
      <YStack
        flexGrow={0}
        flexShrink={0}
        {...(isHorizontal
          ? { flexBasis: secondSize, minWidth: 100 }
          : { flexBasis: secondSize, minHeight: 100 })}
        overflow="visible"
      >
        <LayoutNodeRenderer node={split.second} />
      </YStack>
    </Container>
  );
}

/**
 * Empty state when there is no layout - shows button to open launcher
 */
function EmptyLayout() {
  const openWindow = useTilingStore((state) => state.openWindow);

  return (
    <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor="#0a0a0a">
      <Button
        size="$6"
        circular
        backgroundColor="rgba(6, 182, 212, 0.15)"
        borderWidth={2}
        borderColor="rgba(6, 182, 212, 0.4)"
        hoverStyle={{
          backgroundColor: 'rgba(6, 182, 212, 0.25)',
          borderColor: 'rgba(6, 182, 212, 0.6)',
        }}
        pressStyle={{
          backgroundColor: 'rgba(6, 182, 212, 0.3)',
          scale: 0.95,
        }}
        onPress={() => openWindow('launcher', {}, true)}
        icon={<Plus size={32} color="#06B6D4" />}
      />
    </YStack>
  );
}
