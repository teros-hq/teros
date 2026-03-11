/**
 * useTabState - Shared hook for tab logic
 *
 * Extracts common logic for title, icon, color and status indicators
 * to use in DraggableTab (desktop) and MobileTab (mobile).
 */

import { useMemo } from 'react';
import { windowRegistry } from '../services/windowRegistry';
import { useChatStore } from '../store/chatStore';

export interface TabWindow {
  id: string;
  type: string;
  props: Record<string, any>;
  hasNotification?: boolean;
}

export interface TabState {
  /** Window definition from registry */
  definition: ReturnType<typeof windowRegistry.get>;
  /** Icon component */
  Icon: React.ComponentType<{ size?: number; color?: string }> | undefined;
  /** Icon color from definition */
  iconColor: string;
  /** Computed title */
  title: string;
  /** Whether to show loading spinner */
  showSpinner: boolean;
  /** Whether to show red dot (external action required) */
  showRedDot: boolean;
  /** Whether to show blue dot (unread notification) */
  showBlueDot: boolean;
  /** Whether to show lock icon (private chat) */
  showLock: boolean;
  /** Whether to show the regular icon */
  showIcon: boolean;
  /** Channel data (for chats) */
  channel: ReturnType<typeof useChatStore.getState>['channels'][string] | null;
}

export function useTabState(window: TabWindow, isActive: boolean): TabState {
  const definition = windowRegistry.get(window.type);
  const Icon = definition?.icon;
  const iconColor = definition?.color ?? '#666';

  // For chat windows, reactively subscribe to chatStore
  const channelId = window.type === 'chat' ? window.props.channelId : null;
  const channel = useChatStore((state) => (channelId ? state.channels[channelId] : null));

  // Get title
  const title = useMemo(() => {
    if (window.type === 'chat' && channel?.title) {
      return channel.title;
    }
    return definition?.getTitle(window.props) ?? 'Window';
  }, [window.type, channel?.title, definition, window.props]);

  // Status indicators for chats
  const isTyping = channel?.isTyping ?? false;
  const externalActionRequested = channel?.externalActionRequested ?? false;
  const isPrivate = (channel as any)?.isPrivate ?? false;
  const hasUnreadNotification = !isActive && (window.hasNotification ?? false);

  // Determine what to show (priority: spinner > red > blue > lock > icon)
  const showSpinner = isTyping;
  const showRedDot = !showSpinner && externalActionRequested;
  const showBlueDot = !showSpinner && !showRedDot && hasUnreadNotification;
  const showLock = !showSpinner && !showRedDot && !showBlueDot && isPrivate;
  const showIcon = !showSpinner && !showRedDot && !showBlueDot && !showLock;

  return {
    definition,
    Icon,
    iconColor,
    title,
    showSpinner,
    showRedDot,
    showBlueDot,
    showLock,
    showIcon,
    channel,
  };
}

export default useTabState;
