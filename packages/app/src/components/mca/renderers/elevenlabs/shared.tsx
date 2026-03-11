/**
 * Shared components and utilities for ElevenLabs renderer
 */

import { ChevronRight } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../../../app/_layout';
import { usePulseAnimation } from '../../../../hooks/usePulseAnimation';

// Get backend base URL for static assets and workspace files
function getBackendUrl(): string {
  try {
    const client = getTerosClient();
    return client.getBackendBaseUrl();
  } catch {
    return '';
  }
}

// ElevenLabs icon from backend static — lazy to avoid module-scope initialization error
export function getElevenLabsIcon(): string {
  return `${getBackendUrl()}/static/elevenlabs-icon.png`;
}

// ============================================================================
// Colors
// ============================================================================

export const colors = {
  // Status dot
  success: '#22c55e',
  running: '#06b6d4',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Badges
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },
  badgeGreen: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeBlue: { text: '#93c5fd', bg: 'rgba(59,130,246,0.1)' },
  badgeYellow: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeRed: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgePurple: { text: '#c4b5fd', bg: 'rgba(139,92,246,0.1)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#a1a1aa',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgInnerDark: 'rgba(0,0,0,0.25)',
  border: 'rgba(255,255,255,0.03)',
  borderLight: 'rgba(255,255,255,0.05)',
};

// ============================================================================
// Utilities
// ============================================================================

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function parseOutput<T>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

export function formatCharacters(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Convert /workspace path to backend-accessible URL
 * /workspace/file.mp3 -> http://backend/workspace/file.mp3
 */
export function getFileUrl(filePath: string): string {
  if (!filePath) return '';
  
  // If already a URL, return as-is
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }
  
  const backendUrl = getBackendUrl();
  
  // Remove leading /workspace/ if present
  const cleanPath = filePath.replace(/^\/workspace\//, '');
  
  return `${backendUrl}/workspace/${cleanPath}`;
}

// ============================================================================
// Shared Components
// ============================================================================

interface StatusDotProps {
  status: 'running' | 'completed' | 'failed';
}

export function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'running' ? colors.running : status === 'completed' ? colors.success : colors.failed;

  const glow =
    status === 'running'
      ? colors.glowRunning
      : status === 'completed'
        ? colors.glowSuccess
        : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' ? pulseAnim : 1,
        shadowColor: glow,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 3,
        elevation: 3,
      }}
    />
  );
}

export interface BadgeProps {
  text: string;
  variant: 'gray' | 'green' | 'blue' | 'yellow' | 'red' | 'purple';
}

export function Badge({ text, variant }: BadgeProps) {
  const colorMap = {
    gray: colors.badgeGray,
    green: colors.badgeGreen,
    blue: colors.badgeBlue,
    yellow: colors.badgeYellow,
    red: colors.badgeRed,
    purple: colors.badgePurple,
  };

  const { text: textColor, bg } = colorMap[variant];

  return (
    <XStack backgroundColor={bg} paddingHorizontal={5} paddingVertical={1} borderRadius={3}>
      <Text color={textColor} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}

interface HeaderRowProps {
  status: 'running' | 'completed' | 'failed';
  description: string;
  duration?: number;
  badge?: { text: string; variant: BadgeProps['variant'] };
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
}

export function HeaderRow({
  status,
  description,
  duration,
  badge,
  expanded,
  onToggle,
  isInContainer,
}: HeaderRowProps) {
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [expanded, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={10}
      backgroundColor={isInContainer ? 'transparent' : 'rgba(39,39,42,0.6)'}
      borderRadius={isInContainer ? 0 : 8}
      borderWidth={isInContainer ? 0 : 1}
      borderColor={isInContainer ? 'transparent' : 'rgba(255,255,255,0.04)'}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={isInContainer ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.04)'}
      width={isInContainer ? undefined : '100%'}
      pressStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
      }}
      hoverStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
        borderColor: isInContainer ? 'transparent' : 'rgba(255,255,255,0.08)',
      }}
      onPress={onToggle}
      cursor="pointer"
    >
      <StatusDot status={status} />

      <Image source={{ uri: getElevenLabsIcon() }} width={16} height={16} borderRadius={3} />

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          generating
        </Text>
      ) : (
        duration !== undefined && (
          <Text color={colors.muted} fontSize={9} fontFamily="$mono">
            {formatDuration(duration)}
          </Text>
        )
      )}

      {badge && <Badge text={badge.text} variant={badge.variant} />}

      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={10} color="#3f3f46" />
      </Animated.View>
    </XStack>
  );
}

export function ExpandedContainer({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor="rgba(255,255,255,0.04)"
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

export function ExpandedBody({ children }: { children: React.ReactNode }) {
  return <YStack padding={8}>{children}</YStack>;
}
