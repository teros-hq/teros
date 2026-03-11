/**
 * MinimizedBar - Barra que muestra ventanas minimizadas
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack } from 'tamagui';
import { windowRegistry } from '../../services/windowRegistry';
import { useWorkspaceStore } from '../../store/workspaceStore';

interface Props {
  /** IDs de las ventanas minimizadas */
  windowIds: string[];
}

export function MinimizedBar({ windowIds }: Props) {
  const { windows, restoreWindow } = useWorkspaceStore();

  if (windowIds.length === 0) {
    return null;
  }

  return (
    <XStack
      position="absolute"
      bottom={0}
      left={0}
      right={0}
      height={40}
      backgroundColor="$gray2"
      borderTopWidth={1}
      borderTopColor="$gray5"
      paddingHorizontal="$2"
      alignItems="center"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, alignItems: 'center' }}
      >
        {windowIds.map((windowId) => {
          const window = windows[windowId];
          if (!window) return null;

          const definition = windowRegistry.get(window.type);
          const Icon = definition?.icon;
          const title = definition?.getTitle(window.props) ?? 'Window';

          return (
            <XStack
              key={windowId}
              height={32}
              paddingHorizontal="$3"
              gap="$2"
              alignItems="center"
              backgroundColor="$gray3"
              borderRadius="$2"
              borderWidth={1}
              borderColor="$gray5"
              cursor="pointer"
              hoverStyle={{ backgroundColor: '$gray4', borderColor: '$gray6' }}
              pressStyle={{ backgroundColor: '$gray5' }}
              onPress={() => restoreWindow(windowId)}
            >
              {Icon && <Icon size={14} color="$gray10" />}
              <Text fontSize={12} color="$gray11" numberOfLines={1} maxWidth={120}>
                {title}
              </Text>

              {/* Notification indicator */}
              {window.hasNotification && (
                <XStack width={8} height={8} borderRadius={4} backgroundColor="$cyan10" />
              )}
            </XStack>
          );
        })}
      </ScrollView>
    </XStack>
  );
}
