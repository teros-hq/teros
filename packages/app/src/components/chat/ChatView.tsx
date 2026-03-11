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

import { ChevronDown, MessageCircle } from "@tamagui/lucide-icons"
import React, { useCallback, useMemo } from "react"
import { FlatList, KeyboardAvoidingView, Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, Text, XStack, YStack } from "tamagui"
import { useChatChannel } from "../../hooks/chat/useChatChannel"
import { useChatInput } from "../../hooks/chat/useChatInput"
import { useChatPermissions } from "../../hooks/chat/useChatPermissions"
import { useChatScroll } from "../../hooks/chat/useChatScroll"
import { useChatStore } from "../../store/chatStore"
import { InputComposer } from "../InputComposer"
import type { Message } from "../MessageBubble"
import { MessageItem } from "../MessageItem"
import { PermissionContext } from "../mca"
import { TerosLoading } from "../TerosLoading"
import { ChatHeader } from "./ChatHeader"

// ============================================
// CONSTANTS
// ============================================

const EMPTY_MESSAGE_IDS: string[] = []

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
}: ChatViewProps) {
  const insets = useSafeAreaInsets()
  const isNewChat = !channelId

  // ----------------------------------------
  // Zustand: message IDs for this channel
  // ----------------------------------------
  const messageIds = useChatStore(
    useCallback(
      (state) => {
        return channelId
          ? state.channelMessages[channelId] || EMPTY_MESSAGE_IDS
          : EMPTY_MESSAGE_IDS
      },
      [channelId],
    ),
  )

  // Zustand: typing indicator
  const isTyping = useChatStore(
    useCallback(
      (state) => (channelId ? (state.channels[channelId]?.isTyping ?? false) : false),
      [channelId],
    ),
  )

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
  const {
    flatListRef,
    isNearBottom,
    isInitialLoad,
    scrollToBottom,
    handleScroll,
    handleContentSizeChange,
    enableAutoScroll,
    setIsNearBottom,
    setAutoScrollEnabled,
  } = useChatScroll(
    channelId,
    isTyping,
    isChatReady,
    setIsChatReady,
    justSentMessage,
    getHasCachedMessages,
    isNewChat,
  )

  // ----------------------------------------
  // Hook: permissions
  // ----------------------------------------
  const permissionContextValue = useChatPermissions(channelId)

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
    setAutoScrollEnabled,
    setIsNearBottom,
    scrollToBottom,
    justSentMessage,
  })

  // ----------------------------------------
  // Render helpers
  // ----------------------------------------
  const channelAgentId = useMemo(() => {
    const agentParticipant = conversation?.participants.find((p) => p.role === "agent")
    return agentParticipant?.agentId
  }, [conversation?.participants])

  const renderMessageId = ({ item: messageId, index }: { item: string; index: number }) => {
    return (
      <MessageItem
        messageId={messageId}
        previousMessageId={index > 0 ? messageIds[index - 1] : undefined}
        nextMessageId={index < messageIds.length - 1 ? messageIds[index + 1] : undefined}
        channelAgentId={channelAgentId}
        onRetry={handleRetryMessage}
      />
    )
  }

  // ----------------------------------------
  // Loading state
  // ----------------------------------------
  if (isLoading || !conversation || !user) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center">
        <TerosLoading size={48} color="#0E7490" />
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
      <YStack flex={1}>
        {/* Header */}
        {showHeader && (
          <ChatHeader
            title={conversation.title}
            agentName={agentName || "Agente"}
            agentAvatarUrl={agentAvatarUrl}
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
          />
        )}

        {/* Messages — wrapped in PermissionContext for inline permission UI */}
        <PermissionContext.Provider value={permissionContextValue}>
          <YStack flex={1}>
            {/* Loading overlay while history loads */}
            {!isChatReady && (
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
                <TerosLoading size={48} color="#0E7490" />
              </YStack>
            )}

            {isChatReady && messageIds.length === 0 ? (
              <YStack flex={1} justifyContent="center" alignItems="center" gap="$4">
                <MessageCircle size={64} color="#38383A" />
                <Text fontSize="$5" color="$placeholderColor">
                  Start a conversation
                </Text>
              </YStack>
            ) : (
              <>
                <FlatList
                  ref={flatListRef}
                  data={messageIds}
                  extraData={messageIds.length}
                  renderItem={renderMessageId}
                  keyExtractor={(messageId) => messageId}
                  contentContainerStyle={{
                    padding: 4,
                    gap: 0,
                    flexGrow: 1,
                  }}
                  style={{ opacity: isChatReady ? 1 : 0 }}
                  showsVerticalScrollIndicator={false}
                  onScroll={handleScroll}
                  onContentSizeChange={handleContentSizeChange}
                  scrollEventThrottle={16}
                  {...(Platform.OS === "web"
                    ? {
                        // @ts-expect-error - disableVirtualization is deprecated but needed for web
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
                  maintainVisibleContentPosition={
                    !isTyping && !isInitialLoad.current ? { minIndexForVisible: 0 } : undefined
                  }
                  ListHeaderComponent={
                    hasMoreMessages ? (
                      <XStack justifyContent="center" paddingVertical="$2">
                        {isLoadingMore ? (
                          <TerosLoading size={24} color="#0E7490" />
                        ) : (
                          <Button
                            size="$2"
                            variant="outlined"
                            borderColor="$borderColor"
                            onPress={loadMoreMessages}
                          >
                            <Text fontSize="$2" color="$placeholderColor">
                              Cargar mensajes anteriores
                            </Text>
                          </Button>
                        )}
                      </XStack>
                    ) : null
                  }
                  ListFooterComponent={
                    <XStack
                      paddingTop={4}
                      paddingLeft={32}
                      alignItems="center"
                      height={28}
                      opacity={isTyping ? 1 : 0}
                    >
                      <TerosLoading size={28} color="#0E7490" />
                    </XStack>
                  }
                />
              </>
            )}

            {/* Scroll to bottom button */}
            {!isNearBottom && (
              <Button
                position="absolute"
                bottom={16}
                right={16}
                size="$3"
                circular
                backgroundColor="$backgroundPress"
                borderWidth={1}
                borderColor="$borderColor"
                onPress={enableAutoScroll}
                icon={<ChevronDown size={20} color="#06B6D4" />}
                elevate
              />
            )}
          </YStack>
        </PermissionContext.Provider>

        {/* Input */}
        <InputComposer
          onSend={handleSend}
          disabled={!connected}
          placeholder="Type a message..."
          bottomInset={effectiveBottomInset}
          channelId={channelId}
        />
      </YStack>
    </KeyboardAvoidingView>
  )
}
