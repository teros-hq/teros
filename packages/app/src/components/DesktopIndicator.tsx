import React, { useMemo, useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useTilingStore } from '../store/tilingStore';
import { useColors } from './mca/primitives/useColors';
import { colors as semanticColors } from './mca/primitives/colors';

interface DesktopIndicatorProps {
  /** Whether to show in collapsed mode (vertical layout) */
  collapsed?: boolean;
}

const TILE_WIDTH = 22;
const TILE_HEIGHT = 16;
const TILE_RADIUS = 3;
const INNER_RECT_WIDTH = 14;
const INNER_RECT_HEIGHT = 8;
const INNER_RECT_RADIUS = 1.5;

/**
 * Desktop/Workspace indicator for the navbar.
 * Shows rectangular tiles for each desktop. Inactive desktops are rendered as
 * subtle grey outlines; the active desktop is a filled indigo rectangle with a
 * soft glow. If a desktop contains windows, a small inner rectangle is shown.
 * Clicking a desktop switches to it.
 * When a drag is in progress (globalDragWindowId != null), tiles become drop targets
 * to move the dragged window to another desktop.
 */
export function DesktopIndicator({ collapsed = false }: DesktopIndicatorProps) {
  const c = useColors();
  const styles = useMemo(() => buildStyles(c), [c]);

  const desktops = useTilingStore((state) => state.desktops);
  const activeDesktopIndex = useTilingStore((state) => state.activeDesktopIndex);
  const switchToDesktop = useTilingStore((state) => state.switchToDesktop);
  const windows = useTilingStore((state) => state.windows);
  const moveWindowToDesktop = useTilingStore((state) => state.moveWindowToDesktop);
  const globalDragWindowId = useTilingStore((state) => state.globalDragWindowId);
  const globalDragWindowIds = useTilingStore((state) => state.globalDragWindowIds);
  const globalDragIsGroup = useTilingStore((state) => state.globalDragIsGroup);
  const clearGlobalDrag = useTilingStore((state) => state.clearGlobalDrag);

  const isDragging = globalDragWindowId !== null || globalDragIsGroup;

  // Track which tile is being hovered during a drag
  const [hoveredTileIndex, setHoveredTileIndex] = useState<number | null>(null);

  return (
    <View style={[styles.container, collapsed && styles.containerCollapsed]}>
      {desktops.map((desktop, index) => {
        const isActive = index === activeDesktopIndex;
        const hasWindows = Object.values(windows).some((w) => w.desktopIndex === index);
        const isDroppable = isDragging && !isActive;
        const isHovered = hoveredTileIndex === index;

        return (
          <TouchableOpacity
            key={desktop.id}
            style={[
              styles.tile,
              !isActive && !isDroppable && styles.tileInactive,
              isActive && styles.tileActive,
              isDroppable && styles.tileDroppable,
              isDroppable && isHovered && styles.tileDroppableHover,
            ]}
            onPress={() => switchToDesktop(index)}
            activeOpacity={0.7}
            // HTML5 drag-and-drop handlers (web only)
            {...(isDragging && {
              onDragOver: (e: any) => {
                e.preventDefault();
                setHoveredTileIndex(index);
              },
              onDragLeave: () => {
                setHoveredTileIndex(null);
              },
              onDrop: (e: any) => {
                e.preventDefault();
                setHoveredTileIndex(null);

                if (globalDragIsGroup) {
                  // Move all windows in the group
                  globalDragWindowIds.forEach((wid) => {
                    moveWindowToDesktop(wid, index);
                  });
                } else if (globalDragWindowId) {
                  moveWindowToDesktop(globalDragWindowId, index);
                }

                clearGlobalDrag();
                switchToDesktop(index);
              },
            })}
          >
            {hasWindows && <View style={[styles.innerRect, isActive && styles.innerRectActive]} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const buildStyles = (c: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      backgroundColor: c.bgInner,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.border,
    },
    containerCollapsed: {
      flexDirection: 'column',
      paddingVertical: 10,
      paddingHorizontal: 6,
    },
    tile: {
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      borderRadius: TILE_RADIUS,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1.5,
    },
    tileInactive: {
      backgroundColor: 'transparent',
      borderColor: c.borderStrong,
    },
    tileActive: {
      backgroundColor: 'transparent',
      borderColor: semanticColors.indigo,
      shadowColor: semanticColors.indigo,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.5,
      shadowRadius: 8,
    },
    tileDroppable: {
      backgroundColor: semanticColors.indigoGlow,
      borderWidth: 1.5,
      borderColor: 'rgba(94,106,210,0.4)',
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      borderRadius: TILE_RADIUS,
    },
    tileDroppableHover: {
      backgroundColor: semanticColors.indigo,
      borderColor: semanticColors.indigo,
      opacity: 0.7,
    },
    innerRect: {
      width: INNER_RECT_WIDTH,
      height: INNER_RECT_HEIGHT,
      borderRadius: INNER_RECT_RADIUS,
      backgroundColor: c.borderStrong,
      opacity: 0.85,
    },
    innerRectActive: {
      backgroundColor: semanticColors.indigo,
      opacity: 0.85,
    },
  });
