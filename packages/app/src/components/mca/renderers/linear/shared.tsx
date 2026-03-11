/**
 * Linear Renderer - Shared Components & Utilities
 */

import { ChevronRight, Circle, Zap } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Linking } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';
import { usePulseAnimation } from '../../../../hooks/usePulseAnimation';

// ============================================================================
// Constants
// ============================================================================

const LINEAR_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/linear-icon.png`;

// ============================================================================
// Colors
// ============================================================================

export const colors = {
  // Linear brand
  linearPurple: '#5E6AD2',
  linearBlue: '#4EA8DE',

  // Status dot
  success: '#22c55e',
  running: '#5E6AD2',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(94, 106, 210, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Icon
  icon: '#5E6AD2',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeInfo: { text: '#a5b4fc', bg: 'rgba(94,106,210,0.1)' },
  badgeWarning: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Priority (Linear style: 1=urgent, 2=high, 3=medium, 4=low, 0=none)
  priorityUrgent: '#ef4444',
  priorityHigh: '#f59e0b',
  priorityMedium: '#3b82f6',
  priorityLow: '#6b7280',
  priorityNone: '#52525b',

  // Issue status
  statusBacklog: '#6b7280',
  statusTodo: '#9ca3af',
  statusInProgress: '#5E6AD2',
  statusDone: '#22c55e',
  statusCanceled: '#ef4444',

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

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  assignee?: string;
  team?: string;
  labels?: string[];
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearUser {
  id: string;
  name: string;
  email?: string;
  active?: boolean;
}

export interface LinearProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
  url?: string;
  createdAt?: string;
}

export interface LinearLabel {
  id: string;
  name: string;
  color?: string;
  description?: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string;
  color?: string;
  position?: number;
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

export function getPriorityLabel(priority?: number): string {
  switch (priority) {
    case 1:
      return 'Urgent';
    case 2:
      return 'High';
    case 3:
      return 'Medium';
    case 4:
      return 'Low';
    default:
      return 'None';
  }
}

export function getPriorityColor(priority?: number): string {
  switch (priority) {
    case 1:
      return colors.priorityUrgent;
    case 2:
      return colors.priorityHigh;
    case 3:
      return colors.priorityMedium;
    case 4:
      return colors.priorityLow;
    default:
      return colors.priorityNone;
  }
}

export function getStatusColor(status?: string): string {
  if (!status) return colors.statusBacklog;
  const lower = status.toLowerCase();
  if (lower.includes('done') || lower.includes('complete')) return colors.statusDone;
  if (lower.includes('progress') || lower.includes('started')) return colors.statusInProgress;
  if (lower.includes('cancel')) return colors.statusCanceled;
  if (lower.includes('todo')) return colors.statusTodo;
  return colors.statusBacklog;
}

export function isSuccessMessage(parsed: unknown): boolean {
  return (
    typeof parsed === 'string' &&
    (parsed.includes('✅') ||
      parsed.includes('success') ||
      parsed.includes('Success') ||
      parsed.includes('deleted') ||
      parsed.includes('archived') ||
      parsed.includes('added'))
  );
}

// ============================================================================
// Components
// ============================================================================

export function LinearLogo({ size = 14 }: { size?: number }) {
  return <Image source={{ uri: LINEAR_ICON }} width={size} height={size} borderRadius={2} />;
}

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

interface PriorityBadgeProps {
  priority?: number;
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  const color = getPriorityColor(priority);
  const label = getPriorityLabel(priority);

  if (priority === 0 || priority === undefined) return null;

  return (
    <XStack
      backgroundColor={`${color}15`}
      paddingHorizontal={4}
      paddingVertical={1}
      borderRadius={3}
      borderWidth={1}
      borderColor={`${color}30`}
      alignItems="center"
      gap={3}
    >
      {priority === 1 && <Zap size={7} color={color} />}
      <Text color={color} fontSize={8} fontFamily="$mono" textTransform="uppercase">
        {label}
      </Text>
    </XStack>
  );
}

interface IssueStatusBadgeProps {
  status?: string;
}

export function IssueStatusBadge({ status }: IssueStatusBadgeProps) {
  const color = getStatusColor(status);

  return (
    <XStack
      backgroundColor={`${color}15`}
      paddingHorizontal={4}
      paddingVertical={1}
      borderRadius={3}
      alignItems="center"
      gap={3}
    >
      <Circle size={6} color={color} fill={color} />
      <Text color={color} fontSize={8} fontFamily="$mono">
        {status || 'Backlog'}
      </Text>
    </XStack>
  );
}

export type ToolStatusType = 'running' | 'completed' | 'failed' | 'pending_permission';

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
      <LinearLogo size={14} />

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
    <YStack padding={8} gap={6}>
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

export function SuccessBlock({ message }: { message: string }) {
  return (
    <XStack
      backgroundColor="rgba(34,197,94,0.1)"
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      alignItems="center"
      gap={6}
    >
      <Circle size={12} color={colors.success} fill={colors.success} />
      <Text color={colors.badgeSuccess.text} fontSize={10}>
        {message}
      </Text>
    </XStack>
  );
}
