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
  Code,
  ErrorBlock,
  FileText,
  Image,
  MessageSquare,
  Music,
  ToolCallCard,
  Video,
  useColors,
} from '../primitives';
import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================

function useMessagingColors() {
  const c = useColors();
  return {
    // Icon (theme-agnostic violet for messaging brand)
    icon: '#8b5cf6',

    // Badges (theme-adaptive)
    badgeSuccess: c.badges.ok,
    badgeError: c.badges.err,
    badgeGray: c.badges.gray,

    // Text (theme-adaptive)
    secondary: c.text2,
    muted: c.text3,

    // Backgrounds (theme-adaptive)
    bgInner: c.bgInner,
  };
}

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
// Components
// ============================================================================

interface BadgeProps {
  text: string;
  variant: 'success' | 'error' | 'gray';
}

function Badge({ text, variant }: BadgeProps) {
  const c = useColors();
  const colors = useMessagingColors();
  const styles = {
    success: c.badges.ok,
    error: c.badges.err,
    gray: c.badges.gray,
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

// ============================================================================
// Content Blocks
// ============================================================================

interface ContentPreviewProps {
  input?: Record<string, any>;
}

function ContentPreview({ input }: ContentPreviewProps) {
  const c = useColors();
  const colors = useMessagingColors();
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
      backgroundColor={c.bgInner}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      gap={4}
    >
      {rows.map((row, idx) => (
        <XStack key={idx} gap={8} alignItems="center">
          <Text color={c.text3} fontSize={9} width={50}>
            {row.label}
          </Text>
          <Text color={c.text2} fontSize={10} flex={1} numberOfLines={1}>
            {row.value}
          </Text>
        </XStack>
      ))}
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
  error,
  appIcon,
}: ToolCallRendererProps) {
  const colors = useMessagingColors();

  const { label } = getToolInfo(toolName);

  // Build description
  let description = label;
  if (input?.caption) {
    description = `${label}: ${input.caption.slice(0, 30)}${input.caption.length > 30 ? '...' : ''}`;
  } else if (input?.filename) {
    description = `${label}: ${input.filename}`;
  }

  // Determine badge
  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="sent" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // §8: send-* mutations are irreversible (no undo on a sent message).
  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
      irreversible
    >
      {status === 'completed' && input && <ContentPreview input={input} />}
      {error && <ErrorBlock error={error} />}
    </ToolCallCard>
  );
}

// Suppress unused warning for colors helper (referenced indirectly via Badge/ContentPreview).
void useMessagingColors;

export const MessagingToolCallRenderer = withPermissionSupport(MessagingRendererBase);
export default MessagingToolCallRenderer;
