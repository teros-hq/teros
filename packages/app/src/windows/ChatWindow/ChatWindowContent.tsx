/**
 * ChatWindowContent - Wrapper del ChatView para el sistema de ventanas
 *
 * Este componente:
 * - Envuelve ChatView para usarlo dentro del WindowManager
 * - Handles notifications when the window is not active
 * - Syncs the title with the tiling store
 */

import React, { useCallback, useEffect, useRef } from "react"
import { ChatView } from "../../components/chat/ChatView"
import type { LayoutNode } from "../../store/tilingStore"
import { useTilingStore } from "../../store/tilingStore"
import type { ChatWindowProps } from "./definition"

interface Props extends ChatWindowProps {
  windowId: string
}

// Helper para encontrar container que contiene una ventana
function findContainerWithWindow(node: LayoutNode | null, windowId: string): any {
  if (!node) return null
  if (node.type === "container") {
    return node.windowIds.includes(windowId) ? node : null
  }
  if (node.type === "split") {
    return (
      findContainerWithWindow(node.first, windowId) ||
      findContainerWithWindow(node.second, windowId)
    )
  }
  return null
}

export function ChatWindowContent({
  windowId,
  channelId,
  agentId,
  agentName,
  workspaceId,
  initialDraft,
}: Props) {
  // Use specific selectors to avoid unnecessary re-renders
  const updateWindowProps = useTilingStore((state) => state.updateWindowProps)
  const clearWindowNotification = useTilingStore((state) => state.clearWindowNotification)

  // Selector for hasNotification of this specific window
  const hasNotification = useTilingStore(
    useCallback((state) => state.windows[windowId]?.hasNotification ?? false, [windowId]),
  )

  // Selector to determine if the window is active
  const isActive = useTilingStore(
    useCallback(
      (state) => {
        const layout = (state as any).layout
        if (!layout) return false
        const container = findContainerWithWindow(layout, windowId)
        return container?.activeWindowId === windowId
      },
      [windowId],
    ),
  )

  // Ref to avoid calling clearWindowNotification multiple times
  const clearingNotification = useRef(false)

  // Cuando se crea el canal (primer mensaje en draft), actualizar props y guardar inmediatamente
  const handleChannelCreated = (newChannelId: string) => {
    console.log("[ChatWindowContent] Channel created, updating window props:", {
      windowId,
      newChannelId,
    })
    updateWindowProps(windowId, { channelId: newChannelId })

    // Force immediate save since channel creation is critical
    // (auto-save has a 1s delay that could be lost if the page reloads)
    useTilingStore.getState().persistToStorage()
  }

  // When the title changes, the tab updates automatically
  // porque DraggableTab se suscribe al chatStore
  const handleTitleChange = (newTitle: string) => {
    // We don't need to do anything here, the title is obtained reactively
  }

  // Clear notification when the window becomes active
  useEffect(() => {
    // Only clear if active, has notification, and we're not already clearing
    if (isActive && hasNotification && !clearingNotification.current) {
      clearingNotification.current = true
      clearWindowNotification(windowId)
      // Reset after a tick to allow future cleanups
      requestAnimationFrame(() => {
        clearingNotification.current = false
      })
    }
  }, [isActive, hasNotification, windowId, clearWindowNotification])

  return (
    <ChatView
      channelId={channelId}
      agentId={agentId}
      workspaceId={workspaceId}
      onChannelCreated={handleChannelCreated}
      onTitleChange={handleTitleChange}
      showHeader={true}
      bottomInset={0}
      windowId={windowId}
      initialDraft={initialDraft}
    />
  )
}
