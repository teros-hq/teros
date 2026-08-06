/**
 * Launcher Window Content
 *
 * Shows available window types that can be opened.
 * When user selects one, it replaces this launcher window with the selected type.
 */

import { Plus } from '@tamagui/lucide-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, XStack, YStack } from 'tamagui';
import { NewConversationModal } from '../../components/NewConversationModal';
import { useClickModifiers } from '../../hooks/useClickModifiers';
import { windowRegistry } from '../../services/windowRegistry';
import { useAuthStore } from '../../store/authStore';
import { useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors';

interface Props {
  windowId: string;
}

export function LauncherWindowContent({ windowId }: Props) {
  const { t } = useTranslation();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const { replaceWindow, openWindow } = useTilingStore();
  const { shouldOpenInNewTab } = useClickModifiers();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const userRole = useAuthStore((s) => s.user?.role);
  const isAdmin = userRole === 'admin' || userRole === 'super';
  const launchers = windowRegistry.getLauncherTypes().filter((def) => !def.adminOnly || isAdmin);
  const [showNewConversationModal, setShowNewConversationModal] = useState(false);

  const handleSelect = (type: string, e?: any) => {
    if (e && shouldOpenInNewTab(e)) {
      openWindow(type, {}, true, windowId);
      return;
    }
    replaceWindow(windowId, type, {});
  };

  const handleSelectAgent = (agent: { agentId: string; name: string; fullName: string }) => {
    openWindow(
      'chat',
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: activeWorkspaceId ?? undefined,
      },
      false,
      windowId,
    );
  };

  return (
    <YStack flex={1} padding={16} backgroundColor={c.bgPage}>

      <XStack
        paddingHorizontal={12}
        paddingVertical={10}
        gap={10}
        alignItems="center"
        borderRadius={8}
        cursor="pointer"
        marginBottom={8}
        hoverStyle={{ backgroundColor: isDark ? '#151515' : 'rgba(10,10,15,0.08)' }}
        pressStyle={{ backgroundColor: isDark ? '#1a1a1a' : 'rgba(10,10,15,0.12)' }}
        onPress={() => setShowNewConversationModal(true)}
      >
        <YStack
          width={22}
          height={22}
          borderRadius={4}
          backgroundColor={semanticColors.indigo}
          alignItems="center"
          justifyContent="center"
        >
          <Plus size={14} color="white" />
        </YStack>
        <Text fontSize={13} color={c.text2} fontWeight="500">
          {t("nav.newConversation")}
        </Text>
      </XStack>

      <YStack height={1} backgroundColor={c.border} marginBottom={8} />

      <Text
        fontSize={11}
        color="#666"
        marginBottom={8}
        fontWeight="600"
        textTransform="uppercase"
        letterSpacing={0.5}
      >
        {t("common.open")}
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
              hoverStyle={{ backgroundColor: isDark ? '#151515' : 'rgba(10,10,15,0.08)' }}
              pressStyle={{ backgroundColor: isDark ? '#1a1a1a' : 'rgba(10,10,15,0.12)' }}
              onPress={(e) => handleSelect(launcher.type, e)}
            >
              <Icon size={18} color={launcher.color} />
              <Text fontSize={13} color={c.text2}>
                {launcher.getTitle({})}
              </Text>
            </XStack>
          );
        })}
      </YStack>

      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgent}
      />
    </YStack>
  );
}
