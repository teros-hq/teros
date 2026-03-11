/**
 * VoiceTranscriptView
 *
 * Displays the history of a voice conversation (channel with transport='voice')
 * when opened from the conversation list.
 *
 * Includes:
 * - Transcript of channel messages in readable format
 * - Button to resume the voice conversation
 * - Indicator of whether there is an active session for this channel
 */

import { Mic, MicOff, Phone } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { Button, Text, View, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { useVoiceSession } from '../../contexts/VoiceSessionContext';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

// =============================================================================
// TYPES
// =============================================================================

interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

interface VoiceTranscriptViewProps {
  channelId: string;
  agentId?: string;
  agentName?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

/** Returns true if the text looks like a system/internal log line */
function isSystemLine(text: string): boolean {
  return (
    text.startsWith('🛠️') ||
    text.startsWith('✅') ||
    text.startsWith('❌') ||
    text.includes('→ [ch_') ||
    text.startsWith('send_message →')
  );
}

// =============================================================================
// BUBBLE COMPONENTS
// =============================================================================

function MessageBubble({ msg }: { msg: TranscriptMessage }) {
  const isUser = msg.role === 'user';
  const isSystem = isSystemLine(msg.text);

  if (isSystem) {
    // Render tool/system lines as compact event rows
    return (
      <YStack alignItems="center" paddingVertical="$1">
        <XStack
          backgroundColor="$gray3"
          borderRadius={8}
          paddingHorizontal="$3"
          paddingVertical="$1.5"
          maxWidth="90%"
          alignItems="center"
          gap="$2"
        >
          <Text fontSize={11} color="$color10" fontFamily="$mono" numberOfLines={2}>
            {msg.text}
          </Text>
        </XStack>
        <Text fontSize={10} color="$color9" marginTop={2}>
          {formatTime(msg.timestamp)}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack
      alignItems={isUser ? 'flex-end' : 'flex-start'}
      paddingVertical="$1"
    >
      {/* Speaker label */}
      <Text
        fontSize={11}
        color="$color10"
        marginBottom={3}
        paddingHorizontal="$1"
      >
        {isUser ? '🎙️ You' : '🤖 Assistant'}
      </Text>
      <View
        maxWidth="82%"
        backgroundColor={isUser ? '$blue9' : '$gray4'}
        borderRadius={12}
        paddingHorizontal="$3"
        paddingVertical="$2.5"
      >
        <Text
          fontSize={14}
          color={isUser ? 'white' : '$color12'}
          lineHeight={20}
        >
          {msg.text}
        </Text>
      </View>
      <Text fontSize={10} color="$color10" marginTop={3} paddingHorizontal="$1">
        {formatTime(msg.timestamp)}
      </Text>
    </YStack>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function VoiceTranscriptView({ channelId, agentId, agentName }: VoiceTranscriptViewProps) {
  const client = getTerosClient();
  const voiceSession = useVoiceSession();

  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const scrollRef = useRef<ScrollView>(null);

  // Is this channel the active voice session?
  const isActiveSession = voiceSession.channelId === channelId && voiceSession.isConnected;
  const isThisAgentActive = agentId && voiceSession.activeAgentId === agentId && voiceSession.isConnected;

  // Load transcript messages from the channel
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const { messages: history } = await client.channel.getMessages(channelId, 100);
        const parsed: TranscriptMessage[] = history
          .filter((m: any) => m.content?.type === 'text' && m.content?.text)
          .map((m: any) => ({
            id: m.messageId || m.id,
            role: m.role === 'user' ? 'user' : 'assistant',
            text: m.content.text,
            timestamp: m.timestamp,
          }))
          .sort((a: TranscriptMessage, b: TranscriptMessage) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
        setMessages(parsed);
      } catch (err) {
        console.error('[VoiceTranscriptView] Error loading messages:', err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [channelId]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 150);
    }
  }, [messages]);

  const handleResume = useCallback(async () => {
    if (!agentId) {
      Alert.alert('Error', 'No agent associated with this conversation.');
      return;
    }
    try {
      await voiceSession.startSession(agentId, channelId);
    } catch (err) {
      Alert.alert('Connection Failed', err instanceof Error ? err.message : 'Unknown error');
    }
  }, [agentId, channelId, voiceSession]);

  const handleStop = useCallback(() => {
    voiceSession.stopSession();
  }, [voiceSession]);

  // Group messages by date for section headers
  const grouped = React.useMemo(() => {
    const groups: { date: string; messages: TranscriptMessage[] }[] = [];
    let currentDate = '';
    for (const msg of messages) {
      const d = formatDate(msg.timestamp);
      if (d !== currentDate) {
        currentDate = d;
        groups.push({ date: d, messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  }, [messages]);

  return (
    <YStack flex={1} backgroundColor="$background">
      {/* Header banner */}
      <XStack
        backgroundColor="$purple3"
        borderBottomWidth={1}
        borderBottomColor="$purple5"
        paddingHorizontal="$4"
        paddingVertical="$3"
        alignItems="center"
        gap="$3"
      >
        <View
          width={36}
          height={36}
          borderRadius={18}
          backgroundColor="$purple5"
          alignItems="center"
          justifyContent="center"
        >
          <Mic size={18} color="$purple11" />
        </View>
        <YStack flex={1}>
          <Text fontSize={14} fontWeight="600" color="$purple11">
            Voice Conversation
          </Text>
          {agentName && (
            <Text fontSize={12} color="$purple9">
              with {agentName}
            </Text>
          )}
        </YStack>
        {/* Session status badge */}
        {isActiveSession && (
          <XStack
            backgroundColor="$green3"
            borderRadius={12}
            paddingHorizontal="$2"
            paddingVertical="$1"
            alignItems="center"
            gap="$1"
          >
            <View width={6} height={6} borderRadius={3} backgroundColor="$green9" />
            <Text fontSize={11} color="$green11" fontWeight="600">Live</Text>
          </XStack>
        )}
      </XStack>

      {/* Transcript area */}
      {isLoading ? (
        <FullscreenLoader variant="board" label="Loading transcript..." />
      ) : messages.length === 0 ? (
        <YStack flex={1} alignItems="center" justifyContent="center" padding="$6" gap="$3">
          <Text fontSize={40}>🎙️</Text>
          <Text fontSize={16} fontWeight="600" color="$color12" textAlign="center">
            No transcript yet
          </Text>
          <Text fontSize={14} color="$color11" textAlign="center">
            Start speaking to begin recording the conversation.
          </Text>
        </YStack>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
        >
          <YStack gap="$2">
            {grouped.map((group) => (
              <YStack key={group.date} gap="$2">
                {/* Date separator */}
                <XStack alignItems="center" gap="$2" paddingVertical="$1">
                  <View flex={1} height={1} backgroundColor="$borderColor" />
                  <Text fontSize={11} color="$color10" paddingHorizontal="$2">
                    {group.date}
                  </Text>
                  <View flex={1} height={1} backgroundColor="$borderColor" />
                </XStack>
                {group.messages.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} />
                ))}
              </YStack>
            ))}
          </YStack>
        </ScrollView>
      )}

      {/* Action bar */}
      <YStack
        borderTopWidth={1}
        borderTopColor="$borderColor"
        paddingHorizontal="$4"
        paddingVertical="$3"
        gap="$2"
      >
        {isActiveSession ? (
          // Active session controls
          <XStack gap="$3" justifyContent="center">
            <Button
              size="$4"
              flex={1}
              backgroundColor="$red9"
              pressStyle={{ backgroundColor: '$red10' }}
              onPress={handleStop}
              icon={<MicOff size={18} color="white" />}
            >
              <Text color="white" fontWeight="600">End Session</Text>
            </Button>
          </XStack>
        ) : (
          // Resume / start new session
          <XStack gap="$3" justifyContent="center">
            <Button
              size="$4"
              flex={1}
              backgroundColor="$purple9"
              pressStyle={{ backgroundColor: '$purple10' }}
              onPress={handleResume}
              disabled={!agentId || voiceSession.state === 'connecting'}
              icon={
                voiceSession.state === 'connecting' && isThisAgentActive
                  ? <AppSpinner size="sm" variant="onDark" />
                  : <Phone size={18} color="white" />
              }
            >
              <Text color="white" fontWeight="600">
                {messages.length > 0 ? 'Resume Conversation' : 'Start Voice Chat'}
              </Text>
            </Button>
          </XStack>
        )}

        {/* Message count info */}
        {messages.length > 0 && (
          <Text fontSize={11} color="$color10" textAlign="center">
            {messages.filter((m) => !isSystemLine(m.text)).length} messages
          </Text>
        )}
      </YStack>
    </YStack>
  );
}
