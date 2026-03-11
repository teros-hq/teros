/**
 * VoiceVisualizer - Visual feedback for voice conversation
 * 
 * Shows:
 * - Current state (idle, listening, thinking, speaking)
 * - Waveform animation
 * - Audio level indicator
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { View, XStack, YStack, Text } from 'tamagui';
import type { VoiceSessionState as ConversationState } from '../../contexts/VoiceSessionContext';

interface VoiceVisualizerProps {
  state: ConversationState;
  audioLevel: number; // 0-1
  vadScore: number; // 0-1
}

const WAVEFORM_BARS = 30;
const MIN_BAR_HEIGHT = 4;
const MAX_BAR_HEIGHT = 60;

export function VoiceVisualizer({ state, audioLevel, vadScore }: VoiceVisualizerProps) {
  // Animation values for each bar
  const barAnimations = useRef(
    Array.from({ length: WAVEFORM_BARS }, () => new Animated.Value(0.2))
  ).current;

  // Pulsing animation for thinking/speaking states
  const pulseAnimation = useRef(new Animated.Value(1)).current;

  // Animate bars based on audio level and state
  useEffect(() => {
    if (state === 'listening' || state === 'speaking') {
      // Animate bars with random heights influenced by audio level
      barAnimations.forEach((anim, index) => {
        const delay = index * 20;
        const baseHeight = state === 'listening' ? audioLevel : 0.7;
        const randomFactor = Math.random() * 0.3;
        const targetHeight = Math.max(0.2, Math.min(1, baseHeight + randomFactor));

        Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: targetHeight,
              duration: 200 + Math.random() * 200,
              delay,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: false,
            }),
            Animated.timing(anim, {
              toValue: 0.2 + Math.random() * 0.2,
              duration: 200 + Math.random() * 200,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: false,
            }),
          ])
        ).start();
      });
    } else {
      // Reset to idle state
      barAnimations.forEach((anim) => {
        Animated.timing(anim, {
          toValue: 0.2,
          duration: 300,
          useNativeDriver: false,
        }).start();
      });
    }
  }, [state, audioLevel, barAnimations]);

  // Pulse animation for thinking state
  useEffect(() => {
    if (state === 'thinking') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnimation, {
            toValue: 1.2,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnimation, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      Animated.timing(pulseAnimation, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [state, pulseAnimation]);

  // Get color based on state
  const getStateColor = () => {
    switch (state) {
      case 'listening':
        return vadScore > 0.5 ? '#10B981' : '#6366F1'; // Green if user speaking, blue otherwise
      case 'thinking':
        return '#F59E0B'; // Amber
      case 'speaking':
        return '#8B5CF6'; // Purple
      case 'connecting':
        return '#6B7280'; // Gray
      default:
        return '#3F3F46'; // Dark gray
    }
  };

  // Get state label
  const getStateLabel = () => {
    switch (state) {
      case 'connecting':
        return 'Connecting...';
      case 'listening':
        return vadScore > 0.5 ? 'Listening...' : 'Ready';
      case 'thinking':
        return 'Thinking...';
      case 'speaking':
        return 'Speaking...';
      default:
        return 'Idle';
    }
  };

  const stateColor = getStateColor();

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      paddingVertical="$6"
      gap="$4"
    >
      {/* State Indicator */}
      <Text
        fontSize={14}
        fontWeight="600"
        color={stateColor}
        textTransform="uppercase"
        letterSpacing={1}
      >
        {getStateLabel()}
      </Text>

      {/* Waveform */}
      <XStack
        height={MAX_BAR_HEIGHT}
        alignItems="center"
        justifyContent="center"
        gap={3}
        paddingHorizontal="$4"
      >
        {barAnimations.map((anim, index) => (
          <Animated.View
            key={index}
            style={{
              width: 4,
              borderRadius: 2,
              backgroundColor: stateColor,
              height: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [MIN_BAR_HEIGHT, MAX_BAR_HEIGHT],
              }),
              opacity: state === 'idle' ? 0.3 : 1,
            }}
          />
        ))}
      </XStack>

      {/* VAD Indicator (only show when listening) */}
      {state === 'listening' && vadScore > 0.3 && (
        <View
          width={200}
          height={4}
          backgroundColor="rgba(16, 185, 129, 0.2)"
          borderRadius={2}
          overflow="hidden"
        >
          <View
            width={`${vadScore * 100}%`}
            height="100%"
            backgroundColor="#10B981"
          />
        </View>
      )}
    </YStack>
  );
}
