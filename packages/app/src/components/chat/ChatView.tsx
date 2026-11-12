/**
 * ChatView - Reusable chat component
 *
 * Extracted from app/chat/[channelId].tsx to be used in:
 * - The window system (ChatWindowContent)
 * - The traditional route (for compatibility)
 *
 * Logic is distributed across hooks:
 * - useChatChannel  → connection, conversation loading, subscription, event listeners
 * - useChatPermissions → inline tool permissions
 * - useChatScroll   → scroll state and handlers
 * - useChatInput    → send, retry and rename
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native"
import { useRouter } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { XStack, YStack } from "tamagui"
import { useColors } from "../mca/primitives/useColors"
import { useShallow } from "zustand/react/shallow"
import { Avatar } from "../Avatar"
import { Btn, IconBtn, Ph, T } from "../ui/ds"
import { fx } from "../../styles/fx"
import { ChatPaneContext, type ChatPaneLayout, THREAD_MAX_WIDTH, threadPadH } from "./bubbles"
import { useVoiceSession } from "../../contexts/VoiceSessionContext"
import { useFeatureFlagsStore, getResolvedFlag } from "../../store/featureFlagsStore"
import { useChatChannel } from "../../hooks/chat/useChatChannel"
import { useChatInput } from "../../hooks/chat/useChatInput"
import { useChatPermissions } from "../../hooks/chat/useChatPermissions"
import { usePermissionGroups } from "../../hooks/chat/usePermissionGroups"
import { useChatScroll } from "../../hooks/chat/useChatScroll"
import { MessageList, type TailState } from "./MessageList"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useChatStore } from "../../store/chatStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { InputComposer, type AudioRecording } from "../InputComposer"
import type { Message } from "../MessageBubble"
import { MessageItem } from "../MessageItem"
import { PermissionContext } from "../mca"
import {
  PermissionGroupFooter,
  PermissionGroupHeader,
} from "../mca/primitives/GroupedPermissionPanel"
import { TerosLoading } from "../TerosLoading"
import { useToast } from "../Toast"
import { VoiceControlsBar } from "../voice/VoiceControlsBar"
import { VoiceErrorBanner } from "../voice/VoiceErrorBanner"
import { ChatHeader } from "./ChatHeader"
import { LetterEmptyState } from "./LetterEmptyState"
import { MoveToWorkspaceModal } from "../MoveToWorkspaceModal"
import { PrePublishWarningDialog } from "./PrePublishWarningDialog"
import { useScopeToggle } from "../../hooks/chat/useScopeToggle"
import { useChannelAgentHours } from "../../hooks/useChannelAgentHours"

// ============================================
// CONSTANTS
// ============================================

const EMPTY_MESSAGE_IDS: string[] = []

/** Sentinel id used in `threadIds` to render the typing indicator inline in
 * the thread (between the queued messages and the last message
 * que se está procesando). */
const TYPING_INDICATOR_ITEM_ID = "__typing_indicator__"

// ============================================
// PROPS
// ============================================

export interface ChatViewProps {
  /** Channel ID - undefined for new chat */
  channelId?: string
  /** Agent ID - to create a new chat with a specific agent */
  agentId?: string
  /** Workspace ID - if creating channel within a workspace */
  workspaceId?: string
  /** Callback when a channel is created (for new chats) */
  onChannelCreated?: (channelId: string) => void
  /** Callback when the title changes */
  onTitleChange?: (title: string) => void
  /** Whether to show the header with avatar and title */
  showHeader?: boolean
  /** Bottom inset for the input (safe area) */
  bottomInset?: number
  /** Tiling window ID — forwarded to InputComposer for Alt+X active-window guard */
  windowId?: string
  /** Text pre-filled in the composer (from the Home ask box). */
  initialDraft?: string
}

// ============================================
// COMPONENT
// ============================================

export function ChatView({
  initialDraft,
  channelId,
  agentId: initialAgentId,
  workspaceId,
  onChannelCreated,
  onTitleChange,
  showHeader = true,
  bottomInset,
  windowId,
}: ChatViewProps) {
  const { t } = useTranslation()
  const c = useColors()
  const insets = useSafeAreaInsets()
  const isNewChat = !channelId

  // ----------------------------------------
  // Pane geometry (OS prototype `@container pane`): the header, thread and
  // composer switch to the compact density when the pane is ≤ 620px wide.
  // ----------------------------------------
  const [paneWidth, setPaneWidth] = useState(0)
  const pane = useMemo<ChatPaneLayout>(
    () => ({
      width: paneWidth,
      compact: paneWidth > 0 && paneWidth <= 620,
      narrow: paneWidth > 0 && paneWidth <= 460,
    }),
    [paneWidth],
  )
  const padH = threadPadH(pane)

  // ----------------------------------------
  // Zustand: message IDs for this channel
  // ----------------------------------------
  const messageIds = useChatStore(
    useCallback(
      (state) => {
        return channelId ? state.channelMessages[channelId] || EMPTY_MESSAGE_IDS : EMPTY_MESSAGE_IDS
      },
      [channelId],
    ),
  )

  // Separa user messages `queued` del resto. Los queued se renderizan
  // siempre en última posición visual del chat (sin importar el orden
  // de inserción interno). Cuando pasan a `sent`, salen de esta lista.
  // Dos selectores separados con `useShallow` para que cada array haga
  // shallow-compare por elementos (no por referencia del objeto wrapper).
  const restIds = useChatStore(
    useShallow((state) => {
      if (!channelId) return EMPTY_MESSAGE_IDS
      const ids = state.channelMessages[channelId]
      if (!ids || ids.length === 0) return EMPTY_MESSAGE_IDS
      const out: string[] = []
      for (const id of ids) {
        if (state.messages[id]?.status !== "queued") out.push(id)
      }
      return out.length === ids.length ? ids : out.length === 0 ? EMPTY_MESSAGE_IDS : out
    }),
  )
  const queuedIds = useChatStore(
    useShallow((state) => {
      if (!channelId) return EMPTY_MESSAGE_IDS
      const ids = state.channelMessages[channelId]
      if (!ids || ids.length === 0) return EMPTY_MESSAGE_IDS
      const out: string[] = []
      for (const id of ids) {
        if (state.messages[id]?.status === "queued") out.push(id)
      }
      return out.length === 0 ? EMPTY_MESSAGE_IDS : out
    }),
  )

  // Zustand: typing indicator
  const isTyping = useChatStore(
    useCallback(
      (state) => (channelId ? (state.channels[channelId]?.isTyping ?? false) : false),
      [channelId],
    ),
  )

  const agentPhase = useChatStore(
    useCallback(
      (state) => (channelId ? state.channels[channelId]?.agentPhase : undefined),
      [channelId],
    ),
  )

  // Contextual composer suggestions (backend-generated after each agent
  // response). Selector returns a joined STRING — never a fresh array — so
  // zustand's Object.is comparison can't loop re-renders (same lesson as
  // awaitingUser). InputComposer splits it back into chips.
  const suggestedPromptsKey = useChatStore(
    useCallback(
      (state) => {
        if (!channelId) return ""
        const prompts = state.channels[channelId]?.suggestedPrompts
        return prompts?.length ? prompts.join("\u0000") : ""
      },
      [channelId],
    ),
  )
  const suggestedPrompts = useMemo(
    () => (suggestedPromptsKey ? suggestedPromptsKey.split("\u0000") : []),
    [suggestedPromptsKey],
  )

  // v1.4.4: while a user message is in flight or the agent's turn is running
  // (thinking / streaming / executing a tool), the chips must not show — the
  // old set is stale the instant the user sends. Boolean selector — only
  // re-renders when it flips. Cleared by useChatChannel when a fresh set
  // arrives (channel_status) or the turn ends (agentPhase idle).
  const suggestedPromptsSuppressed = useChatStore(
    useCallback(
      (state) => (channelId ? (state.channels[channelId]?.suggestedPromptsSuppressed ?? false) : false),
      [channelId],
    ),
  )
  // The chips the composer actually renders: empty while suppressed → the
  // row unmounts (fade out); the persisted set stays untouched in the store.
  const visibleSuggestedPrompts = suggestedPromptsSuppressed ? [] : suggestedPrompts

  // ≥1 message (queued or persisted) → the composer swaps the tools row for
  // the contextual suggestion chips. Empty conversation keeps the tools row.
  const hasMessages = restIds.length > 0 || queuedIds.length > 0
  // The turn may be blocked waiting on the user (permission or inline form):
  // showing "thinking" while the ball is in THEIR court reads as a bug.
  // Boolean selector — only re-renders when it flips.
  const hasPendingInteraction = useChatStore(
    useCallback(
      (state) => {
        if (!channelId) return false
        const ids = state.channelMessages[channelId]
        if (!ids?.length) return false
        return ids.some((id) => {
          const content = state.messages[id]?.content
          return (
            content?.type === "tool_execution" &&
            (content.status === "pending_permission" || content.status === "pending_user_input")
          )
        })
      },
      [channelId],
    ),
  )

  // The unified awaiting-user channel state. Reads channel_status.awaitingUser
  // (form | permission | auth); falls back to scanning pending permissions
  // only — forms re-broadcast awaiting_user on restore (restorePendingForms),
  // but restorePendingApprovals does not, so the scan is the permission chip's
  // reload hydration.
  // NOTE: the selector returns a STRING, never a fresh object — zustand v5
  // compares snapshots with Object.is; an object literal here re-renders
  // forever (Maximum update depth exceeded, seen in InputComposer).
  const awaitingUser = useChatStore(
    useCallback(
      (state): "form" | "permission" | "auth" | null => {
        if (!channelId) return null
        const explicit = (state.channels[channelId] as any)?.awaitingUser
        if (explicit) return explicit.kind as "form" | "permission" | "auth"
        // Fallback: a pending permission tool_execution (reload hydration).
        const ids = state.channelMessages[channelId]
        if (!ids?.length) return null
        for (let i = ids.length - 1; i >= 0; i--) {
          const content = state.messages[ids[i]]?.content
          if (content?.type !== "tool_execution") continue
          if (content.status === "pending_permission") return "permission"
        }
        return null
      },
      [channelId],
    ),
  )

  // Detect if there's an irreversible tool currently running or awaiting
  // permission — forwarded to InputComposer so StopButton shows the hard-cancel
  // warning with the tool name instead of a generic message.
  // useShallow: el selector construye un objeto nuevo en cada evaluación;
  // sin shallow-compare, zustand v5 (Object.is) entra en bucle de renders.
  const irreversibleToolInFlight = useChatStore(
    useShallow((state) => {
      if (!channelId) return { active: false, toolName: undefined }
      const ids = state.channelMessages[channelId]
      if (!ids?.length) return { active: false, toolName: undefined }
      for (let i = ids.length - 1; i >= 0; i--) {
        const msg = state.messages[ids[i]]
        if (!msg) continue
        if (msg.sender === "user") break
        const c = msg.content
        if (
          c?.type === "tool_execution" &&
          c.irreversible &&
          (c.status === "running" || c.status === "pending_permission")
        ) {
          return { active: true, toolName: c.toolName }
        }
      }
      return { active: false, toolName: undefined }
    }),
  )

  // Visible mientras el tracker reporta canal activo (debounced), salvo durante
  // `streaming_text` (el bubble ya revela texto y el indicator sería ruido) y
  // salvo con una interacción pendiente (permiso/form) — see above.
  const showTypingIndicator = agentPhase !== "streaming_text" && isTyping && !hasPendingInteraction

  // Zustand: channel scope — a missing scope counts as personal (MUW-NFR-3).
  const isPersonal = useChatStore(
    useCallback(
      (state) =>
        channelId
          ? ((state.channels[channelId] as any)?.scope ?? "personal") === "personal"
          : true,
      [channelId],
    ),
  )

  // ----------------------------------------
  // Hook: channel, conversation & messages
  // ----------------------------------------
  const {
    user,
    conversation,
    connected,
    isLoading,
    notFound,
    agentName,
    agentAvatarUrl,
    agentRole,
    modelString,
    modelName,
    providerName,
    workspaceInfo,
    tokenBudget,
    isChatReady,
    hasMoreMessages,
    isLoadingMore,
    conversationInitialized,
    justSentMessage,
    setConversation,
    setIsChatReady,
    setModelString,
    setModelName,
    setProviderName,
    loadMoreMessages,
  } = useChatChannel(channelId, initialAgentId, workspaceId, onTitleChange, messageIds)

  // Helper used by useChatScroll to check cached messages
  const getHasCachedMessages = useCallback(() => {
    return channelId ? (useChatStore.getState().channelMessages[channelId]?.length ?? 0) > 0 : false
  }, [channelId])

  // ----------------------------------------
  // Hook: scroll
  // ----------------------------------------
  const { listRef, scrollToBottom } = useChatScroll()
  // Where the reader is: `pinned` is the sticky follow (the thread tracks the
  // live tail); `unseen` flags rows that arrived while they were scrolled up.
  // Drives the "jump to the latest" arrow — always visible while unpinned,
  // with the indigo pip only while there is unseen content.
  const [tail, setTail] = useState<TailState>({ pinned: true, unseen: false })

  // The anchor rule: the thread follows its tail ONLY while the reader is at
  // the bottom (MessageList pins itself there and releases when they scroll
  // up to read). The one thing that always brings the viewport down is the
  // reader's OWN send. Tracked by last id (not length) so loading older
  // messages never moves the viewport.
  const lastChronologicalId = useMemo(() => {
    const allIds = queuedIds.length > 0 ? [...restIds, ...queuedIds] : restIds
    return allIds[allIds.length - 1]
  }, [restIds, queuedIds])
  const lastMessageIdRef = useRef<string | undefined>(lastChronologicalId)
  const currentUserId = user?.userId
  useEffect(() => {
    const prevLastId = lastMessageIdRef.current
    lastMessageIdRef.current = lastChronologicalId
    if (!lastChronologicalId || prevLastId === undefined || lastChronologicalId === prevLastId)
      return
    const msg = useChatStore.getState().messages[lastChronologicalId]
    const own =
      msg?.sender === "user" &&
      (!msg.senderInfo?.id || !currentUserId || msg.senderInfo.id === currentUserId)
    if (own) scrollToBottom()
  }, [lastChronologicalId, scrollToBottom, currentUserId])

  // ----------------------------------------
  // Hook: permissions
  // ----------------------------------------
  const permissionContextValue = useChatPermissions(channelId)

  // PERMW-REQ-3: runs of ≥2 tools awaiting approval get a frame — a header
  // before the first pending card and Deny all / Allow all after the last card.
  // Every card keeps its own detail and ControlsBar.
  const { groupByAnchorId, groupByFirstPendingId } = usePermissionGroups(channelId)

  // Close this chat window after archiving (the window belongs to the tiling manager).
  const closeWindow = useTilingStore((s) => s.closeWindow)

  // Move to workspace modal state
  const [showMoveModal, setShowMoveModal] = useState(false)

  const handleMoveToWorkspace = useCallback(() => {
    setShowMoveModal(true)
  }, [])

  const handleMovedToWorkspace = useCallback(() => {
    // Close the chat window — the conversation now belongs to a different workspace
    if (windowId) closeWindow(windowId)
  }, [windowId, closeWindow])

  // ----------------------------------------
  // Hook: input / send
  // ----------------------------------------
  const { handleSend, handleRetryMessage, handleRenameChannel, handleArchive } = useChatInput({
    channelId,
    initialAgentId,
    workspaceId,
    conversation,
    onChannelCreated,
    onTitleChange,
    setModelString,
    setModelName,
    setProviderName,
    setConversation,
    onArchived: windowId ? () => closeWindow(windowId) : undefined,
  })

  // ----------------------------------------
  // Voice session integration
  // ----------------------------------------
  const voiceSession = useVoiceSession()
  // Read voice.enabled without subscribing to the store — avoids re-renders on flag hydration
  // which caused InputComposer to remount and oscillate between single/multiline layout.
  const isVoiceEnabled = getResolvedFlag<boolean>(useFeatureFlagsStore.getState(), "voice.enabled")
  // v2 (F3a): the presence UI (orb + bloom + mode) lives behind its own flag —
  // off = the legacy composer swap keeps working untouched (zero regression).
  const isVoiceModeUiEnabled =
    isVoiceEnabled && getResolvedFlag<boolean>(useFeatureFlagsStore.getState(), "voice.mode-ui")

  // Resolve the agent ID: prefer the one from the conversation participants
  const channelAgentId = useMemo(() => {
    const agentParticipant = conversation?.participants.find((p) => p.role === "agent")
    return agentParticipant?.agentId
  }, [conversation?.participants])

  // Channel scope — used for authorship display in shared conversations (MUW-REQ-8).
  const channelScope = conversation?.scope

  // Whether the current user is the channel owner/creator (for redaction UI, REQ-4)
  const isChannelOwner = useMemo(() => {
    if (!conversation?.userId || !user?.userId) return false
    return conversation.userId === user.userId
  }, [conversation?.userId, user?.userId])

  // Display name of the channel creator for the non-owner "Protected by …"
  // label (MUW-REQ-9). Only the creator can redact, so the protector is the
  // creator. The channel payload carries no name, but every message in a
  // shared conversation carries its author's senderInfo (MUW-REQ-8), so the
  // creator's name is read from any message they wrote; undefined → the
  // bubble falls back to the generic "Owner" label (never the conversation
  // title, which is what v1 showed).
  const creatorId = conversation?.userId
  const channelOwnerName = useChatStore(
    useCallback(
      (state) => {
        if (!channelId || !creatorId) return undefined
        for (const id of state.channelMessages[channelId] ?? []) {
          const info = state.messages[id]?.senderInfo
          if (info?.type === "user" && info.id === creatorId && info.name) return info.name
        }
        return undefined
      },
      [channelId, creatorId],
    ),
  )

  // Toggle redaction on a message (AC-5, AC-7). Owner only.
  const handleToggleRedaction = useCallback(
    async (messageId: string, redacted: boolean) => {
      if (!channelId) return
      try {
        await getTerosClient().channel.toggleRedaction(channelId, messageId, redacted)
      } catch (err) {
        console.error("[ChatView] toggleRedaction failed:", err)
      }
    },
    [channelId],
  )

  // Scope toggle (MUW-15) — shared hook with the conversation list.
  // When the owner toggles personal↔shared from inside the chat, the same
  // pre-publish scan → warning dialog flow runs (MUW-10).
  const {
    isScanning: isScanningScope,
    showWarning: showScopeWarning,
    personalApps: scopeWarningApps,
    toggleScope: toggleChannelScope,
    confirmPublishAnyway: confirmScopePublish,
    cancelPublishWarning: cancelScopeWarning,
  } = useScopeToggle()

  // WS2: agent-hours of THIS conversation in the current billing period —
  // feeds the header chip. Shared cache: if the conversations list or a task
  // already loaded this channel, no extra call happens.
  const agentHoursInfo = useChannelAgentHours(channelId)

  // ----------------------------------------
  // Thread ids, CHRONOLOGICAL (top→bottom visual):
  //   [old, ..., last_being_processed, TYPING_INDICATOR, queued1, ..., queuedN]
  // MessageList owns how that becomes a scroller on each platform.
  // ----------------------------------------
  const threadIds = useMemo(() => {
    if (!showTypingIndicator && queuedIds.length === 0) return restIds
    const items: string[] = [...restIds]
    if (showTypingIndicator) items.push(TYPING_INDICATOR_ITEM_ID)
    for (const id of queuedIds) items.push(id)
    return items
  }, [queuedIds, restIds, showTypingIndicator])

  // ----------------------------------------
  // Render helper — memoized so MessageList rows don't re-render needlessly.
  // `index` is chronological: previous = index - 1 (older, above),
  // next = index + 1 (newer, below).
  // ----------------------------------------
  const renderMessageId = useCallback(
    (messageId: string, index: number) => {
      if (messageId === TYPING_INDICATOR_ITEM_ID) {
        // Indicator inline, debajo del último mensaje "no queued".
        // `.thinking` — the agent turn opening: story avatar + name, then
        // the loader with "is thinking…" in sans 13 text2.
        return (
          <XStack
            width="100%"
            maxWidth={THREAD_MAX_WIDTH + padH * 2}
            alignSelf="center"
            paddingTop={18}
            paddingHorizontal={padH}
            alignItems="flex-start"
            gap={14}
            animation="quick"
            enterStyle={{ opacity: 0 }}
            exitStyle={{ opacity: 0 }}
            accessibilityLiveRegion="polite"
            role="status"
            aria-live="polite"
          >
            <Avatar
              name={agentName || "Agente"}
              imageUrl={agentAvatarUrl ?? undefined}
              size={36}
              isAgent={true}
              status="busy"
            />
            <YStack flex={1} minWidth={0} gap={6}>
              <T step="xl" numberOfLines={1}>
                {agentName || t("chatView.typing.label", { name: "Agente" })}
              </T>
              <XStack alignItems="center" gap={8}>
                <TerosLoading size={18} color={c.accent} />
                <T step="sm" tone="text2">
                  {t("chatView.typing.thinking")}
                </T>
              </XStack>
            </YStack>
          </XStack>
        )
      }
      // PERMW-REQ-3: the batch frame. The header goes right before the first
      // pending card of a run of ≥2 pending tools, the footer right after the
      // last card of the run.
      const headerGroup = groupByFirstPendingId.get(messageId)
      const footerGroup = groupByAnchorId.get(messageId)
      const frameStyle = {
        width: "100%",
        maxWidth: THREAD_MAX_WIDTH + padH * 2,
        alignSelf: "center",
        paddingHorizontal: padH,
        paddingLeft: padH + (pane.compact ? 0 : 50),
      } as const
      return (
        <>
          {headerGroup && (
            <View style={[frameStyle, { paddingTop: 12 }]}>
              <PermissionGroupHeader tools={headerGroup.tools} />
            </View>
          )}
          <MessageItem
            messageId={messageId}
            previousMessageId={index > 0 ? threadIds[index - 1] : undefined}
            nextMessageId={index < threadIds.length - 1 ? threadIds[index + 1] : undefined}
            channelAgentId={channelAgentId}
            channelAgentName={agentName || t("conversation.agent")}
            channelAgentAvatarUrl={agentAvatarUrl}
            channelScope={channelScope}
            isChannelOwner={isChannelOwner}
            channelOwnerName={channelOwnerName}
            onToggleRedaction={handleToggleRedaction}
            onRetry={handleRetryMessage}
          />
          {footerGroup && (
            <View style={[frameStyle, { paddingTop: 4 }]}>
              <PermissionGroupFooter tools={footerGroup.tools} />
            </View>
          )}
        </>
      )
    },
    [
      threadIds,
      channelAgentId,
      channelScope,
      isChannelOwner,
      channelOwnerName,
      handleToggleRedaction,
      handleRetryMessage,
      agentName,
      agentAvatarUrl,
      t,
      groupByAnchorId,
      groupByFirstPendingId,
      padH,
      pane.compact,
      c.accent,
    ],
  )
  // The effective agent ID for voice (conversation agent > prop)
  const effectiveAgentId = channelAgentId || initialAgentId

  // Is there an active voice session for THIS agent AND this chat channel?
  // We consider voice "active" (i.e. show voice UI) when:
  //   - The feature flag voice.enabled is true, AND
  //   - The agent matches AND the WS is connected/connecting, OR
  //   - The agent matches AND there are transcripts to show (even after disconnect)
  // AF-3: After the channel-creation fix, voice is always started with a
  // concrete channelId. The ambiguous `(!channelId && !activeChatChannelId)`
  // fallback is removed — the guard is now unambiguous (AC-3.3).
  // AF-7: Also show voice UI when there's an error to display.
  const voiceAgentMatches =
    isVoiceEnabled &&
    !!effectiveAgentId &&
    voiceSession.activeAgentId === effectiveAgentId &&
    !!voiceSession.activeChatChannelId &&
    voiceSession.activeChatChannelId === channelId

  const isVoiceActive =
    voiceAgentMatches &&
    (voiceSession.isConnected ||
      voiceSession.state === "connecting" ||
      voiceSession.transcripts.length > 0 ||
      !!voiceSession.error)

  // AF-3: Lock to prevent double-tap creating two channels
  const voiceStartingRef = useRef(false)

  const handleStartVoice = useCallback(async () => {
    if (
      !effectiveAgentId ||
      !getResolvedFlag<boolean>(useFeatureFlagsStore.getState(), "voice.enabled")
    )
      return
    // AF-3: guard against rapid double-tap
    if (voiceStartingRef.current) return
    voiceStartingRef.current = true
    try {
      // AF-3: guarantee a Conversation ID before startSession.
      // For a new conversation that hasn't been persisted yet, create the
      // channel first so startSession never receives chatChannelId = null.
      let effectiveChannelId = channelId
      if (!effectiveChannelId) {
        const client = getTerosClient()
        const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? undefined
        const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId
        const result = await client.channel.create({
          agentId: effectiveAgentId,
          workspaceId: resolvedWorkspaceId,
        })
        effectiveChannelId = result.channelId
        // Route the UI to the new channel
        onChannelCreated?.(result.channelId)
      }

      // Start voice session linked to this chat channel so transcripts appear inline.
      // effectiveChannelId is never null here — AC-3.2.
      // Pablo (decision 2, PoC 2026-10-31): every door opens the presence in
      // Disponible — the chat door included (it opened in Conversando, which
      // answered the whole room).
      await voiceSession.startSession(effectiveAgentId, undefined, effectiveChannelId, "available")
    } catch (err) {
      console.error("[ChatView] handleStartVoice failed:", err)
      // AF-7: surface the error in the voice overlay so the user sees feedback
      // even when startSession was never reached (e.g. channel.create() failed).
      const message = err instanceof Error ? err.message : "Failed to start voice session"
      voiceSession.setError({ code: "unknown", message })
    } finally {
      voiceStartingRef.current = false
    }
  }, [effectiveAgentId, channelId, workspaceId, onChannelCreated, voiceSession])

  const handleStopVoice = useCallback(() => {
    voiceSession.stopSession()
  }, [voiceSession])

  // ── v2 error recovery actions (ui-evolution §3.3, UX §7.2) ────────────────
  // auth → "Iniciar sesión": the session died — take the user to the auth
  // surface (same route the logout page uses). flag_disabled → "Solicitar
  // acceso" also lands here for now (no dedicated request flow exists).
  const router = useRouter()
  const handleVoiceLogin = useCallback(() => {
    router.replace("/(auth)/login")
  }, [router])

  // ── v2 reconnection visual (UX §7.3) ──────────────────────────────────────
  // "Reconectado — sigue escuchando": the connection dropped, the orb showed
  // the amber blink with "intento n/5", and then it CAME BACK. That recovery
  // is worth announcing — the user can stop holding their breath. Fires on
  // the isReconnecting true→false transition with an active session.
  const toast = useToast()
  const wasReconnectingRef = useRef(false)
  useEffect(() => {
    const was = wasReconnectingRef.current
    wasReconnectingRef.current = voiceSession.isReconnecting
    if (!was || voiceSession.isReconnecting) return
    // Only announce recovery for a session that is still alive — a reconnect
    // that ended because the session ended is not "recovered".
    if (!voiceSession.isConnected) return
    if (!isVoiceModeUiEnabled) return
    toast.success(
      t("voice.reconnect.toast", { defaultValue: "Reconectado" }),
      t("voice.reconnect.toastBody", { defaultValue: "Sigue escuchando" }),
    )
  }, [voiceSession.isReconnecting, voiceSession.isConnected, isVoiceModeUiEnabled, toast, t])

  // ── v2 bloom/collapse (ui-evolution §2.5.2) ─────────────────────────────────
  // The dry swap (InputComposer ↔ VoiceControls) becomes bloom/collapse: the
  // composer is always mounted; with presence on, the orb floats above it; the
  // orb BLOOMS into VoiceControls on tap or when an invocation is accepted
  // (activity hearing/thinking/speaking), and collapses back to orb after 30s
  // of conversational inactivity in passive mode, or on tap.
  // v2 presence for THIS chat: the session's agent matches this conversation.
  const voicePresenceHere =
    isVoiceModeUiEnabled && voiceAgentMatches ? voiceSession.presence : ("off" as const)

  // The action bar is ALWAYS visible while the voice session lives here
  // (Pablo, 2026-10-05): no bloom/collapse, no 30s idle timer — a control
  // surface that appears and disappears on its own is state the user has
  // to track. The bar is born with the session and dies with it.

  // ── v2 closing receipt (ui-evolution §2.5.1 + §3.5, UX §5.5) ────────────────
  // When the presence stretch ends HERE (on → off/error), the thread keeps a
  // receipt: "Alice conectada 9:12–14:03 · 4h 51m" (or "· interrumpida" when
  // it died of error). Turning presence off is not losing the call — it's
  // saying goodbye to someone who was there, and the receipt makes it
  // tangible. It stays rendered until the next session starts here.
  const [closedReceipt, setClosedReceipt] = useState<{
    startedAt: number
    endedAt: number
    interrupted: boolean
  } | null>(null)
  const prevPresenceHereRef = useRef(voicePresenceHere)
  useEffect(() => {
    const prev = prevPresenceHereRef.current
    prevPresenceHereRef.current = voicePresenceHere
    if (prev === "on" && (voicePresenceHere === "off" || voicePresenceHere === "error")) {
      const startedAt = voiceSession.sessionStartedAt ?? Date.now()
      setClosedReceipt({
        startedAt,
        endedAt: Date.now(),
        interrupted: voicePresenceHere === "error" || !!voiceSession.error,
      })
    }
    // A new session here clears the old receipt — the new opening divider
    // takes over the thread's voice story.
    if (prev !== "on" && voicePresenceHere === "on") {
      setClosedReceipt(null)
    }
  }, [voicePresenceHere, voiceSession.sessionStartedAt, voiceSession.error])

  const handleStop = useCallback(
    async (kind: "soft" | "hard" | "queue_only") => {
      if (!channelId) return
      try {
        await getTerosClient().channel.stopMessage(channelId, kind)
      } catch (err) {
        console.error("[ChatView] stopMessage failed", err)
      }
    },
    [channelId],
  )

  // ----------------------------------------
  // Transcribe audio → text for composer
  // ----------------------------------------
  const handleTranscribe = useCallback(async (audio: AudioRecording): Promise<string> => {
    const client = getTerosClient()
    if (!audio.blob) throw new Error("No audio data available")

    const arrayBuffer = await audio.blob.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ""
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    const base64Data = btoa(binary)

    const result = await client.channel.transcribeAudio(base64Data, audio.blob.type)
    return result.text
  }, [])

  // ----------------------------------------
  // Not found state
  // ----------------------------------------
  if (notFound) {
    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        gap={12}
        paddingHorizontal={32}
        backgroundColor={c.bgSheet}
      >
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            backgroundColor: c.tile,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ph name="chat-circle-dots" size={26} color={c.accent} />
        </View>
        <T step="xl" center>
          {t("conversation.notFound")}
        </T>
        <T step="sm" tone="text3" center style={{ maxWidth: 360 }}>
          {t("conversation.notFoundDescription")}
        </T>
      </YStack>
    )
  }

  // ----------------------------------------
  // Loading state
  // ----------------------------------------
  if (isLoading || !conversation || !user) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor={c.bgSheet}>
        <TerosLoading size={48} color={c.accent} />
      </YStack>
    )
  }

  // `?? ` — a docked window passes 0 on purpose (the shell owns the safe
  // area); `||` turned that 0 back into the device inset and the composer
  // padded the safe zone a second time (the white band on iPhone).
  const effectiveBottomInset = bottomInset ?? insets.bottom
  // `.compose textarea::placeholder` — "Escribe a Iria…"
  const composerPlaceholder = agentName
    ? t("conversation.typeMessageTo", {
        defaultValue: "Write to {{name}}…",
        name: agentName,
      })
    : t("conversation.typeMessage")

  // ----------------------------------------
  // Render
  // ----------------------------------------
  return (
    <>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {/* The chat lives on the SHEET (OS prototype `.chat-view`): Main/100 in
          light, Main/900 in dark. Cards (tool calls, quotes, code) are one
          step off it; the composer pill rides it. The pane measures itself
          so the header / thread / composer can switch to the compact density. */}
        <ChatPaneContext.Provider value={pane}>
          <YStack
            flex={1}
            backgroundColor={c.bgSheet}
            onLayout={(e) => setPaneWidth(e.nativeEvent.layout.width)}
            testID="chat-view"
            // data-channel-id: lets the browser smoke scope in-chat widgets to THIS
            // conversation when several chat windows are open (preview tabs pin on write).
            {...({ dataSet: { channelId } } as object)}
          >
            {/* Header */}
            {showHeader && (
              <ChatHeader
                title={conversation.title}
                agentName={agentName || t("conversation.agent")}
                agentAvatarUrl={agentAvatarUrl}
                agentRole={agentRole}
                modelString={modelString}
                modelName={modelName}
                providerName={providerName}
                agentId={initialAgentId}
                isWorking={isTyping}
                scope={isPersonal ? "personal" : "shared"}
                tokenBudget={tokenBudget}
                workspace={workspaceInfo}
                onTitleChange={handleRenameChannel}
                onArchive={handleArchive}
                onMoveToWorkspace={channelId ? handleMoveToWorkspace : undefined}
                onStartVoice={effectiveAgentId ? handleStartVoice : undefined}
                isVoiceActive={isVoiceActive}
                voicePresence={isVoiceModeUiEnabled ? voiceSession.presence : undefined}
                voiceMode={isVoiceModeUiEnabled ? voiceSession.mode : undefined}
                channelScope={channelScope}
                isChannelOwner={isChannelOwner}
                onToggleScope={
                  channelId && channelScope
                    ? () => toggleChannelScope(channelId, channelScope)
                    : undefined
                }
                isScanningScope={isScanningScope}
                agentHours={agentHoursInfo.formatted || null}
              />
            )}

            {/* Messages — wrapped in PermissionContext for inline permission UI. The box is the
                scroller's positioning frame (the web list is absolutely inset). */}
            <PermissionContext.Provider value={permissionContextValue}>
              <YStack flex={1} overflow="hidden" position="relative">
                {/* Loading overlay while history loads — shown on top of whatever
              base content is rendered (the thread or the empty state). Suppressed
              when voice is active to avoid layering conflicts with the voice
              transcript panel. v2 (§2.5.6): with the unified thread the
              overlay never covers transcripts — voice lives IN the list. */}
                {!isChatReady && !isVoiceActive && (
                  <YStack
                    position="absolute"
                    top={0}
                    left={0}
                    right={0}
                    bottom={0}
                    justifyContent="center"
                    alignItems="center"
                    zIndex={1}
                  >
                    <TerosLoading size={48} color={c.accent} />
                  </YStack>
                )}

                {/* ── Base layer: chat history (always rendered) ──────────────
              The thread is the base content. Voice mode no longer replaces
              it — instead, voice transcripts and errors are overlaid as
              bottom panels (see below). This ensures the chat history stays
              visible while the user talks, and there is never a blank screen. */}
                {/* v2 (§2.5.1): with the unified thread, an active voice session
              here means there IS live content — render the thread (the
              voice section rides it), not the empty state. */}
                {isChatReady &&
                messageIds.length === 0 &&
                !isVoiceActive &&
                !voiceSession.error ? (
                  <LetterEmptyState
                    agentName={agentName || t("conversation.agent")}
                    agentAvatarUrl={agentAvatarUrl}
                    agentRole={agentRole}
                    agentId={channelAgentId ?? initialAgentId}
                    workspaceId={
                      workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? undefined
                    }
                    userName={user?.name}
                    // CSUM-REQ-4: on unless the user turned it off in the profile.
                    showSummary={user?.conversationSummary !== false}
                    onPromptSelected={(message) => {
                      handleSend(message).catch((err) =>
                        console.error("[ChatView] Letter prompt send failed:", err),
                      )
                    }}
                  />
                ) : (
                  <MessageList
                    ref={listRef}
                    ids={threadIds}
                    renderItem={renderMessageId}
                    onTailChange={setTail}
                    // Visual TOP: earlier history.
                    header={
                      hasMoreMessages ? (
                        <XStack justifyContent="center" paddingVertical={8} paddingBottom={18}>
                          {isLoadingMore ? (
                            <TerosLoading size={24} color={c.accent} />
                          ) : (
                            <Btn
                              variant="sec"
                              size="sm"
                              icon="arrow-up"
                              onPress={loadMoreMessages}
                            >
                              {t("conversation.loadEarlierMessages")}
                            </Btn>
                          )}
                        </XStack>
                      ) : null
                    }
                    // The live voice section (opening divider, delegation and
                    // permission rows, closing receipt) is NOT rendered: the
                    // conversation thread already shows the voice turns and the
                    // chat's own permission cards (Pablo, PoC 2026-10-31: "me
                    // sobra completamente, toda esta sección").
                  />
                )}

                {/* `.jump-tail` — visible whenever the reader is NOT sticky to
                    the tail, no matter how far up they scrolled. Pressing it
                    scrolls to the bottom and re-arms the sticky follow (the
                    MessageList pin). While rows arrived unseen, the brand
                    indigo pip rides on the corner; it clears the moment the
                    reader is back at the tail. */}
                {!tail.pinned ? (
                  <View
                    style={{
                      position: "absolute",
                      right: pane.compact ? 12 : 20,
                      bottom: 14,
                      zIndex: 3,
                    }}
                    {...fx("pop")}
                  >
                    <IconBtn
                      testID="jump-to-tail"
                      icon="arrow-down"
                      title={t("chatView.jumpToLatest", { defaultValue: "Jump to the latest" })}
                      onPress={() => scrollToBottom(true)}
                      style={{
                        backgroundColor: c.bgStep,
                        borderColor: "transparent",
                        ...(Platform.OS === "web" ? ({ boxShadow: c.liftSmHover } as any) : null),
                      }}
                    />
                    {tail.unseen ? (
                      <View
                        pointerEvents="none"
                        testID="jump-to-tail-pip"
                        style={{
                          position: "absolute",
                          top: 2,
                          right: 2,
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          // Brand indigo requested by Pablo (18-oct-2026) —
                          // NOT the theme accent (which is the violet ramp).
                          backgroundColor: "#5E6AD2",
                        }}
                      />
                    ) : null}
                  </View>
                ) : null}

                {/* ── Voice transcript panel (bottom overlay) ──────────────────
              Voice Mode v2 F3b (§2.5.1): ELIMINATED. With the single channel
              (F0/REQ-2), voice transcripts are PERSISTED messages of the
              conversation — they render as bubbles in the thread (the voice
              mark + the tenue overheard rows). The live-only frames
              (delegation events) ride the thread's bottom via
              ListHeaderComponent (VoiceThreadSection). The 220px overlay was
              a patch for the dual-write era; its removal is literal. */}

                {/* ── Voice error panel (bottom overlay) ───────────────────────
              v2 (ui-evolution §3.3): with the presence UI flag ON the
              inline block is replaced by VoiceErrorBanner — the complete
              typed catalog with a recovery action per code (mic_permission
              deep link, auth login, transient auto-retry with a visible
              countdown, copy-code for support). With the flag OFF the
              legacy inline panel below stays exactly as it was (zero
              regression). In both cases: renders regardless of
              isVoiceActive so errors from before startSession (e.g.
              channel.create() failure) are visible; the chat history
              stays above; zero Alert modals (AC-UX4). */}
                {isVoiceModeUiEnabled ? (
                  <VoiceErrorBanner
                    error={voiceSession.error}
                    agentName={agentName ?? undefined}
                    onRetry={handleStartVoice}
                    onLogin={handleVoiceLogin}
                  />
                ) : (
                  voiceSession.error && (
                    <YStack
                      padding={16}
                      gap={8}
                      borderTopWidth={1}
                      borderTopColor={c.tint.r.bd}
                      backgroundColor={c.tint.r.bg}
                      alignItems="center"
                      zIndex={2}
                    >
                      <XStack alignItems="center" gap={8} flexWrap="wrap" justifyContent="center">
                        <Ph name="warning-circle" size={18} color={c.tint.r.tx} />
                        <T step="sm" color={c.tint.r.tx} center>
                          {voiceSession.error.code === "auth"
                            ? t("voice.error.auth", {
                                defaultValue: "Authentication failed — please log in again",
                              })
                            : voiceSession.error.code === "flag_disabled"
                              ? t("voice.error.flagDisabled", {
                                  defaultValue: "Voice mode is not enabled for your account",
                                })
                              : voiceSession.error.code === "elevenlabs_signed_url"
                                ? t("voice.error.elevenlabs", {
                                    defaultValue:
                                      "Voice service unavailable (ElevenLabs connection failed)",
                                  })
                                : voiceSession.error.code === "timeout"
                                  ? t("voice.error.timeout", {
                                      defaultValue: "Connection timed out — please try again",
                                    })
                                  : voiceSession.error.code === "workspace_unresolved"
                                    ? t("voice.error.workspace", {
                                        defaultValue:
                                          "Could not resolve workspace for voice session",
                                      })
                                    : voiceSession.error.code === "server_error"
                                      ? t("voice.error.serverError", {
                                          defaultValue: "Server error — please try again",
                                        })
                                      : voiceSession.error.code === "bad_request"
                                        ? t("voice.error.badRequest", {
                                            defaultValue:
                                              "Invalid request — check your parameters",
                                          })
                                        : t("voice.error.unknown", {
                                            defaultValue: "Connection failed",
                                          })}
                        </T>
                      </XStack>
                      <T step="12" tone="text3" center>
                        {voiceSession.error.message}
                      </T>
                      {/* Retry is shown for all codes except bad_request — a client bug
                  will keep failing, so retrying is misleading. */}
                      {voiceSession.error.code !== "bad_request" && (
                        <Btn
                          variant="dangerSoft"
                          size="sm"
                          icon="arrow-clockwise"
                          onPress={handleStartVoice}
                        >
                          {t("voice.retry", { defaultValue: "Retry" })}
                        </Btn>
                      )}
                    </YStack>
                  )
                )}
              </YStack>
            </PermissionContext.Provider>

            {/* v2 non-blocking interactions: the unified awaiting-user chip — one
                indicator for all three kinds (form / permission / auth). The
                input below stays ENABLED: the user can always answer in chat. */}
            {awaitingUser && (
              <XStack
                alignItems="center"
                justifyContent="center"
                gap={6}
                paddingBottom={6}
                paddingHorizontal={12}
              >
                <Ph
                  name={
                    awaitingUser === "form"
                      ? "check-square"
                      : awaitingUser === "permission"
                        ? "shield-warning"
                        : "plug"
                  }
                  size={13}
                  color={c.tint.a.tx}
                />
                <T step="codenote" color={c.text3}>
                  {awaitingUser === "form"
                    ? t("conversation.awaitingForm", "Waiting for you — form")
                    : awaitingUser === "permission"
                      ? t("conversation.awaitingPermission", "Waiting for you — approval")
                      : t("conversation.awaitingAuth", "Waiting for you — connection")}
                </T>
              </XStack>
            )}

            {/* The typing indicator renders inline inside the thread (between the
            last message being processed and the queued ones). */}

            {/* Input — v2 UNIFIED voice surface (F5c, ui-evolution §2.5.2 + Pablo's
            "dos interfaces" feedback 2026-10-03): with the presence UI flag ON
            there is ONE voice grammar — the ORB is the state (halo+echo+
            speaking ring) and it NEVER disappears; the InputComposer stays
            mounted (voice-notes are a legitimate, unchanged feature); the
            bloom no longer swaps the composer for a second state grammar —
            it adds VoiceControlsBar, a MINIMAL action bar (mute · mode ·
            hang up) ABOVE the composer. Zero state duplication: the bar
            carries doors, the orb carries state. With the flag OFF, the
            legacy swap keeps working untouched (zero regression). */}
            {isVoiceModeUiEnabled &&
            voicePresenceHere !== "off" &&
            voicePresenceHere !== "error" ? (
              <YStack position="relative">
                {/* The action bar — ALWAYS mounted while the session lives here
                (doors, not state — F5c). The orb carries ALL the state. */}
                <VoiceControlsBar
                  mode={voiceSession.mode}
                  isMuted={voiceSession.isMuted}
                  onSetMode={voiceSession.setMode}
                  onToggleMute={voiceSession.toggleMute}
                  onDisconnect={handleStopVoice}
                />
                <InputComposer
                  onSend={handleSend}
                  onTranscribe={handleTranscribe}
                  disabled={!connected}
                  placeholder={composerPlaceholder}
                  initialText={initialDraft}
                  bottomInset={effectiveBottomInset}
                  channelId={channelId}
                  windowId={windowId}
                  isGenerating={isTyping}
                  onStop={handleStop}
                  hasIrreversibleToolInFlight={irreversibleToolInFlight.active}
                  irreversibleToolName={irreversibleToolInFlight.toolName}
                  agentId={effectiveAgentId}
                  agentName={agentName || undefined}
                  hasMessages={hasMessages}
                  suggestedPrompts={visibleSuggestedPrompts}
                  workspaceId={
                    workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? undefined
                  }
                />
                {/* F5e: the orb LEFT the chat — it is now a global floating
                overlay (VoiceOrbOverlay, mounted in the workspace layout).
                While the voice session lives, the orb floats over the WHOLE
                app: navigate anywhere, it stays present, audible,
                breathing, draggable, closable. The chat keeps the bloom's
                action bar (VoiceControlsBar) and the thread's voice story
                (VoiceThreadSection + interim rows) — the orb itself is
                global now. One orb, one owner: zero duplication. */}
              </YStack>
            ) : (
              <InputComposer
                onSend={handleSend}
                onTranscribe={handleTranscribe}
                disabled={!connected}
                placeholder={composerPlaceholder}
                initialText={initialDraft}
                bottomInset={effectiveBottomInset}
                channelId={channelId}
                windowId={windowId}
                isGenerating={isTyping}
                onStop={handleStop}
                hasIrreversibleToolInFlight={irreversibleToolInFlight.active}
                irreversibleToolName={irreversibleToolInFlight.toolName}
                agentId={effectiveAgentId}
                agentName={agentName || undefined}
                hasMessages={hasMessages}
                suggestedPrompts={visibleSuggestedPrompts}
                workspaceId={
                  workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? undefined
                }
              />
            )}
          </YStack>
        </ChatPaneContext.Provider>
      </KeyboardAvoidingView>

      {/* Move to Workspace Modal */}
      <MoveToWorkspaceModal
        channelId={channelId ?? null}
        visible={showMoveModal}
        onClose={() => setShowMoveModal(false)}
        onMoved={handleMovedToWorkspace}
      />

      {/* Pre-publish Warning Dialog (MUW-15) — shared with the conversation list */}
      <PrePublishWarningDialog
        open={showScopeWarning}
        personalApps={scopeWarningApps}
        onConfirm={confirmScopePublish}
        onCancel={cancelScopeWarning}
      />
    </>
  )
}

const styles = StyleSheet.create({
  // `.thread` — vertical breathing room; the rows pad themselves horizontally.
})
