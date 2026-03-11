/**
 * VoiceWindowContent
 *
 * Pure voice chat view. Does not manage any connection —
 * all state and WebSocket lifecycle live in
 * VoiceSessionContext, which persists even when this window is unmounted.
 */

import React, { useCallback } from 'react';
import { Alert } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { useVoiceSession } from '../../contexts/VoiceSessionContext';
import { TranscriptDisplay } from '../../components/voice/TranscriptDisplay';
import { VoiceControls } from '../../components/voice/VoiceControls';
import { VoiceVisualizer } from '../../components/voice/VoiceVisualizer';
import type { VoiceWindowProps } from './definition';
import { AppSpinner } from '../../components/ui';

interface Props extends VoiceWindowProps {
  windowId: string;
}

export function VoiceWindowContent({ windowId, agentId, agentName }: Props) {
  const {
    state,
    isConnected,
    activeAgentId,
    transcripts,
    conversationId,
    audioLevel,
    vadScore,
    isMuted,
    isReconnecting,
    lastSession,
    startSession,
    stopSession,
    toggleMute,
  } = useVoiceSession();

  // This window is "active" if the global session is for this agent
  const isThisAgentActive = activeAgentId === agentId;

  const handleConnect = useCallback(async () => {
    try {
      await startSession(agentId);
    } catch (error) {
      Alert.alert('Connection Failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [agentId, startSession]);

  const handleDisconnect = useCallback(() => {
    stopSession();
  }, [stopSession]);

  // State and transcripts to display: only those from this session
  const displayState = isThisAgentActive ? state : 'idle';
  const displayTranscripts = isThisAgentActive ? transcripts : [];
  const displayAudioLevel = isThisAgentActive ? audioLevel : 0;
  const displayVadScore = isThisAgentActive ? vadScore : 0;
  const displayConnected = isThisAgentActive && isConnected;

  // Relative time for last session
  const lastSessionAge = lastSession && lastSession.agentId === agentId
    ? (() => {
        const diff = Date.now() - lastSession.savedAt;
        const mins = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        if (days > 0) return `${days}d ago`;
        if (hours > 0) return `${hours}h ago`;
        if (mins > 0) return `${mins}m ago`;
        return 'just now';
      })()
    : null;

  return (
    <YStack flex={1} backgroundColor="$background">
      {/* Reconnecting banner */}
      {isReconnecting && isThisAgentActive && (
        <XStack
          backgroundColor="$orange3"
          paddingHorizontal="$4"
          paddingVertical="$2"
          alignItems="center"
          gap="$2"
          borderBottomWidth={1}
          borderBottomColor="$orange5"
        >
          <AppSpinner size="sm" variant="warning" />
          <Text fontSize={12} color="$orange11" fontWeight="500">
            Reconnecting...
          </Text>
        </XStack>
      )}

      {/* Visualizer */}
      <VoiceVisualizer
        state={displayState}
        audioLevel={displayAudioLevel}
        vadScore={displayVadScore}
      />

      {/* Transcripts */}
      <TranscriptDisplay transcripts={displayTranscripts} />

      {/* Controls */}
      <VoiceControls
        state={displayState}
        isConnected={displayConnected}
        isMuted={isMuted}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onToggleMute={toggleMute}
      />

      {/* Last session hint — shown when idle and there's a previous session */}
      {!displayConnected && !isReconnecting && lastSessionAge && (
        <YStack
          paddingHorizontal="$4"
          paddingBottom="$3"
          alignItems="center"
        >
          <Text fontSize={11} color="$color10" textAlign="center">
            Last session {lastSessionAge} · Tap connect to resume
          </Text>
        </YStack>
      )}

      {/* Debug info */}
      {__DEV__ && conversationId && isThisAgentActive && (
        <YStack padding="$2" backgroundColor="$gray2" borderTopWidth={1} borderTopColor="$borderColor">
          <Text style={{ fontSize: 10, color: '#666' }}>
            Conversation: {conversationId}
          </Text>
        </YStack>
      )}
    </YStack>
  );
}
