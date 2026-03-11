/**
 * PendingApprovalsWindow - Vista centralizada de permisos pendientes
 *
 * Features:
 * - List of all pending permissions grouped by conversation
 * - Approve/deny individually or in batch
 * - View tool details and parameters
 * - Real-time updates
 */

import { Check, ChevronRight, Shield, User, X } from '@tamagui/lucide-icons';
import React, { useEffect, useState } from 'react';
import { ScrollView, TouchableOpacity, View } from 'react-native';
import { Avatar, Button, Circle, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { useChatStore } from '../../store/chatStore';
import { useTilingStore } from '../../store/tilingStore';
import type { PendingApprovalsWindowProps } from './definition';
import { AppSpinner } from '../../components/ui';

interface PendingPermission {
  requestId: string;
  channelId: string;
  channelName: string;
  agentId?: string;
  agentName?: string;
  agentAvatarUrl?: string;
  toolName: string;
  appId: string;
  input: Record<string, any>;
  messageId?: string;
  toolCallId?: string;
  timestamp: number;
}

export function PendingApprovalsWindowContent({
  windowId,
}: PendingApprovalsWindowProps & { windowId: string }) {
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connected, setConnected] = useState(false);

  const client = getTerosClient();
  const { openWindow, findWindow, focusWindow } = useTilingStore();

  // Connection status
  useEffect(() => {
    const handleConnected = () => setConnected(true);
    const handleDisconnected = () => setConnected(false);

    client.on('connected', handleConnected);
    client.on('disconnected', handleDisconnected);
    setConnected(client.isConnected());

    return () => {
      client.off('connected', handleConnected);
      client.off('disconnected', handleDisconnected);
    };
  }, []);

  // Load pending permissions when connected
  useEffect(() => {
    if (!connected) return;
    loadPendingPermissions();
  }, [connected]);

  // Listen for permission requests and responses
  useEffect(() => {
    if (!connected) return;

    const handlePermissionRequest = (data: any) => {
      console.log('[PendingApprovalsWindow] Permission request received:', data);
      const {
        requestId,
        toolName,
        appId,
        input,
        messageId,
        toolCallId,
        timestamp,
      } = data;

      // Get channelId from the event or current subscriptions
      const channelId = data.channelId;
      if (!channelId) {
        console.warn('[PendingApprovalsWindow] No channelId in permission request');
        return;
      }

      // Get channel info from chatStore
      const channel = useChatStore.getState().channels[channelId];

      setPendingPermissions((prev) => {
        // Avoid duplicates
        if (prev.some((p) => p.requestId === requestId)) {
          return prev;
        }

        return [
          ...prev,
          {
            requestId,
            channelId,
            channelName: channel?.title || 'Chat',
            agentId: channel?.agentId,
            agentName: channel?.agentName,
            agentAvatarUrl: channel?.agentAvatarUrl || undefined,
            toolName,
            appId,
            input,
            messageId,
            toolCallId,
            timestamp: timestamp || Date.now(),
          },
        ];
      });
    };

    const handlePermissionResponse = (data: any) => {
      const { requestId } = data;
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    };

    // Also listen for channel status updates to remove permissions when externalActionRequested becomes false
    const handleChannelStatus = (data: any) => {
      const { channelId, externalActionRequested } = data;
      if (externalActionRequested === false) {
        // Remove all permissions for this channel
        setPendingPermissions((prev) => prev.filter((p) => p.channelId !== channelId));
      }
    };

    client.on('tool_permission_request', handlePermissionRequest);
    client.on('permission_response', handlePermissionResponse);
    client.on('channel_status', handleChannelStatus);

    return () => {
      client.off('tool_permission_request', handlePermissionRequest);
      client.off('permission_response', handlePermissionResponse);
      client.off('channel_status', handleChannelStatus);
    };
  }, [connected]);

  const loadPendingPermissions = async () => {
    setIsLoading(true);
    try {
      // Get all channels with externalActionRequested
      const { channels } = await client.channel.list();
      const channelsWithPending = channels.filter((ch: any) => ch.externalActionRequested);

      console.log('[PendingApprovalsWindow] Channels with pending permissions:', channelsWithPending.length);

      // Subscribe to each channel to receive pending permission events
      for (const ch of channelsWithPending) {
        await client.channel.subscribe(ch.channelId);
      }

      setIsLoading(false);
    } catch (err) {
      console.error('[PendingApprovalsWindow] Error loading permissions:', err);
      setIsLoading(false);
    }
  };

  const handleApprove = async (requestId: string, appId?: string, toolName?: string) => {
    try {
      await client.grantPermission(requestId);
      // Remove from local state immediately for better UX
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    } catch (err) {
      console.error('[PendingApprovalsWindow] Error approving permission:', err);
    }
  };

  const handleDeny = async (requestId: string) => {
    try {
      await client.denyPermission(requestId);
      // Remove from local state immediately for better UX
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    } catch (err) {
      console.error('[PendingApprovalsWindow] Error denying permission:', err);
    }
  };

  const handleApproveAll = async (channelId: string) => {
    const channelPermissions = pendingPermissions.filter((p) => p.channelId === channelId);
    for (const perm of channelPermissions) {
      await handleApprove(perm.requestId);
    }
  };

  const handleOpenChat = (channelId: string, agentName?: string) => {
    const existingWindow = findWindow('chat', (props) => props.channelId === channelId);

    if (existingWindow) {
      focusWindow(existingWindow.id);
    } else {
      openWindow('chat', {
        channelId,
        agentName,
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

  // Group permissions by channel
  const groupedPermissions = pendingPermissions.reduce(
    (acc, perm) => {
      if (!acc[perm.channelId]) {
        acc[perm.channelId] = {
          channelId: perm.channelId,
          channelName: perm.channelName,
          agentName: perm.agentName,
          agentAvatarUrl: perm.agentAvatarUrl,
          permissions: [],
        };
      }
      acc[perm.channelId].permissions.push(perm);
      return acc;
    },
    {} as Record<
      string,
      {
        channelId: string;
        channelName: string;
        agentName?: string;
        agentAvatarUrl?: string;
        permissions: PendingPermission[];
      }
    >,
  );

  const groupedArray = Object.values(groupedPermissions);

  return (
    <YStack flex={1} backgroundColor="#0a0a0a">
      {/* Header */}
      <XStack
        height={40}
        paddingHorizontal={12}
        alignItems="center"
        justifyContent="space-between"
        borderBottomWidth={1}
        borderBottomColor="#1a1a1a"
      >
        <XStack gap={8} alignItems="center">
          <Shield size={16} color="#F59E0B" />
          <Text fontSize={12} fontWeight="600" color="#FAFAFA">
            Permisos pendientes
          </Text>
        </XStack>

        <XStack
          paddingHorizontal={8}
          paddingVertical={4}
          borderRadius={12}
          backgroundColor="rgba(245, 158, 11, 0.15)"
        >
          <Text fontSize={11} fontWeight="600" color="#F59E0B">
            {pendingPermissions.length}
          </Text>
        </XStack>
      </XStack>

      {/* Content */}
      {isLoading ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <AppSpinner variant="warning" />
          <Text fontSize={12} color="#666" marginTop={12}>
            Cargando permisos...
          </Text>
        </YStack>
      ) : pendingPermissions.length === 0 ? (
        <YStack flex={1} justifyContent="center" alignItems="center" padding={20}>
          <Circle size={64} backgroundColor="rgba(245, 158, 11, 0.1)" marginBottom={16}>
            <Shield size={32} color="#F59E0B" />
          </Circle>
          <Text fontSize={14} fontWeight="600" color="#FAFAFA" marginBottom={6}>
            Sin permisos pendientes
          </Text>
          <Text fontSize={12} color="#666" textAlign="center">
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
                borderColor="rgba(245, 158, 11, 0.2)"
                backgroundColor="#111"
                overflow="hidden"
              >
                {/* Channel header */}
                <XStack
                  padding={12}
                  alignItems="center"
                  gap={10}
                  backgroundColor="rgba(245, 158, 11, 0.05)"
                  borderBottomWidth={1}
                  borderBottomColor="rgba(245, 158, 11, 0.1)"
                >
                  {/* Avatar */}
                  <Circle size={36} backgroundColor="#1a1a1a" overflow="hidden">
                    {group.agentAvatarUrl ? (
                      <Avatar circular size={36}>
                        <Avatar.Image src={group.agentAvatarUrl} />
                      </Avatar>
                    ) : (
                      <User size={18} color="#555" />
                    )}
                  </Circle>

                  {/* Info */}
                  <YStack flex={1}>
                    <Text fontSize={13} fontWeight="600" color="#FAFAFA">
                      {group.agentName || 'Agente'}
                    </Text>
                    <Text fontSize={11} color="#888">
                      {group.channelName}
                    </Text>
                  </YStack>

                  {/* Badge */}
                  <XStack
                    paddingHorizontal={8}
                    paddingVertical={4}
                    borderRadius={12}
                    backgroundColor="rgba(245, 158, 11, 0.15)"
                  >
                    <Text fontSize={11} fontWeight="600" color="#F59E0B">
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
                      backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    }}
                  >
                    <ChevronRight size={16} color="#888" />
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
                      borderBottomColor="rgba(255, 255, 255, 0.05)"
                    >
                      {/* Tool name */}
                      <XStack alignItems="center" gap={8}>
                        <View
                          style={{
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            borderRadius: 4,
                            backgroundColor: 'rgba(6, 182, 212, 0.1)',
                          }}
                        >
                          <Text fontSize={11} fontWeight="600" color="#06B6D4" fontFamily="$mono">
                            {perm.toolName}
                          </Text>
                        </View>
                      </XStack>

                      {/* Parameters */}
                      {perm.input && Object.keys(perm.input).length > 0 && (
                        <YStack gap={6}>
                          <Text fontSize={10} color="#666" fontWeight="500">
                            PARAMETERS
                          </Text>
                          <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            style={{ maxHeight: 120 }}
                          >
                            <View
                              style={{
                                backgroundColor: 'rgba(0, 0, 0, 0.4)',
                                borderRadius: 6,
                                padding: 10,
                              }}
                            >
                              <Text
                                fontSize={11}
                                color="#A1A1AA"
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
                          backgroundColor="rgba(244, 63, 94, 0.12)"
                          borderWidth={1}
                          borderColor="rgba(244, 63, 94, 0.3)"
                          hoverStyle={{
                            backgroundColor: 'rgba(244, 63, 94, 0.2)',
                            borderColor: '#F43F5E',
                          }}
                          onPress={() => handleDeny(perm.requestId)}
                          icon={<X size={14} color="#F43F5E" />}
                        >
                          <Text fontSize={11} color="#F43F5E" fontWeight="600">
                            Denegar
                          </Text>
                        </Button>

                        {/* Approve */}
                        <Button
                          flex={1}
                          size="$2"
                          backgroundColor="rgba(34, 197, 94, 0.12)"
                          borderWidth={1}
                          borderColor="rgba(34, 197, 94, 0.3)"
                          hoverStyle={{
                            backgroundColor: 'rgba(34, 197, 94, 0.2)',
                            borderColor: '#22C55E',
                          }}
                          onPress={() => handleApprove(perm.requestId)}
                          icon={<Check size={14} color="#22C55E" />}
                        >
                          <Text fontSize={11} color="#22C55E" fontWeight="600">
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
                    borderTopColor="rgba(255, 255, 255, 0.05)"
                    backgroundColor="rgba(0, 0, 0, 0.2)"
                  >
                    <Button
                      flex={1}
                      size="$2"
                      backgroundColor="rgba(34, 197, 94, 0.15)"
                      borderWidth={1}
                      borderColor="rgba(34, 197, 94, 0.4)"
                      hoverStyle={{
                        backgroundColor: 'rgba(34, 197, 94, 0.25)',
                        borderColor: '#22C55E',
                      }}
                      onPress={() => handleApproveAll(group.channelId)}
                    >
                      <Text fontSize={11} color="#22C55E" fontWeight="600">
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
