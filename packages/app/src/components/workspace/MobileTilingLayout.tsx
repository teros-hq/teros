/**
 * MobileTilingLayout - Mobile layout with all tabs consolidated
 *
 * On mobile, instead of showing splits, we show:
 * - A single pane with all tabs from all containers
 * - A menu icon at the top left to open the sidebar
 * - The active tab takes up the full screen
 */

import { ChevronLeft, ChevronRight, Menu, Plus, X } from '@tamagui/lucide-icons';
import React, { useCallback, useMemo } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Circle, Text, XStack, YStack } from 'tamagui';
import { useTabState } from '../../hooks/useTabState';
import { useNavbarStore } from '../../store/navbarStore';
import { type ContainerNode, type LayoutNode, useTilingStore } from '../../store/tilingStore';
import { TerosLoading } from '../TerosLoading';
import { WindowContent } from './WindowContent';

/** Collect all windows from all containers in the layout tree */
function collectAllWindows(node: LayoutNode | null): string[] {
  if (!node) return [];

  if (node.type === 'container') {
    return node.windowIds;
  }

  // Split node - recurse
  return [...collectAllWindows(node.first), ...collectAllWindows(node.second)];
}

/** Find the container that has a specific window */
function findContainerForWindow(node: LayoutNode | null, windowId: string): ContainerNode | null {
  if (!node) return null;

  if (node.type === 'container') {
    if (node.windowIds.includes(windowId)) {
      return node;
    }
    return null;
  }

  // Split node - recurse
  return (
    findContainerForWindow(node.first, windowId) || findContainerForWindow(node.second, windowId)
  );
}

export function MobileTilingLayout() {
  const insets = useSafeAreaInsets();

  const windows = useTilingStore((state) => state.windows);
  const activeDesktop = useTilingStore((state) => state.desktops[state.activeDesktopIndex]);
  const closeWindow = useTilingStore((state) => state.closeWindow);
  const focusWindow = useTilingStore((state) => state.focusWindow);
  const openWindow = useTilingStore((state) => state.openWindow);
  const navigateBack = useTilingStore((state) => state.navigateBack);
  const navigateForward = useTilingStore((state) => state.navigateForward);

  const layout = activeDesktop?.layout;
  const activeContainerId = activeDesktop?.activeContainerId;

  const { setMobileMenuOpen } = useNavbarStore();

  // Collect all window IDs from all containers
  const allWindowIds = useMemo(() => collectAllWindows(layout), [layout]);

  // Get all window objects
  const allWindows = useMemo(
    () => allWindowIds.map((id) => windows[id]).filter(Boolean),
    [allWindowIds, windows],
  );

  // Find the active window - use the active window from the active container
  const activeWindow = useMemo(() => {
    if (!layout) return null;

    // Find the active container and its active window
    const findActiveWindow = (node: LayoutNode): string | null => {
      if (node.type === 'container') {
        if (node.id === activeContainerId) {
          return node.activeWindowId;
        }
        return null;
      }
      return findActiveWindow(node.first) || findActiveWindow(node.second);
    };

    const activeWindowId = findActiveWindow(layout);
    return activeWindowId ? windows[activeWindowId] : allWindows[0] || null;
  }, [layout, activeContainerId, windows, allWindows]);

  const handleTabPress = useCallback(
    (windowId: string) => {
      focusWindow(windowId);
    },
    [focusWindow],
  );

  const handleCloseTab = useCallback(
    (windowId: string) => {
      closeWindow(windowId);
    },
    [closeWindow],
  );

  const handleOpenLauncher = useCallback(() => {
    openWindow('launcher', {}, true);
  }, [openWindow]);

  const canGoBack = activeWindow ? (activeWindow.historyIndex ?? 0) > 0 : false;
  const canGoForward = activeWindow
    ? (activeWindow.historyIndex ?? 0) < (activeWindow.history?.length ?? 1) - 1
    : false;

  if (!layout || allWindows.length === 0) {
    return <EmptyMobileLayout onOpenLauncher={handleOpenLauncher} />;
  }

  return (
    <YStack flex={1} backgroundColor="#0a0a0a">
      {/* Tab bar with menu button */}
      <XStack
        height={44 + insets.top}
        paddingTop={insets.top}
        backgroundColor="#0c0c0e"
        borderBottomWidth={1}
        borderBottomColor="#1f1f22"
        alignItems="center"
        paddingHorizontal={4}
      >
        {/* Menu button */}
        <XStack
          width={36}
          height={36}
          justifyContent="center"
          alignItems="center"
          borderRadius={8}
          cursor="pointer"
          opacity={0.6}
          hoverStyle={{ backgroundColor: '#1a1a1a', opacity: 1 }}
          pressStyle={{ backgroundColor: '#222' }}
          marginLeft={4}
          onPress={() => setMobileMenuOpen(true)}
        >
          <Menu size={18} color="#06B6D4" />
        </XStack>

        {/* Back / Forward navigation buttons */}
        <XStack alignSelf="center" gap={0}>
          <XStack
            width={32}
            height={32}
            justifyContent="center"
            alignItems="center"
            borderRadius={6}
            opacity={canGoBack ? 0.7 : 0.2}
            cursor={canGoBack ? 'pointer' : 'default'}
            hoverStyle={canGoBack ? { backgroundColor: '#1a1a1a', opacity: 1 } : {}}
            pressStyle={canGoBack ? { backgroundColor: '#222' } : {}}
            onPress={canGoBack && activeWindow ? () => navigateBack(activeWindow.id) : undefined}
          >
            <ChevronLeft size={16} color="#aaa" />
          </XStack>
          <XStack
            width={32}
            height={32}
            justifyContent="center"
            alignItems="center"
            borderRadius={6}
            opacity={canGoForward ? 0.7 : 0.2}
            cursor={canGoForward ? 'pointer' : 'default'}
            hoverStyle={canGoForward ? { backgroundColor: '#1a1a1a', opacity: 1 } : {}}
            pressStyle={canGoForward ? { backgroundColor: '#222' } : {}}
            onPress={canGoForward && activeWindow ? () => navigateForward(activeWindow.id) : undefined}
          >
            <ChevronRight size={16} color="#aaa" />
          </XStack>
        </XStack>

        {/* Scrollable tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ alignItems: 'center', gap: 2, paddingHorizontal: 4 }}
        >
          <XStack gap={2} alignItems="center">
            {allWindows.map((window) => (
              <MobileTab
                key={window.id}
                window={window}
                isActive={activeWindow?.id === window.id}
                onSelect={() => handleTabPress(window.id)}
                onClose={() => handleCloseTab(window.id)}
              />
            ))}
          </XStack>
        </ScrollView>

        {/* Add button */}
        <XStack
          width={36}
          height={36}
          justifyContent="center"
          alignItems="center"
          opacity={0.6}
          hoverStyle={{ backgroundColor: '#1a1a1a', opacity: 1 }}
          borderRadius={8}
          cursor="pointer"
          marginRight={4}
          onPress={handleOpenLauncher}
        >
          <Plus size={18} color="#06B6D4" />
        </XStack>
      </XStack>

      {/* Content */}
      <YStack flex={1} backgroundColor="#0f0f0f">
        {activeWindow && (
          <WindowContent
            key={activeWindow.id}
            window={{
              id: activeWindow.id,
              type: activeWindow.type,
              props: activeWindow.props,
              mode: 'docked',
              isMinimized: false,
              isMaximized: false,
              hasNotification: activeWindow.hasNotification,
              notificationCount: activeWindow.notificationCount,
              createdAt: Date.now(),
              isPinned: false,
            }}
          />
        )}
      </YStack>
    </YStack>
  );
}

// ============================================
// MOBILE TAB COMPONENT
// ============================================

interface MobileTabProps {
  window: { id: string; type: string; props: Record<string, any>; hasNotification: boolean };
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function MobileTab({ window, isActive, onSelect, onClose }: MobileTabProps) {
  // Use shared hook for tab state
  const { Icon, iconColor, title, showSpinner, showRedDot, showBlueDot, showIcon } = useTabState(
    window,
    isActive,
  );

  const handleCloseClick = useCallback(
    (e: any) => {
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );

  return (
    <XStack
      height={36}
      paddingHorizontal={10}
      paddingRight={6}
      gap={6}
      alignItems="center"
      backgroundColor={isActive ? '#1a1a1a' : 'transparent'}
      borderRadius={6}
      cursor="pointer"
      hoverStyle={{ backgroundColor: isActive ? '#1a1a1a' : '#151515' }}
      pressStyle={{ backgroundColor: '#1f1f1f' }}
      onPress={onSelect}
    >
      {/* Status indicator */}
      {showSpinner && <TerosLoading size={14} color="#06B6D4" />}
      {showRedDot && <Circle size={8} backgroundColor="#ef4444" />}
      {showBlueDot && <Circle size={8} backgroundColor="#06B6D4" />}
      {showIcon && Icon && <Icon size={14} color={iconColor} />}

      <Text fontSize={13} color={isActive ? '#e4e4e7' : '#888'} numberOfLines={1} maxWidth={100}>
        {title}
      </Text>

      <XStack
        width={22}
        height={22}
        borderRadius={4}
        justifyContent="center"
        alignItems="center"
        opacity={0.5}
        hoverStyle={{ backgroundColor: '#333', opacity: 1 }}
        onPress={handleCloseClick}
      >
        <X size={12} color="#aaa" />
      </XStack>
    </XStack>
  );
}

// ============================================
// EMPTY STATE
// ============================================

function EmptyMobileLayout({ onOpenLauncher }: { onOpenLauncher: () => void }) {
  const insets = useSafeAreaInsets();
  const { setMobileMenuOpen } = useNavbarStore();

  return (
    <YStack flex={1} backgroundColor="#0a0a0a">
      {/* Header with menu */}
      <XStack
        height={44 + insets.top}
        paddingTop={insets.top}
        backgroundColor="#0c0c0e"
        borderBottomWidth={1}
        borderBottomColor="#1f1f22"
        alignItems="center"
        paddingHorizontal={4}
      >
        <XStack
          width={36}
          height={36}
          justifyContent="center"
          alignItems="center"
          borderRadius={8}
          cursor="pointer"
          opacity={0.6}
          hoverStyle={{ backgroundColor: '#1a1a1a', opacity: 1 }}
          pressStyle={{ backgroundColor: '#222' }}
          marginLeft={4}
          onPress={() => setMobileMenuOpen(true)}
        >
          <Menu size={18} color="#06B6D4" />
        </XStack>
      </XStack>

      {/* Empty content - just show + button that opens launcher */}
      <YStack flex={1} justifyContent="center" alignItems="center" gap={16}>
        <XStack
          width={64}
          height={64}
          borderRadius={32}
          backgroundColor="rgba(6, 182, 212, 0.15)"
          borderWidth={2}
          borderColor="rgba(6, 182, 212, 0.4)"
          justifyContent="center"
          alignItems="center"
          cursor="pointer"
          hoverStyle={{
            backgroundColor: 'rgba(6, 182, 212, 0.25)',
            borderColor: 'rgba(6, 182, 212, 0.6)',
          }}
          pressStyle={{
            backgroundColor: 'rgba(6, 182, 212, 0.3)',
            scale: 0.95,
          }}
          onPress={onOpenLauncher}
        >
          <Plus size={28} color="#06B6D4" />
        </XStack>
      </YStack>
    </YStack>
  );
}
