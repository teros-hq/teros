/**
 * Feedback Renderer - Shared Components & Utilities
 */

import {
  Bell,
  Bug,
  CheckCircle,
  Clock,
  Lightbulb,
  MessageSquare,
  colors,
  useColors,
  useMcaTheme,
} from '../../primitives';
import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';

// ============================================================================
// Colors
// ============================================================================

// Renderer UX Guide v2 §5 — theme-adaptive palette.
// Feedback domain enum tints (status/severity) are semantic theme-agnostic;
// surface/text/badges come from useColors(). Brand purple uses the shared
// `colors.violet` semantic token so it stays in sync with the global palette.
export function useFeedbackColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    // Brand (semantic, theme-agnostic)
    feedbackPurple: colors.violet,
    success: colors.success,

    // Badges (theme-adaptive)
    badgeSuccess: c.badges.ok,
    badgeError: c.badges.err,
    badgeWarning: c.badges.warn,

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,

    // Backgrounds (theme-adaptive)
    successBg: c.badges.ok.bg,

    // Tinted backgrounds — alpha shifts for light-mode readability
    unreadBg: isDark ? 'rgba(139,92,246,0.20)' : 'rgba(139,92,246,0.08)',
    updateBg: isDark ? 'rgba(139,92,246,0.05)' : 'rgba(139,92,246,0.03)',

    // Fallback for unknown enum values (theme-adaptive text3)
    mutedFallback: c.text3,
    ...c,
  };
}

// ============================================================================
// Types
// ============================================================================

export interface FeedbackUpdate {
  updateId: string;
  message: string;
  newStatus?: string;
  createdAt: string;
  createdBy: string;
}

export interface Feedback {
  feedbackId: string;
  type: 'bug' | 'suggestion';
  title: string;
  description?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in_review' | 'in_progress' | 'resolved' | 'dismissed';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  hasUnreadUpdates?: boolean;
  updatesCount?: number;
  updates?: FeedbackUpdate[];
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
}

// ============================================================================
// Utilities
// ============================================================================

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function parseOutput<T>(output: string): T | string | null {
  try {
    return JSON.parse(output) as T;
  } catch {
    return output;
  }
}

export function truncate(text: string, maxLength: number = 50): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Theme-agnostic enum color tables (status/severity tints are domain
// semantic — same hue across themes).
const STATUS_COLORS: Record<string, string> = {
  open: colors.indigo,
  in_review: colors.amber,
  in_progress: colors.violet,
  resolved: colors.success,
  dismissed: '#6b7280',
};
const SEVERITY_COLORS: Record<string, string> = {
  critical: colors.red,
  high: colors.orange,
  medium: '#eab308',
  low: colors.success,
};

export function getStatusColor(status: string, fallback?: string): string {
  return STATUS_COLORS[status] ?? (fallback ?? '#6b7280');
}

export function getStatusLabel(status: string): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'in_review':
      return 'In Review';
    case 'in_progress':
      return 'In Progress';
    case 'resolved':
      return 'Resolved';
    case 'dismissed':
      return 'Dismissed';
    default:
      return status;
  }
}

export function getSeverityColor(severity?: string, fallback?: string): string {
  const fb = fallback ?? '#6b7280';
  return severity ? (SEVERITY_COLORS[severity] ?? fb) : fb;
}

// ============================================================================
// Components
// ============================================================================

export function FeedbackIcon({ size = 14 }: { size?: number }) {
  // Feedback brand color (semantic, theme-agnostic).
  return <MessageSquare size={size} color={colors.violet} />;
}

// StatusDot lives in `../../primitives/StatusDot` — global theme-adaptive
// version is mounted by `ToolCallCard` automatically. Local re-export
// removed; sub-renderers compose directly via ToolCallCard.

// Badge re-export — variants match global primitive.
export { Badge } from '../../primitives';

export function StatusBadge({ status }: { status: string }) {
  const c = useFeedbackColors();
  const colors = useFeedbackColors();
  const color = getStatusColor(status, c.text3);
  const label = getStatusLabel(status);

  return (
    <XStack
      backgroundColor={`${color}15`}
      paddingHorizontal={6}
      paddingVertical={2}
      borderRadius={4}
      alignItems="center"
      gap={4}
    >
      <XStack width={6} height={6} borderRadius={3} backgroundColor={color} />
      <Text color={color} fontSize={10} fontWeight="500">
        {label}
      </Text>
    </XStack>
  );
}

export function TypeBadge({ type }: { type: 'bug' | 'suggestion' }) {
  const c = useFeedbackColors();
  const colors = useFeedbackColors();
  const isBug = type === 'bug';
  const Icon = isBug ? Bug : Lightbulb;
  const color = isBug ? c.badges.err.text : c.badges.warn.text;
  const bg = isBug ? c.badges.err.bg : c.badges.warn.bg;

  return (
    <XStack
      backgroundColor={bg}
      paddingHorizontal={5}
      paddingVertical={2}
      borderRadius={4}
      alignItems="center"
      gap={4}
    >
      <Icon size={10} color={color} />
      <Text color={color} fontSize={9} fontWeight="500">
        {isBug ? 'Bug' : 'Suggestion'}
      </Text>
    </XStack>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const c = useFeedbackColors();
  const colors = useFeedbackColors();
  const color = getSeverityColor(severity, c.text3);

  return (
    <XStack
      backgroundColor={`${color}15`}
      paddingHorizontal={5}
      paddingVertical={2}
      borderRadius={4}
    >
      <Text color={color} fontSize={9} fontWeight="500">
        {severity}
      </Text>
    </XStack>
  );
}

export function UnreadBadge() {
  const colors = useFeedbackColors();
  return (
    <XStack
      backgroundColor={colors.unreadBg}
      paddingHorizontal={5}
      paddingVertical={2}
      borderRadius={4}
      alignItems="center"
      gap={3}
    >
      <Bell size={9} color={colors.feedbackPurple} />
      <Text color={colors.feedbackPurple} fontSize={9} fontWeight="500">
        New updates
      </Text>
    </XStack>
  );
}

/**
 * FeedbackSuccessBlock — variant of `SuccessBlock` that additionally
 * shows the generated feedback ID. Specific to this MCA's submit flows.
 */
export function FeedbackSuccessBlock({ message, feedbackId }: { message: string; feedbackId?: string }) {
  const c = useFeedbackColors();
  const colors = useFeedbackColors();
  return (
    <YStack
      backgroundColor={colors.successBg}
      borderRadius={6}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={4}
    >
      <XStack alignItems="center" gap={6}>
        <CheckCircle size={14} color={colors.success} />
        <Text color={c.badges.ok.text} fontSize={11} fontWeight="500">
          {message}
        </Text>
      </XStack>
      {feedbackId && (
        <Text color={c.text2} fontSize={10} fontFamily="$mono">
          ID: {feedbackId}
        </Text>
      )}
    </YStack>
  );
}

interface FeedbackRowProps {
  feedback: Feedback;
  compact?: boolean;
}

export function FeedbackRow({ feedback, compact = false }: FeedbackRowProps) {
  const c = useFeedbackColors();
  const colors = useFeedbackColors();
  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={6}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={6}
    >
      <XStack alignItems="center" gap={8}>
        <TypeBadge type={feedback.type} />
        <Text flex={1} color={c.text} fontSize={11} fontWeight="500" numberOfLines={1} ellipsizeMode="tail">
          {feedback.title}
        </Text>
        {feedback.hasUnreadUpdates && <UnreadBadge />}
      </XStack>

      <XStack alignItems="center" gap={8} flexWrap="wrap">
        <StatusBadge status={feedback.status} />
        {feedback.severity && <SeverityBadge severity={feedback.severity} />}
        <XStack alignItems="center" gap={4}>
          <Clock size={10} color={c.text3} />
          <Text color={c.text2} fontSize={9}>
            {formatDate(feedback.createdAt)}
          </Text>
        </XStack>
        {feedback.updatesCount !== undefined && feedback.updatesCount > 0 && (
          <Text color={c.text2} fontSize={9}>
            {feedback.updatesCount} update{feedback.updatesCount !== 1 ? 's' : ''}
        </Text>
      )}
      </XStack>
    </YStack>
  );
}

interface UpdateRowProps {
  update: FeedbackUpdate;
}

export function UpdateRow({ update }: UpdateRowProps) {
  const c = useFeedbackColors();
  const colors = useFeedbackColors();
  return (
    <YStack
      backgroundColor={colors.updateBg}
      borderLeftWidth={2}
      borderLeftColor={colors.feedbackPurple}
      paddingVertical={6}
      paddingHorizontal={10}
      gap={4}
    >
      <XStack alignItems="center" gap={6}>
        {update.newStatus && <StatusBadge status={update.newStatus} />}
        <Text color={c.text2} fontSize={9}>
          {formatDate(update.createdAt)}
        </Text>
      </XStack>
      <Text color={c.text} fontSize={11}>
        {update.message}
      </Text>
    </YStack>
  );
}
