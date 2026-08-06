/**
 * TranscriptDisplay - Shows conversation transcripts
 * 
 * Displays user and agent messages in a scrollable list.
 * Tool calls, results and errors are rendered as special event rows.
 */

import { CheckCircle, Clock, ExternalLink, Lock, XCircle } from '@tamagui/lucide-icons';
import { Phone } from '@tamagui/lucide-icons';
import React, { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';
import { Text, View, XStack, YStack } from 'tamagui';
import type { VoiceTranscript as Transcript } from '../../contexts/VoiceSessionContext';
import { useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { colors } from '../mca/primitives/colors';
import { useColors } from '../mca/primitives/useColors';

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
  /** Historic transcripts loaded from MongoDB (previous session) */
  historicTranscripts?: Transcript[];
  /** Live transcripts from the current session */
  liveTranscripts?: Transcript[];
  /**
   * Fallback: combined transcripts (used when caller doesn't split historic/live).
   * If historicTranscripts/liveTranscripts are provided, this is ignored.
   */
  transcripts?: Transcript[];
}

export function TranscriptDisplay({
  historicTranscripts,
  liveTranscripts,
  transcripts,
}: TranscriptDisplayProps) {
  const c = useColors();
  const scrollViewRef = useRef<ScrollView>(null);

  // Resolve which lists to render
  const historic = historicTranscripts ?? [];
  const live = liveTranscripts ?? transcripts ?? [];
  const hasHistoric = historic.length > 0;
  const hasLive = live.length > 0;
  const isEmpty = !hasHistoric && !hasLive;

  // Auto-scroll to bottom when new transcript arrives
  useEffect(() => {
    if (!isEmpty) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [historic.length, live.length, isEmpty]);

  if (isEmpty) {
    return (
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        padding="$4"
      >
        <Text
          fontSize={14}
          color={c.text3}
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
        {/* Historic transcripts from previous session */}
        {hasHistoric && historic.map((transcript) => (
          <TranscriptBubble
            key={transcript.id}
            transcript={transcript}
            dimmed
          />
        ))}

        {/* Visual separator between historic and live */}
        {hasHistoric && (
          <SessionDivider label={hasLive ? 'Current session' : 'End of previous session'} />
        )}

        {/* Live transcripts from current session */}
        {hasLive && live.map((transcript) => (
          <TranscriptBubble
            key={transcript.id}
            transcript={transcript}
          />
        ))}
      </YStack>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Channel event row
// ---------------------------------------------------------------------------

function ChannelEventRow({
  event,
  dimmed,
  timeString,
}: {
  event: NonNullable<Transcript['channelEvent']>;
  dimmed: boolean;
  timeString: string;
}) {
  const c = useColors();
  const openWindow = useTilingStore((s) => s.openWindow);
  const { eventType, observedChannelId, observedChannelName, toolName, resolution } = event;
  const shortTool = toolName ? String(toolName).split('_').pop() : 'tool';
  const name = observedChannelName || observedChannelId || 'channel';

  const configs = {
    channel_started: {
      icon: <Clock size={12} color={c.text3} />,
      bg: c.bgInner,
      border: c.border,
      label: `${name} started working`,
    },
    channel_finished: {
      icon: <CheckCircle size={12} color={`${colors.green}99`} />,
      bg: `${colors.green}0A`,
      border: `${colors.green}1F`,
      label: `${name} finished`,
    },
    channel_permission: {
      icon: <Lock size={12} color={`${colors.amber}B3`} />,
      bg: `${colors.amber}0D`,
      border: `${colors.amber}26`,
      label: `${name} needs approval: ${shortTool}`,
    },
    channel_resolved: {
      icon: resolution === 'granted'
        ? <CheckCircle size={12} color={`${colors.green}B3`} />
        : <XCircle size={12} color={`${colors.red}B3`} />,
      bg: resolution === 'granted' ? `${colors.green}0A` : `${colors.red}0A`,
      border: resolution === 'granted' ? `${colors.green}1F` : `${colors.red}1F`,
      label: `${name}: ${shortTool} ${resolution === 'granted' ? 'approved' : 'denied'}`,
    },
  };

  const cfg = configs[eventType] ?? configs.channel_started;

  return (
    <YStack alignItems="center" gap="$1" opacity={dimmed ? 0.45 : 1}>
      <XStack
        backgroundColor={cfg.bg}
        borderRadius={8}
        borderWidth={1}
        borderColor={cfg.border}
        paddingHorizontal="$3"
        paddingVertical="$1.5"
        alignItems="center"
        gap="$2"
        maxWidth="92%"
      >
        {cfg.icon}
        <Text fontSize={11} color={c.text3} flex={1}>
          {cfg.label}
        </Text>
        {eventType === 'channel_permission' && observedChannelId && (
          <XStack
            paddingHorizontal={6}
            paddingVertical={2}
            borderRadius={4}
            backgroundColor={`${colors.amber}1F`}
            borderWidth={1}
            borderColor={`${colors.amber}40`}
            alignItems="center"
            gap={3}
            cursor="pointer"
            hoverStyle={{ backgroundColor: `${colors.amber}33` }}
            onPress={() => openWindow('chat', { channelId: observedChannelId }, true)}
          >
            <ExternalLink size={10} color={`${colors.amber}CC`} />
            <Text fontSize={10} color={`${colors.amber}E6`} fontWeight="500">Approve</Text>
          </XStack>
        )}
      </XStack>
      <Text fontSize={10} color={c.text3}>{timeString}</Text>
    </YStack>
  );
}

// ---------------------------------------------------------------------------
// Session divider
// ---------------------------------------------------------------------------

function SessionDivider({ label }: { label: string }) {
  return (
    <YStack alignItems="center" paddingVertical="$2" gap="$1.5">
      <XStack alignItems="center" gap="$2" width="100%">
        <View flex={1} height={1} backgroundColor="$borderColor" opacity={0.5} />
        <XStack
          backgroundColor="$purple3"
          borderRadius={10}
          paddingHorizontal="$3"
          paddingVertical="$1"
          borderWidth={1}
          borderColor="$purple5"
          alignItems="center"
          gap="$1.5"
        >
          <Text fontSize={10} color="$purple11" fontWeight="600">
            {label}
          </Text>
        </XStack>
        <View flex={1} height={1} backgroundColor="$borderColor" opacity={0.5} />
      </XStack>
    </YStack>
  );
}

function TranscriptBubble({ transcript, dimmed = false }: { transcript: Transcript; dimmed?: boolean }) {
  const c = useColors();
  const { text, isUser, timestamp, type } = transcript;

  const timeString = new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  // ── Channel event ──────────────────────────────────────────────────────────
  if (type === 'channel_event' && transcript.channelEvent) {
    return <ChannelEventRow event={transcript.channelEvent} dimmed={dimmed} timeString={timeString} />;
  }

  // ── Tool call ──────────────────────────────────────────────────────────────
  if (type === 'tool_call') {
    const { toolName, detail } = parseToolCallText(text);
    const meta = getToolMeta(toolName);

    return (
      <YStack alignItems="center" gap="$1" opacity={dimmed ? 0.45 : 1}>
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
      <YStack alignItems="center" gap="$1" opacity={dimmed ? 0.45 : 1}>
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
      <YStack alignItems="center" gap="$1" opacity={dimmed ? 0.45 : 1}>
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
      opacity={dimmed ? 0.5 : 1}
    >
      <View
        maxWidth="80%"
        backgroundColor={isUser ? (dimmed ? `${colors.indigo}40` : `${colors.indigo}2E`) : c.bgCard}
        borderTopLeftRadius={isUser ? 16 : 4}
        borderTopRightRadius={isUser ? 4 : 16}
        borderBottomLeftRadius={16}
        borderBottomRightRadius={16}
        borderWidth={1}
        borderColor={isUser ? `${colors.indigo}40` : c.border}
        paddingHorizontal="$3"
        paddingVertical="$2.5"
      >
        {/* Phone icon badge — indica que es un mensaje de voz */}
        <XStack gap="$1.5" alignItems="center" marginBottom="$1">
          <Phone size={10} color={isUser ? colors.indigo : c.text3} />
          <Text fontSize={10} color={isUser ? colors.indigo : c.text3} opacity={0.8}>
            {isUser ? 'Tú' : 'Agente'} · voz
          </Text>
        </XStack>
        <Text
          fontSize={14}
          color={isUser ? c.text : c.text}
          lineHeight={20}
        >
          {text}
        </Text>
      </View>
      <Text fontSize={11} color={c.text3} paddingHorizontal="$2">
        {timeString}
      </Text>
    </YStack>
  );
}
