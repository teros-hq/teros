/**
 * Chat Store - Messages and channels management with normalized data structure
 *
 * Benefits of normalization:
 * - No duplicate messages
 * - Easy updates by ID
 * - Efficient lookups
 * - Better performance with large datasets
 */

import { create } from "zustand"
import type { MessageContent, ToolCall } from "../components/MessageBubble"

/** Sender info - who actually sent this message */
export interface MessageSenderInfo {
  type: "user" | "agent"
  id: string
  name: string
  avatarUrl?: string
}

export interface Message {
  id: string
  channelId: string
  content: MessageContent
  sender: "user" | "agent" | "system"
  timestamp: Date
  isStreaming?: boolean

  /**
   * Detailed sender info - used to show avatar when sender differs from current user.
   * For agent-to-agent communication or multi-user scenarios.
   */
  senderInfo?: MessageSenderInfo

  // Streaming-only fields (NOT persisted, used only during live streaming)
  toolCalls?: ToolCall[]
  text?: string // For showing text in real-time before final content

  // Message delivery status (for user messages)
  status?: "sending" | "sent" | "failed"

  // Retry data - preserved for failed messages to allow retry
  retryData?: {
    // For voice messages
    audioData?: string // Base64 audio data
    audioMimeType?: string
    audioDuration?: number
    // For text messages
    text?: string
  }
}

export interface Channel {
  channelId: string
  title: string
  agentId: string
  agentName: string
  agentAvatarUrl: string | null
  modelString?: string
  modelName?: string
  providerName?: string
  isTyping: boolean
  isRenaming: boolean
  isAutonaming: boolean
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
  /** An external action has been requested (to a human or another agent) */
  externalActionRequested?: boolean
  /** Private channel - hidden from lists/search, deleted on close */
  isPrivate?: boolean
}

interface ChatState {
  // ========================================
  // NORMALIZED STATE
  // ========================================

  // Messages indexed by messageId for O(1) lookups
  messages: Record<string, Message>

  // Channels indexed by channelId
  channels: Record<string, Channel>

  // Message IDs per channel (ordered chronologically)
  channelMessages: Record<string, string[]>

  // ========================================
  // ACTIONS - MESSAGES
  // ========================================

  /**
   * Add or update a message (used for both new and final messages).
   * Appends to the end of the channel list (newest messages).
   * Triggers head-eviction to keep the window bounded.
   */
  upsertMessage: (message: Message, isHistorical?: boolean) => void

  /**
   * Prepend a batch of older messages to the beginning of a channel's list
   * in a single atomic update (no per-message sorts or re-renders).
   * Evicts from the tail to keep the window bounded.
   * Returns how many messages were actually prepended (0 if all duplicates).
   */
  prependMessages: (channelId: string, messages: Message[]) => number

  /**
   * Update specific fields of a message
   */
  updateMessage: (messageId: string, updates: Partial<Message>) => void

  /**
   * Update message ID (used when backend returns real ID for optimistic message)
   * Removes old message and adds it with new ID
   */
  updateMessageId: (oldId: string, newId: string, channelId: string) => void

  /**
   * Delete a message
   */
  deleteMessage: (messageId: string, channelId: string) => void

  /**
   * Clear all messages for a channel
   */
  clearChannelMessages: (channelId: string) => void

  // ========================================
  // ACTIONS - STREAMING
  // ========================================

  /**
   * Append text chunk to a streaming message
   * Creates message if it doesn't exist
   */
  appendTextChunk: (messageId: string, channelId: string, text: string) => void

  /**
   * Add a tool call to a message
   * Creates message if it doesn't exist
   */
  addToolCall: (messageId: string, channelId: string, toolCall: ToolCall) => void

  /**
   * Update a specific tool call within a message
   */
  updateToolCall: (messageId: string, toolCallId: string, updates: Partial<ToolCall>) => void

  /**
   * Mark streaming message as complete
   */
  markMessageComplete: (messageId: string) => void

  // ========================================
  // ACTIONS - CHANNELS
  // ========================================

  /**
   * Add or update a channel
   */
  setChannel: (channel: Channel) => void

  /**
   * Update specific fields of a channel
   */
  updateChannel: (channelId: string, updates: Partial<Channel>) => void

  /**
   * Set typing indicator for a channel
   */
  setTyping: (channelId: string, isTyping: boolean) => void

  /**
   * Set renaming state for a channel
   */
  setRenaming: (channelId: string, isRenaming: boolean) => void

  /**
   * Set autonaming state for a channel
   */
  setAutonaming: (channelId: string, isAutonaming: boolean) => void

  /**
   * Delete a channel and all its messages
   */
  deleteChannel: (channelId: string) => void

  // ========================================
  // SELECTORS (COMPUTED)
  // ========================================

  /**
   * Get all messages for a channel (ordered by timestamp)
   */
  getChannelMessages: (channelId: string) => Message[]

  /**
   * Get a specific channel
   */
  getChannel: (channelId: string) => Channel | undefined

  /**
   * Get a specific message
   */
  getMessage: (messageId: string) => Message | undefined

  /**
   * Get all channels (for conversation list)
   */
  getAllChannels: () => Channel[]
}

// Constant empty array to avoid creating new arrays on every selector call
const EMPTY_ARRAY: string[] = []

/**
 * Window size: max messages kept in memory per channel at any time.
 * When the window slides, this many are kept and the rest evicted.
 */
const WINDOW_SIZE = 100

/**
 * Evict messages from the TAIL (newest end) of a channel's list.
 * Used after prepending older messages so memory stays bounded.
 * Returns updated state objects, or null if no eviction needed.
 */
function evictTail(
  channelId: string,
  messages: Record<string, Message>,
  channelMessages: Record<string, string[]>,
): { messages: Record<string, Message>; channelMessages: Record<string, string[]> } | null {
  const msgIds = channelMessages[channelId]
  if (!msgIds || msgIds.length <= WINDOW_SIZE) return null

  const idsToKeep = msgIds.slice(0, WINDOW_SIZE)
  const idsToRemove = msgIds.slice(WINDOW_SIZE)

  const newMessages = { ...messages }
  idsToRemove.forEach((id) => delete newMessages[id])

  return {
    messages: newMessages,
    channelMessages: { ...channelMessages, [channelId]: idsToKeep },
  }
}

/**
 * Evict messages from the HEAD (oldest end) of a channel's list.
 * Used when new messages arrive so memory stays bounded.
 * Returns updated state objects, or null if no eviction needed.
 */
function evictHead(
  channelId: string,
  messages: Record<string, Message>,
  channelMessages: Record<string, string[]>,
): { messages: Record<string, Message>; channelMessages: Record<string, string[]> } | null {
  const msgIds = channelMessages[channelId]
  if (!msgIds || msgIds.length <= WINDOW_SIZE) return null

  const idsToRemove = msgIds.slice(0, msgIds.length - WINDOW_SIZE)
  const idsToKeep = msgIds.slice(-WINDOW_SIZE)

  const newMessages = { ...messages }
  idsToRemove.forEach((id) => delete newMessages[id])

  return {
    messages: newMessages,
    channelMessages: { ...channelMessages, [channelId]: idsToKeep },
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  // Initial state
  messages: {},
  channels: {},
  channelMessages: {},

  // ========================================
  // MESSAGE ACTIONS
  // ========================================

  upsertMessage: (message, isHistorical = false) =>
    set((state) => {
      const { id, channelId } = message

      // Update messages map
      let newMessages = { ...state.messages, [id]: message }

      // Update channelMessages array only if it's a new message
      let newChannelMessages = { ...state.channelMessages }
      const channelMsgs = newChannelMessages[channelId] || []

      if (!channelMsgs.includes(id)) {
        // Append to the end — messages arrive in chronological order
        newChannelMessages[channelId] = [...channelMsgs, id]

        // Evict oldest messages from the head to keep the window bounded.
        // Skip during initial history load (isHistorical=true) since prependMessages
        // handles its own eviction from the tail.
        if (!isHistorical) {
          const evicted = evictHead(channelId, newMessages, newChannelMessages)
          if (evicted) {
            newMessages = evicted.messages
            newChannelMessages = evicted.channelMessages
          }
        }
      }

      return { messages: newMessages, channelMessages: newChannelMessages }
    }),

  prependMessages: (channelId, messages) => {
    let prepended = 0

    set((state) => {
      const existingIds = new Set(state.channelMessages[channelId] || [])

      // Filter out duplicates and build new entries map
      const newEntries = messages.filter((m) => !existingIds.has(m.id))
      if (newEntries.length === 0) return state

      prepended = newEntries.length

      // Add to messages map
      let newMessages = { ...state.messages }
      newEntries.forEach((m) => {
        newMessages[m.id] = m
      })

      // Prepend IDs at the head (oldest first)
      const newIds = [...newEntries.map((m) => m.id), ...(state.channelMessages[channelId] || [])]
      let newChannelMessages = { ...state.channelMessages, [channelId]: newIds }

      // Evict from the tail to keep the window bounded
      const evicted = evictTail(channelId, newMessages, newChannelMessages)
      if (evicted) {
        newMessages = evicted.messages
        newChannelMessages = evicted.channelMessages
      }

      return { messages: newMessages, channelMessages: newChannelMessages }
    })

    return prepended
  },

  updateMessage: (messageId, updates) =>
    set((state) => {
      const existingMessage = state.messages[messageId]
      if (!existingMessage) return state

      return {
        messages: {
          ...state.messages,
          [messageId]: { ...existingMessage, ...updates },
        },
      }
    }),

  updateMessageId: (oldId, newId, channelId) =>
    set((state) => {
      const message = state.messages[oldId]
      if (!message) return state

      // Create new message with updated ID
      const updatedMessage = { ...message, id: newId }

      // Remove old message
      const newMessages = { ...state.messages }
      delete newMessages[oldId]
      newMessages[newId] = updatedMessage

      // Update channelMessages array (replace oldId with newId)
      const newChannelMessages = { ...state.channelMessages }
      const channelMsgs = newChannelMessages[channelId] || []
      newChannelMessages[channelId] = channelMsgs.map((id) => (id === oldId ? newId : id))

      return {
        messages: newMessages,
        channelMessages: newChannelMessages,
      }
    }),

  deleteMessage: (messageId, channelId) =>
    set((state) => {
      const newMessages = { ...state.messages }
      delete newMessages[messageId]

      const newChannelMessages = { ...state.channelMessages }
      newChannelMessages[channelId] = (newChannelMessages[channelId] || []).filter(
        (id) => id !== messageId,
      )

      return {
        messages: newMessages,
        channelMessages: newChannelMessages,
      }
    }),

  clearChannelMessages: (channelId) =>
    set((state) => {
      const messageIds = state.channelMessages[channelId] || []
      const newMessages = { ...state.messages }

      // Remove all messages for this channel
      messageIds.forEach((id) => delete newMessages[id])

      const newChannelMessages = { ...state.channelMessages }
      delete newChannelMessages[channelId]

      return {
        messages: newMessages,
        channelMessages: newChannelMessages,
      }
    }),

  // ========================================
  // STREAMING ACTIONS
  // ========================================

  appendTextChunk: (messageId, channelId, text) =>
    set((state) => {
      const existingMessage = state.messages[messageId]

      if (existingMessage) {
        // Append to existing message
        const currentText = existingMessage.text || ""
        return {
          messages: {
            ...state.messages,
            [messageId]: {
              ...existingMessage,
              text: currentText + text,
              content: { type: "text", text: currentText + text },
            },
          },
        }
      } else {
        // Create new streaming message
        const newMessage: Message = {
          id: messageId,
          channelId,
          sender: "agent",
          timestamp: new Date(),
          isStreaming: true,
          text: text,
          content: { type: "text", text },
        }

        const newMessages: Record<string, Message> = { ...state.messages, [messageId]: newMessage }
        const channelMsgs = state.channelMessages[channelId] || []
        const newChannelMessages = {
          ...state.channelMessages,
          [channelId]: [...channelMsgs, messageId],
        }

        // Skip eviction during streaming — removing items from the head while
        // the FlatList has maintainVisibleContentPosition active causes a
        // jarring scroll-up.  Eviction will happen when the final message
        // arrives via upsertMessage (isHistorical=false).

        return {
          messages: newMessages,
          channelMessages: newChannelMessages,
        }
      }
    }),

  addToolCall: (messageId, channelId, toolCall) =>
    set((state) => {
      const existingMessage = state.messages[messageId]

      if (existingMessage) {
        // Add to existing message
        const currentToolCalls = existingMessage.toolCalls || []
        return {
          messages: {
            ...state.messages,
            [messageId]: {
              ...existingMessage,
              toolCalls: [...currentToolCalls, toolCall],
            },
          },
        }
      } else {
        // Create new streaming message with tool call
        const newMessage: Message = {
          id: messageId,
          channelId,
          sender: "agent",
          timestamp: new Date(),
          isStreaming: true,
          text: "",
          content: { type: "text", text: "" },
          toolCalls: [toolCall],
        }

        const newMessages: Record<string, Message> = { ...state.messages, [messageId]: newMessage }
        const channelMsgs = state.channelMessages[channelId] || []

        const newChannelMessages = {
          ...state.channelMessages,
          [channelId]: [...channelMsgs, messageId],
        }

        // Skip eviction during streaming (same reason as appendTextChunk above)

        return {
          messages: newMessages,
          channelMessages: newChannelMessages,
        }
      }
    }),

  updateToolCall: (messageId, toolCallId, updates) =>
    set((state) => {
      const message = state.messages[messageId]
      if (!message || !message.toolCalls) return state

      const updatedToolCalls = message.toolCalls.map((tc) =>
        tc.toolCallId === toolCallId ? { ...tc, ...updates } : tc,
      )

      return {
        messages: {
          ...state.messages,
          [messageId]: {
            ...message,
            toolCalls: updatedToolCalls,
          },
        },
      }
    }),

  markMessageComplete: (messageId) =>
    set((state) => {
      const message = state.messages[messageId]
      if (!message) return state

      const { isStreaming, ...messageWithoutStreaming } = message

      return {
        messages: {
          ...state.messages,
          [messageId]: messageWithoutStreaming,
        },
      }
    }),

  // ========================================
  // CHANNEL ACTIONS
  // ========================================

  setChannel: (channel) =>
    set((state) => ({
      channels: {
        ...state.channels,
        [channel.channelId]: channel,
      },
    })),

  updateChannel: (channelId, updates) =>
    set((state) => {
      const existingChannel = state.channels[channelId]

      // If the channel doesn't exist, create a minimal one with the updates
      const baseChannel: Channel = existingChannel ?? {
        channelId,
        title: "",
        agentId: "",
        agentName: "",
        agentAvatarUrl: null,
        isTyping: false,
        isRenaming: false,
        isAutonaming: false,
        lastMessageAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      return {
        channels: {
          ...state.channels,
          [channelId]: { ...baseChannel, ...updates },
        },
      }
    }),

  setTyping: (channelId, isTyping) =>
    set((state) => {
      const channel = state.channels[channelId]

      // If channel doesn't exist, create a minimal one just for typing state
      const updatedChannel = channel
        ? { ...channel, isTyping }
        : {
            channelId,
            title: "",
            agentId: "",
            agentName: "",
            agentAvatarUrl: null,
            isTyping,
            isRenaming: false,
            isAutonaming: false,
            lastMessageAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }

      return {
        channels: {
          ...state.channels,
          [channelId]: updatedChannel,
        },
      }
    }),

  setRenaming: (channelId, isRenaming) =>
    set((state) => {
      const channel = state.channels[channelId]
      if (!channel) return state

      return {
        channels: {
          ...state.channels,
          [channelId]: { ...channel, isRenaming },
        },
      }
    }),

  setAutonaming: (channelId, isAutonaming) =>
    set((state) => {
      const channel = state.channels[channelId]
      if (!channel) return state

      return {
        channels: {
          ...state.channels,
          [channelId]: { ...channel, isAutonaming },
        },
      }
    }),

  deleteChannel: (channelId) =>
    set((state) => {
      // Delete channel
      const newChannels = { ...state.channels }
      delete newChannels[channelId]

      // Delete all messages for this channel
      const messageIds = state.channelMessages[channelId] || []
      const newMessages = { ...state.messages }
      messageIds.forEach((id) => delete newMessages[id])

      const newChannelMessages = { ...state.channelMessages }
      delete newChannelMessages[channelId]

      return {
        channels: newChannels,
        messages: newMessages,
        channelMessages: newChannelMessages,
      }
    }),

  // ========================================
  // SELECTORS
  // ========================================

  getChannelMessages: (channelId) => {
    const state = get()
    const messageIds = state.channelMessages[channelId] || []
    return messageIds
      .map((id) => state.messages[id])
      .filter(Boolean)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  },

  getChannel: (channelId) => {
    return get().channels[channelId]
  },

  getMessage: (messageId) => {
    return get().messages[messageId]
  },

  getAllChannels: () => {
    const state = get()
    return Object.values(state.channels).sort((a, b) => {
      const aTime = a.lastMessageAt || a.updatedAt
      const bTime = b.lastMessageAt || b.updatedAt
      return new Date(bTime).getTime() - new Date(aTime).getTime()
    })
  },
}))
