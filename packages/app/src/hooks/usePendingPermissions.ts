/**
 * usePendingPermissions
 *
 * Shared hook that tracks pending tool permission requests across all
 * channels. Used by both the navbar PermissionIndicator dropdown and the
 * PendingApprovalsWindow so they share a single source of truth and a
 * single set of WS subscriptions.
 *
 * Extracted from PendingApprovalsWindowContent.tsx to avoid duplicating
 * the event-listener logic in the navbar dropdown.
 */

import { useCallback, useEffect, useState } from 'react';
import { getTerosClient } from '../services/terosClientSingleton';
import { useChatStore } from '../store/chatStore';

export interface PendingPermission {
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

export function usePendingPermissions() {
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connected, setConnected] = useState(false);

  const client = getTerosClient();

  // ── Connection status ──────────────────────────────────────────────────
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
  }, [client]);

  // ── Load + subscribe on connect ────────────────────────────────────────
  useEffect(() => {
    if (!connected) return;
    loadPendingPermissions();
  }, [connected]);

  // ── Listen for permission events ───────────────────────────────────────
  useEffect(() => {
    if (!connected) return;

    const handlePermissionRequest = (data: any) => {
      const {
        requestId,
        toolName,
        appId,
        input,
        messageId,
        toolCallId,
        timestamp,
      } = data;

      const channelId = data.channelId;
      if (!channelId) return;

      const channel = useChatStore.getState().channels[channelId];

      setPendingPermissions((prev) => {
        if (prev.some((p) => p.requestId === requestId)) return prev;
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

    const handleChannelStatus = (data: any) => {
      const { channelId, externalActionRequested } = data;
      if (externalActionRequested === false) {
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
  }, [connected, client]);

  // ── Load: subscribe to channels with pending permissions ───────────────
  const loadPendingPermissions = async () => {
    setIsLoading(true);
    try {
      const { channels } = await client.channel.list();
      const channelsWithPending = channels.filter((ch: any) => ch.externalActionRequested);
      for (const ch of channelsWithPending) {
        await client.channel.subscribe(ch.channelId);
      }
      setIsLoading(false);
    } catch (err) {
      console.error('[usePendingPermissions] Error loading:', err);
      setIsLoading(false);
    }
  };

  // ── Actions ────────────────────────────────────────────────────────────
  const handleApprove = useCallback((requestId: string) => {
    client.respondToToolPermission(requestId, true);
    setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
  }, [client]);

  const handleDeny = useCallback((requestId: string) => {
    client.respondToToolPermission(requestId, false);
    setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
  }, [client]);

  const handleApproveAll = useCallback((channelId: string) => {
    setPendingPermissions((prev) => {
      const channelPerms = prev.filter((p) => p.channelId === channelId);
      for (const perm of channelPerms) {
        client.respondToToolPermission(perm.requestId, true);
      }
      return prev.filter((p) => p.channelId !== channelId);
    });
  }, [client]);

  // ── Grouped by channel (derived) ───────────────────────────────────────
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

  return {
    pendingPermissions,
    groupedArray,
    isLoading,
    connected,
    handleApprove,
    handleDeny,
    handleApproveAll,
  };
}
