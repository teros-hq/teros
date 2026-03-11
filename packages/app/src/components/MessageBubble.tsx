import type React from 'react';
import { Platform } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { useAuthStore } from '../store/authStore';
import type { Message } from '../store/chatStore';
import { Avatar } from './Avatar';
import { ErrorBlock } from './ErrorBlock';
import { ensureMcasRegistered } from './mca';
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
} from './chat/bubbles';

// Re-export types for backwards compatibility
export type { Message };
export type { MessageContent, ToolCall } from './chat/bubbles';

// Ensure MCAs are registered on module load
ensureMcasRegistered();

interface MessageProps {
  message: Message;
  showTimestamp?: boolean;
  /** The agent ID of the channel (to determine if sender is the main agent) */
  channelAgentId?: string;
  /** Callback to retry sending a failed message */
  onRetry?: (message: Message) => void;
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
  const currentUserId = useAuthStore((state) => state.user?.userId);

  // Check if this message is from someone else (agent-to-agent or multi-user)
  const isFromOther = message.senderInfo && message.senderInfo.id !== currentUserId;
  const senderName = isFromOther ? message.senderInfo?.name : null;
  const senderAvatarUrl = isFromOther ? message.senderInfo?.avatarUrl : undefined;
  const isAgentSender = isFromOther && message.senderInfo?.type === 'agent';

  // Handle voice messages (with transcription)
  if (message.content.type === 'voice') {
    return (
      <VoiceBubble
        url={message.content.url || ''}
        data={message.retryData?.audioData}
        duration={message.content.duration}
        transcription={message.content.transcription}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
        onRetry={onRetry ? () => onRetry(message) : undefined}
      />
    );
  }

  // Handle audio messages (music, podcasts - no transcription)
  if (message.content.type === 'audio') {
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
    );
  }

  // Handle image messages from user
  if (message.content.type === 'image') {
    return (
      <ImageBubble
        url={message.content.url}
        caption={message.content.caption}
        width={message.content.width}
        height={message.content.height}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
      />
    );
  }

  // Handle file messages from user
  if (message.content.type === 'file') {
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
      />
    );
  }

  if (message.content.type !== 'text') {
    return (
      <YStack maxWidth="85%" alignSelf="flex-end">
        <SelectableText color="$color" fontSize="$3" selectable>
          Unsupported message type: {message.content.type}
        </SelectableText>
      </YStack>
    );
  }

  const paragraphs = message.content.text.split('\n').filter((p) => p.trim().length > 0);

  // iOS: no bubble, just text on background
  if (Platform.OS !== 'web') {
    return (
      <XStack width="85%" gap="$2" alignSelf="flex-end" alignItems="flex-end" paddingRight="$2">
        {/* Show avatar for messages from others */}
        {isFromOther && (
          <Avatar
            name={senderName || '?'}
            imageUrl={senderAvatarUrl}
            size={28}
            isAgent={isAgentSender}
          />
        )}

        <YStack gap="$1" flex={1}>
          {/* Show sender name for messages from others */}
          {isFromOther && senderName && (
            <Text fontSize="$2" color="rgba(255, 255, 255, 0.5)" textAlign="right">
              {senderName}
            </Text>
          )}

          {paragraphs.map((paragraph, index) => (
            <SelectableText
              key={index}
              color="rgba(255, 255, 255, 0.9)"
              fontSize="$4"
              lineHeight="$2"
              selectable
              textAlign="right"
            >
              {paragraph}
            </SelectableText>
          ))}
          {showTimestamp && (
            <SelectableText
              fontSize="$2"
              color="rgba(255, 255, 255, 0.5)"
              selectable
              textAlign="right"
            >
              {message.timestamp.toLocaleTimeString('es-ES', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </SelectableText>
          )}
        </YStack>
      </XStack>
    );
  }

  // Web: with bubble
  // Use different style for messages from others
  const bubbleBg = isFromOther ? 'rgba(255, 255, 255, 0.08)' : '$blue';
  const textColor = isFromOther ? 'rgba(255, 255, 255, 0.9)' : '$color';
  const timestampColor = isFromOther ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.7)';

  return (
    <XStack
      maxWidth="85%"
      gap="$2"
      alignSelf="flex-end"
      alignItems="flex-end"
      // @ts-ignore - userSelect is valid for web
      userSelect={Platform.OS === 'web' ? 'text' : undefined}
    >
      {/* Show avatar for messages from others */}
      {isFromOther && (
        <Avatar
          name={senderName || '?'}
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
            color="rgba(255, 255, 255, 0.5)"
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
          >
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
            {showTimestamp && (
              <SelectableText fontSize="$2" color={timestampColor} selectable>
                {message.timestamp.toLocaleTimeString('es-ES', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </SelectableText>
            )}
          </YStack>
        )}
      </YStack>
    </XStack>
  );
}

/**
 * Agent message - left aligned, integrated into background (no bubble)
 * Used for the main channel agent's messages (fullwidth, no avatar)
 */
export function AgentMessage({ message, showTimestamp = true }: MessageProps): React.ReactElement {
  // Handle messages with toolCalls array (streaming tool executions)
  if (message.toolCalls && message.toolCalls.length > 0) {
    return (
      <YStack
        gap="$1"
        alignSelf="flex-start"
        width="100%"
        // @ts-ignore - userSelect is valid for web
        userSelect={Platform.OS === 'web' ? 'text' : undefined}
      >
        {message.toolCalls.map((tool) => (
          <ToolCallBlock key={tool.toolCallId} tool={tool} />
        ))}
        {showTimestamp && (
          <SelectableText
            fontSize="$2"
            color="rgba(255, 255, 255, 0.4)"
            alignSelf="flex-start"
            selectable
          >
            {message.timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </SelectableText>
        )}
      </YStack>
    );
  }

  // Handle persisted tool execution messages
  if (message.content.type === 'tool_execution') {
    return (
      <YStack
        gap="$1"
        alignSelf="flex-start"
        width="100%"
        // @ts-ignore - userSelect is valid for web
        userSelect={Platform.OS === 'web' ? 'text' : undefined}
      >
        <ToolCallBlock tool={message.content} />
        {showTimestamp && (
          <SelectableText
            fontSize="$2"
            color="rgba(255, 255, 255, 0.4)"
            alignSelf="flex-start"
            selectable
          >
            {message.timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </SelectableText>
        )}
      </YStack>
    );
  }

  // Handle image messages
  if (message.content.type === 'image') {
    return (
      <ImageBubble
        url={message.content.url}
        caption={message.content.caption}
        width={message.content.width}
        height={message.content.height}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
      />
    );
  }

  // Handle video messages
  if (message.content.type === 'video') {
    return (
      <VideoBubble
        url={message.content.url}
        caption={message.content.caption}
        duration={message.content.duration}
        thumbnailUrl={message.content.thumbnailUrl}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
      />
    );
  }

  // Handle voice messages (with transcription)
  if (message.content.type === 'voice') {
    return (
      <VoiceBubble
        url={message.content.url || ''}
        duration={message.content.duration}
        transcription={message.content.transcription}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
      />
    );
  }

  // Handle audio messages (music, podcasts - no transcription)
  if (message.content.type === 'audio') {
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
    );
  }

  // Handle file messages
  if (message.content.type === 'file') {
    return (
      <FileBubble
        url={message.content.url}
        filename={message.content.filename}
        caption={message.content.caption}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
      />
    );
  }

  // Handle HTML widget messages
  if (message.content.type === 'html') {
    return (
      <HtmlBubble
        html={message.content.html}
        caption={message.content.caption}
        height={message.content.height}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />
    );
  }

  // Handle HTML file messages (send-html-file tool)
  if (message.content.type === 'html_file') {
    return (
      <HtmlFileBubble
        filePath={message.content.filePath}
        caption={message.content.caption}
        channelId={message.channelId}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />
    );
  }

  // Handle system events (reminders, recurring tasks, etc.)
  if (message.content.type === 'event') {
    return (
      <EventBubble
        eventType={message.content.eventType}
        eventData={message.content.eventData}
        description={message.content.description}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />
    );
  }

  if (message.content.type === 'text') {
    return (
      <YStack
        gap="$2"
        alignSelf="flex-start"
        width="100%"
        // @ts-ignore - userSelect is valid for web
        userSelect={Platform.OS === 'web' ? 'text' : undefined}
      >
        <MarkdownContent text={message.content.text} />
        {showTimestamp && (
          <SelectableText fontSize="$2" color="rgba(255, 255, 255, 0.4)" selectable>
            {message.timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </SelectableText>
        )}
      </YStack>
    );
  }

  if (message.content.type === 'error') {
    return (
      <ErrorBlock
        errorType={message.content.errorType}
        userMessage={message.content.userMessage}
        technicalMessage={message.content.technicalMessage}
        context={message.content.context}
        timestamp={message.timestamp}
      />
    );
  }

  // Unsupported type
  return (
    <YStack alignSelf="flex-start">
      <SelectableText color="$color" fontSize="$3" selectable>
        Unsupported message type: {(message.content as any).type}
      </SelectableText>
    </YStack>
  );
}

// Keep old export for backwards compatibility during migration
export function MessageBubble({
  message,
  showTimestamp = true,
  channelAgentId,
  onRetry,
}: MessageProps): React.ReactElement {
  // User messages always use UserBubble (which handles isFromOther internally)
  if (message.sender === 'user') {
    return <UserBubble message={message} showTimestamp={showTimestamp} onRetry={onRetry} />;
  }

  // For agent messages: check if it's from a different agent than the channel's main agent
  // If so, render as UserBubble with isFromOther styling (gray bubble with avatar)
  if (message.sender === 'agent' && message.senderInfo && channelAgentId) {
    const isFromOtherAgent =
      message.senderInfo.id !== `agent_${channelAgentId}` &&
      message.senderInfo.id !== channelAgentId;
    if (isFromOtherAgent) {
      // Render as "other user" style - gray bubble with avatar
      return <UserBubble message={message} showTimestamp={showTimestamp} onRetry={onRetry} />;
    }
  }

  // Main channel agent and system messages go through AgentMessage (fullwidth, no avatar)
  return <AgentMessage message={message} showTimestamp={showTimestamp} />;
}
