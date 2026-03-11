// ============================================================================
// CONVERSATION PREVIEW
// ============================================================================

import { ArrowRight, MessageSquare } from '@tamagui/lucide-icons';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, TouchableOpacity } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { CompactMarkdown } from './CompactMarkdown';
import { AppSpinner } from '../../components/ui';

interface ConversationPreviewProps {
  channelId: string;
  onOpenConversation: (channelId: string) => void;
  agentMap: Record<string, { name: string; avatarUrl?: string }>;
}

/** Extract displayable text from a MessageContent object */
function getMessageText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content; // legacy fallback
  switch (content.type) {
    case 'text':
      return content.text || '';
    case 'voice':
      return content.transcription || '[Nota de voz]';
    case 'image':
      return content.caption || '[Imagen]';
    case 'video':
      return content.caption || '[Video]';
    case 'audio':
      return content.caption || '[Audio]';
    case 'file':
      return content.caption || content.filename || '[Archivo]';
    case 'html':
      return content.caption || '[Widget HTML]';
    case 'html_file':
      return content.caption || '[Archivo HTML]';
    case 'tool_execution':
      return `🔧 ${content.toolName || 'Tool call'}`;
    case 'event':
      return content.description || '';
    case 'error':
      return content.userMessage || '[Error]';
    default:
      return '';
  }
}

/** Returns true if the message should be shown in the preview */
function isVisibleMessage(msg: any): boolean {
  if (!msg?.content) return false;
  const type = msg.content.type;
  // Skip internal event messages
  if (type === 'event') return false;
  // Only show user and assistant messages
  if (msg.role !== 'user' && msg.role !== 'assistant') return false;
  return true;
}

/** Whether a message is a tool call (compact card style) */
function isToolCall(msg: any): boolean {
  return msg?.content?.type === 'tool_execution';
}

// ─── User bubble (right-aligned, blue) ───────────────────────────────────────

function UserBubble({ text }: { text: string }) {
  return (
    <XStack justifyContent="flex-end" paddingLeft={40}>
      <YStack
        backgroundColor="$blue"
        borderRadius={16}
        borderBottomRightRadius={4}
        paddingHorizontal={12}
        paddingVertical={8}
        maxWidth="85%"
      >
        <Text fontSize={13} color="white" lineHeight={19}>
          {text}
        </Text>
      </YStack>
    </XStack>
  );
}

// ─── Agent message (left-aligned, no bubble) ──────────────────────────────────

function AgentMessage({ text, agentName }: { text: string; agentName: string }) {
  return (
    <YStack alignItems="flex-start" paddingRight={40} gap={2}>
      <Text fontSize={11} fontWeight="600" color="#A78BFA">
        {agentName}
      </Text>
      <CompactMarkdown text={text} fontSize={13} color="rgba(255,255,255,0.85)" />
    </YStack>
  );
}

// ─── Tool call card (compact dark card) ──────────────────────────────────────

function ToolCallCard({ content }: { content: any }) {
  const toolName = content?.toolName || 'Tool call';
  const status = content?.status;
  const statusIcon =
    status === 'completed' ? '✓' : status === 'failed' ? '✗' : status === 'running' ? '⏳' : '·';
  const statusColor =
    status === 'completed'
      ? '#22C55E'
      : status === 'failed'
        ? '#EF4444'
        : 'rgba(255,255,255,0.4)';

  return (
    <XStack
      backgroundColor="rgba(255,255,255,0.05)"
      borderRadius={8}
      paddingHorizontal={10}
      paddingVertical={6}
      borderWidth={1}
      borderColor="rgba(255,255,255,0.08)"
      gap={6}
      alignItems="center"
    >
      <Text fontSize={11} color={statusColor} fontWeight="700">
        {statusIcon}
      </Text>
      <Text fontSize={11} color="rgba(255,255,255,0.5)" fontFamily="$mono">
        {toolName}
      </Text>
      {content?.duration ? (
        <Text fontSize={10} color="rgba(255,255,255,0.3)" marginLeft="auto">
          {content.duration}ms
        </Text>
      ) : null}
    </XStack>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ConversationPreview({
  channelId,
  onOpenConversation,
  agentMap,
}: ConversationPreviewProps) {
  const client = getTerosClient();
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Fetch last 30 messages; backend returns newest-first so we reverse
        const result = await client.channel.getMessages(channelId, 30);
        if (!cancelled) {
          const visible = (result.messages || [])
            .filter(isVisibleMessage)
            .reverse() // chronological order
            .slice(-20); // keep last 20
          setMessages(visible);
        }
      } catch (err) {
        console.error('Error loading conversation preview:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  return (
    <YStack flex={1}>
      {/* Header */}
      <XStack
        alignItems="center"
        justifyContent="space-between"
        paddingHorizontal={12}
        paddingVertical={8}
        borderBottomWidth={1}
        borderBottomColor="rgba(255,255,255,0.05)"
        flexShrink={0}
      >
        <XStack alignItems="center" gap={6}>
          <MessageSquare size={13} color="#3B82F6" />
          <Text fontSize={12} fontWeight="600" color="$color" opacity={0.5}>
            Conversation
          </Text>
        </XStack>
        <TouchableOpacity
          onPress={() => onOpenConversation(channelId)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            backgroundColor: 'rgba(59,130,246,0.12)',
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 4,
          }}
        >
          <Text fontSize={10} color="#3B82F6" fontWeight="600">
            Abrir completa
          </Text>
          <ArrowRight size={10} color="#3B82F6" />
        </TouchableOpacity>
      </XStack>

      {/* Messages */}
      {loading ? (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <AppSpinner size="sm" variant="default" />
        </YStack>
      ) : messages.length === 0 ? (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <Text fontSize={12} color="$color" opacity={0.3}>
            No messages yet
          </Text>
        </YStack>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {messages.map((msg, i) => {
            const isUser = msg.role === 'user';
            const agentName =
              msg.sender?.name ||
              (msg.agentId ? agentMap[msg.agentId]?.name : null) ||
              'Agente';

            // Tool call card
            if (isToolCall(msg)) {
              return (
                <ToolCallCard key={msg.messageId || i} content={msg.content} />
              );
            }

            const rawText = getMessageText(msg.content);
            const text = rawText.length > 400 ? rawText.slice(0, 400) + '…' : rawText;
            if (!text) return null;

            if (isUser) {
              return <UserBubble key={msg.messageId || i} text={text} />;
            }

            return (
              <AgentMessage key={msg.messageId || i} text={text} agentName={agentName} />
            );
          })}
        </ScrollView>
      )}
    </YStack>
  );
}
