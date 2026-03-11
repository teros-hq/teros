/**
 * Messaging MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for messaging tools.
 * Minimal renderer since the actual content appears as a message in the chat.
 * Shows a subtle indicator for sent content, more prominent for errors.
 *
 * Tools:
 * - send-image: Send image to chat
 * - send-video: Send video to chat
 * - send-audio: Send audio to chat
 * - send-file: Send file to chat
 * - send-html: Send HTML widget to chat
 */

import {
  ChevronRight,
  Code,
  FileText,
  Image,
  MessageSquare,
  Music,
  Video,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { usePulseAnimation } from '../../../hooks/usePulseAnimation';

// ============================================================================
// Colors
// ============================================================================

const colors = {
  // Status dot
  success: '#22c55e',
  running: '#06b6d4',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Icon
  icon: '#8b5cf6',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#9ca3af',
  muted: '#52525b',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  border: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',
};

// ============================================================================
// Tool Config
// ============================================================================

interface ToolInfo {
  icon: typeof Image;
  label: string;
}

function getToolInfo(toolName: string): ToolInfo {
  const name = toolName.toLowerCase();

  if (name.includes('image')) {
    return { icon: Image, label: 'Send image' };
  }
  if (name.includes('video')) {
    return { icon: Video, label: 'Send video' };
  }
  if (name.includes('audio')) {
    return { icon: Music, label: 'Send audio' };
  }
  if (name.includes('file')) {
    return { icon: FileText, label: 'Send file' };
  }
  if (name.includes('html')) {
    return { icon: Code, label: 'Send widget' };
  }

  return { icon: MessageSquare, label: 'Send content' };
}

// ============================================================================
// Utilities
// ============================================================================

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// Components
// ============================================================================

interface StatusDotProps {
  status: 'running' | 'completed' | 'failed';
}

function StatusDot({ status }: StatusDotProps) {
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

interface BadgeProps {
  text: string;
  variant: 'success' | 'error' | 'gray';
}

function Badge({ text, variant }: BadgeProps) {
  const styles = {
    success: colors.badgeSuccess,
    error: colors.badgeError,
    gray: colors.badgeGray,
  };
  const { text: textColor, bg } = styles[variant];

  return (
    <XStack backgroundColor={bg} paddingHorizontal={4} paddingVertical={1} borderRadius={3}>
      <Text color={textColor} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}

interface HeaderRowProps {
  status: 'running' | 'completed' | 'failed';
  icon: React.ReactNode;
  description: string;
  duration?: number;
  badge?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
}

function HeaderRow({
  status,
  icon,
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
      borderColor={isInContainer ? 'transparent' : colors.border}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={colors.border}
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
      {icon}

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          sending
        </Text>
      ) : (
        duration !== undefined && (
          <Text color={colors.muted} fontSize={9} fontFamily="$mono">
            {formatDuration(duration)}
          </Text>
        )
      )}

      {badge}

      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={10} color={colors.chevron} />
      </Animated.View>
    </XStack>
  );
}

function ExpandedContainer({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor={colors.border}
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack padding={8} gap={6}>
      {children}
    </YStack>
  );
}

// ============================================================================
// Content Blocks
// ============================================================================

interface ContentPreviewProps {
  input?: Record<string, any>;
  toolName: string;
}

function ContentPreview({ input, toolName }: ContentPreviewProps) {
  if (!input) return null;

  const rows: Array<{ label: string; value: string }> = [];

  if (input.url) {
    rows.push({ label: 'URL', value: input.url });
  }
  if (input.filename) {
    rows.push({ label: 'File', value: input.filename });
  }
  if (input.caption) {
    rows.push({ label: 'Caption', value: input.caption });
  }
  if (input.width && input.height) {
    rows.push({ label: 'Size', value: `${input.width}×${input.height}` });
  }
  if (input.duration) {
    rows.push({ label: 'Duration', value: `${input.duration}s` });
  }

  if (rows.length === 0) return null;

  return (
    <YStack
      backgroundColor={colors.bgInner}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      gap={4}
    >
      {rows.map((row, idx) => (
        <XStack key={idx} gap={8} alignItems="center">
          <Text color={colors.muted} fontSize={9} width={50}>
            {row.label}
          </Text>
          <Text color={colors.secondary} fontSize={10} flex={1} numberOfLines={1}>
            {row.value}
          </Text>
        </XStack>
      ))}
    </YStack>
  );
}

interface ErrorBlockProps {
  error: string;
}

function ErrorBlock({ error }: ErrorBlockProps) {
  return (
    <YStack
      backgroundColor="rgba(239,68,68,0.1)"
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
    >
      <Text color={colors.badgeError.text} fontSize={10} fontFamily="$mono">
        {error}
      </Text>
    </YStack>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function MessagingRendererBase({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const { icon: IconComponent, label } = getToolInfo(toolName);

  // Build description
  let description = label;
  if (input?.caption) {
    description = `${label}: ${input.caption.slice(0, 30)}${input.caption.length > 30 ? '...' : ''}`;
  } else if (input?.filename) {
    description = `${label}: ${input.filename}`;
  }

  // Determine badge
  let badge: React.ReactNode = null;
  let hasExpandedContent = false;

  if (status === 'completed') {
    badge = <Badge text="sent" variant="success" />;
    hasExpandedContent = !!(input?.url || input?.filename || input?.caption);
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
    hasExpandedContent = !!error;
  }

  const icon = <IconComponent size={12} color={colors.icon} />;

  const headerProps = {
    status,
    icon,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  // Collapsed view
  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  // Expanded view
  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Content preview */}
        {status === 'completed' && input && <ContentPreview input={input} toolName={toolName} />}

        {/* Error */}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export const MessagingToolCallRenderer = withPermissionSupport(MessagingRendererBase);
export default MessagingToolCallRenderer;
