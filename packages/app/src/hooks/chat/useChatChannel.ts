/**
 * useChatChannel
 *
 * Manages:
 * - WebSocket connection state (connected/disconnected)
 * - User session loading
 * - Conversation metadata loading (agent, workspace, model info)
 * - Channel subscription and history loading
 * - All real-time message event listeners
 */

import type { TokenBudget } from "@teros/shared"
import { useCallback, useEffect, useRef, useState } from "react"
import { getTerosClient } from "../../../app/_layout"
import { STORAGE_KEYS, storage } from "../../services/storage"
import { useChatStore } from "../../store/chatStore"
import type { Message, ToolCall } from "../../components/MessageBubble"

// ============================================
// TYPES
// ============================================

export interface Conversation {
  sessionId: string
  channelId: string
  title: string
  transport: string
  sessionImage?: string | null
  participants: Array<{ agentId: string; role: string }>
  createdAt: string
  updatedAt: string
  lastMessageAt?: string | null
}

export interface ChatChannelState {
  user: any
  conversation: Conversation | null
  connected: boolean
  isLoading: boolean
  agentName: string
  agentAvatarUrl: string | null
  modelString: string | undefined
  modelName: string | undefined
  providerName: string | undefined
  workspaceInfo: { name: string; icon?: string; color?: string } | null
  tokenBudget: TokenBudget | null
  isChatReady: boolean
  hasMoreMessages: boolean
  isLoadingMore: boolean
  conversationInitialized: React.MutableRefObject<boolean>
  typingHeartbeatTimeout: React.MutableRefObject<NodeJS.Timeout | null>
  justSentMessage: React.MutableRefObject<boolean>
  setConversation: (conv: Conversation | null | ((prev: Conversation | null) => Conversation | null)) => void
  setIsChatReady: (v: boolean | ((prev: boolean) => boolean)) => void
  setHasMoreMessages: (v: boolean) => void
  setIsLoadingMore: (v: boolean) => void
  setTokenBudget: (v: TokenBudget | null) => void
  setModelString: (v: string | undefined) => void
  setModelName: (v: string | undefined) => void
  setProviderName: (v: string | undefined) => void
  loadMoreMessages: () => Promise<void>
}

// ============================================
// HOOK
// ============================================

export function useChatChannel(
  channelId: string | undefined,
  initialAgentId: string | undefined,
  workspaceId: string | undefined,
  onTitleChange: ((title: string) => void) | undefined,
  messageIds: string[],
): ChatChannelState {
  const client = getTerosClient()
  const isNewChat = !channelId

  // Helper: check if there are cached messages for current channel
  const getHasCachedMessages = useCallback(() => {
    return channelId
      ? (useChatStore.getState().channelMessages[channelId]?.length ?? 0) > 0
      : false
  }, [channelId])

  // ----------------------------------------
  // State
  // ----------------------------------------
  const [user, setUser] = useState<any>(null)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [connected, setConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(() => !isNewChat && !getHasCachedMessages())
  const [agentName, setAgentName] = useState<string>("")
  const [agentAvatarUrl, setAgentAvatarUrl] = useState<string | null>(null)
  const [modelString, setModelString] = useState<string | undefined>(undefined)
  const [modelName, setModelName] = useState<string | undefined>(undefined)
  const [providerName, setProviderName] = useState<string | undefined>(undefined)
  const [workspaceInfo, setWorkspaceInfo] = useState<{
    name: string
    icon?: string
    color?: string
  } | null>(null)
  const [tokenBudget, setTokenBudget] = useState<TokenBudget | null>(null)
  const [isChatReady, setIsChatReady] = useState(() => isNewChat || getHasCachedMessages())
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // ----------------------------------------
  // Refs
  // ----------------------------------------
  const conversationInitialized = useRef(false)
  const typingHeartbeatTimeout = useRef<NodeJS.Timeout | null>(null)
  const justSentMessage = useRef(false)

  // ----------------------------------------
  // EFFECT: User & Connection
  // ----------------------------------------
  useEffect(() => {
    const loadUser = async () => {
      try {
        const savedUser = await storage.getItem(STORAGE_KEYS.USER)
        if (savedUser) {
          setUser(JSON.parse(savedUser))
        }
      } catch (e) {
        console.error("Failed to load user from storage:", e)
      }
    }
    loadUser()

    const handleConnected = () => setConnected(true)
    const handleDisconnected = () => {
      setConnected(false)
      conversationInitialized.current = false
    }

    client.on("connected", handleConnected)
    client.on("disconnected", handleDisconnected)
    setConnected(client.isConnected())

    return () => {
      client.off("connected", handleConnected)
      client.off("disconnected", handleDisconnected)
    }
  }, [])

  // ----------------------------------------
  // EFFECT: Load Conversation
  // ----------------------------------------
  useEffect(() => {
    const loadConversation = async () => {
      if (!user || !connected) return

      // For new chats, just load agent info
      if (isNewChat && initialAgentId) {
        try {
          const agents = await client.agent.listAgents(workspaceId).then((r: any) => r.agents)
          const agent = agents.find((a: any) => a.agentId === initialAgentId)
          if (agent) {
            setAgentName(agent.name || agent.fullName || "")
            setAgentAvatarUrl(agent.avatarUrl || null)
            const draftConv: Conversation = {
              sessionId: "draft",
              channelId: "draft",
              title: `Nuevo chat con ${agent.name || agent.fullName || "Agente"}`,
              transport: "web",
              sessionImage: null,
              participants: [{ agentId: initialAgentId, role: "agent" }],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              lastMessageAt: null,
            }
            setConversation(draftConv)
          }

          if (workspaceId) {
            try {
              const workspaces = await client.listWorkspaces()
              const ws = workspaces.find((w: any) => w.workspaceId === workspaceId)
              if (ws) {
                setWorkspaceInfo({
                  name: ws.name,
                  icon: ws.appearance?.icon,
                  color: ws.appearance?.color,
                })
              }
            } catch (err) {
              console.error("[useChatChannel] Error loading workspace info:", err)
            }
          }
        } catch (err) {
          console.error("[useChatChannel] Error loading agent info:", err)
        }
        return
      }

      if (!channelId) return

      // Check for cached data
      const cachedChannel = useChatStore.getState().channels[channelId]
      const cachedMessages = useChatStore.getState().channelMessages[channelId]
      const hasCached = cachedChannel && cachedMessages && cachedMessages.length > 0

      if (hasCached) {
        const conv: Conversation = {
          sessionId: channelId,
          channelId: channelId,
          title: cachedChannel.title || "Chat",
          transport: "web",
          sessionImage: null,
          participants: cachedChannel.agentId
            ? [{ agentId: cachedChannel.agentId, role: "agent" }]
            : [],
          createdAt: cachedChannel.createdAt || new Date().toISOString(),
          updatedAt: cachedChannel.updatedAt || new Date().toISOString(),
          lastMessageAt:
            cachedChannel.lastMessageAt || cachedChannel.updatedAt || new Date().toISOString(),
        }
        setConversation(conv)
        if (cachedChannel.agentName) setAgentName(cachedChannel.agentName)
        if (cachedChannel.modelString) setModelString(cachedChannel.modelString)
        if (cachedChannel.modelName) setModelName(cachedChannel.modelName)
        if (cachedChannel.providerName) setProviderName(cachedChannel.providerName)
        setIsLoading(false)
        setIsChatReady(true)
      } else {
        setIsLoading(true)
      }

      try {
        const { channels } = await client.channel.list()
        const ch = channels.find((c: any) => c.channelId === channelId)

        if (!ch) {
          console.error("[useChatChannel] Channel not found:", channelId)
          setIsLoading(false)
          return
        }

        if (ch.agentId) {
          try {
            const channelWorkspaceId = ch.workspaceId || workspaceId
            const agents = await client.agent.listAgents(channelWorkspaceId).then((r: any) => r.agents)
            const agent = agents.find((a: any) => a.agentId === ch.agentId)
            if (agent) {
              setAgentName(agent.name || agent.fullName || "")
              setAgentAvatarUrl(agent.avatarUrl || null)
            }

            if (channelWorkspaceId) {
              try {
                const workspaces = await client.listWorkspaces()
                const ws = workspaces.find((w: any) => w.workspaceId === channelWorkspaceId)
                if (ws) {
                  setWorkspaceInfo({
                    name: ws.name,
                    icon: ws.appearance?.icon,
                    color: ws.appearance?.color,
                  })
                }
              } catch (wsErr) {
                console.error("[useChatChannel] Error loading workspace info:", wsErr)
              }
            } else {
              setWorkspaceInfo(null)
            }
          } catch (err) {
            console.error("[useChatChannel] Error loading agent info:", err)
          }
        }

        const chAny = ch as any
        const conv: Conversation = {
          sessionId: ch.channelId,
          channelId: ch.channelId,
          title: chAny.metadata?.name || "Chat con " + (ch.agentId || "Agente"),
          transport: chAny.metadata?.transport || "web",
          sessionImage: null,
          participants: ch.agentId ? [{ agentId: ch.agentId, role: "agent" }] : [],
          createdAt: ch.createdAt || new Date().toISOString(),
          updatedAt: ch.updatedAt || new Date().toISOString(),
          lastMessageAt: ch.updatedAt || new Date().toISOString(),
        }
        setConversation(conv)

        if (chAny.modelString) setModelString(chAny.modelString)
        if (chAny.modelName) setModelName(chAny.modelName)
        if (chAny.providerName) setProviderName(chAny.providerName)

        useChatStore.getState().updateChannel(ch.channelId, {
          title: conv.title,
          isPrivate: ch.isPrivate ?? false,
          agentName: chAny.agentName,
          agentAvatarUrl: chAny.agentAvatarUrl,
          modelString: chAny.modelString,
          modelName: chAny.modelName,
          providerName: chAny.providerName,
        })
      } catch (error) {
        console.error("[useChatChannel] Error loading conversation:", error)
      } finally {
        setIsLoading(false)
      }
    }

    loadConversation()
  }, [user, channelId, connected, isNewChat, initialAgentId])

  // ----------------------------------------
  // EFFECT: Subscribe & Load History
  // ----------------------------------------
  useEffect(() => {
    if (isNewChat && !channelId) return
    if (!conversation || !connected || conversationInitialized.current) return

    conversationInitialized.current = true

    const initializeChat = async () => {
      const hasCached = getHasCachedMessages()

      if (hasCached) {
        setIsChatReady(true)
      }

      try {
        await client.channel.subscribe(channelId as string)

        const {
          messages: history,
          hasMore,
          tokenBudget: initialBudget,
        } = await client.channel.getMessages(channelId as string, 20)
        setHasMoreMessages(hasMore)

        if (initialBudget) {
          setTokenBudget(initialBudget)
        }

        const historicalMessages: Message[] = history
          .map((msg: any) => ({
            id: msg.messageId || msg.id,
            channelId: channelId as string,
            content: msg.content,
            sender:
              msg.sender === "system" || msg.content?.type === "event"
                ? ("system" as const)
                : msg.role === "user"
                  ? ("user" as const)
                  : ("agent" as const),
            senderInfo: msg.sender
              ? {
                  type: msg.sender.type,
                  id: msg.sender.id,
                  name: msg.sender.name,
                  avatarUrl: msg.sender.avatarUrl,
                }
              : undefined,
            timestamp: new Date(msg.timestamp),
            isStreaming: false,
          }))
          .sort((a: Message, b: Message) => a.timestamp.getTime() - b.timestamp.getTime())

        historicalMessages.forEach((msg) => {
          useChatStore.getState().upsertMessage(msg, true)
        })

        if (!hasCached) {
          if (historicalMessages.length === 0) {
            setIsChatReady(true)
          }
        }
      } catch (error: any) {
        console.error("[useChatChannel] Error initializing chat:", error)
        conversationInitialized.current = false
        setIsChatReady(true)
      }
    }

    initializeChat()
  }, [conversation, connected, channelId, getHasCachedMessages])

  // ----------------------------------------
  // EFFECT: Message Listeners
  // ----------------------------------------
  useEffect(() => {
    if (!channelId) return

    const handleMessage = (data: any) => {
      if (!data.message || !data.message.messageId) return
      if (data.channelId !== channelId) return

      const store = useChatStore.getState()
      const messageId = data.message.messageId
      const isUserMessage = data.message.role === "user"

      const existingMessage = store.messages[messageId]

      if (existingMessage) {
        store.updateMessage(messageId, {
          content: data.message.content,
          timestamp: new Date(data.message.timestamp),
        })
        return
      }

      if (isUserMessage) {
        const channelMsgs = store.channelMessages[channelId] || []
        const tempId = channelMsgs.find((id) => id.startsWith("temp_"))

        if (tempId) {
          store.updateMessageId(tempId, messageId, channelId)
          store.updateMessage(messageId, {
            content: data.message.content,
            timestamp: new Date(data.message.timestamp),
          })
          return
        }
      }

      const message: Message = {
        id: messageId,
        channelId: data.channelId,
        content: data.message.content,
        sender: isUserMessage ? "user" : "agent",
        senderInfo: data.message.sender
          ? {
              type: data.message.sender.type,
              id: data.message.sender.id,
              name: data.message.sender.name,
              avatarUrl: data.message.sender.avatarUrl,
            }
          : undefined,
        timestamp: new Date(data.message.timestamp),
        isStreaming: false,
      }

      store.upsertMessage(message)
    }

    const handleMessageChunk = (data: any) => {
      if (data.channelId !== channelId) return

      const chunkType = data.chunkType
      const text = data.text || ""

      if (chunkType === "text_chunk" && text) {
        useChatStore.getState().appendTextChunk(data.messageId, channelId, text)
      } else if (chunkType === "text_complete") {
        useChatStore.getState().markMessageComplete(data.messageId)
      } else if (chunkType === "tool_call_start") {
        const toolCall: ToolCall = {
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          mcaId: data.mcaId,
          input: data.toolInput,
          status: "running",
        }
        useChatStore.getState().addToolCall(data.messageId, channelId, toolCall)
      } else if (chunkType === "tool_call_complete") {
        const status = data.toolStatus === "completed" ? "completed" : "failed"
        useChatStore.getState().updateToolCall(data.messageId, data.toolCallId, {
          status: status as "completed" | "failed",
          output: data.toolOutput,
          error: data.toolError,
          duration: data.toolDuration,
        })
      }
    }

    const handleMessageSent = (data: any) => {
      if (!data.messageId) return

      const store = useChatStore.getState()
      const channelMsgs = store.channelMessages[channelId] || []
      const tempId = channelMsgs.find((id) => id.startsWith("temp_"))

      if (tempId) {
        const tempMessage = store.messages[tempId]
        if (tempMessage && tempMessage.content.type === "voice" && data.transcription) {
          store.updateMessage(tempId, {
            content: {
              ...tempMessage.content,
              transcription: data.transcription,
            },
          })
        }
        store.updateMessageId(tempId, data.messageId, channelId)
        store.updateMessage(data.messageId, {
          status: "sent",
          retryData: undefined,
        })
      }
    }

    const TYPING_HEARTBEAT_TIMEOUT = 15000

    const handleTyping = (data: any) => {
      if (data.channelId === channelId) {
        if (typingHeartbeatTimeout.current) {
          clearTimeout(typingHeartbeatTimeout.current)
          typingHeartbeatTimeout.current = null
        }

        if (data.isTyping) {
          useChatStore.getState().setTyping(channelId, true)
          typingHeartbeatTimeout.current = setTimeout(() => {
            useChatStore.getState().setTyping(channelId, false)
            typingHeartbeatTimeout.current = null
          }, TYPING_HEARTBEAT_TIMEOUT)
        } else {
          useChatStore.getState().setTyping(channelId, false)
          justSentMessage.current = false
        }
      }
    }

    const handleTokenBudget = (data: any) => {
      if (data.channelId === channelId && data.budget) {
        setTokenBudget(data.budget)
      }
    }

    const handleSystemEvent = (data: any) => {
      if (data.channelId === channelId && data.event) {
        const eventMessage: Message = {
          id: data.event.id,
          channelId: channelId as string,
          content: {
            type: "event",
            eventType: data.event.eventType,
            eventData: {
              message: data.event.message,
              ...data.event.metadata,
            },
            description: data.event.description,
          },
          sender: "system",
          timestamp: new Date(data.event.timestamp),
        }
        useChatStore.getState().upsertMessage(eventMessage)
      }
    }

    const handleError = (error: any) => {
      console.error("[useChatChannel] Error from server:", error)

      const technicalParts: string[] = []
      if (error.code) technicalParts.push(`Code: ${error.code}`)
      if (error.details)
        technicalParts.push(
          `Details: ${typeof error.details === "string" ? error.details : JSON.stringify(error.details)}`,
        )
      if (error.raw && error.raw !== "{}") technicalParts.push(`Raw: ${error.raw}`)
      if (error.type) technicalParts.push(`Type: ${error.type}`)

      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        channelId,
        content: {
          type: "error",
          errorType:
            error.code === "LLM_ERROR"
              ? "llm"
              : error.code === "TOOL_ERROR"
                ? "tool"
                : error.code === "VALIDATION_ERROR"
                  ? "validation"
                  : error.code === "NETWORK_ERROR"
                    ? "network"
                    : "unknown",
          userMessage: error.message || "Ha ocurrido un error inesperado",
          technicalMessage:
            technicalParts.length > 0 ? technicalParts.join(" | ") : JSON.stringify(error),
          context: error.context,
        },
        sender: "system",
        timestamp: new Date(),
      }

      useChatStore.getState().upsertMessage(errorMessage)
    }

    const handleChannelStatus = (data: any) => {
      if (data.channelId === channelId) {
        const updates: any = {}
        if (data.title !== undefined) {
          updates.title = data.title
          setConversation((prev) => (prev ? { ...prev, title: data.title } : prev))
          onTitleChange?.(data.title)
        }
        if (data.externalActionRequested !== undefined)
          updates.externalActionRequested = data.externalActionRequested
        if (data.isPrivate !== undefined) updates.isPrivate = data.isPrivate

        if (Object.keys(updates).length > 0) {
          useChatStore.getState().updateChannel(channelId, updates)
        }
      }
    }

    const handleChannelPrivateUpdated = (data: any) => {
      if (data.channelId === channelId) {
        useChatStore.getState().updateChannel(channelId, { isPrivate: data.isPrivate })
      }
    }

    client.on("message", handleMessage)
    client.on("message_chunk", handleMessageChunk)
    client.on("message_sent", handleMessageSent)
    client.on("typing", handleTyping)
    client.on("token_budget", handleTokenBudget)
    client.on("system_event", handleSystemEvent)
    client.on("channel_status", handleChannelStatus)
    client.on("channel_private_updated", handleChannelPrivateUpdated)
    client.on("error", handleError)

    return () => {
      client.off("message", handleMessage)
      client.off("message_chunk", handleMessageChunk)
      client.off("message_sent", handleMessageSent)
      client.off("typing", handleTyping)
      client.off("token_budget", handleTokenBudget)
      client.off("system_event", handleSystemEvent)
      client.off("channel_status", handleChannelStatus)
      client.off("error", handleError)

      if (typingHeartbeatTimeout.current) {
        clearTimeout(typingHeartbeatTimeout.current)
        typingHeartbeatTimeout.current = null
      }
    }
  }, [client, channelId, user, onTitleChange])

  // ----------------------------------------
  // EFFECT: Reset on channel change
  // ----------------------------------------
  useEffect(() => {
    const hasCached = getHasCachedMessages()

    setIsChatReady(isNewChat || hasCached)
    setHasMoreMessages(false)
    conversationInitialized.current = false
    justSentMessage.current = false

    if (channelId) {
      useChatStore.getState().setTyping(channelId, false)
    }

    const safetyTimeout = setTimeout(() => {
      setIsChatReady((current) => {
        if (!current) {
          console.warn("[useChatChannel] Safety timeout triggered")
        }
        return true
      })
    }, 5000)

    return () => clearTimeout(safetyTimeout)
  }, [channelId, getHasCachedMessages])

  // Reset token budget when channel changes
  useEffect(() => {
    setTokenBudget(null)
  }, [channelId])

  // ----------------------------------------
  // Load More Messages
  // ----------------------------------------
  const loadMoreMessages = useCallback(async () => {
    if (!hasMoreMessages || isLoadingMore || !client || messageIds.length === 0 || !channelId) return

    setIsLoadingMore(true)
    try {
      const oldestMessageId = messageIds[0]
      const { messages: olderMessages, hasMore } = await client.channel.getMessages(
        channelId,
        10,
        oldestMessageId,
      )

      setHasMoreMessages(hasMore)

      // Sort oldest-first before prepending so the order in the list is correct
      const sorted = [...olderMessages].sort(
        (a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )
      const formatted = sorted.map((msg: any) => ({
        id: msg.messageId || msg.id,
        channelId: channelId,
        content: msg.content,
        sender: (
          msg.role === "user" ? "user" : msg.sender === "system" ? "system" : "agent"
        ) as "user" | "agent" | "system",
        senderInfo: msg.sender
          ? {
              type: msg.sender.type,
              id: msg.sender.id,
              name: msg.sender.name,
              avatarUrl: msg.sender.avatarUrl,
            }
          : undefined,
        timestamp: new Date(msg.timestamp),
        isStreaming: false as const,
      }))
      useChatStore.getState().prependMessages(channelId, formatted)
    } catch (error) {
      console.error("[useChatChannel] Error loading more messages:", error)
    } finally {
      setIsLoadingMore(false)
    }
  }, [hasMoreMessages, isLoadingMore, client, messageIds, channelId])

  return {
    user,
    conversation,
    connected,
    isLoading,
    agentName,
    agentAvatarUrl,
    modelString,
    modelName,
    providerName,
    workspaceInfo,
    tokenBudget,
    isChatReady,
    hasMoreMessages,
    isLoadingMore,
    conversationInitialized,
    typingHeartbeatTimeout,
    justSentMessage,
    setConversation,
    setIsChatReady,
    setHasMoreMessages,
    setIsLoadingMore,
    setTokenBudget,
    setModelString,
    setModelName,
    setProviderName,
    loadMoreMessages,
  }
}
