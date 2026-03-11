/**
 * VoiceControls - Control buttons for voice conversation
 * 
 * Shows:
 * - Connect/Disconnect button
 * - Mute/Unmute button
 * - Connection status indicator
 */

import { Mic, MicOff, Phone, PhoneOff } from '@tamagui/lucide-icons';
import React from 'react';
import { Button, Text, View, XStack, YStack } from 'tamagui';
import type { VoiceSessionState as ConversationState } from '../../contexts/VoiceSessionContext';

interface VoiceControlsProps {
  state: ConversationState;
  isConnected: boolean;
  isMuted: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleMute: () => void;
}

export function VoiceControls({
  state,
  isConnected,
  isMuted,
  onConnect,
  onDisconnect,
  onToggleMute,
}: VoiceControlsProps) {
  const isConnecting = state === 'connecting';
  const canMute = isConnected && !isConnecting;

  return (
    <YStack
      padding="$4"
      gap="$3"
      borderTopWidth={1}
      borderTopColor="$borderColor"
      backgroundColor="$background"
    >
      {/* Connection Status */}
      <XStack
        alignItems="center"
        justifyContent="center"
        gap="$2"
      >
        <View
          width={8}
          height={8}
          borderRadius={4}
          backgroundColor={isConnected ? '$green9' : '$gray8'}
        />
        <Text fontSize={12} color="$color11">
          {isConnected ? 'Connected' : 'Disconnected'}
        </Text>
      </XStack>

      {/* Control Buttons */}
      <XStack gap="$3" justifyContent="center">
        {/* Mute/Unmute Button */}
        <Button
          size="$5"
          circular
          disabled={!canMute}
          onPress={onToggleMute}
          backgroundColor={isMuted ? '$red9' : '$gray4'}
          borderWidth={1}
          borderColor={isMuted ? '$red10' : '$borderColor'}
          pressStyle={{
            opacity: 0.8,
            scale: 0.95,
          }}
          icon={isMuted ? <MicOff size={24} /> : <Mic size={24} />}
        />

        {/* Connect/Disconnect Button */}
        <Button
          size="$6"
          circular
          disabled={isConnecting}
          onPress={isConnected ? onDisconnect : onConnect}
          backgroundColor={isConnected ? '$red9' : '$green9'}
          borderWidth={2}
          borderColor={isConnected ? '$red10' : '$green10'}
          pressStyle={{
            opacity: 0.9,
            scale: 0.95,
          }}
          icon={
            isConnected ? (
              <PhoneOff size={28} color="white" />
            ) : (
              <Phone size={28} color="white" />
            )
          }
        />
      </XStack>

      {/* Instructions */}
      {!isConnected && (
        <Text
          fontSize={12}
          color="$color11"
          textAlign="center"
          paddingTop="$2"
        >
          Tap the green button to start the conversation
        </Text>
      )}

      {isConnecting && (
        <Text
          fontSize={12}
          color="$color11"
          textAlign="center"
          paddingTop="$2"
        >
          Connecting...
        </Text>
      )}
    </YStack>
  );
}
