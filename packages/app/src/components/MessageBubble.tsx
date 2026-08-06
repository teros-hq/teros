import type React from "react"
import { useTranslation } from "react-i18next"
import { Platform } from "react-native"
import { Text, View, XStack, YStack } from "tamagui"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors, surface } from "./mca/primitives/colors"
import { useTypewriter } from "../hooks/useTypewriter"
import { getDateLocale } from "../i18n"
import { useAuthStore } from "../store/authStore"
import type { Message } from "../store/chatStore"
import { useTilingStore } from "../store/tilingStore"
import { useWorkspaceStore } from "../store/workspaceStore"
import { Avatar } from "./Avatar"
import {
  AudioBubble,
  EventBubble,
  FileBubble,
  HtmlBubble,
  HtmlFileBubble,
  ImageBubble,
  MarkdownContent,
  SelectableText,
  ToolCallBlock,
  VideoBubble,
  VoiceBubble,
} from "./chat/bubbles"
import { QueuedIndicator, QueuedShimmer } from "./chat/queuedDecorations"
import { ErrorBlock } from "./ErrorBlock"
import { MessageFeedback } from "./MessageFeedback"
import { ensureMcasRegistered } from "./mca"

interface AgentTextBlockProps {
  message: Message
  isVoiceMsg: boolean
  showTimestamp: boolean
  isLastMessage: boolean
}
function AgentTextBlock({
  message,
  isVoiceMsg,
  showTimestamp,
  isLastMessage,
}: AgentTextBlockProps): React.ReactElement {
  const c = useColors()
  const target = message.content.type === "text" ? message.content.text : ""
  // Only animate on the last bubble — older text snaps so a newer tool_call below it doesn't render under text still revealing.
  const isStreaming = message.isStreaming === true && isLastMessage
  const visible = useTypewriter(target, isStreaming)
  return (
    <YStack
      gap="$2"
      alignSelf="flex-start"
      width="100%"
      // @ts-ignore - userSelect is valid for web
      userSelect={Platform.OS === "web" ? "text" : undefined}
    >
      <MarkdownContent text={visible} />
      <XStack alignItems="center" gap="$1">
        {isVoiceMsg && (
          <Text fontSize={10} color={semanticColors.violet}>
            🎙️
          </Text>
        )}
        {showTimestamp && (
          <SelectableText fontSize="$2" color={c.text3} selectable>
            {message.timestamp.toLocaleTimeString(getDateLocale(), {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </SelectableText>
        )}
      </XStack>
      {!message.isStreaming && (
        <MessageFeedback
          messageId={message.id}
          channelId={message.channelId}
          messageText={target}
          currentRating={message.feedback?.rating}
        />
      )}
    </YStack>
  )
}

import { BoardEventBubble } from "./chat/BoardEventBubble"
import { BrowserbaseLiveViewBubble } from "./chat/bubbles/BrowserbaseLiveViewBubble"

export type { MessageContent, ToolCall } from "./chat/bubbles"
// Re-export types for backwards compatibility
export type { Message }

// Ensure MCAs are registered on module load
ensureMcasRegistered()

interface MessageProps {
  message: Message
  showTimestamp?: boolean
  /** The agent ID of the channel (to determine if sender is the main agent) */
  channelAgentId?: string
  isLastMessage?: boolean
  /** Callback to retry sending a failed message */
  onRetry?: (message: Message) => void
}

/**
 * User message bubble - right aligned with cyan background
 * Shows sender info when message is from another user/agent (not the current user)
 */
export function UserBubble({
  message,
  showTimestamp = true,
  onRetry,
}: MessageProps): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()
  const currentUserId = useAuthStore((state: any) => state.user?.userId)

  // Check if this message is from someone else (agent-to-agent or multi-user)
  const isFromOther = message.senderInfo && message.senderInfo.id !== currentUserId
  const senderName = isFromOther ? message.senderInfo?.name : null
  const senderAvatarUrl = isFromOther ? message.senderInfo?.avatarUrl : undefined
  const isAgentSender = isFromOther && message.senderInfo?.type === "agent"

  // Handle voice messages (with transcription)
  if (message.content.type === "voice") {
    return (
      <VoiceBubble
        url={message.content.url || ""}
        data={message.retryData?.audioData}
        duration={message.content.duration}
        transcription={message.content.transcription}
        transcriptionError={message.content.transcriptionError}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
        onRetry={onRetry ? () => onRetry(message) : undefined}
      />
    )
  }

  // Handle audio messages (music, podcasts - no transcription)
  if (message.content.type === "audio") {
    return (
      <AudioBubble
        url={message.content.url}
        duration={message.content.duration}
        caption={message.content.caption}
        mimeType={message.content.mimeType}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
        onRetry={onRetry ? () => onRetry(message) : undefined}
      />
    )
  }

  // Handle image messages from user
  if (message.content.type === "image") {
    return (
      <ImageBubble
        url={message.content.url}
        caption={message.content.caption}
        width={message.content.width}
        height={message.content.height}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
      />
    )
  }

  // Handle file messages from user
  if (message.content.type === "file") {
    return (
      <FileBubble
        url={message.content.url}
        filename={message.content.filename}
        caption={message.content.caption}
        mimeType={message.content.mimeType}
        size={message.content.size}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
      />
    )
  }

  if (message.content.type !== "text") {
    return (
      <YStack maxWidth="85%" alignSelf="flex-end">
        <SelectableText color={c.text} fontSize="$3" selectable>
          {t("conversation.unsupportedMessageType", { type: message.content.type })}
        </SelectableText>
      </YStack>
    )
  }

  const paragraphs = message.content.text.split("\n").filter((p) => p.trim().length > 0)

  const isVoiceMessage = message.source === "voice"

  // iOS: no bubble, just text on background
  if (Platform.OS !== "web") {
    return (
      <XStack width="85%" gap="$2" alignSelf="flex-end" alignItems="flex-end" paddingRight="$2">
        {/* Show avatar for messages from others */}
        {isFromOther && (
          <Avatar
            name={senderName || "?"}
            imageUrl={senderAvatarUrl}
            size={28}
            isAgent={isAgentSender}
          />
        )}

        <YStack gap="$1" flex={1}>
          {/* Show sender name for messages from others */}
          {isFromOther && senderName && (
            <Text fontSize="$2" color={c.text3} textAlign="right">
              {senderName}
            </Text>
          )}

          {paragraphs.map((paragraph, index) => (
            <SelectableText
              key={index}
              color={c.text}
              fontSize="$4"
              lineHeight="$2"
              selectable
              textAlign="right"
            >
              {paragraph}
            </SelectableText>
          ))}
          <XStack justifyContent="flex-end" alignItems="center" gap="$2">
            {message.status === "queued" && <QueuedIndicator />}
            {isVoiceMessage && (
              <Text fontSize={10} color={semanticColors.violet}>
                🎙️
              </Text>
            )}
            {showTimestamp && (
              <SelectableText fontSize="$2" color={c.text3} selectable>
                {message.timestamp.toLocaleTimeString(getDateLocale(), {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </SelectableText>
            )}
          </XStack>
        </YStack>
      </XStack>
    )
  }

  // Web: with bubble
  // Use different style for messages from others
  // User's own messages: indigo tint bg + dark text in light theme,
  // indigoDark bg + white text in dark theme. isFromOther stays neutral.
  const isDark = c.bgPage === surface.dark.bgPage
  const bubbleBg = isFromOther
    ? c.bgInner
    : isDark ? semanticColors.indigoDark : semanticColors.indigoGlow
  const textColor = isFromOther ? c.text : isDark ? "#FFFFFF" : c.text
  const timestampColor = isFromOther ? c.text3 : isDark ? "rgba(255,255,255,0.55)" : c.text3

  return (
    <XStack
      maxWidth="85%"
      gap="$2"
      alignSelf="flex-end"
      alignItems="flex-end"
      // @ts-ignore - userSelect is valid for web
      userSelect={Platform.OS === "web" ? "text" : undefined}
    >
      {/* Show avatar for messages from others */}
      {isFromOther && (
        <Avatar
          name={senderName || "?"}
          imageUrl={senderAvatarUrl}
          size={28}
          isAgent={isAgentSender}
        />
      )}

      <YStack gap="$1" flex={1}>
        {/* Show sender name for messages from others */}
        {isFromOther && senderName && (
          <Text
            fontSize="$2"
            color={c.text3}
            alignSelf="flex-end"
            marginRight="$1"
          >
            {senderName}
          </Text>
        )}

        {paragraphs.length > 0 && (
          <YStack
            padding="$3"
            borderRadius="$4"
            gap="$1"
            backgroundColor={bubbleBg}
            borderBottomRightRadius="$1"
            overflow={message.status === "queued" ? "hidden" : undefined}
            position={message.status === "queued" ? "relative" : undefined}
          >
            {message.status === "queued" && <QueuedShimmer />}
            <YStack gap="$2">
              {paragraphs.map((paragraph, index) => (
                <SelectableText
                  key={index}
                  color={textColor}
                  fontSize="$4"
                  lineHeight="$2"
                  selectable
                >
                  {paragraph}
                </SelectableText>
              ))}
            </YStack>
            <XStack alignItems="center" gap="$2">
              {message.status === "queued" && <QueuedIndicator />}
              {isVoiceMessage && (
                <Text fontSize={10} color={semanticColors.violet}>
                  🎙️
                </Text>
              )}
              {showTimestamp && (
                <SelectableText fontSize="$2" color={timestampColor} selectable>
                  {message.timestamp.toLocaleTimeString(getDateLocale(), {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </SelectableText>
              )}
            </XStack>
          </YStack>
        )}
      </YStack>
    </XStack>
  )
}

/**
 * Agent message - left aligned, integrated into background (no bubble)
 * Used for the main channel agent's messages (fullwidth, no avatar)
 */
export function AgentMessage({
  message,
  showTimestamp = true,
  isLastMessage = false,
  onRetry,
  channelAgentId,
}: MessageProps): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()
  const openWindow = useTilingStore((s) => s.openWindow)
  // Tool execution messages — single source of truth en message.content.
  // El array message.toolCalls[] era legado de streaming live; ahora upsertToolMessage
  // populate content directamente en cada chunk WS, así render persisted y streaming
  // colapsan al mismo path.
  if (message.content.type === "tool_execution") {
    return (
      <YStack
        gap="$1"
        alignSelf="flex-start"
        width="100%"
        // @ts-ignore - userSelect is valid for web
        userSelect={Platform.OS === "web" ? "text" : undefined}
      >
        <ToolCallBlock tool={message.content} />
        {showTimestamp && (
          <SelectableText
            fontSize="$2"
            color={c.text3}
            alignSelf="flex-start"
            selectable
          >
            {message.timestamp.toLocaleTimeString(getDateLocale(), {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </SelectableText>
        )}
      </YStack>
    )
  }

  // Handle image messages
  if (message.content.type === "image") {
    return (
      <ImageBubble
        url={message.content.url}
        caption={message.content.caption}
        width={message.content.width}
        height={message.content.height}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
        status={message.status}
      />
    )
  }

  // Handle video messages
  if (message.content.type === "video") {
    return (
      <VideoBubble
        url={message.content.url}
        caption={message.content.caption}
        duration={message.content.duration}
        thumbnailUrl={message.content.thumbnailUrl}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
        status={message.status}
      />
    )
  }

  // Handle voice messages (with transcription)
  if (message.content.type === "voice") {
    return (
      <VoiceBubble
        url={message.content.url || ""}
        duration={message.content.duration}
        transcription={message.content.transcription}
        transcriptionError={message.content.transcriptionError}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
      />
    )
  }

  // Handle audio messages (music, podcasts - no transcription)
  if (message.content.type === "audio") {
    return (
      <AudioBubble
        url={message.content.url}
        duration={message.content.duration}
        caption={message.content.caption}
        mimeType={message.content.mimeType}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
      />
    )
  }

  // Handle file messages
  if (message.content.type === "file") {
    return (
      <FileBubble
        url={message.content.url}
        filename={message.content.filename}
        caption={message.content.caption}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
        status={message.status}
      />
    )
  }

  // Handle HTML widget messages
  if (message.content.type === "html") {
    return (
      <HtmlBubble
        html={message.content.html}
        caption={message.content.caption}
        height={message.content.height}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />
    )
  }

  // Handle HTML file messages (send-html-file tool)
  if (message.content.type === "html_file") {
    return (
      <HtmlFileBubble
        filePath={message.content.filePath}
        caption={message.content.caption}
        workspaceId={message.content.workspaceId}
        channelId={message.channelId}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />
    )
  }

  // Handle Browserbase Live View messages (session-create tool)
  if (message.content.type === "browser_live_view") {
    return (
      <BrowserbaseLiveViewBubble
        sessionId={message.content.sessionId}
        url={message.content.url}
        caption={message.content.caption}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />
    )
  }

  // Handle system events (reminders, recurring tasks, etc.)
  if (message.content.type === "event") {
    return (
      <EventBubble
        eventType={message.content.eventType}
        eventData={message.content.eventData}
        description={message.content.description}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />
    )
  }

  if (message.content.type === "text") {
    const isVoiceMsg = message.source === "voice"
    return (
      <AgentTextBlock
        message={message}
        isVoiceMsg={isVoiceMsg}
        showTimestamp={showTimestamp}
        isLastMessage={isLastMessage}
      />
    )
  }

  if (message.content.type === "error") {
    // Error messages don't carry agentId/senderInfo on the frontend store, so
    // the "Change model" action targets the channel's agent (opens its window).
    const targetAgentId = channelAgentId
      ? channelAgentId.startsWith("agent_")
        ? channelAgentId
        : `agent_${channelAgentId}`
      : undefined
    return (
      <ErrorBlock
        errorType={message.content.errorType}
        userMessage={message.content.userMessage}
        technicalMessage={message.content.technicalMessage}
        context={message.content.context}
        timestamp={message.timestamp}
        onRetry={onRetry ? () => onRetry(message) : undefined}
        onChangeModel={
          targetAgentId
            ? () =>
                openWindow(
                  "agent",
                  {
                    agentId: targetAgentId,
                    workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
                  },
                  true,
                )
            : undefined
        }
      />
    )
  }

  // Unsupported type
  return (
    <YStack alignSelf="flex-start">
      <SelectableText color={c.text} fontSize="$3" selectable>
        Unsupported message type: {(message.content as any).type}
      </SelectableText>
    </YStack>
  )
}

// Keep old export for backwards compatibility during migration
export function MessageBubble({
  message,
  showTimestamp = true,
  channelAgentId,
  isLastMessage = false,
  onRetry,
}: MessageProps): React.ReactElement {
  // Board subscription messages — compact board event style
  if ((message.metadata as any)?.source === "board_subscription") {
    return <BoardEventBubble message={message} showTimestamp={showTimestamp} />
  }

  // User messages always use UserBubble (which handles isFromOther internally)
  if (message.sender === "user") {
    return <UserBubble message={message} showTimestamp={showTimestamp} onRetry={onRetry} />
  }

  // For agent messages: check if it's from a different agent than the channel's main agent
  // If so, render as UserBubble with isFromOther styling (gray bubble with avatar)
  if (message.sender === "agent" && message.senderInfo && channelAgentId) {
    const isFromOtherAgent =
      message.senderInfo.id !== `agent_${channelAgentId}` &&
      message.senderInfo.id !== channelAgentId
    if (isFromOtherAgent) {
      // Render as "other user" style - gray bubble with avatar
      return <UserBubble message={message} showTimestamp={showTimestamp} onRetry={onRetry} />
    }
  }

  // Main channel agent and system messages go through AgentMessage (fullwidth, no avatar)
  return (
    <AgentMessage
      message={message}
      showTimestamp={showTimestamp}
      isLastMessage={isLastMessage}
      onRetry={onRetry}
      channelAgentId={channelAgentId}
    />
  )
}
