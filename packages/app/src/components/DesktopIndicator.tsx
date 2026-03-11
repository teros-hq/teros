import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useTilingStore } from '../store/tilingStore';

interface DesktopIndicatorProps {
  /** Whether to show in collapsed mode (vertical layout) */
  collapsed?: boolean;
}

/**
 * Desktop/Workspace indicator for the navbar.
 * Shows dots for each desktop with a center indicator for windows.
 * Clicking a desktop switches to it.
 */
export function DesktopIndicator({ collapsed = false }: DesktopIndicatorProps) {
  const desktops = useTilingStore((state) => state.desktops);
  const activeDesktopIndex = useTilingStore((state) => state.activeDesktopIndex);
  const switchToDesktop = useTilingStore((state) => state.switchToDesktop);
  const getDesktopWindowCount = useTilingStore((state) => state.getDesktopWindowCount);

  return (
    <View style={[styles.container, collapsed && styles.containerCollapsed]}>
      {desktops.map((desktop, index) => {
        const isActive = index === activeDesktopIndex;
        const hasWindows = getDesktopWindowCount(index) > 0;

        return (
          <TouchableOpacity
            key={desktop.id}
            style={[styles.dot, isActive && styles.dotActive]}
            onPress={() => switchToDesktop(index)}
            activeOpacity={0.7}
          >
            {hasWindows && <View style={styles.windowIndicator} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(39, 39, 42, 0.4)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(63, 63, 70, 0.5)',
  },
  containerCollapsed: {
    flexDirection: 'column',
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#3f3f46',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dotActive: {
    backgroundColor: '#06B6D4',
    shadowColor: '#06B6D4',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
  },
  windowIndicator: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#27272a',
  },
});
