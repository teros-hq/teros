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

import { AlertCircle, MessageCircle } from "@tamagui/lucide-icons"
import React, { useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, Text, XStack, YStack } from "tamagui"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors } from "../mca/primitives/colors"
import { useShallow } from "zustand/react/shallow"
import { Avatar } from "../Avatar"
import { useVoiceSession } from "../../contexts/VoiceSessionContext"
import { useFeatureFlagsStore, getResolvedFlag } from "../../store/featureFlagsStore"
import { useChatChannel } from "../../hooks/chat/useChatChannel"
import { useChatInput } from "../../hooks/chat/useChatInput"
import { useChatPermissions } from "../../hooks/chat/useChatPermissions"
import { usePermissionGroups } from "../../hooks/chat/usePermissionGroups"
import { useChatScroll } from "../../hooks/chat/useChatScroll"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useChatStore } from "../../store/chatStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { InputComposer, type AudioRecording } from "../InputComposer"
import type { Message } from "../MessageBubble"
import { MessageItem } from "../MessageItem"
import { PermissionContext } from "../mca"
import { GroupedPermissionPanel } from "../mca/primitives/GroupedPermissionPanel"
import { PermissionGroupContext } from "../mca/primitives/PermissionGroupContext"
import { TerosLoading } from "../TerosLoading"
import { TranscriptDisplay } from "../voice/TranscriptDisplay"
import { VoiceControls } from "../voice/VoiceControls"
import { ChatHeader } from "./ChatHeader"

// ============================================
// CONSTANTS
// ============================================

const EMPTY_MESSAGE_IDS: string[] = []

/** Sentinel id usado en `invertedMessageIds` para renderizar el typing
 * indicator inline en el FlatList (entre los queued y el último mensaje
 * que se está procesando). */
const TYPING_INDICATOR_ITEM_ID = '__typing_indicator__'


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
}

// ============================================
// COMPONENT
// ============================================

export function ChatView({
  channelId,
  agentId: initialAgentId,
  workspaceId,
  onChannelCreated,
  onTitleChange,
  showHeader = true,
  bottomInset = 0,
  windowId,
}: ChatViewProps) {
  const { t } = useTranslation()
  const c = useColors()
  const insets = useSafeAreaInsets()
  const isNewChat = !channelId

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
        if (state.messages[id]?.status !== 'queued') out.push(id)
      }
      return out.length === ids.length ? ids : (out.length === 0 ? EMPTY_MESSAGE_IDS : out)
    }),
  )
  const queuedIds = useChatStore(
    useShallow((state) => {
      if (!channelId) return EMPTY_MESSAGE_IDS
      const ids = state.channelMessages[channelId]
      if (!ids || ids.length === 0) return EMPTY_MESSAGE_IDS
      const out: string[] = []
      for (const id of ids) {
        if (state.messages[id]?.status === 'queued') out.push(id)
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

  // Zustand: private mode
  const isPrivate = useChatStore(
    useCallback(
      (state) => (channelId ? (state.channels[channelId]?.isPrivate ?? false) : false),
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
  const { flatListRef, scrollToBottom } = useChatScroll()

  // Track last id (not length) so loading older messages doesn't trigger an unwanted scroll-to-bottom.
  const lastChronologicalId = useMemo(() => {
    const allIds = queuedIds.length > 0 ? [...restIds, ...queuedIds] : restIds
    return allIds[allIds.length - 1]
  }, [restIds, queuedIds])
  const lastMessageIdRef = useRef<string | undefined>(lastChronologicalId)
  useEffect(() => {
    const prevLastId = lastMessageIdRef.current
    lastMessageIdRef.current = lastChronologicalId
    if (lastChronologicalId && prevLastId !== undefined && lastChronologicalId !== prevLastId) {
      scrollToBottom()
    }
  }, [lastChronologicalId, scrollToBottom])

  // ----------------------------------------
  // Hook: permissions
  // ----------------------------------------
  const permissionContextValue = useChatPermissions(channelId)

  // TER-375: detect runs of ≥2 parallel tools awaiting approval so a single
  // GroupedPermissionPanel replaces the N stacked per-card ControlsBars.
  const { groupedRequestIds, groupByAnchorId } = usePermissionGroups(channelId)

  // Close this chat window after archiving (the window belongs to the tiling manager).
  const closeWindow = useTilingStore((s) => s.closeWindow)

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
  const isVoiceEnabled = getResolvedFlag<boolean>(useFeatureFlagsStore.getState(), 'voice.enabled')

  // Resolve the agent ID: prefer the one from the conversation participants
  const channelAgentId = useMemo(() => {
    const agentParticipant = conversation?.participants.find((p) => p.role === "agent")
    return agentParticipant?.agentId
  }, [conversation?.participants])

  // ----------------------------------------
  // Inverted message IDs (newest first, for inverted FlatList)
  // Layout chronological (top→bottom visual):
  //   [old, ..., last_being_processed, TYPING_INDICATOR, queued1, ..., queuedN]
  // El FlatList invertido renderiza array[0] en el bottom, así que aquí
  // construimos: [queuedN, ..., queued1, TYPING, last_rest, ..., oldest].
  // ----------------------------------------
  const invertedMessageIds = useMemo(() => {
    const items: string[] = []
    for (let i = queuedIds.length - 1; i >= 0; i--) items.push(queuedIds[i]!)
    if (showTypingIndicator) items.push(TYPING_INDICATOR_ITEM_ID)
    for (let i = restIds.length - 1; i >= 0; i--) items.push(restIds[i]!)
    return items
  }, [queuedIds, restIds, showTypingIndicator])

  // ----------------------------------------
  // Render helper — memoized to avoid FlatList re-renders
  // With inverted FlatList, index 0 = newest message.
  // previousMessageId = the message rendered above (older) = index + 1
  // nextMessageId     = the message rendered below (newer) = index - 1
  // ----------------------------------------
  const renderMessageId = useCallback(
    ({ item: messageId, index }: { item: string; index: number }) => {
      if (messageId === TYPING_INDICATOR_ITEM_ID) {
        // Indicator inline, debajo del último mensaje "no queued".
        return (
          <XStack
            paddingTop={6}
            paddingBottom={6}
            paddingHorizontal={16}
            alignItems="center"
            gap={10}
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
              size={28}
              isAgent={true}
            />
            <YStack gap={1}>
              <Text fontSize="$2" color={c.text2} lineHeight={14}>
                {agentName || t("chatView.typing.label", { name: "Agente" })}
              </Text>
              <XStack alignItems="center" gap={6}>
                <TerosLoading size={18} color={semanticColors.indigoDark} />
                <Text fontSize="$1" color={c.text3} fontStyle="italic">
                  {t("chatView.typing.thinking")}
                </Text>
              </XStack>
            </YStack>
          </XStack>
        )
      }
      // TER-375: this message is the last tool of a parallel batch with ≥2
      // pending tools → render the single GroupedPermissionPanel right after it.
      // The per-card ControlsBars are suppressed by the HOC.
      const group = groupByAnchorId.get(messageId)
      return (
        <>
          <MessageItem
            messageId={messageId}
            previousMessageId={
              index < invertedMessageIds.length - 1 ? invertedMessageIds[index + 1] : undefined
            }
            nextMessageId={index > 0 ? invertedMessageIds[index - 1] : undefined}
            channelAgentId={channelAgentId}
            onRetry={handleRetryMessage}
          />
          {group && (
            <YStack paddingHorizontal="$4" paddingTop="$1" paddingBottom="$2">
              <GroupedPermissionPanel tools={group.tools} />
            </YStack>
          )}
        </>
      )
    },
    [invertedMessageIds, channelAgentId, handleRetryMessage, agentName, agentAvatarUrl, t, groupByAnchorId],
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
    if (!effectiveAgentId || !getResolvedFlag<boolean>(useFeatureFlagsStore.getState(), 'voice.enabled')) return
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
      await voiceSession.startSession(effectiveAgentId, undefined, effectiveChannelId)
    } catch (err) {
      console.error('[ChatView] handleStartVoice failed:', err)
      // AF-7: surface the error in the voice overlay so the user sees feedback
      // even when startSession was never reached (e.g. channel.create() failed).
      const message = err instanceof Error ? err.message : 'Failed to start voice session'
      voiceSession.setError({ code: 'unknown', message })
    } finally {
      voiceStartingRef.current = false
    }
  }, [effectiveAgentId, channelId, workspaceId, onChannelCreated, voiceSession])

  const handleStopVoice = useCallback(() => {
    voiceSession.stopSession()
  }, [voiceSession])

  const handleStop = useCallback(
    async (kind: 'soft' | 'hard' | 'queue_only') => {
      if (!channelId) return
      try {
        await getTerosClient().channel.stopMessage(channelId, kind)
      } catch (err) {
        console.error('[ChatView] stopMessage failed', err)
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
      <YStack flex={1} justifyContent="center" alignItems="center" gap="$4" paddingHorizontal="$6">
        <AlertCircle size={64} color={c.text3} />
        <Text fontSize="$6" fontWeight="600" color={c.text} textAlign="center">
          {t('conversation.notFound')}
        </Text>
        <Text fontSize="$4" color={c.text3} textAlign="center">
          {t('conversation.notFoundDescription')}
        </Text>
      </YStack>
    )
  }

  // ----------------------------------------
  // Loading state
  // ----------------------------------------
  if (isLoading || !conversation || !user) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center">
        <TerosLoading size={48} color={semanticColors.indigoDark} />
      </YStack>
    )
  }

  const effectiveBottomInset = bottomInset || insets.bottom

  // ----------------------------------------
  // Render
  // ----------------------------------------
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
    >
      <YStack flex={1} backgroundColor={c.bgPage}>
        {/* Header */}
        {showHeader && (
          <ChatHeader
            title={conversation.title}
            agentName={agentName || t('conversation.agent')}
            agentAvatarUrl={agentAvatarUrl}
            agentRole={agentRole}
            modelString={modelString}
            modelName={modelName}
            providerName={providerName}
            agentId={initialAgentId}
            isWorking={isTyping}
            isPrivate={isPrivate}
            tokenBudget={tokenBudget}
            workspace={workspaceInfo}
            onTitleChange={handleRenameChannel}
            onArchive={handleArchive}
            onStartVoice={effectiveAgentId ? handleStartVoice : undefined}
            isVoiceActive={isVoiceActive}
          />
        )}

        {/* Messages — wrapped in PermissionContext for inline permission UI. `overflow:hidden` clips the inverted FlatList's flexGrow so it can't bleed onto siblings below. PermissionGroupContext (TER-375) lets the per-card HOC suppress its ControlsBar when the request is part of a parallel group. */}
        <PermissionContext.Provider value={permissionContextValue}>
         <PermissionGroupContext.Provider value={groupedRequestIds}>
          <YStack flex={1} overflow="hidden">
            {/* Loading overlay while history loads — shown on top of whatever
                base content is rendered (FlatList or empty state). Suppressed
                when voice is active to avoid layering conflicts with the voice
                transcript panel. */}
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
                <TerosLoading size={48} color={semanticColors.indigoDark} />
              </YStack>
            )}

            {/* ── Base layer: chat history (always rendered) ──────────────
                The FlatList is the base content. Voice mode no longer replaces
                it — instead, voice transcripts and errors are overlaid as
                bottom panels (see below). This ensures the chat history stays
                visible while the user talks, and there is never a blank screen. */}
            {isChatReady && messageIds.length === 0 && !isVoiceActive && !voiceSession.error ? (
              <YStack flex={1} justifyContent="center" alignItems="center" gap="$4">
                <MessageCircle size={64} color={c.text3} />
                <Text fontSize="$5" color={c.text3}>
                  {t('conversation.startConversation')}
                </Text>
              </YStack>
            ) : (
              <FlatList
                ref={flatListRef}
                data={invertedMessageIds}
                renderItem={renderMessageId}
                keyExtractor={(messageId) => messageId}
                style={{ flex: 1 }}
                contentContainerStyle={styles.flatListContent}
                showsVerticalScrollIndicator={false}
                inverted
                {...(Platform.OS === "web"
                  ? {
                      disableVirtualization: true,
                      initialNumToRender: 100,
                      maxToRenderPerBatch: 100,
                      windowSize: 21,
                    }
                  : {
                      initialNumToRender: 20,
                      maxToRenderPerBatch: 10,
                      windowSize: 11,
                    })}
                ListFooterComponent={
                  hasMoreMessages ? (
                    <XStack justifyContent="center" paddingVertical="$2">
                      {isLoadingMore ? (
                        <TerosLoading size={24} color={semanticColors.indigoDark} />
                      ) : (
                        <Button
                          size="$2"
                          variant="outlined"
                          borderColor={c.border}
                          onPress={loadMoreMessages}
                        >
                          <Text fontSize="$2" color={c.text3}>
                            {t('conversation.loadEarlierMessages')}
                          </Text>
                        </Button>
                      )}
                    </XStack>
                  ) : null
                }
              />
            )}

            {/* ── Voice transcript panel (bottom overlay) ──────────────────
                Shows live + historic voice transcripts in a fixed-height panel
                at the bottom of the message area. The chat history remains
                visible above it. The user can scroll both independently. */}
            {isVoiceActive && !voiceSession.error && (
              <YStack
                height={220}
                maxHeight="45%"
                borderTopWidth={1}
                borderTopColor={c.border}
                backgroundColor={c.bgPage}
                overflow="hidden"
                zIndex={2}
              >
                <TranscriptDisplay
                  historicTranscripts={voiceSession.historicTranscripts}
                  liveTranscripts={voiceSession.liveTranscripts}
                />
              </YStack>
            )}

            {/* ── Voice error panel (bottom overlay) ───────────────────────
                Compact error banner at the bottom of the message area.
                Renders regardless of isVoiceActive so that errors from before
                startSession (e.g. channel.create() failure) are visible —
                not just errors from an active session. The chat history
                stays visible above the error banner. */}
            {voiceSession.error && (
              <YStack
                padding="$4"
                gap="$2"
                borderTopWidth={1}
                borderTopColor={`${semanticColors.red}4D`}
                backgroundColor={`${semanticColors.red}0D`}
                alignItems="center"
                zIndex={2}
              >
                <XStack alignItems="center" gap="$2" flexWrap="wrap" justifyContent="center">
                  <AlertCircle size={20} color={semanticColors.red} />
                  <Text fontSize="$4" fontWeight="600" color={semanticColors.red} textAlign="center">
                    {voiceSession.error.code === 'auth'
                      ? t('voice.error.auth', { defaultValue: 'Authentication failed — please log in again' })
                      : voiceSession.error.code === 'flag_disabled'
                        ? t('voice.error.flagDisabled', { defaultValue: 'Voice mode is not enabled for your account' })
                        : voiceSession.error.code === 'elevenlabs_signed_url'
                          ? t('voice.error.elevenlabs', { defaultValue: 'Voice service unavailable (ElevenLabs connection failed)' })
                          : voiceSession.error.code === 'timeout'
                            ? t('voice.error.timeout', { defaultValue: 'Connection timed out — please try again' })
                            : voiceSession.error.code === 'workspace_unresolved'
                              ? t('voice.error.workspace', { defaultValue: 'Could not resolve workspace for voice session' })
                              : voiceSession.error.code === 'server_error'
                                ? t('voice.error.serverError', { defaultValue: 'Server error — please try again' })
                                : voiceSession.error.code === 'bad_request'
                                  ? t('voice.error.badRequest', { defaultValue: 'Invalid request — check your parameters' })
                                  : t('voice.error.unknown', { defaultValue: 'Connection failed' })}
                  </Text>
                </XStack>
                <Text fontSize="$2" color={c.text3} textAlign="center">
                  {voiceSession.error.message}
                </Text>
                {/* Retry is shown for all codes except bad_request — a client bug
                    will keep failing, so retrying is misleading. */}
                {voiceSession.error.code !== 'bad_request' && (
                  <Button
                    size="$2"
                    backgroundColor={`${semanticColors.red}26`}
                    borderColor={`${semanticColors.red}66`}
                    borderWidth={1}
                    onPress={handleStartVoice}
                  >
                    <Text fontSize="$2" color={semanticColors.red}>{t('voice.retry', { defaultValue: 'Retry' })}</Text>
                  </Button>
                )}
              </YStack>
            )}
          </YStack>
         </PermissionGroupContext.Provider>
        </PermissionContext.Provider>

        {/* El typing indicator se renderiza ahora inline dentro del FlatList
            (entre el último mensaje en procesamiento y los queued). */}

        {/* Input — replaced by voice controls when voice session is active */}
        {isVoiceActive ? (
          <VoiceControls
            state={voiceSession.state}
            isConnected={voiceSession.isConnected}
            isMuted={voiceSession.isMuted}
            agentAvatarUrl={agentAvatarUrl ?? undefined}
            audioLevel={voiceSession.audioLevel}
            error={voiceSession.error}
            onConnect={handleStartVoice}
            onDisconnect={handleStopVoice}
            onToggleMute={voiceSession.toggleMute}
          />
        ) : (
          <InputComposer
            onSend={handleSend}
            onTranscribe={handleTranscribe}
            disabled={!connected}
            placeholder={t('conversation.typeMessage')}
            bottomInset={effectiveBottomInset}
            channelId={channelId}
            windowId={windowId}
            isGenerating={isTyping}
            onStop={handleStop}
            hasIrreversibleToolInFlight={irreversibleToolInFlight.active}
            irreversibleToolName={irreversibleToolInFlight.toolName}
          />
        )}
      </YStack>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flatListContent: {
    padding: 4,
    gap: 0,
    flexGrow: 1,
  },
})
