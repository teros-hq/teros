/**
 * Chat unread badges — one store-level watcher.
 *
 * Each mounted ChatWindowContent used to subscribe to the chat store itself to
 * raise its window's badge, which cannot work for a hibernated tab (TABH) and
 * cost one subscription per chat on every streamed token. This watcher is
 * installed once by the workspace layout and raises the badge of any chat
 * window of the active desktop that is not its pane's active tab.
 *
 * @spec TABH-REQ-5
 */

import { useChatStore } from "../store/chatStore"
import { type LayoutNode, useTilingStore } from "../store/tilingStore"

function activeWindowIds(layout: LayoutNode | null, out: Set<string>): Set<string> {
  if (!layout) return out
  if (layout.type === "container") {
    if (layout.activeWindowId) out.add(layout.activeWindowId)
    return out
  }
  activeWindowIds(layout.first, out)
  activeWindowIds(layout.second, out)
  return out
}

/** Install the watcher; returns the unsubscribe. */
export function installChatNotifications(): () => void {
  return useChatStore.subscribe((state, prev) => {
    if (state.channelMessages === prev.channelMessages) return

    const grown: string[] = []
    for (const channelId of Object.keys(state.channelMessages)) {
      const now = state.channelMessages[channelId]
      const before = prev.channelMessages[channelId]
      if (now !== before && now.length > (before?.length ?? 0)) grown.push(channelId)
    }
    if (grown.length === 0) return

    const tiling = useTilingStore.getState()
    const layout = tiling.desktops[tiling.activeDesktopIndex]?.layout ?? null
    const active = activeWindowIds(layout, new Set())

    for (const win of Object.values(tiling.windows)) {
      if (win.type !== "chat" || win.desktopIndex !== tiling.activeDesktopIndex) continue
      const channelId = win.props.channelId as string | undefined
      if (!channelId || !grown.includes(channelId) || active.has(win.id)) continue
      tiling.setWindowNotification(win.id, true, (win.notificationCount || 0) + 1)
    }
  })
}
