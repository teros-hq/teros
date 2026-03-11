/**
 * Feedback Renderer - Shared Components & Utilities
 */

import {
  AlertCircle,
  Bell,
  Bug,
  CheckCircle,
  ChevronRight,
  Clock,
  Lightbulb,
  MessageSquare,
  XCircle,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { usePulseAnimation } from '../../../../hooks/usePulseAnimation';

// ============================================================================
// Colors
// ============================================================================

export const colors = {
  // Feedback brand
  feedbackPurple: '#8b5cf6',
  feedbackBlue: '#3b82f6',

  // Status
  success: '#22c55e',
  running: '#8b5cf6',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(139, 92, 246, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeInfo: { text: '#c4b5fd', bg: 'rgba(139,92,246,0.1)' },
  badgeWarning: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Feedback status colors
  statusOpen: '#3b82f6',
  statusInReview: '#f59e0b',
  statusInProgress: '#8b5cf6',
  statusResolved: '#22c55e',
  statusDismissed: '#6b7280',

  // Priority
  priorityCritical: '#ef4444',
  priorityHigh: '#f97316',
  priorityMedium: '#eab308',
  priorityLow: '#22c55e',

  // Severity (user-reported)
  severityCritical: '#ef4444',
  severityHigh: '#f97316',
  severityMedium: '#eab308',
  severityLow: '#22c55e',

  // Text
  primary: '#d4d4d8',
  secondary: '#9ca3af',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgDark: 'rgba(0,0,0,0.3)',
  border: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',
};

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

export function getStatusColor(status: string): string {
  switch (status) {
    case 'open':
      return colors.statusOpen;
    case 'in_review':
      return colors.statusInReview;
    case 'in_progress':
      return colors.statusInProgress;
    case 'resolved':
      return colors.statusResolved;
    case 'dismissed':
      return colors.statusDismissed;
    default:
      return colors.muted;
  }
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

export function getSeverityColor(severity?: string): string {
  switch (severity) {
    case 'critical':
      return colors.severityCritical;
    case 'high':
      return colors.severityHigh;
    case 'medium':
      return colors.severityMedium;
    case 'low':
      return colors.severityLow;
    default:
      return colors.muted;
  }
}

// ============================================================================
// Components
// ============================================================================

export function FeedbackIcon({ size = 14 }: { size?: number }) {
  return <MessageSquare size={size} color={colors.feedbackPurple} />;
}

export type ToolStatusType = 'running' | 'completed' | 'failed' | 'pending_permission';

interface StatusDotProps {
  status: ToolStatusType;
}

export function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'running' || status === 'pending_permission'
      ? colors.running
      : status === 'completed'
        ? colors.success
        : colors.failed;

  const glow =
    status === 'running' || status === 'pending_permission'
      ? colors.glowRunning
      : status === 'completed'
        ? colors.glowSuccess
        : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running' || status === 'pending_permission');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' || status === 'pending_permission' ? pulseAnim : 1,
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
  variant: 'success' | 'error' | 'info' | 'warning' | 'gray';
}

export function Badge({ text, variant }: BadgeProps) {
  const styles = {
    success: colors.badgeSuccess,
    error: colors.badgeError,
    info: colors.badgeInfo,
    warning: colors.badgeWarning,
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

export function StatusBadge({ status }: { status: string }) {
  const color = getStatusColor(status);
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
  const isBug = type === 'bug';
  const Icon = isBug ? Bug : Lightbulb;
  const color = isBug ? colors.badgeError.text : colors.badgeWarning.text;
  const bg = isBug ? colors.badgeError.bg : colors.badgeWarning.bg;

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
  const color = getSeverityColor(severity);

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
  return (
    <XStack
      backgroundColor="rgba(139,92,246,0.2)"
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

export interface HeaderRowProps {
  status: ToolStatusType;
  description: string;
  duration?: number;
  badge?: React.ReactNode;
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
      <FeedbackIcon size={14} />

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' || status === 'pending_permission' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          {status === 'pending_permission' ? 'awaiting' : 'running'}
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

export function ExpandedContainer({ children }: { children: React.ReactNode }) {
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

export function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack padding={10} gap={8}>
      {children}
    </YStack>
  );
}

export function ErrorBlock({ error }: { error: string }) {
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

export function SuccessBlock({ message, feedbackId }: { message: string; feedbackId?: string }) {
  return (
    <YStack
      backgroundColor="rgba(34,197,94,0.1)"
      borderRadius={6}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={4}
    >
      <XStack alignItems="center" gap={6}>
        <CheckCircle size={14} color={colors.success} />
        <Text color={colors.badgeSuccess.text} fontSize={11} fontWeight="500">
          {message}
        </Text>
      </XStack>
      {feedbackId && (
        <Text color={colors.secondary} fontSize={10} fontFamily="$mono">
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
  return (
    <YStack
      backgroundColor={colors.bgInner}
      borderRadius={6}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={6}
    >
      <XStack alignItems="center" gap={8}>
        <TypeBadge type={feedback.type} />
        <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
          {feedback.title}
        </Text>
        {feedback.hasUnreadUpdates && <UnreadBadge />}
      </XStack>

      <XStack alignItems="center" gap={8} flexWrap="wrap">
        <StatusBadge status={feedback.status} />
        {feedback.severity && <SeverityBadge severity={feedback.severity} />}
        <XStack alignItems="center" gap={4}>
          <Clock size={10} color={colors.muted} />
          <Text color={colors.secondary} fontSize={9}>
            {formatDate(feedback.createdAt)}
          </Text>
        </XStack>
        {feedback.updatesCount !== undefined && feedback.updatesCount > 0 && (
          <Text color={colors.secondary} fontSize={9}>
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
  return (
    <YStack
      backgroundColor="rgba(139,92,246,0.05)"
      borderLeftWidth={2}
      borderLeftColor={colors.feedbackPurple}
      paddingVertical={6}
      paddingHorizontal={10}
      gap={4}
    >
      <XStack alignItems="center" gap={6}>
        {update.newStatus && <StatusBadge status={update.newStatus} />}
        <Text color={colors.secondary} fontSize={9}>
          {formatDate(update.createdAt)}
        </Text>
      </XStack>
      <Text color={colors.primary} fontSize={11}>
        {update.message}
      </Text>
    </YStack>
  );
}
