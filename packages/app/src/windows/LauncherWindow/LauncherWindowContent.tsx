/**
 * Launcher Window Content
 *
 * Shows available window types that can be opened.
 * When user selects one, it replaces this launcher window with the selected type.
 */

import React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { useClickModifiers } from '../../hooks/useClickModifiers';
import { windowRegistry } from '../../services/windowRegistry';
import { useTilingStore } from '../../store/tilingStore';

interface Props {
  windowId: string;
}

export function LauncherWindowContent({ windowId }: Props) {
  const { replaceWindow, openWindow } = useTilingStore();
  const { shouldOpenInNewTab } = useClickModifiers();
  const launchers = windowRegistry.getLauncherTypes();

  const handleSelect = (type: string, e?: any) => {
    if (e && shouldOpenInNewTab(e)) {
      // Open in new tab in the same container as this launcher
      openWindow(type, {}, true, windowId);
      return;
    }
    // Replace this launcher window with the selected type
    replaceWindow(windowId, type, {});
  };

  return (
    <YStack flex={1} padding={16} backgroundColor="#0a0a0b">
      <Text
        fontSize={11}
        color="#666"
        marginBottom={12}
        fontWeight="600"
        textTransform="uppercase"
        letterSpacing={0.5}
      >
        Abrir
      </Text>

      <YStack gap={4}>
        {launchers.map((launcher) => {
          const Icon = launcher.icon;
          return (
            <XStack
              key={launcher.type}
              paddingHorizontal={12}
              paddingVertical={10}
              gap={12}
              alignItems="center"
              borderRadius={8}
              cursor="pointer"
              hoverStyle={{ backgroundColor: '#151515' }}
              pressStyle={{ backgroundColor: '#1a1a1a' }}
              onPress={(e) => handleSelect(launcher.type, e)}
            >
              <Icon size={18} color={launcher.color} />
              <Text fontSize={13} color="#e4e4e7">
                {launcher.displayName}
              </Text>
            </XStack>
          );
        })}
      </YStack>
    </YStack>
  );
}
