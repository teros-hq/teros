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

import { normalizeError, type TokenBudget } from "@teros/shared"
import { obfuscateText } from "@teros/shared"
import { useCallback, useEffect, useRef, useState } from "react"
import i18n from "../../i18n"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useChatStore } from "../../store/chatStore"
import { useAuthStore } from "../../store/authStore"
import type { Message } from "../../store/chatStore"
import type { ToolCall } from "../../components/chat/bubbles/types"

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
  /** Channel scope — 'personal' or 'shared'. Missing = 'personal'. */
  scope?: 'personal' | 'shared'
  /** The userId of the channel creator — used for owner-only actions like redaction (REQ-4). */
  userId?: string
}

export interface ChatChannelState {
  user: any
  conversation: Conversation | null
  connected: boolean
  isLoading: boolean
  notFound: boolean
  agentName: string
  agentRole: string | undefined
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
  typingHeartbeatTimeout: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
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
  const user = useAuthStore((state) => state.user)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [connected, setConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(() => !isNewChat && !getHasCachedMessages())
  const [notFound, setNotFound] = useState(false)
  const [agentName, setAgentName] = useState<string>("")
  const [agentRole, setAgentRole] = useState<string | undefined>(undefined)
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
  const typingHeartbeatTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justSentMessage = useRef(false)

  // ----------------------------------------
  // EFFECT: User & Connection
  // ----------------------------------------
  useEffect(() => {
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
          // listAgents(workspaceId) now returns workspace agents + superagents from backend
          const agents = await client.agent.listAgents(workspaceId).then((r: any) => r.agents)
          let agent = agents.find((a: any) => a.agentId === initialAgentId)

          if (agent) {
            setAgentName(agent.name || agent.fullName || "")
            setAgentRole(agent.role || undefined)
            setAgentAvatarUrl(agent.avatarUrl || null)
          }

          // Crear draftConv siempre, aunque no se encuentre el agente,
          // para evitar que conversation quede null y cause loader infinito
          const draftConv: Conversation = {
            sessionId: "draft",
            channelId: "draft",
            title: agent
              ? i18n.t('conversation.newChatWith', { name: agent.name || agent.fullName || i18n.t('conversation.agent') })
              : i18n.t('conversation.newChat'),
            transport: "web",
            sessionImage: null,
            participants: [{ agentId: initialAgentId, role: "agent" }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastMessageAt: null,
          }
          setConversation(draftConv)

          if (workspaceId) {
            try {
              const { workspaces } = await client.workspace.listWorkspaces()
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
          title: cachedChannel.title || i18n.t('nav.chat'),
          transport: "web",
          sessionImage: null,
          participants: cachedChannel.agentId
            ? [{ agentId: cachedChannel.agentId, role: "agent" }]
            : [],
          createdAt: cachedChannel.createdAt || new Date().toISOString(),
          updatedAt: cachedChannel.updatedAt || new Date().toISOString(),
          lastMessageAt:
            cachedChannel.lastMessageAt || cachedChannel.updatedAt || new Date().toISOString(),
          scope: (cachedChannel as any).scope ?? 'personal',
          userId: (cachedChannel as any).userId,
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
        // Use channel.get() to fetch a specific channel by ID — more direct than listing.
        const ch = await client.channel.get(channelId) as any

        if (!ch) {
          console.error("[useChatChannel] Channel not found:", channelId)
          setIsLoading(false)
          setNotFound(true)
          return
        }

        if (ch.agentId) {
          try {
            const channelWorkspaceId = ch.workspaceId || workspaceId
            const agents = await client.agent.listAgents(channelWorkspaceId).then((r: any) => r.agents)
            const agent = agents.find((a: any) => a.agentId === ch.agentId)
            if (agent) {
              setAgentName(agent.name || agent.fullName || "")
              setAgentRole(agent.role || undefined)
              setAgentAvatarUrl(agent.avatarUrl || null)
            }

            if (channelWorkspaceId) {
              try {
                const { workspaces } = await client.workspace.listWorkspaces()
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
          title: chAny.metadata?.name || i18n.t('conversation.chatWith', { name: ch.agentId || i18n.t('conversation.agent') }),
          transport: chAny.metadata?.transport || "web",
          sessionImage: null,
          participants: ch.agentId ? [{ agentId: ch.agentId, role: "agent" }] : [],
          createdAt: ch.createdAt || new Date().toISOString(),
          updatedAt: ch.updatedAt || new Date().toISOString(),
          lastMessageAt: ch.lastMessageAt || ch.updatedAt || new Date().toISOString(),
          scope: chAny.scope ?? 'personal',
          userId: chAny.userId,
        }
        setConversation(conv)

        if (chAny.modelString) setModelString(chAny.modelString)
        if (chAny.modelName) setModelName(chAny.modelName)
        if (chAny.providerName) setProviderName(chAny.providerName)

        useChatStore.getState().updateChannel(ch.channelId, {
          title: conv.title,
          scope: ch.scope ?? 'personal',
          agentName: chAny.agentName,
          agentAvatarUrl: chAny.agentAvatarUrl,
          modelString: chAny.modelString,
          modelName: chAny.modelName,
          providerName: chAny.providerName,
          // Hydrate cached composer suggestions (regenerated server-side after
          // each agent response; empty/absent = nothing to show).
          suggestedPrompts: chAny.metadata?.suggestedPrompts ?? null,
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
        const subscribeResp: any = await client.channel.subscribe(channelId as string)

        // Hydration snapshot — fresh tab / post-reconnect needs this before the next push arrives.
        if (subscribeResp && typeof subscribeResp === "object") {
          const phase = subscribeResp.agentPhase as
            | "idle"
            | "thinking"
            | "streaming_text"
            | "executing_tool"
            | undefined
          if (phase) {
            useChatStore.getState().setAgentPhase(channelId as string, phase)
          }
          // v1.4.4: hydration of the chips' visibility gate. A fresh tab /
          // post-reconnect reload mid-turn must NOT resurrect the old chips —
          // the persisted set is still the pre-turn one. Turn in course
          // (thinking/streaming/executing, or a queued/running user message)
          // → suppressed; idle/absent → visible.
          const turnInCourse =
            (phase && phase !== "idle") ||
            (Array.isArray(subscribeResp.pendingUserMessageIds) &&
              (subscribeResp.pendingUserMessageIds as unknown[]).length > 0) ||
            typeof subscribeResp.runningUserMessageId === "string"
          useChatStore
            .getState()
            .setSuggestedPromptsSuppressed(channelId as string, Boolean(turnInCourse))
          // Applied AFTER history load below so the statuses survive the upsert.
          const pendingIds = Array.isArray(subscribeResp.pendingUserMessageIds)
            ? (subscribeResp.pendingUserMessageIds as string[])
            : []
          const runningId = typeof subscribeResp.runningUserMessageId === 'string'
            ? subscribeResp.runningUserMessageId
            : undefined
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(subscribeResp as any).__appliedPendingIds = pendingIds
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(subscribeResp as any).__appliedRunningId = runningId
        }

        const {
          messages: history,
          hasMore,
        } = await client.channel.getMessages(channelId as string, 20)
        setHasMoreMessages(hasMore)

        // Token usage is admin-only now (Pablo, 2026-10-30): channel.get-messages
        // no longer carries tokenBudget. Admins read it from the admin-api domain
        // (requireAdmin-guarded server-side); non-admins never see the data.
        // Role is read imperatively (store snapshot) so this closure never goes
        // stale and the effect's dep array stays untouched.
        const role = useAuthStore.getState().user?.role
        if (role === "admin" || role === "super") {
          try {
            const { budget } = await client.admin.channelTokenBudget(channelId as string)
            if (budget) {
              setTokenBudget(budget)
            }
          } catch (err) {
            console.warn("[useChatChannel] Failed to load admin token budget:", err)
          }
        }

        const historicalMessages: Message[] = history
          .map((msg: any) => {
            const isUserMsg = msg.role === "user"
            const persistedQueueState: 'pending' | 'running' | 'done' | undefined =
              msg.meta?.queueState
            const status: Message['status'] =
              isUserMsg && persistedQueueState === 'pending'
                ? 'queued'
                : isUserMsg
                  ? 'sent'
                  : undefined
            return {
              id: msg.messageId || msg.id,
              channelId: channelId as string,
              content: msg.content,
              sender: (msg.sender?.type ??
                (msg.source === "voice" ? (msg.role === "user" ? "user" : "agent") : "agent")) as
                | "user"
                | "agent"
                | "system",
              senderInfo: msg.sender
                ? {
                    type: msg.sender.type,
                    id: msg.sender.id,
                    name: msg.sender.name,
                    avatarUrl: msg.sender.avatarUrl,
                  }
                : undefined,
              source: msg.source,
              // REQ-9 (F3b): overheard flag rides with source:'voice' — the
              // tenue row routing depends on it.
              ...(msg.overheard !== undefined ? { overheard: msg.overheard } : {}),
              timestamp: new Date(msg.timestamp),
              isStreaming: false,
              ...(msg.redacted !== undefined ? { redacted: msg.redacted } : {}),
              ...(msg.redactedBy ? { redactedBy: msg.redactedBy } : {}),
              ...(msg.redactedAt ? { redactedAt: msg.redactedAt } : {}),
              ...(msg.redactedPlaceholder ? { redactedPlaceholder: msg.redactedPlaceholder } : {}),
              // v2 non-blocking: pointer to the pending form this message
              // answered in chat (spec §Implementation design 2) — renders
              // the "answered the form" pill.
              ...(msg.respondsTo ? { respondsTo: msg.respondsTo } : {}),
              ...(status ? { status } : {}),
            } as Message
          })
          .sort((a: Message, b: Message) => a.timestamp.getTime() - b.timestamp.getTime())

        historicalMessages.forEach((msg) => {
          useChatStore.getState().upsertMessage(msg, true)
        })

        // `channel_messages` (read by `getMessages`) doesn't carry `meta.queueState` — that lives in `session_messages`.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const appliedPendingIds = (subscribeResp as any)?.__appliedPendingIds as
          | string[]
          | undefined
        if (appliedPendingIds?.length) {
          const store = useChatStore.getState()
          for (const id of appliedPendingIds) {
            if (store.messages[id]) {
              store.updateMessage(id, { status: 'queued' })
            }
          }
        }

        if (!hasCached) {
          setIsChatReady(true)
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
        // Explicitly close the stream — `text_complete` doesn't fire on tool_call or end_turn without an explicit text close.
        store.updateMessage(messageId, {
          content: data.message.content,
          timestamp: new Date(data.message.timestamp),
          isStreaming: false,
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
        // Voice transcripts (F0 single channel) persist with `role` but no
        // `sender` — derive it so the user's spoken words render on their
        // side of the thread (F3b, ui-evolution §2.4.4).
        sender: (data.message.sender?.type ??
          (data.message.source === "voice"
            ? data.message.role === "user"
              ? "user"
              : "agent"
            : "agent")) as "user" | "agent" | "system",
        senderInfo: data.message.sender
          ? {
              type: data.message.sender.type,
              id: data.message.sender.id,
              name: data.message.sender.name,
              avatarUrl: data.message.sender.avatarUrl,
            }
          : undefined,
        source: data.message.source,
        // REQ-9 (F3b): overheard flag rides with source:'voice'.
        ...(data.message.overheard !== undefined
          ? { overheard: data.message.overheard }
          : {}),
        timestamp: new Date(data.message.timestamp),
        isStreaming: false,
        // v2 non-blocking: pointer to the pending form this message answered
        // in chat — same passthrough as the history-load path.
        ...(data.message.respondsTo ? { respondsTo: data.message.respondsTo } : {}),
      }

      store.upsertMessage(message)
    }

    const applyQueueState = (
      messageId: string,
      state: 'pending' | 'running' | 'done',
      assistantId: string | undefined,
    ) => {
      const store = useChatStore.getState()
      if (state === 'pending') {
        // El selector `displayedMessageIds` en ChatView flota los queued
        // al final visualmente — no hace falta reorder aquí.
        store.updateMessage(messageId, { status: 'queued' })
        return
      }
      if (state === 'running') {
        store.updateMessage(messageId, { status: 'sent' })
        store.reorderMessageToEnd(channelId, messageId)
        return
      }
      // state === 'done'
      store.updateMessage(messageId, { status: 'sent' })
      if (assistantId && store.messages[assistantId]) {
        store.reorderMessageBefore(channelId, messageId, assistantId)
      }
    }

    const handleQueueState = (data: any) => {
      if (data.channelId !== channelId) return
      const messageId: string | undefined = data.messageId
      const state: 'pending' | 'running' | 'done' | undefined = data.state
      const assistantId: string | undefined = data.assistantId
      if (!messageId || !state) return
      // Retry: this event can land before the temp_id has been swapped via the `message_sent` ack.
      const tryApply = (attempt: number) => {
        if (useChatStore.getState().messages[messageId]) {
          applyQueueState(messageId, state, assistantId)
          return
        }
        if (attempt >= 3) {
          console.warn('[useChatChannel] handleQueueState abandoned after 3 retries', { messageId, state })
          return
        }
        const delay = attempt === 0 ? 200 : attempt === 1 ? 500 : 1500
        setTimeout(() => tryApply(attempt + 1), delay)
      }
      tryApply(0)
    }

    const handleAgentPhase = (data: any) => {
      if (data.channelId !== channelId) return
      const phase: 'idle' | 'thinking' | 'streaming_text' | 'executing_tool' | undefined = data.phase
      if (!phase) return
      useChatStore.getState().setAgentPhase(channelId, phase)
      // v1.4.4: chips visibility follows the turn. Any ACTIVE phase → hidden
      // (covers a queued turn starting right after the previous one ended —
      // the FIFO drain is immediate, the flag must not lag behind it).
      // idle → show again, UNLESS user messages still sit in the FIFO/flight:
      // another turn is about to run and would re-stale whatever set shows.
      if (phase === 'idle') {
        const s = useChatStore.getState()
        const ids = s.channelMessages[channelId] || []
        const hasPendingUser = ids.some((id) => {
          const m = s.messages[id]
          return m?.sender === 'user' && (m.status === 'queued' || m.status === 'sending')
        })
        if (!hasPendingUser) s.setSuggestedPromptsSuppressed(channelId, false)
      } else {
        useChatStore.getState().setSuggestedPromptsSuppressed(channelId, true)
      }
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
        useChatStore.getState().upsertToolMessage(data.messageId, channelId, {
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          mcaId: data.mcaId,
          input: data.toolInput,
          status: "running",
        })
      } else if (chunkType === "tool_call_complete") {
        useChatStore.getState().upsertToolMessage(data.messageId, channelId, {
          toolCallId: data.toolCallId,
          status: data.toolStatus === "completed" ? "completed" : "failed",
          output: data.toolOutput,
          error: data.toolError,
          duration: data.toolDuration,
          attachments: data.attachments,
          // Clear permission/form flow fields on completion.
          permissionRequestId: undefined,
          formRequestId: undefined,
        })
      } else if (chunkType === "tool_status_update") {
        // Intermediate state during the permission/form flows:
        //   pending → pending_permission | pending_user_input → running → completed/failed
        // When transitioning OUT of the waiting state, clear its requestId so
        // the widget (ControlsBar / FormWidget) disappears immediately.
        useChatStore.getState().upsertToolMessage(data.messageId, channelId, {
          toolCallId: data.toolCallId,
          status: data.toolStatus,
          ...(data.toolStatus === "pending_permission" && data.permissionRequestId
            ? {
                permissionRequestId: data.permissionRequestId,
                appId: data.appId,
                ...(data.irreversible ? { irreversible: true } : {}),
              }
            : { permissionRequestId: undefined }),
          ...(data.toolStatus === "pending_user_input" && data.formRequestId
            ? { formRequestId: data.formRequestId }
            : { formRequestId: undefined }),
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
        // Preserve "queued" — the optimistic message may have already been flagged as waiting in the FIFO.
        const wasQueued = tempMessage?.status === "queued"
        store.updateMessageId(tempId, data.messageId, channelId)
        store.updateMessage(data.messageId, {
          status: wasQueued ? "queued" : "sent",
          retryData: undefined,
        })
      }
    }

    // Must exceed the 10s backend heartbeat by a wide margin so a single dropped/late event doesn't ghost the indicator mid-turn.
    const TYPING_HEARTBEAT_TIMEOUT = 30000

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

    const handleSystemEvent = (data: any) => {
      if (data.channelId === channelId && data.event) {
        const eventMessage: Message = {
          id: data.event.messageId || data.event.id,
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

      const normalized = normalizeError(error)

      const resolvedI18n = i18n.exists(normalized.i18nKey) ? i18n.t(normalized.i18nKey) : null

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
                    : normalized.errorType,
          userMessage: resolvedI18n || normalized.userMessage,
          technicalMessage:
            technicalParts.length > 0 ? technicalParts.join(" | ") : normalized.technicalMessage,
          context: {
            ...error.context,
            recoverable: normalized.recoverable,
            i18nKey: normalized.i18nKey,
          },
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
        if (data.scope !== undefined) updates.scope = data.scope
        // v2 non-blocking interactions: unified awaiting-user channel state
        // (form | permission | auth). null = nothing waiting — the chip hides.
        if (data.awaitingUser !== undefined) updates.awaitingUser = data.awaitingUser
        // Contextual composer suggestions — fresh set after each agent response.
        if (data.suggestedPrompts !== undefined) {
          updates.suggestedPrompts = data.suggestedPrompts
          // v1.4.4: a fresh set may show again — but NOT while another turn is
          // already in course (the broadcast is async and can land after the
          // FIFO drained the next queued message: its set would be stale for
          // the turn now running). Persist the set; gate on the live phase.
          const livePhase = useChatStore.getState().channels[channelId]?.agentPhase
          updates.suggestedPromptsSuppressed = livePhase !== undefined && livePhase !== 'idle'
        }

        if (Object.keys(updates).length > 0) {
          useChatStore.getState().updateChannel(channelId, updates)
        }
      }
    }

    const handleChannelScopeUpdated = (data: any) => {
      if (data.channelId === channelId) {
        useChatStore.getState().updateChannel(channelId, { scope: data.scope })
      }
    }

    const handleMessageFeedbackCreated = (data: any) => {
      if (data.channelId !== channelId) return
      if (data.userId !== user?.userId) return
      useChatStore.getState().setMessageFeedback(data.messageId, {
        rating: data.rating,
        reasons: data.reasons,
        hasComment: data.hasComment,
        createdAt: data.createdAt,
      })
    }

    const handleMessageActionExecuted = (data: any) => {
      if (data.channelId !== channelId) return
      if (data.userId !== user?.userId) return
      if (data.action === 'report') {
        useChatStore.getState().updateMessage(data.messageId, { reportedAt: data.createdAt })
      } else if (data.action === 'copy') {
        useChatStore.getState().updateMessage(data.messageId, { copiedAt: data.createdAt })
      }
    }

    // Handle message redaction state change (REQ-4, AC-5, AC-6, AC-7).
    // The broadcast contains NO message content — only the redaction state.
    // For owners: update the redacted flag on the existing message (content is already in store).
    // For non-owners: the message content was never received, so we just update the flag.
    // If the message is being un-redacted (redacted=false), non-owners would need a page reload
    // to fetch the now-visible content — the broadcast intentionally doesn't include it.
    // MUW-REQ-9: the creator keeps the content (click-to-reveal); every other
    // viewer must end up with exactly what the backend would serve them — the
    // obfuscated text + placeholder on redact, and the real content again on
    // un-redact (which the client no longer has, so it is refetched).
    const handleMessageRedacted = (data: any) => {
      if (data.channelId !== channelId) return
      const store = useChatStore.getState()
      const existing = store.messages[data.messageId]
      if (!existing) return
      const channel = store.channels[channelId as string] as any
      const creatorId = channel?.creatorId ?? channel?.userId
      const viewerId = useAuthStore.getState().user?.userId
      const isCreator = !!creatorId && creatorId === viewerId
      const stateUpdate = {
        redacted: data.redacted,
        ...(data.redactedBy ? { redactedBy: data.redactedBy } : {}),
        ...(data.redactedAt ? { redactedAt: data.redactedAt } : {}),
      }
      if (isCreator) {
        store.updateMessage(data.messageId, stateUpdate)
        return
      }
      if (data.redacted) {
        const text = existing.content?.type === "text" ? existing.content.text : ""
        store.updateMessage(data.messageId, {
          ...stateUpdate,
          content: { type: "text", text: obfuscateText(text) } as any,
          redactedPlaceholder: {
            type: "redacted",
            reason: "protected_by_owner",
            originalAuthor: (existing as any).sender?.type ?? (existing as any).role ?? "user",
            originalTimestamp:
              existing.timestamp instanceof Date ? existing.timestamp.toISOString() : String(existing.timestamp),
          },
        } as any)
        return
      }
      // Un-redacted for a non-creator: the real content lives only on the
      // backend — refetch the recent page and restore this message's content
      // in place (updateMessage keeps the store's own id/timestamp shape; a raw
      // upsert of the wire message would duplicate the row with a string
      // timestamp).
      store.updateMessage(data.messageId, { ...stateUpdate, redactedPlaceholder: undefined } as any)
      client.channel
        .getMessages(channelId as string, 50)
        .then(({ messages: page }) => {
          const fresh = page.find((m: any) => (m.messageId ?? m.id) === data.messageId)
          if (fresh?.content) {
            useChatStore.getState().updateMessage(data.messageId, { content: fresh.content, redacted: false, redactedPlaceholder: undefined } as any)
          }
        })
        .catch((err) => console.warn("[useChatChannel] refetch after un-redact failed:", err))
    }

    client.on("message", handleMessage)
    client.on("message_chunk", handleMessageChunk)
    client.on("message_sent", handleMessageSent)
    client.on("queue_state", handleQueueState)
    client.on("agent_phase", handleAgentPhase)
    client.on("typing", handleTyping)
    client.on("system_event", handleSystemEvent)
    client.on("channel_status", handleChannelStatus)
    client.on("channel_scope_updated", handleChannelScopeUpdated)
    client.on("conversation.message.feedback.created", handleMessageFeedbackCreated)
    client.on("conversation.message.action.executed", handleMessageActionExecuted)
    client.on("message_redacted", handleMessageRedacted)
    client.on("error", handleError)

    return () => {
      client.off("message", handleMessage)
      client.off("message_chunk", handleMessageChunk)
      client.off("message_sent", handleMessageSent)
      client.off("queue_state", handleQueueState)
      client.off("agent_phase", handleAgentPhase)
      client.off("typing", handleTyping)
      client.off("system_event", handleSystemEvent)
      client.off("channel_status", handleChannelStatus)
      client.off("channel_scope_updated", handleChannelScopeUpdated)
      client.off("conversation.message.feedback.created", handleMessageFeedbackCreated)
      client.off("conversation.message.action.executed", handleMessageActionExecuted)
      client.off("message_redacted", handleMessageRedacted)
      client.off("error", handleError)

      // Reset before unmount so re-entry doesn't flash a stale phase from the previous session.
      if (channelId) {
        useChatStore.getState().setAgentPhase(channelId, "idle")
      }

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
    setNotFound(false)
    conversationInitialized.current = false
    justSentMessage.current = false

    if (channelId) {
      useChatStore.getState().setTyping(channelId, false)
      // v1.4.4: leaving the channel — reset the chips' visibility gate so the
      // next mount hydrates it fresh from the subscribe snapshot.
      useChatStore.getState().setSuggestedPromptsSuppressed(channelId, false)
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
        // Voice transcripts (F0) persist with `role` but no `sender` — derive
        // it (F3b, ui-evolution §2.4.4). Same rule as the history/broadcast
        // ingestion paths.
        sender: (msg.sender?.type ??
          (msg.source === "voice" ? (msg.role === "user" ? "user" : "agent") : "agent")) as
          | "user"
          | "agent"
          | "system",
        senderInfo: msg.sender
          ? {
              type: msg.sender.type,
              id: msg.sender.id,
              name: msg.sender.name,
              avatarUrl: msg.sender.avatarUrl,
            }
          : undefined,
        source: msg.source,
        timestamp: new Date(msg.timestamp),
        isStreaming: false as const,
        // Redaction fields — must be preserved so MessageBubble routes to
        // RedactedMessageBubble instead of crashing on null content.
        // @fixme nira - 2026.09.15 : this duplicates the field-spreading in the
        // initial-load map above (lines 401-404); extract into a shared
        // normalizeMessage helper to prevent future drift.
        ...(msg.redacted !== undefined ? { redacted: msg.redacted } : {}),
        ...(msg.redactedBy ? { redactedBy: msg.redactedBy } : {}),
        ...(msg.redactedAt ? { redactedAt: msg.redactedAt } : {}),
        ...(msg.redactedPlaceholder ? { redactedPlaceholder: msg.redactedPlaceholder } : {}),
        // v2 non-blocking: pointer to the pending form this message answered
        // in chat — same passthrough as the other ingestion paths.
        ...(msg.respondsTo ? { respondsTo: msg.respondsTo } : {}),
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
    notFound,
    agentName,
    agentRole,
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
