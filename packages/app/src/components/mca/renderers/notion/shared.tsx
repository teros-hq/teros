/**
 * Notion Renderer - Shared Components & Utilities
 */

import { ChevronRight, Circle } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';
import { usePulseAnimation } from '../../../../hooks/usePulseAnimation';

// ============================================================================
// Constants
// ============================================================================

const NOTION_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/notion-icon.png`;

// ============================================================================
// Colors
// ============================================================================

export const colors = {
  // Notion brand
  notionBlack: '#000000',
  notionWhite: '#FFFFFF',

  // Status dot
  success: '#22c55e',
  running: '#06b6d4',
  pending: '#f59e0b',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowPending: 'rgba(245, 158, 11, 0.4)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeInfo: { text: '#93c5fd', bg: 'rgba(59,130,246,0.1)' },
  badgeWarning: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Page status (Notion style)
  statusDone: '#22c55e',
  statusInProgress: '#5E6AD2',
  statusTodo: '#6b7280',
  statusBacklog: '#52525b',

  // Text
  primary: '#d4d4d8',
  secondary: '#9ca3af',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgFilter: 'rgba(0,0,0,0.15)',
  bgDark: 'rgba(0,0,0,0.3)',
  border: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',
};

// ============================================================================
// Types
// ============================================================================

export interface NotionPage {
  id: string;
  title?: string;
  icon?: { type: 'emoji' | 'external'; emoji?: string; external?: { url: string } };
  url?: string;
  properties?: Record<string, unknown>;
  createdTime?: string;
  lastEditedTime?: string;
}

export interface NotionDatabase {
  id: string;
  title?: string;
  description?: string;
  icon?: { type: 'emoji' | 'external'; emoji?: string; external?: { url: string } };
  url?: string;
  properties?: Record<string, unknown>;
}

export interface NotionUser {
  id: string;
  name?: string;
  avatarUrl?: string;
  type?: 'person' | 'bot';
}

export interface NotionBlock {
  id: string;
  type: string;
  hasChildren?: boolean;
}

export interface NotionComment {
  id: string;
  text?: string;
  createdTime?: string;
  createdBy?: NotionUser;
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

export function getPageTitle(page: NotionPage): string {
  if (page.title) return page.title;
  
  // Try to extract from properties
  if (page.properties) {
    const titleProp = Object.values(page.properties).find(
      (p: any) => p?.type === 'title' && p?.title?.[0]?.plain_text
    ) as any;
    if (titleProp) return titleProp.title[0].plain_text;
  }
  
  return 'Untitled';
}

export function getPageIcon(page: NotionPage): string {
  if (page.icon?.type === 'emoji' && page.icon.emoji) {
    return page.icon.emoji;
  }
  return '📄';
}

export function getStatusColor(status?: string): string {
  if (!status) return colors.statusBacklog;
  const lower = status.toLowerCase();
  if (lower.includes('done') || lower.includes('complete')) return colors.statusDone;
  if (lower.includes('progress') || lower.includes('started') || lower.includes('doing')) return colors.statusInProgress;
  if (lower.includes('todo') || lower.includes('not started')) return colors.statusTodo;
  return colors.statusBacklog;
}

export function isSuccessMessage(parsed: unknown): boolean {
  return (
    typeof parsed === 'string' &&
    (parsed.includes('✅') ||
      parsed.includes('success') ||
      parsed.includes('Success') ||
      parsed.includes('created') ||
      parsed.includes('updated') ||
      parsed.includes('deleted'))
  );
}

export function formatDate(dateString?: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================================================
// Components
// ============================================================================

export function NotionLogo({ size = 14 }: { size?: number }) {
  return <Image source={{ uri: NOTION_ICON }} width={size} height={size} borderRadius={2} />;
}

export type ToolStatusType = 'pending' | 'running' | 'completed' | 'failed' | 'pending_permission';

interface StatusDotProps {
  status: ToolStatusType;
}

export function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'running'
      ? colors.running
      : status === 'pending' || status === 'pending_permission'
        ? colors.pending
        : status === 'completed'
          ? colors.success
          : colors.failed;

  const glow =
    status === 'running'
      ? colors.glowRunning
      : status === 'pending' || status === 'pending_permission'
        ? colors.glowPending
        : status === 'completed'
          ? colors.glowSuccess
          : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running' || status === 'pending' || status === 'pending_permission');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' || status === 'pending' || status === 'pending_permission' ? pulseAnim : 1,
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

interface PageStatusBadgeProps {
  status?: string;
}

export function PageStatusBadge({ status }: PageStatusBadgeProps) {
  const color = getStatusColor(status);

  return (
    <XStack
      backgroundColor={`${color}15`}
      paddingHorizontal={5}
      paddingVertical={2}
      borderRadius={3}
      alignItems="center"
      gap={4}
    >
      <Circle size={5} color={color} fill={color} />
      <Text color={color} fontSize={8} fontFamily="$mono">
        {status || 'Backlog'}
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
      <NotionLogo size={14} />

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' || status === 'pending' || status === 'pending_permission' ? (
        <Text color={status === 'running' ? colors.running : colors.pending} fontSize={9} fontFamily="$mono">
          {status === 'pending_permission' ? 'approval' : status}
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

export function WarningBlock({ message }: { message: string }) {
  return (
    <XStack
      backgroundColor={colors.badgeWarning.bg}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      alignItems="center"
      gap={6}
    >
      <Text color={colors.badgeWarning.text} fontSize={10}>
        ⚠️ {message}
      </Text>
    </XStack>
  );
}

interface FilterBlockProps {
  filter?: Record<string, unknown>;
  sorts?: Array<{ property?: string; direction?: string; timestamp?: string }>;
}

export function FilterBlock({ filter, sorts }: FilterBlockProps) {
  const filterTags: string[] = [];
  const sortInfo: string[] = [];

  // Parse filter to extract readable tags
  if (filter) {
    const extractFilters = (f: any, depth = 0): void => {
      if (depth > 3) return; // Prevent infinite recursion
      
      if (f.property && f.status) {
        const statusVal = f.status.equals || f.status.does_not_equal;
        const op = f.status.equals ? '=' : '≠';
        if (statusVal) filterTags.push(`Status ${op} ${statusVal}`);
      }
      if (f.property && f.select) {
        const selectVal = f.select.equals || f.select.does_not_equal;
        const op = f.select.equals ? '=' : '≠';
        if (selectVal) filterTags.push(`${f.property} ${op} ${selectVal}`);
      }
      if (f.property && f.checkbox !== undefined) {
        filterTags.push(`${f.property} = ${f.checkbox.equals ? '✓' : '✗'}`);
      }
      if (f.and && Array.isArray(f.and)) {
        f.and.forEach((subF: any) => extractFilters(subF, depth + 1));
      }
      if (f.or && Array.isArray(f.or)) {
        f.or.forEach((subF: any) => extractFilters(subF, depth + 1));
      }
    };
    extractFilters(filter);
  }

  // Parse sorts
  if (sorts && Array.isArray(sorts)) {
    sorts.forEach((s) => {
      const prop = s.property || s.timestamp || 'Unknown';
      const dir = s.direction === 'ascending' ? '↑' : '↓';
      sortInfo.push(`${prop} ${dir}`);
    });
  }

  if (filterTags.length === 0 && sortInfo.length === 0) return null;

  return (
    <XStack
      backgroundColor={colors.bgFilter}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      alignItems="center"
      gap={8}
      flexWrap="wrap"
    >
      {filterTags.length > 0 && (
        <>
          <Text fontSize={9} color={colors.muted} textTransform="uppercase" letterSpacing={0.5}>
            Filter
          </Text>
          {filterTags.map((tag, idx) => (
            <XStack
              key={idx}
              backgroundColor={colors.badgeInfo.bg}
              paddingHorizontal={6}
              paddingVertical={2}
              borderRadius={3}
            >
              <Text fontSize={9} color={colors.badgeInfo.text}>
                {tag}
              </Text>
            </XStack>
          ))}
        </>
      )}
      {sortInfo.length > 0 && (
        <>
          <XStack flex={1} />
          <Text fontSize={9} color={colors.muted} textTransform="uppercase" letterSpacing={0.5}>
            Sort
          </Text>
          <Text fontSize={10} color={colors.secondary} fontFamily="$mono">
            {sortInfo.join(', ')}
          </Text>
        </>
      )}
    </XStack>
  );
}
