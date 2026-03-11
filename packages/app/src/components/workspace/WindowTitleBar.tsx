/**
 * WindowTitleBar - Title bar for floating windows
 */

import { Maximize2, Minimize2, Minus, Square, X } from '@tamagui/lucide-icons';
import type React from 'react';
import { Text, XStack } from 'tamagui';
import { windowRegistry } from '../../services/windowRegistry';
import { type FloatingWindow, useWorkspaceStore } from '../../store/workspaceStore';

interface Props {
  window: FloatingWindow;
  isActive: boolean;
  /** Props del hook useWindowDrag para el handle */
  dragHandleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    onTouchStart: (e: React.TouchEvent) => void;
    style: { cursor: string; userSelect: string };
  };
}

export function WindowTitleBar({ window, isActive, dragHandleProps }: Props) {
  const { minimizeWindow, maximizeWindow, restoreWindow, closeWindow, dockWindow } =
    useWorkspaceStore();
  const definition = windowRegistry.get(window.type);

  const Icon = definition?.icon;
  const title = definition?.getTitle(window.props) ?? 'Window';
  const subtitle = definition?.getSubtitle?.(window.props);

  const handleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (definition?.capabilities.canMinimize) {
      minimizeWindow(window.id);
    }
  };

  const handleMaximize = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (definition?.capabilities.canMaximize) {
      if (window.isMaximized) {
        restoreWindow(window.id);
      } else {
        maximizeWindow(window.id);
      }
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (definition?.capabilities.canClose) {
      closeWindow(window.id);
    }
  };

  const handleDoubleClick = () => {
    // Double click en title bar = maximize/restore
    if (definition?.capabilities.canMaximize) {
      if (window.isMaximized) {
        restoreWindow(window.id);
      } else {
        maximizeWindow(window.id);
      }
    }
  };

  return (
    <XStack
      height={36}
      backgroundColor={isActive ? '$gray3' : '$gray2'}
      borderBottomWidth={1}
      borderBottomColor="$gray5"
      alignItems="center"
      paddingLeft="$3"
      paddingRight="$1"
      gap="$2"
      {...dragHandleProps}
      onDoubleClick={handleDoubleClick}
    >
      {/* Icon */}
      {Icon && <Icon size={14} color={isActive ? '$cyan10' : '$gray9'} />}

      {/* Title */}
      <XStack flex={1} alignItems="center" gap="$2">
        <Text
          fontSize={13}
          fontWeight="500"
          color={isActive ? '$gray12' : '$gray10'}
          numberOfLines={1}
        >
          {title}
        </Text>

        {subtitle && (
          <Text fontSize={11} color="$gray9" numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </XStack>

      {/* Notification indicator */}
      {window.hasNotification && (
        <XStack width={8} height={8} borderRadius={4} backgroundColor="$cyan10" />
      )}

      {/* Window controls */}
      <XStack gap={0}>
        {/* Minimize */}
        {definition?.capabilities.canMinimize && (
          <XStack
            width={32}
            height={28}
            justifyContent="center"
            alignItems="center"
            hoverStyle={{ backgroundColor: '$gray4' }}
            pressStyle={{ backgroundColor: '$gray5' }}
            onPress={handleMinimize}
          >
            <Minus size={14} color="$gray10" />
          </XStack>
        )}

        {/* Maximize/Restore */}
        {definition?.capabilities.canMaximize && (
          <XStack
            width={32}
            height={28}
            justifyContent="center"
            alignItems="center"
            hoverStyle={{ backgroundColor: '$gray4' }}
            pressStyle={{ backgroundColor: '$gray5' }}
            onPress={handleMaximize}
          >
            {window.isMaximized ? (
              <Minimize2 size={12} color="$gray10" />
            ) : (
              <Maximize2 size={12} color="$gray10" />
            )}
          </XStack>
        )}

        {/* Close */}
        {definition?.capabilities.canClose && (
          <XStack
            width={32}
            height={28}
            justifyContent="center"
            alignItems="center"
            hoverStyle={{ backgroundColor: '$red9' }}
            pressStyle={{ backgroundColor: '$red10' }}
            borderTopRightRadius="$2"
            onPress={handleClose}
          >
            <X size={14} color="$gray10" />
          </XStack>
        )}
      </XStack>
    </XStack>
  );
}
