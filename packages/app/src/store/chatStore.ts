/**
 * Chat Store - Messages and channels management with normalized data structure
 *
 * Benefits of normalization:
 * - No duplicate messages
 * - Easy updates by ID
 * - Efficient lookups
 * - Better performance with large datasets
 */

import { createSessionStore } from './session/createSessionStore'
import type { MessageContent, ToolCall } from "../components/chat/bubbles/types"

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

  // Streaming-only field (NOT persisted, used only during live text streaming).
  // Tool executions ya viven en `content` con `type: 'tool_execution'`; no hay
  // un buffer separado para tools en este modelo.
  text?: string // For showing text in real-time before final content

  // Message delivery status (for user messages). `queued` = backend ack'd but waiting in the channel FIFO.
  status?: "sending" | "sent" | "queued" | "failed"

  // Source of the message — 'voice' when sent via voice mode
  source?: "voice" | "web"

  /** Additional metadata for the message (e.g., board_subscription source) */
  metadata?: Record<string, any>

  // User feedback for assistant messages (thumbs up/down, reasons, comment)
  feedback?: {
    rating: "up" | "down"
    reasons?: string[]
    comment?: string
    hasComment?: boolean
    createdAt?: string
  }

  // Action metadata logged for assistant messages (copy/report)
  reportedAt?: string
  copiedAt?: string

  // Retry data - preserved for failed messages to allow retry
  retryData?: {
    // For voice messages
    audioUri?: string  // Persisted local file URI (documentDirectory) — survives until retry succeeds
    audioData?: string // Base64 audio data (cached after first successful read)
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
  agentPhase?: 'idle' | 'thinking' | 'streaming_text' | 'executing_tool'
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
   * Set user feedback for a specific message
   */
  setMessageFeedback: (messageId: string, feedback: Message['feedback']) => void

  /**
   * Delete a message
   */
  deleteMessage: (messageId: string, channelId: string) => void

  /**
   * Clear all messages for a channel
   */
  clearChannelMessages: (channelId: string) => void

  /**
   * Reset session — clears all chat state (messages, channels, channelMessages)
   */
  resetSession: () => void

  // @deprecated Use resetSession() instead — kept for backward compatibility during transition
  resetAllState: () => void

  // ========================================
  // ACTIONS - STREAMING
  // ========================================

  /**
   * Append text chunk to a streaming message
   * Creates message if it doesn't exist
   */
  appendTextChunk: (messageId: string, channelId: string, text: string) => void

  /**
   * Insert or update a tool execution message. Single source of truth for tool
   * call state — handles both the initial streaming creation (chunk
   * `tool_call_start`) and subsequent status updates (`tool_status_update`,
   * `tool_call_complete`).
   *
   * Always operates on `message.content` (the persisted shape). No separate
   * `toolCalls[]` buffer — render and store agree on a single representation.
   *
   * Creates the message if it doesn't exist, merges content if it does.
   */
  upsertToolMessage: (
    messageId: string,
    channelId: string,
    update: Partial<Extract<MessageContent, { type: 'tool_execution' }>> & {
      toolCallId: string
    },
  ) => void


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
  setAgentPhase: (channelId: string, phase: 'idle' | 'thinking' | 'streaming_text' | 'executing_tool') => void
  /** Move `messageId` to immediately before `beforeId` in `channelMessages[channelId]`. */
  reorderMessageBefore: (channelId: string, messageId: string, beforeId: string) => void

  /** Move `messageId` to the tail of `channelMessages[channelId]`. */
  reorderMessageToEnd: (channelId: string, messageId: string) => void

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

/** Fallback channel when a runtime event arrives before `setChannel`. */
function createChannelStub(channelId: string): Channel {
  return {
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
}

export const useChatStore = createSessionStore<ChatState>('chat', (set, get) => ({
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

  setMessageFeedback: (messageId, feedback) =>
    set((state) => {
      const existingMessage = state.messages[messageId]
      if (!existingMessage) return state

      return {
        messages: {
          ...state.messages,
          [messageId]: { ...existingMessage, feedback },
        },
      }
    }),

  updateMessageId: (oldId, newId, channelId) =>
    set((state) => {
      const message = state.messages[oldId]
      if (!message) return state
      // Unchanged id → no-op (otherwise the dedup branch below would drop it).
      if (oldId === newId) return state

      // Remove the optimistic message.
      const newMessages = { ...state.messages }
      delete newMessages[oldId]
      // If the real message already arrived (newId present), keep the server copy
      // instead of overwriting it with the optimistic one.
      if (!newMessages[newId]) {
        newMessages[newId] = { ...message, id: newId }
      }

      // Update channelMessages: replace oldId with newId — but if newId is already
      // present (the real message landed first), just drop oldId to avoid a duplicate.
      const newChannelMessages = { ...state.channelMessages }
      const channelMsgs = newChannelMessages[channelId] || []
      newChannelMessages[channelId] = channelMsgs.includes(newId)
        ? channelMsgs.filter((id) => id !== oldId)
        : channelMsgs.map((id) => (id === oldId ? newId : id))

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

  resetSession: () =>
    set({
      messages: {},
      channels: {},
      channelMessages: {},
    }),

  // Legacy alias — @todo nira - 2026-05-20: remove after all callers migrated
  resetAllState: () => useChatStore.getState().resetSession(),

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

  upsertToolMessage: (messageId, channelId, update) =>
    set((state) => {
      const existingMessage = state.messages[messageId]

      // Si el message existe Y su content es ya tool_execution → merge granular
      // del content. Preserva otros campos del Message (timestamp, sender, etc.).
      if (existingMessage && existingMessage.content?.type === 'tool_execution') {
        const mergedContent = {
          ...existingMessage.content,
          ...update,
        }
        return {
          messages: {
            ...state.messages,
            [messageId]: { ...existingMessage, content: mergedContent },
          },
        }
      }

      // Caso new message OR el message existe pero con otro content type.
      // Si el update no incluye `toolName` (p.ej. un tool_status_update llega
      // antes que tool_call_start por orden inverso), saltamos en silencio —
      // el siguiente chunk con toolName completará la creación.
      if (!update.toolName) {
        if (typeof window !== 'undefined' && (window as any).__DEBUG_TOOL_UPSERT) {
          console.warn(
            `[chatStore.upsertToolMessage] skipping creation of ${messageId} — toolName missing`,
            { toolCallId: update.toolCallId, status: update.status },
          )
        }
        return state
      }

      const baseContent: Extract<MessageContent, { type: 'tool_execution' }> = {
        type: 'tool_execution',
        status: 'pending',
        ...update,
        // Re-aplicar campos required tras spread para satisfacer el tipo.
        toolCallId: update.toolCallId,
        toolName: update.toolName,
      }

      const newMessage: Message = existingMessage
        ? { ...existingMessage, content: baseContent }
        : {
            id: messageId,
            channelId,
            sender: 'agent',
            timestamp: new Date(),
            content: baseContent,
          }

      const newMessages = { ...state.messages, [messageId]: newMessage }

      // Append a channelMessages solo si es nuevo en el canal.
      let newChannelMessages = state.channelMessages
      const channelMsgs = state.channelMessages[channelId] || []
      if (!channelMsgs.includes(messageId)) {
        newChannelMessages = {
          ...state.channelMessages,
          [channelId]: [...channelMsgs, messageId],
        }
      }

      return { messages: newMessages, channelMessages: newChannelMessages }
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
      // If channel doesn't exist, create a minimal one just for typing state.
      const updatedChannel = { ...(channel ?? createChannelStub(channelId)), isTyping }

      // No queue flush on typing→false: the per-assistant helper has already drained any user that received a turn.
      return {
        channels: {
          ...state.channels,
          [channelId]: updatedChannel,
        },
      }
    }),

  reorderMessageBefore: (channelId, messageId, beforeId) =>
    set((state) => {
      const ids = state.channelMessages[channelId]
      if (!ids) return state
      if (!ids.includes(messageId) || !ids.includes(beforeId)) return state
      const filtered = ids.filter((id) => id !== messageId)
      const targetIdx = filtered.indexOf(beforeId)
      if (targetIdx < 0) return state
      const next = [
        ...filtered.slice(0, targetIdx),
        messageId,
        ...filtered.slice(targetIdx),
      ]
      if (next.length === ids.length && next.every((v, i) => v === ids[i])) {
        return state
      }
      return {
        channelMessages: { ...state.channelMessages, [channelId]: next },
      }
    }),

  reorderMessageToEnd: (channelId, messageId) =>
    set((state) => {
      const ids = state.channelMessages[channelId]
      if (!ids) return state
      if (!ids.includes(messageId)) return state
      const msg = state.messages[messageId]
      if (!msg) return state
      const filtered = ids.filter((id) => id !== messageId)
      // Insert by msg.timestamp — `queue_state:running` arrives async, receipt order is not guaranteed.
      const ts = msg.timestamp.getTime()
      let insertIdx = filtered.length
      while (insertIdx > 0) {
        const prevId = filtered[insertIdx - 1]
        const prev = prevId ? state.messages[prevId] : undefined
        if (!prev || prev.sender !== 'user' || prev.status !== 'sent') break
        if (prev.timestamp.getTime() <= ts) break
        insertIdx--
      }
      const next = [
        ...filtered.slice(0, insertIdx),
        messageId,
        ...filtered.slice(insertIdx),
      ]
      if (next.length === ids.length && next.every((v, i) => v === ids[i])) {
        return state
      }
      return {
        channelMessages: { ...state.channelMessages, [channelId]: next },
      }
    }),

  setAgentPhase: (channelId, phase) =>
    set((state) => {
      const channel = state.channels[channelId]
      const updatedChannel = { ...(channel ?? createChannelStub(channelId)), agentPhase: phase }
      // On `idle`, clear `isStreaming` on every agent message — turns ending on tool_call / abort never fire `text_complete`.
      let messages = state.messages
      if (phase === "idle") {
        let mutated = false
        const next: Record<string, Message> = {}
        for (const [id, m] of Object.entries(state.messages)) {
          if (
            m.channelId === channelId &&
            m.sender === "agent" &&
            m.isStreaming === true
          ) {
            next[id] = { ...m, isStreaming: false }
            mutated = true
          } else {
            next[id] = m
          }
        }
        if (mutated) messages = next
      }
      return {
        channels: {
          ...state.channels,
          [channelId]: updatedChannel,
        },
        messages,
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
