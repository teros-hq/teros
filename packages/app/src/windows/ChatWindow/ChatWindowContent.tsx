/**
 * ChatWindowContent - Wrapper del ChatView para el sistema de ventanas
 *
 * Este componente:
 * - Envuelve ChatView para usarlo dentro del WindowManager
 * - Handles notifications when the window is not active
 * - Syncs the title with the tiling store
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { ChatView } from '../../components/chat/ChatView';
import { VoiceTranscriptView } from '../../components/voice/VoiceTranscriptView';
import { useChatStore } from '../../store/chatStore';
import type { LayoutNode } from '../../store/tilingStore';
import { useTilingStore } from '../../store/tilingStore';
import type { ChatWindowProps } from './definition';

interface Props extends ChatWindowProps {
  windowId: string;
  transport?: string;
}

// Helper para encontrar container que contiene una ventana
function findContainerWithWindow(node: LayoutNode | null, windowId: string): any {
  if (!node) return null;
  if (node.type === 'container') {
    return node.windowIds.includes(windowId) ? node : null;
  }
  if (node.type === 'split') {
    return (
      findContainerWithWindow(node.first, windowId) ||
      findContainerWithWindow(node.second, windowId)
    );
  }
  return null;
}

export function ChatWindowContent({ windowId, channelId, agentId, agentName, workspaceId, transport }: Props) {
  // Use specific selectors to avoid unnecessary re-renders
  const updateWindowProps = useTilingStore((state) => state.updateWindowProps);
  const setWindowNotification = useTilingStore((state) => state.setWindowNotification);
  const clearWindowNotification = useTilingStore((state) => state.clearWindowNotification);

  // Selector for hasNotification of this specific window
  const hasNotification = useTilingStore(
    useCallback((state) => state.windows[windowId]?.hasNotification ?? false, [windowId]),
  );

  // Selector to determine if the window is active
  const isActive = useTilingStore(
    useCallback(
      (state) => {
        const layout = state.layout;
        if (!layout) return false;
        const container = findContainerWithWindow(layout, windowId);
        return container?.activeWindowId === windowId;
      },
      [windowId],
    ),
  );

  // Ref to avoid calling clearWindowNotification multiple times
  const clearingNotification = useRef(false);

  // Cuando se crea el canal (primer mensaje en draft), actualizar props y guardar inmediatamente
  const handleChannelCreated = (newChannelId: string) => {
    console.log('[ChatWindowContent] Channel created, updating window props:', {
      windowId,
      newChannelId,
    });
    updateWindowProps(windowId, { channelId: newChannelId });

    // Force immediate save since channel creation is critical
    // (auto-save has a 1s delay that could be lost if the page reloads)
    useTilingStore.getState().saveState();
  };

  // When the title changes, the tab updates automatically
  // porque DraggableTab se suscribe al chatStore
  const handleTitleChange = (newTitle: string) => {
    // We don't need to do anything here, the title is obtained reactively
  };

  // Escuchar mensajes nuevos para notificaciones
  useEffect(() => {
    if (!channelId) return;

    const unsubscribe = useChatStore.subscribe((state, prevState) => {
      const messages = state.channelMessages[channelId] || [];
      const prevMessages = prevState.channelMessages[channelId] || [];

      // Si hay mensajes nuevos
      if (messages.length > prevMessages.length) {
        // Obtener el estado actual del tiling store
        const tilingState = useTilingStore.getState();
        const currentWindow = tilingState.windows[windowId];

        if (!currentWindow) return;

        // Check if the window is active
        const container = findContainerWithWindow(tilingState.layout, windowId);
        const currentIsActive = container?.activeWindowId === windowId;

        // If the window is not active, show notification
        if (!currentIsActive) {
          const currentCount = currentWindow.notificationCount || 0;
          setWindowNotification(windowId, true, currentCount + 1);
        }
      }
    });

    return unsubscribe;
  }, [channelId, windowId, setWindowNotification]);

  // Clear notification when the window becomes active
  useEffect(() => {
    // Only clear if active, has notification, and we're not already clearing
    if (isActive && hasNotification && !clearingNotification.current) {
      clearingNotification.current = true;
      clearWindowNotification(windowId);
      // Reset after a tick to allow future cleanups
      requestAnimationFrame(() => {
        clearingNotification.current = false;
      });
    }
  }, [isActive, hasNotification, windowId, clearWindowNotification]);

  // Voice channels get a dedicated transcript view
  if (transport === 'voice' && channelId) {
    return (
      <VoiceTranscriptView
        channelId={channelId}
        agentId={agentId}
        agentName={agentName}
      />
    );
  }

  return (
    <ChatView
      channelId={channelId}
      agentId={agentId}
      workspaceId={workspaceId}
      onChannelCreated={handleChannelCreated}
      onTitleChange={handleTitleChange}
      showHeader={true}
      bottomInset={0}
    />
  );
}
