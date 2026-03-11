import React from 'react';
import { YStack } from 'tamagui';
import { type Message, useChatStore } from '../store/chatStore';
import { MessageBubble } from './MessageBubble';

interface MessageItemProps {
  messageId: string;
  previousMessageId?: string;
  nextMessageId?: string;
  /** The agent ID of the channel (to determine if sender is the main agent) */
  channelAgentId?: string;
  /** Callback to retry sending a failed message */
  onRetry?: (message: Message) => void;
}

/**
 * Check if two timestamps are in the same minute
 */
function isSameMinute(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate() &&
    date1.getHours() === date2.getHours() &&
    date1.getMinutes() === date2.getMinutes()
  );
}

/**
 * MessageItem - Wrapper component that subscribes to a single message by ID
 *
 * This component only re-renders when THIS specific message changes,
 * not when other messages in the channel change.
 *
 * This is the key to avoiding infinite loops with large message lists.
 */
export const MessageItem = React.memo(
  ({ messageId, previousMessageId, nextMessageId, channelAgentId, onRetry }: MessageItemProps) => {
    // Subscribe ONLY to this specific message (granular selector)
    const message = useChatStore((state) => state.messages[messageId]);
    const previousMessage = useChatStore((state) =>
      previousMessageId ? state.messages[previousMessageId] : undefined,
    );
    const nextMessage = useChatStore((state) =>
      nextMessageId ? state.messages[nextMessageId] : undefined,
    );

    // If message doesn't exist (shouldn't happen), render nothing
    if (!message) {
      console.warn('[MessageItem] Message not found in store:', messageId);
      return null;
    }

    // Determine if we should show timestamp (hide if same minute as next message from same sender)
    const showTimestamp =
      !nextMessage ||
      nextMessage.sender !== message.sender ||
      !isSameMinute(message.timestamp, nextMessage.timestamp);

    // Determine if this is a consecutive message from the same sender within the same minute
    const isConsecutive =
      previousMessage &&
      previousMessage.sender === message.sender &&
      isSameMinute(previousMessage.timestamp, message.timestamp);

    // Use compact padding for consecutive messages, especially tool calls
    const isToolCall = message.toolCalls?.length > 0 || message.content?.type === 'tool_execution';
    const isNextToolCall =
      nextMessage?.toolCalls?.length > 0 || nextMessage?.content?.type === 'tool_execution';
    const isPrevToolCall =
      previousMessage?.toolCalls?.length > 0 || previousMessage?.content?.type === 'tool_execution';

    // More padding when transitioning between tool calls and text
    const paddingTop = isConsecutive
      ? isPrevToolCall && !isToolCall
        ? '$3'
        : '$1' // Extra space after tool call before text
      : '$2';
    const paddingBottom = showTimestamp ? '$2' : isToolCall && !isNextToolCall ? '$2' : '$1'; // Extra space after tool call if next is text

    return (
      <YStack paddingHorizontal="$4" paddingTop={paddingTop} paddingBottom={paddingBottom}>
        <MessageBubble
          message={message}
          showTimestamp={showTimestamp}
          channelAgentId={channelAgentId}
          onRetry={onRetry}
        />
      </YStack>
    );
  },
);

MessageItem.displayName = 'MessageItem';
