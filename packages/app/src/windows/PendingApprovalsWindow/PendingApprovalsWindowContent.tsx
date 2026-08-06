/**
 * PendingApprovalsWindow - Vista centralizada de permisos pendientes
 *
 * Features:
 * - List of all pending permissions grouped by conversation
 * - Approve/deny individually or in batch
 * - View tool details and parameters
 * - Real-time updates
 *
 * Now uses the shared usePendingPermissions hook (same source of truth
 * as the navbar PermissionIndicator dropdown).
 */

import { ChevronRight, Shield, User } from '@tamagui/lucide-icons';
import React from 'react';
import { ScrollView, TouchableOpacity, View } from 'react-native';
import { Avatar, Button, Circle, Text, XStack, YStack } from 'tamagui';
import { useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import type { PendingApprovalsWindowProps } from './definition';
import { AppSpinner } from '../../components/ui';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface, controlsBar, indicators } from '../../components/mca/primitives/colors';
import { usePendingPermissions } from '../../hooks/usePendingPermissions';

export function PendingApprovalsWindowContent({
  windowId,
}: PendingApprovalsWindowProps & { windowId: string }) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  const {
    pendingPermissions,
    groupedArray,
    isLoading,
    handleApprove,
    handleDeny,
    handleApproveAll,
  } = usePendingPermissions();

  const { openWindow, findWindow, focusWindow } = useTilingStore();

  const handleOpenChat = (channelId: string, agentName?: string) => {
    const existingWindow = findWindow('chat', (props) => props.channelId === channelId);

    if (existingWindow) {
      focusWindow(existingWindow.id);
    } else {
      openWindow('chat', {
        channelId,
        agentName,
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      }, false, windowId);
    }
  };

  const formatInput = (input: Record<string, any>): string => {
    try {
      const formatted = JSON.stringify(
        input,
        (key, value) => {
          if (typeof value === 'string' && value.length > 200) {
            return value.substring(0, 200) + '...';
          }
          return value;
        },
        2,
      );
      return formatted;
    } catch {
      return String(input);
    }
  };

  // ── Theme-adaptive tint helpers ──────────────────────────────────────────────
  const subtleBorder = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  const amberTint = (alpha: number) =>
    isDark ? `rgba(245,158,11,${alpha})` : `rgba(245,158,11,${(alpha * 0.8).toFixed(2)})`;

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Header */}
      <XStack
        height={40}
        paddingHorizontal={12}
        alignItems="center"
        justifyContent="space-between"
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        <XStack gap={8} alignItems="center">
          <Shield size={16} color={semanticColors.amber} />
          <Text fontSize={12} fontWeight="600" color={c.text}>
            Permisos pendientes
          </Text>
        </XStack>

        <XStack
          paddingHorizontal={8}
          paddingVertical={4}
          borderRadius={12}
          backgroundColor={indicators.risk.bg}
        >
          <Text fontSize={11} fontWeight="600" color={semanticColors.amber}>
            {pendingPermissions.length}
          </Text>
        </XStack>
      </XStack>

      {/* Content */}
      {isLoading ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <AppSpinner variant="warning" />
          <Text fontSize={12} color={c.text3} marginTop={12}>
            Cargando permisos...
          </Text>
        </YStack>
      ) : pendingPermissions.length === 0 ? (
        <YStack flex={1} justifyContent="center" alignItems="center" padding={20}>
          <Circle size={64} backgroundColor={amberTint(0.1)} marginBottom={16}>
            <Shield size={32} color={semanticColors.amber} />
          </Circle>
          <Text fontSize={14} fontWeight="600" color={c.text} marginBottom={6}>
            Sin permisos pendientes
          </Text>
          <Text fontSize={12} color={c.text3} textAlign="center">
            When an agent needs permissions,{'\n'}they will appear here for approval
          </Text>
        </YStack>
      ) : (
        <ScrollView style={{ flex: 1 }}>
          <YStack padding={12} gap={12}>
            {groupedArray.map((group) => (
              <YStack
                key={group.channelId}
                borderRadius={8}
                borderWidth={1}
                borderColor={indicators.risk.border}
                backgroundColor={c.bgCard}
                overflow="hidden"
              >
                {/* Channel header */}
                <XStack
                  padding={12}
                  alignItems="center"
                  gap={10}
                  backgroundColor={amberTint(0.05)}
                  borderBottomWidth={1}
                  borderBottomColor={amberTint(0.1)}
                >
                  {/* Avatar */}
                  <Circle size={36} backgroundColor={c.bgCardHover} overflow="hidden">
                    {group.agentAvatarUrl ? (
                      <Avatar circular size={36}>
                        <Avatar.Image src={group.agentAvatarUrl} />
                      </Avatar>
                    ) : (
                      <User size={18} color={c.text3} />
                    )}
                  </Circle>

                  {/* Info */}
                  <YStack flex={1}>
                    <Text fontSize={13} fontWeight="600" color={c.text}>
                      {group.agentName || 'Agente'}
                    </Text>
                    <Text fontSize={11} color={c.text2}>
                      {group.channelName}
                    </Text>
                  </YStack>

                  {/* Badge */}
                  <XStack
                    paddingHorizontal={8}
                    paddingVertical={4}
                    borderRadius={12}
                    backgroundColor={indicators.risk.bg}
                  >
                    <Text fontSize={11} fontWeight="600" color={semanticColors.amber}>
                      {group.permissions.length}
                    </Text>
                  </XStack>

                  {/* Open chat button */}
                  <TouchableOpacity
                    onPress={() => handleOpenChat(group.channelId, group.agentName)}
                    activeOpacity={0.7}
                    style={{
                      padding: 6,
                      borderRadius: 6,
                      backgroundColor: subtleBorder,
                    }}
                  >
                    <ChevronRight size={16} color={c.text2} />
                  </TouchableOpacity>
                </XStack>

                {/* Permissions list */}
                <YStack>
                  {group.permissions.map((perm, idx) => (
                    <YStack
                      key={perm.requestId}
                      padding={12}
                      gap={10}
                      borderBottomWidth={idx < group.permissions.length - 1 ? 1 : 0}
                      borderBottomColor={subtleBorder}
                    >
                      {/* Tool name */}
                      <XStack alignItems="center" gap={8}>
                        <View
                          style={{
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            borderRadius: 4,
                            backgroundColor: semanticColors.indigoGlow,
                          }}
                        >
                          <Text fontSize={11} fontWeight="600" color={semanticColors.indigo} fontFamily="$mono">
                            {perm.toolName}
                          </Text>
                        </View>
                      </XStack>

                      {/* Parameters */}
                      {perm.input && Object.keys(perm.input).length > 0 && (
                        <YStack gap={6}>
                          <Text fontSize={10} color={c.text3} fontWeight="500">
                            PARAMETERS
                          </Text>
                          <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            style={{ maxHeight: 120 }}
                          >
                            <View
                              style={{
                                backgroundColor: isDark ? 'rgba(0,0,0,0.4)' : c.bgInner,
                                borderRadius: 6,
                                padding: 10,
                              }}
                            >
                              <Text
                                fontSize={11}
                                color={c.text2}
                                fontFamily="$mono"
                                style={{ lineHeight: 16 }}
                              >
                                {formatInput(perm.input)}
                              </Text>
                            </View>
                          </ScrollView>
                        </YStack>
                      )}

                      {/* Actions */}
                      <XStack gap={8} marginTop={4}>
                        {/* Deny */}
                        <Button
                          flex={1}
                          size="$2"
                          backgroundColor={controlsBar.deny.bg}
                          borderWidth={1}
                          borderColor={controlsBar.deny.border}
                          hoverStyle={{
                            backgroundColor: isDark
                              ? 'rgba(239,68,68,0.2)'
                              : 'rgba(239,68,68,0.15)',
                            borderColor: semanticColors.red,
                          }}
                          onPress={() => handleDeny(perm.requestId)}
                        >
                          <Text fontSize={11} color={controlsBar.deny.fg} fontWeight="600">
                            Denegar
                          </Text>
                        </Button>

                        {/* Approve */}
                        <Button
                          flex={1}
                          size="$2"
                          backgroundColor={controlsBar.allow.bg}
                          borderWidth={1}
                          borderColor={controlsBar.allow.border}
                          hoverStyle={{
                            backgroundColor: isDark
                              ? 'rgba(34,197,94,0.2)'
                              : 'rgba(34,197,94,0.15)',
                            borderColor: semanticColors.green,
                          }}
                          onPress={() => handleApprove(perm.requestId)}
                        >
                          <Text fontSize={11} color={controlsBar.allow.fg} fontWeight="600">
                            Aprobar
                          </Text>
                        </Button>
                      </XStack>
                    </YStack>
                  ))}
                </YStack>

                {/* Approve all button */}
                {group.permissions.length > 1 && (
                  <XStack
                    padding={10}
                    borderTopWidth={1}
                    borderTopColor={subtleBorder}
                    backgroundColor={isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.03)'}
                  >
                    <Button
                      flex={1}
                      size="$2"
                      backgroundColor={controlsBar.allow.bg}
                      borderWidth={1}
                      borderColor={controlsBar.allow.border}
                      hoverStyle={{
                        backgroundColor: isDark
                          ? 'rgba(34,197,94,0.25)'
                          : 'rgba(34,197,94,0.18)',
                        borderColor: semanticColors.green,
                      }}
                      onPress={() => handleApproveAll(group.channelId)}
                    >
                      <Text fontSize={11} color={controlsBar.allow.fg} fontWeight="600">
                        Aprobar todas ({group.permissions.length})
                      </Text>
                    </Button>
                  </XStack>
                )}
              </YStack>
            ))}
          </YStack>
        </ScrollView>
      )}
    </YStack>
  );
}
