/**
 * Replicate Renderer - Shared Components & Utilities
 */

import { ChevronRight, Image as ImageIcon, Video } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text, XStack, YStack } from 'tamagui';
import { usePulseAnimation } from '../../../../hooks/usePulseAnimation';

// ============================================================================
// Colors
// ============================================================================

export const colors = {
  // Replicate brand (dark theme friendly)
  replicate: '#FFFFFF',
  replicateDim: '#A1A1AA',

  // Status dot
  success: '#22c55e',
  running: '#06b6d4',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeWhite: { text: '#e4e4e7', bg: 'rgba(255,255,255,0.1)' },
  badgeBlue: { text: '#93c5fd', bg: 'rgba(59,130,246,0.1)' },
  badgePurple: { text: '#c4b5fd', bg: 'rgba(139,92,246,0.1)' },
  badgeRed: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#a1a1aa',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgInnerDark: 'rgba(0,0,0,0.25)',
  border: 'rgba(255,255,255,0.03)',
  borderLight: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',
};

// ============================================================================
// Types
// ============================================================================

export type ToolStatusType = 'running' | 'completed' | 'failed' | 'pending_permission';

export type BadgeVariant = 'success' | 'white' | 'blue' | 'purple' | 'red' | 'gray';

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract short tool name from full tool name
 * "replicate_replicate-flux-pro" -> "replicate-flux-pro"
 */
export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

/**
 * Format duration in ms to human readable
 */
export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Parse JSON output safely
 */
export function parseOutput<T = any>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return { text: output } as T;
  }
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number = 50): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Get friendly model name
 */
export function getModelDisplayName(model: string): string {
  if (!model) return 'Unknown';
  // "black-forest-labs/flux-pro" -> "flux-pro"
  const parts = model.split('/');
  return parts[parts.length - 1] || model;
}

/**
 * Check if tool is image generation
 */
export function isImageTool(toolName: string): boolean {
  const short = getShortToolName(toolName);
  return short.includes('flux') || short === 'replicate-run';
}

/**
 * Check if tool is video generation
 */
export function isVideoTool(toolName: string): boolean {
  const short = getShortToolName(toolName);
  return short.includes('video') || short.includes('minimax') || short.includes('veo');
}

/**
 * Extract image/video URLs from output
 */
export function extractMediaUrls(output: any): string[] {
  if (!output) return [];

  // Direct array of URLs
  if (Array.isArray(output)) {
    return output.filter((item) => typeof item === 'string' && item.startsWith('http'));
  }

  // Object with output array
  if (output.output && Array.isArray(output.output)) {
    return output.output.filter((item: any) => typeof item === 'string' && item.startsWith('http'));
  }

  // Object with output as single URL string (FLUX Pro returns this)
  if (output.output && typeof output.output === 'string' && output.output.startsWith('http')) {
    return [output.output];
  }

  // Single URL string
  if (typeof output === 'string' && output.startsWith('http')) {
    return [output];
  }

  // Object with url field
  if (output.url && typeof output.url === 'string') {
    return [output.url];
  }

  return [];
}

// ============================================================================
// Components
// ============================================================================

/**
 * Replicate Logo SVG Icon
 */
export function ReplicateLogo({ size = 14 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M24 10.262v2.712h-9.518V24h-3.034V10.262zm0-5.131v2.717H8.755V24H5.722V5.131zM24 0v2.717H3.034V24H0V0z"
        fill={colors.replicateDim}
      />
    </Svg>
  );
}

/**
 * Status Dot with pulse animation
 */
interface StatusDotProps {
  status: ToolStatusType;
}

export function StatusDot({ status }: StatusDotProps) {
  const isActive = status === 'running' || status === 'pending_permission';
  const color = isActive ? colors.running : status === 'completed' ? colors.success : colors.failed;

  const glow = isActive
    ? colors.glowRunning
    : status === 'completed'
      ? colors.glowSuccess
      : colors.glowFailed;

  const pulseAnim = usePulseAnimation(isActive);

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: isActive ? pulseAnim : 1,
        shadowColor: glow,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 3,
        elevation: 3,
      }}
    />
  );
}

/**
 * Badge Component
 */
interface BadgeProps {
  text: string;
  variant: BadgeVariant;
}

export function Badge({ text, variant }: BadgeProps) {
  const colorMap = {
    success: colors.badgeSuccess,
    white: colors.badgeWhite,
    blue: colors.badgeBlue,
    purple: colors.badgePurple,
    red: colors.badgeRed,
    gray: colors.badgeGray,
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

/**
 * Header Row - collapsible header for tool cards
 */
export interface HeaderRowProps {
  status: ToolStatusType;
  description: string;
  duration?: number;
  badge?: { text: string; variant: BadgeVariant };
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
  icon?: 'image' | 'video';
}

export function HeaderRow({
  status,
  description,
  duration,
  badge,
  expanded,
  onToggle,
  isInContainer,
  icon,
}: HeaderRowProps) {
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  const isActive = status === 'running' || status === 'pending_permission';

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
      borderColor={isInContainer ? 'transparent' : colors.borderLight}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={colors.borderLight}
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
      <ReplicateLogo size={14} />

      {icon === 'video' ? (
        <Video size={12} color={colors.muted} />
      ) : icon === 'image' ? (
        <ImageIcon size={12} color={colors.muted} />
      ) : null}

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {isActive ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          {status === 'pending_permission' ? 'awaiting' : 'generating'}
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
        <ChevronRight size={10} color={colors.chevron} />
      </Animated.View>
    </XStack>
  );
}

/**
 * Expanded Container - wrapper for expanded content
 */
export function ExpandedContainer({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor={colors.borderLight}
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

/**
 * Expanded Body - content area inside expanded container
 */
export function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack padding={8} gap={6}>
      {children}
    </YStack>
  );
}

/**
 * Info Block - displays label + value
 */
interface InfoBlockProps {
  label: string;
  value: string;
  mono?: boolean;
}

export function InfoBlock({ label, value, mono }: InfoBlockProps) {
  return (
    <YStack
      backgroundColor={colors.bgInnerDark}
      borderRadius={5}
      padding={8}
      paddingHorizontal={10}
    >
      <Text color={colors.muted} fontSize={9} marginBottom={4}>
        {label}
      </Text>
      <Text color={colors.bright} fontSize={11} fontFamily={mono ? '$mono' : undefined}>
        {value || '(empty)'}
      </Text>
    </YStack>
  );
}

/**
 * Error Block - displays error message
 */
export function ErrorBlock({ error }: { error: string }) {
  return (
    <YStack
      backgroundColor="rgba(239,68,68,0.1)"
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
    >
      <Text color={colors.badgeRed.text} fontSize={10} fontFamily="$mono">
        {error}
      </Text>
    </YStack>
  );
}

/**
 * Loading Placeholder - skeleton for loading state
 */
export function LoadingPlaceholder({ icon }: { icon?: 'image' | 'video' }) {
  const Icon = icon === 'video' ? Video : ImageIcon;
  const text = icon === 'video' ? 'Generating video...' : 'Generating image...';

  return (
    <YStack
      backgroundColor={colors.bgInner}
      borderRadius={5}
      padding={10}
      alignItems="center"
      gap={8}
    >
      <Icon size={24} color={colors.muted} />
      <Text color={colors.secondary} fontSize={10}>
        {text}
      </Text>
    </YStack>
  );
}
