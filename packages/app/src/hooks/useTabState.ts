/**
 * useTabState - Shared hook for tab logic
 *
 * Extracts common logic for title, icon, color and status indicators
 * to use in DraggableTab (desktop) and MobileTab (mobile).
 */

import { useMemo } from 'react';
import { windowRegistry } from '../services/windowRegistry';
import { useChatStore } from '../store/chatStore';
import { type WindowTabMeta, useWindowTabMetaStore } from '../store/windowTabMetaStore';

export interface TabWindow {
  id: string;
  type: string;
  props: Record<string, any>;
  hasNotification?: boolean;
}

export interface TabState {
  /** Window definition from registry */
  definition: any;
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
  /** Whether to show the regular icon */
  showIcon: boolean;
  /** Live tab meta published by the window (useWindowTabMeta), if any */
  meta: WindowTabMeta | null;
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
  const meta = useWindowTabMetaStore((state) => state.meta[window.id] ?? null);

  // Get title
  const title = useMemo(() => {
    if (window.type === 'chat' && channel?.title) {
      return channel.title;
    }
    if (meta?.title) return meta.title;
    return definition?.getTitle(window.props) ?? 'Window';
  }, [window.type, channel?.title, definition, window.props, meta?.title]);

  // Status indicators for chats
  const isTyping = channel?.isTyping ?? false;
  const externalActionRequested = channel?.externalActionRequested ?? false;
  const hasUnreadNotification = !isActive && (window.hasNotification ?? false);

  // Determine what to show (priority: spinner > red > blue > icon).
  const showSpinner = isTyping;
  const showRedDot = !showSpinner && externalActionRequested;
  const showBlueDot = !showSpinner && !showRedDot && hasUnreadNotification;
  const showIcon = !showSpinner && !showRedDot && !showBlueDot;

  return {
    definition,
    Icon,
    iconColor,
    title,
    showSpinner,
    showRedDot,
    showBlueDot,
    showIcon,
    meta,
    channel,
  };
}

export default useTabState;
