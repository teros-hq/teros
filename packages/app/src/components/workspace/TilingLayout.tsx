/**
 * TilingLayout - Renders the tiling layout tree
 *
 * Renderiza recursivamente splits y containers.
 * En mobile, usa MobileTilingLayout que consolida todas las tabs.
 */

import { LayoutGrid, Plus } from '@tamagui/lucide-icons';
import React, { useCallback, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { NewConversationModal } from '../NewConversationModal';
import { type LayoutNode, type SplitNode, useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { DragDropProvider, type DropTarget } from './DragDropContext';
import { MobileTilingLayout } from './MobileTilingLayout';
import { SplitHandle } from './SplitHandle';
import { TilingContainer } from './TilingContainer';
import { useColors } from '../mca/primitives/useColors';
import { colors as semanticColors } from '../mca/primitives/colors';

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
  const c = useColors();
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
      <YStack flex={1} backgroundColor={c.bgPage} overflow="visible">
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
          : { flexBasis: firstSize, minHeight: 100 }) as any}
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
          : { flexBasis: secondSize, minHeight: 100 }) as any}
        overflow="visible"
      >
        <LayoutNodeRenderer node={split.second} />
      </YStack>
    </Container>
  );
}

/**
 * Empty state when there is no layout - shows actions to start
 */
function EmptyLayout() {
  const c = useColors();
  const { openWindow } = useTilingStore();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [showNewConversationModal, setShowNewConversationModal] = useState(false);

  const handleSelectAgent = (agent: { agentId: string; name: string; fullName: string }) => {
    openWindow(
      'chat',
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: activeWorkspaceId ?? undefined,
      },
      true,
    );
  };

  return (
    <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor={c.bgPage} gap={16}>
      {/* Primary: New Conversation */}
      <XStack
        alignItems="center"
        gap={14}
        paddingHorizontal={28}
        paddingLeft={14}
        height={56}
        borderWidth={1.5}
        borderColor={c.border}
        borderRadius={14}
        cursor="pointer"
        hoverStyle={{ backgroundColor: c.bgCardHover, borderColor: c.borderStrong }}
        pressStyle={{ scale: 0.97 }}
        onPress={() => setShowNewConversationModal(true)}
      >
        <YStack
          width={32}
          height={32}
          borderRadius={6}
          backgroundColor={semanticColors.indigo}
          alignItems="center"
          justifyContent="center"
        >
          <Plus size={20} color="white" />
        </YStack>
        <Text fontSize={18} fontWeight="500" color={c.text}>
          New Conversation
        </Text>
      </XStack>

      {/* Secondary: Open Window Selector */}
      <XStack
        alignItems="center"
        gap={9}
        paddingHorizontal={18}
        paddingVertical={8}
        borderRadius={10}
        cursor="pointer"
        hoverStyle={{ backgroundColor: c.bgCardHover }}
        onPress={() => openWindow('launcher', {}, true)}
      >
        <LayoutGrid size={15} color={c.text3} />
        <Text fontSize={15} color={c.text3}>
          Open Window Selector
        </Text>
      </XStack>

      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgent}
      />
    </YStack>
  );
}
