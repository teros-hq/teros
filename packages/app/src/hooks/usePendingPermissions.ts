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
 *
 * Each entry carries what the tool's own card needs (PERMW-REQ-1/2): the sheet
 * and the window build a `ToolCall` from it and render it with `ToolCallBlock`,
 * never fetching the channel's messages (PERMW-NFR-1). A decision taken on any
 * surface reaches the others through the existing events: the request leaves
 * the list when its tool card's status moves out of `pending_permission`
 * (`tool_status_update` / `tool_call_complete` chunks).
 */

import { useCallback, useEffect, useState } from 'react';
import { getTerosClient } from '../services/terosClientSingleton';
import { useChatStore } from '../store/chatStore';

/** @spec PERMW-REQ-2 */
export interface PendingPermission {
  requestId: string;
  channelId: string;
  channelName: string;
  agentId?: string;
  agentName?: string;
  agentAvatarUrl?: string;
  toolName: string;
  appId: string;
  /** Catalog MCA id — picks the tool's own renderer and its icon. */
  mcaId?: string;
  /** Manifest irreversibility flag — badge on the card, excluded from "Allow all". */
  irreversible?: boolean;
  input: Record<string, any>;
  messageId?: string;
  toolCallId?: string;
  timestamp: number;
}

/** @spec PERMW-REQ-1 @spec PERMW-NFR-1 */
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
        mcaId,
        irreversible,
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
            ...(mcaId ? { mcaId } : {}),
            ...(irreversible ? { irreversible: true } : {}),
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

    // PERMW-NFR-1: a decision taken in the chat (or "Always allow" resolving
    // every request of a tool) settles the tool card through the chunks the
    // chat already applies; a card leaving `pending_permission` leaves the list.
    const handleMessageChunk = (data: any) => {
      const { chunkType, channelId, toolCallId, toolStatus } = data ?? {};
      if (!toolCallId) return;
      const settled =
        chunkType === 'tool_call_complete' ||
        (chunkType === 'tool_status_update' && toolStatus !== 'pending_permission');
      if (!settled) return;
      setPendingPermissions((prev) =>
        prev.some((p) => p.toolCallId === toolCallId && p.channelId === channelId)
          ? prev.filter((p) => !(p.toolCallId === toolCallId && p.channelId === channelId))
          : prev,
      );
    };

    client.on('tool_permission_request', handlePermissionRequest);
    client.on('permission_response', handlePermissionResponse);
    client.on('channel_status', handleChannelStatus);
    client.on('message_chunk', handleMessageChunk);

    return () => {
      client.off('tool_permission_request', handlePermissionRequest);
      client.off('permission_response', handlePermissionResponse);
      client.off('channel_status', handleChannelStatus);
      client.off('message_chunk', handleMessageChunk);
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
  };
}
