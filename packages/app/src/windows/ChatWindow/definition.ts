/**
 * Chat Window Type Definition
 *
 * Chat window type definition for agent conversations.
 */

import { MessageCircle } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { useChatStore } from '../../store/chatStore';
import { ChatWindowContent } from './ChatWindowContent';

// ============================================
// PROPS
// ============================================

export interface ChatWindowProps {
  /** Channel ID — undefined for new chat (draft) */
  channelId?: string;
  /** Agent ID - to create a new chat with a specific agent */
  agentId?: string;
  /** Agent name - to show in the title while the channel is being created */
  agentName?: string;
  /** Workspace ID - if chat belongs to a workspace */
  workspaceId?: string;
}

// ============================================
// DEFINITION
// ============================================

export const chatWindowDefinition: WindowTypeDefinition<ChatWindowProps> = {
  type: 'chat',
  displayName: 'Chat',
  icon: MessageCircle,
  color: '#5E6AD2',
  component: ChatWindowContent,

  defaultSize: { width: 500, height: 650 },
  minSize: { width: 350, height: 400 },

  // Deduplicate by channelId
  getKey: (props) => props.channelId,

  getTitle: (props) => {
    // If there's a channelId, look up the title in the store
    if (props.channelId) {
      const channel = useChatStore.getState().channels[props.channelId];
      if (channel?.title) {
        return channel.title;
      }
    }

    // If it's a new chat with an agent, show the agent's name
    if (props.agentName) {
      return i18n.t("conversation.chatWith", { name: props.agentName });
    }

    return i18n.t("conversation.newChat");
  },

  getSubtitle: (props) => {
    if (!props.channelId) return undefined;

    const channel = useChatStore.getState().channels[props.channelId];
    if (!channel) return undefined;

    // Show "AgentName · modelString" format
    if (channel.modelString) {
      return `${channel.agentName} · ${channel.modelString}`;
    }

    return channel.agentName;
  },

  serialize: (props) => ({
    channelId: props.channelId,
    agentId: props.agentId,
    agentName: props.agentName,
    workspaceId: props.workspaceId,
  }),

  deserialize: (data) => ({
    channelId: data.channelId as string | undefined,
    agentId: data.agentId as string | undefined,
    agentName: data.agentName as string | undefined,
    workspaceId: data.workspaceId as string | undefined,
  }),

  onFocus: (_windowId, _props) => {
    // Clear unread message notifications when focused
    // This is handled in the component
  },
};
