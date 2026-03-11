/**
 * TranscriptDisplay - Shows conversation transcripts
 * 
 * Displays user and agent messages in a scrollable list.
 * Tool calls, results and errors are rendered as special event rows.
 */

import React, { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';
import { Text, View, XStack, YStack } from 'tamagui';
import type { VoiceTranscript as Transcript } from '../../contexts/VoiceSessionContext';

// Map of tool names to readable labels and icons
const TOOL_META: Record<string, { icon: string; label: string; color: string }> = {
  send_message:        { icon: '💬', label: 'send_message',        color: '$blue9' },
  get_channel_messages:{ icon: '📨', label: 'get_channel_messages', color: '$purple9' },
  get_user_context:    { icon: '👤', label: 'get_user_context',     color: '$orange9' },
  list_channels:       { icon: '📋', label: 'list_channels',        color: '$teal9' },
};

function getToolMeta(toolName: string) {
  return TOOL_META[toolName] ?? { icon: '🛠️', label: toolName, color: '$gray9' };
}

// Extract the tool name from a tool_call transcript text
// Format: "🛠️ toolName: ..." or "🛠️ toolName (key: val)"
function parseToolCallText(text: string): { toolName: string; detail: string } {
  // Remove the leading emoji if present
  const clean = text.replace(/^🛠️\s*/, '');
  const colonIdx = clean.indexOf(':');
  const parenIdx = clean.indexOf('(');

  let toolName = clean;
  let detail = '';

  if (colonIdx !== -1 && (parenIdx === -1 || colonIdx < parenIdx)) {
    toolName = clean.substring(0, colonIdx).trim();
    detail = clean.substring(colonIdx + 1).trim();
  } else if (parenIdx !== -1) {
    toolName = clean.substring(0, parenIdx).trim();
    detail = clean.substring(parenIdx).trim();
  }

  return { toolName, detail };
}

interface TranscriptDisplayProps {
  transcripts: Transcript[];
}

export function TranscriptDisplay({ transcripts }: TranscriptDisplayProps) {
  const scrollViewRef = useRef<ScrollView>(null);

  // Auto-scroll to bottom when new transcript arrives
  useEffect(() => {
    if (transcripts.length > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [transcripts]);

  if (transcripts.length === 0) {
    return (
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        padding="$4"
      >
        <Text
          fontSize={14}
          color="$color11"
          textAlign="center"
        >
          Start speaking to begin the conversation
        </Text>
      </YStack>
    );
  }

  return (
    <ScrollView
      ref={scrollViewRef}
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16 }}
    >
      <YStack gap="$3">
        {transcripts.map((transcript) => (
          <TranscriptBubble
            key={transcript.id}
            transcript={transcript}
          />
        ))}
      </YStack>
    </ScrollView>
  );
}

function TranscriptBubble({ transcript }: { transcript: Transcript }) {
  const { text, isUser, timestamp, type } = transcript;

  const timeString = new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  // ── Tool call ──────────────────────────────────────────────────────────────
  if (type === 'tool_call') {
    const { toolName, detail } = parseToolCallText(text);
    const meta = getToolMeta(toolName);

    return (
      <YStack alignItems="center" gap="$1">
        <View
          maxWidth="92%"
          backgroundColor="$blue2"
          borderRadius={10}
          borderWidth={1}
          borderColor="$blue6"
          overflow="hidden"
        >
          {/* Header row */}
          <XStack
            backgroundColor="$blue3"
            paddingHorizontal="$3"
            paddingVertical="$1.5"
            alignItems="center"
            gap="$2"
          >
            <Text fontSize={13}>{meta.icon}</Text>
            <Text fontSize={12} fontWeight="600" color="$blue11" fontFamily="$mono">
              {meta.label}
            </Text>
          </XStack>

          {/* Detail row (only if there's something to show) */}
          {detail ? (
            <View paddingHorizontal="$3" paddingVertical="$2">
              <Text fontSize={12} color="$color11" lineHeight={18} fontFamily="$mono">
                {detail}
              </Text>
            </View>
          ) : null}
        </View>
        <Text fontSize={10} color="$color10" paddingHorizontal="$2">
          {timeString}
        </Text>
      </YStack>
    );
  }

  // ── Tool result ────────────────────────────────────────────────────────────
  if (type === 'tool_result') {
    return (
      <YStack alignItems="center" gap="$1">
        <View
          maxWidth="92%"
          backgroundColor="$green2"
          borderRadius={10}
          borderWidth={1}
          borderColor="$green6"
          overflow="hidden"
        >
          <XStack
            backgroundColor="$green3"
            paddingHorizontal="$3"
            paddingVertical="$1.5"
            alignItems="center"
            gap="$2"
          >
            <Text fontSize={13}>✅</Text>
            <Text fontSize={12} fontWeight="600" color="$green11" fontFamily="$mono">
              tool_result
            </Text>
          </XStack>
          {text ? (
            <View paddingHorizontal="$3" paddingVertical="$2">
              <Text
                fontSize={12}
                color="$color11"
                lineHeight={18}
                fontFamily="$mono"
                numberOfLines={6}
                ellipsizeMode="tail"
              >
                {text}
              </Text>
            </View>
          ) : null}
        </View>
        <Text fontSize={10} color="$color10" paddingHorizontal="$2">
          {timeString}
        </Text>
      </YStack>
    );
  }

  // ── Tool error ─────────────────────────────────────────────────────────────
  if (type === 'tool_error') {
    return (
      <YStack alignItems="center" gap="$1">
        <View
          maxWidth="92%"
          backgroundColor="$red2"
          borderRadius={10}
          borderWidth={1}
          borderColor="$red6"
          overflow="hidden"
        >
          <XStack
            backgroundColor="$red3"
            paddingHorizontal="$3"
            paddingVertical="$1.5"
            alignItems="center"
            gap="$2"
          >
            <Text fontSize={13}>❌</Text>
            <Text fontSize={12} fontWeight="600" color="$red11" fontFamily="$mono">
              tool_error
            </Text>
          </XStack>
          <View paddingHorizontal="$3" paddingVertical="$2">
            <Text fontSize={12} color="$red11" lineHeight={18} fontFamily="$mono">
              {text}
            </Text>
          </View>
        </View>
        <Text fontSize={10} color="$color10" paddingHorizontal="$2">
          {timeString}
        </Text>
      </YStack>
    );
  }

  // ── Normal transcript bubble ───────────────────────────────────────────────
  return (
    <YStack
      alignItems={isUser ? 'flex-end' : 'flex-start'}
      gap="$1"
    >
      <View
        maxWidth="80%"
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
          {text}
        </Text>
      </View>
      <Text fontSize={11} color="$color11" paddingHorizontal="$2">
        {timeString}
      </Text>
    </YStack>
  );
}
