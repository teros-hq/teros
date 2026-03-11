/**
 * Gmail MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for Gmail tool calls.
 * Renders email operations with minimal footprint when collapsed,
 * expandable to show full details.
 *
 * Design based on mockup with:
 * - Status dot with glow effect
 * - App icon from manifest
 * - Contextual badges (count, sent, label, err)
 * - Collapsed/expanded views
 * - Smooth animations
 */

import { ChevronRight } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { usePulseAnimation } from '../../../hooks/usePulseAnimation';

// Gmail icon from manifest
const GMAIL_ICON = 'https://www.gstatic.com/images/branding/product/1x/gmail_2020q4_48dp.png';

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

  // Badges
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },
  badgeGreen: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeBlue: { text: '#93c5fd', bg: 'rgba(59,130,246,0.1)' },
  badgeYellow: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeRed: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgePurple: { text: '#c4b5fd', bg: 'rgba(139,92,246,0.1)' },

  // Email unread dot
  unread: '#3b82f6',

  // Text
  primary: '#d4d4d8',
  secondary: '#a1a1aa',
  muted: '#52525b',
  bright: '#e4e4e7',
  white: '#fafafa',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgInnerDark: 'rgba(0,0,0,0.25)',
  border: 'rgba(255,255,255,0.03)',
  borderLight: 'rgba(255,255,255,0.05)',

  // Labels
  labelAdded: { text: '#86efac', bg: 'rgba(34,197,94,0.15)', border: 'rgba(34,197,94,0.2)' },
  labelRemoved: { text: '#fca5a5', bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.2)' },
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract short tool name from full tool name
 * "gmail-work_list-messages" -> "list-messages"
 */
function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

/**
 * Format duration in ms to human readable
 */
function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Parse JSON output safely
 */
function parseOutput<T>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

/**
 * Extract sender name from email address
 * "John Doe <john@example.com>" -> "John Doe"
 * "john@example.com" -> "john"
 */
function extractSenderName(from: string): string {
  const match = from.match(/^([^<]+)</);
  if (match) return match[1].trim();
  const atIndex = from.indexOf('@');
  return atIndex > 0 ? from.slice(0, atIndex) : from;
}

/**
 * Get initials from name for avatar
 */
function getInitials(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Format date for display
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Truncate text with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Check if email is unread based on labelIds or unread field
 */
function isEmailUnread(email: { unread?: boolean; labelIds?: string[] }): boolean {
  // Check explicit unread field first
  if (email.unread !== undefined) return email.unread;
  // Check labelIds for UNREAD label
  if (email.labelIds?.includes('UNREAD')) return true;
  return false;
}

// ============================================================================
// Shared Components
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
        // Shadow for glow effect
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
  variant: 'gray' | 'green' | 'blue' | 'yellow' | 'red' | 'purple';
}

function Badge({ text, variant }: BadgeProps) {
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
  /** Whether this is inside an expanded container (different border radius) */
  isInContainer?: boolean;
}

function HeaderRow({
  status,
  description,
  duration,
  badge,
  expanded,
  onToggle,
  isInContainer,
}: HeaderRowProps) {
  // Rotation animation for chevron
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

      <Image source={{ uri: GMAIL_ICON }} width={16} height={16} borderRadius={3} />

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

      {badge && <Badge text={badge.text} variant={badge.variant} />}

      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={10} color="#3f3f46" />
      </Animated.View>
    </XStack>
  );
}

/** Wrapper for expanded state - contains header + body */
interface ExpandedContainerProps {
  children: React.ReactNode;
}

function ExpandedContainer({ children }: ExpandedContainerProps) {
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

/** Body wrapper for expanded content */
interface ExpandedBodyProps {
  children: React.ReactNode;
}

function ExpandedBody({ children }: ExpandedBodyProps) {
  return <YStack padding={8}>{children}</YStack>;
}

// ============================================================================
// Output Types
// ============================================================================

interface EmailMessage {
  id: string;
  from: string;
  to?: string;
  subject: string;
  date: string;
  snippet?: string;
  body?: string;
  unread?: boolean;
  labels?: string[];
}

interface ListMessagesOutput {
  messages: EmailMessage[];
  total?: number;
}

interface SendMessageOutput {
  id: string;
  threadId: string;
  labelIds?: string[];
}

interface SearchMessagesOutput {
  messages: EmailMessage[];
  total?: number;
  query?: string;
}

interface ModifyLabelsOutput {
  id: string;
  labelIds?: string[];
  addedLabels?: string[];
  removedLabels?: string[];
}

interface DraftOutput {
  id: string;
  message?: EmailMessage;
}

interface ListDraftsOutput {
  drafts: Array<{
    id: string;
    message?: EmailMessage;
  }>;
  total?: number;
}

// ============================================================================
// Sub-Renderers
// ============================================================================

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

// --- List Messages ---

function ListMessagesRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<ListMessagesOutput>(output);
  const count = data?.messages?.length ?? 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} emails`, variant: 'gray' as const }
        : undefined;

  const displayError = error || output;

  // Collapsed view
  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description="List inbox messages"
        duration={duration}
        badge={badge}
        expanded={expanded}
        onToggle={onToggle}
      />
    );
  }

  // Expanded view
  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description="List inbox messages"
        duration={duration}
        badge={badge}
        expanded={expanded}
        onToggle={onToggle}
        isInContainer
      />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10} alignItems="center" gap={6}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : data?.messages && data.messages.length > 0 ? (
            data.messages.slice(0, 10).map((email, idx) => (
              <XStack
                key={email.id || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < data.messages.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <XStack
                  width={5}
                  height={5}
                  borderRadius={2.5}
                  backgroundColor={isEmailUnread(email) ? colors.unread : 'transparent'}
                  flexShrink={0}
                />
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  width={90}
                  flexShrink={0}
                  numberOfLines={1}
                >
                  {extractSenderName(email.from)}
                </Text>
                <Text color={colors.secondary} fontSize={10} flex={1} numberOfLines={1}>
                  {email.subject}
                </Text>
                <Text color={colors.muted} fontSize={9} flexShrink={0}>
                  {formatDate(email.date)}
                </Text>
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No messages found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Send Message ---

function SendMessageRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const to = input?.to || '';
  const subject = input?.subject || '';
  const body = input?.body || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'sent', variant: 'green' as const }
        : undefined;

  const displayError = error || output;

  const headerProps = {
    status,
    description: `Send email to ${truncate(to, 30)}`,
    duration,
    badge,
    expanded,
    onToggle,
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
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>
              To
            </Text>
            <Text color={colors.bright} fontSize={10} flex={1} numberOfLines={1}>
              {to || '(empty)'}
            </Text>
          </XStack>

          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>
              Subj
            </Text>
            <Text color={colors.bright} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>
              {subject || '(empty)'}
            </Text>
          </XStack>

          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>
              Body
            </Text>
            <Text color="#71717a" fontSize={10} flex={1} numberOfLines={2}>
              {truncate(body, 100) || '(empty)'}
            </Text>
          </XStack>

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={32}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Reply Message ---

function ReplyMessageRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const body = input?.body || '';
  const messageId = input?.messageId || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'sent', variant: 'green' as const }
        : undefined;

  const displayError = error || output;

  const headerProps = {
    status,
    description: 'Reply to message',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          {messageId && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={32}>
                To
              </Text>
              <Text
                color={colors.secondary}
                fontSize={9}
                fontFamily="$mono"
                flex={1}
                numberOfLines={1}
              >
                {messageId}
              </Text>
            </XStack>
          )}

          <XStack alignItems="flex-start" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>
              Body
            </Text>
            <Text color="#71717a" fontSize={10} flex={1} numberOfLines={3}>
              {truncate(body, 150) || '(empty)'}
            </Text>
          </XStack>

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={32}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Search Messages ---

function SearchMessagesRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<SearchMessagesOutput>(output);
  const query = input?.query || '';
  const count = data?.messages?.length ?? 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} found`, variant: 'blue' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: `Search emails ${truncate(query, 25)}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {/* Query row */}
          <XStack
            paddingVertical={6}
            paddingHorizontal={10}
            alignItems="center"
            gap={6}
            borderBottomWidth={1}
            borderBottomColor={colors.border}
          >
            <Text color={colors.muted} fontSize={9}>
              Query:
            </Text>
            <XStack
              backgroundColor={colors.badgeBlue.bg}
              paddingHorizontal={6}
              paddingVertical={2}
              borderRadius={3}
            >
              <Text color={colors.badgeBlue.text} fontSize={10} fontFamily="$mono">
                {query || '(empty)'}
              </Text>
            </XStack>
          </XStack>

          {status === 'failed' && displayError ? (
            <XStack paddingVertical={6} paddingHorizontal={10} alignItems="center" gap={6}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          ) : data?.messages && data.messages.length > 0 ? (
            data.messages.slice(0, 10).map((email, idx) => (
              <XStack
                key={email.id || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < data.messages.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <XStack
                  width={5}
                  height={5}
                  borderRadius={2.5}
                  backgroundColor={isEmailUnread(email) ? colors.unread : 'transparent'}
                  flexShrink={0}
                />
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  width={90}
                  flexShrink={0}
                  numberOfLines={1}
                >
                  {extractSenderName(email.from)}
                </Text>
                <Text color={colors.secondary} fontSize={10} flex={1} numberOfLines={1}>
                  {email.subject}
                </Text>
                <Text color={colors.muted} fontSize={9} flexShrink={0}>
                  {formatDate(email.date)}
                </Text>
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No messages found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get Message ---

function GetMessageRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<EmailMessage>(output);
  const messageId = input?.messageId || '';

  const senderName = data?.from ? extractSenderName(data.from) : '';
  const initials = senderName ? getInitials(senderName) : '?';
  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'Get message details',
    duration,
    badge: status === 'failed' ? { text: 'failed', variant: 'red' as const } : undefined,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={10}>
          {status === 'failed' ? (
            <YStack gap={4}>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={32}>
                  ID
                </Text>
                <Text
                  color={colors.secondary}
                  fontSize={9}
                  fontFamily="$mono"
                  flex={1}
                  numberOfLines={1}
                >
                  {messageId || '(unknown)'}
                </Text>
              </XStack>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={32}>
                  Error
                </Text>
                <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                  {displayError || 'Unknown error'}
                </Text>
              </XStack>
            </YStack>
          ) : data ? (
            <>
              {/* Header with avatar */}
              <XStack
                alignItems="flex-start"
                gap={10}
                marginBottom={8}
                paddingBottom={8}
                borderBottomWidth={1}
                borderBottomColor={colors.borderLight}
              >
                <XStack
                  width={28}
                  height={28}
                  borderRadius={14}
                  backgroundColor="#3b82f6"
                  alignItems="center"
                  justifyContent="center"
                  flexShrink={0}
                >
                  <Text color="white" fontSize={11} fontWeight="600">
                    {initials}
                  </Text>
                </XStack>
                <YStack flex={1}>
                  <Text color={colors.bright} fontSize={11} fontWeight="500">
                    {senderName}
                  </Text>
                  <Text color="#71717a" fontSize={10} numberOfLines={1}>
                    {data.from}
                  </Text>
                  {data.subject && (
                    <Text color={colors.white} fontSize={12} fontWeight="500" marginTop={4}>
                      {data.subject}
                    </Text>
                  )}
                </YStack>
              </XStack>
              {(data.body || data.snippet) && (
                <Text color="#9ca3af" fontSize={10} lineHeight={15}>
                  {truncate(data.body || data.snippet || '', 300)}
                </Text>
              )}
            </>
          ) : (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9}>
                ID:
              </Text>
              <Text color={colors.secondary} fontSize={9} fontFamily="$mono">
                {messageId || '(unknown)'}
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Modify Labels ---

function ModifyLabelsRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const addLabelIds = input?.addLabelIds as string[] | undefined;
  const removeLabelIds = input?.removeLabelIds as string[] | undefined;
  const messageId = input?.messageId || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'modified', variant: 'yellow' as const }
        : undefined;

  const hasChanges = (addLabelIds?.length || 0) > 0 || (removeLabelIds?.length || 0) > 0;
  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'Update labels on message',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          {hasChanges && (
            <>
              <Text color="#71717a" fontSize={9} textTransform="uppercase" letterSpacing={0.5}>
                Changes
              </Text>
              <XStack flexWrap="wrap" gap={4} marginTop={2}>
                {addLabelIds?.map((label) => (
                  <XStack
                    key={`add-${label}`}
                    backgroundColor={colors.labelAdded.bg}
                    borderWidth={1}
                    borderColor={colors.labelAdded.border}
                    paddingHorizontal={6}
                    paddingVertical={2}
                    borderRadius={3}
                  >
                    <Text color={colors.labelAdded.text} fontSize={9}>
                      + {label}
                    </Text>
                  </XStack>
                ))}
                {removeLabelIds?.map((label) => (
                  <XStack
                    key={`remove-${label}`}
                    backgroundColor={colors.labelRemoved.bg}
                    borderWidth={1}
                    borderColor={colors.labelRemoved.border}
                    paddingHorizontal={6}
                    paddingVertical={2}
                    borderRadius={3}
                  >
                    <Text
                      color={colors.labelRemoved.text}
                      fontSize={9}
                      textDecorationLine="line-through"
                    >
                      − {label}
                    </Text>
                  </XStack>
                ))}
              </XStack>
            </>
          )}

          {!hasChanges && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9}>
                ID:
              </Text>
              <Text color={colors.secondary} fontSize={9} fontFamily="$mono">
                {messageId || '(unknown)'}
              </Text>
            </XStack>
          )}

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={hasChanges ? 4 : 0}>
              <Text color={colors.muted} fontSize={9} width={32}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Create Draft ---

function CreateDraftRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const to = input?.to || '';
  const subject = input?.subject || '';
  const body = input?.body || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'draft', variant: 'purple' as const }
        : undefined;

  const displayError = error || output;

  const headerProps = {
    status,
    description: 'Create email draft',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>
              To
            </Text>
            <Text color={colors.bright} fontSize={10} flex={1} numberOfLines={1}>
              {to || '(empty)'}
            </Text>
          </XStack>

          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>
              Subj
            </Text>
            <Text color={colors.bright} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>
              {subject || '(empty)'}
            </Text>
          </XStack>

          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>
              Body
            </Text>
            <Text color="#71717a" fontSize={10} flex={1} numberOfLines={2}>
              {truncate(body, 100) || '(empty)'}
            </Text>
          </XStack>

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={32}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- List Drafts ---

function ListDraftsRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<ListDraftsOutput>(output);
  const count = data?.drafts?.length ?? 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} drafts`, variant: 'gray' as const }
        : undefined;

  const displayError = error || output;

  const headerProps = {
    status,
    description: 'List email drafts',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10} alignItems="center" gap={6}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : data?.drafts && data.drafts.length > 0 ? (
            data.drafts.slice(0, 10).map((draft, idx) => {
              const email = draft.message;
              return (
                <XStack
                  key={draft.id || idx}
                  paddingVertical={6}
                  paddingHorizontal={10}
                  alignItems="center"
                  gap={8}
                  borderBottomWidth={idx < data.drafts.length - 1 ? 1 : 0}
                  borderBottomColor={colors.border}
                >
                  <XStack
                    backgroundColor={colors.badgePurple.bg}
                    paddingHorizontal={4}
                    paddingVertical={1}
                    borderRadius={2}
                  >
                    <Text color={colors.badgePurple.text} fontSize={8}>
                      DRAFT
                    </Text>
                  </XStack>
                  <Text
                    color={colors.primary}
                    fontSize={10}
                    fontWeight="500"
                    width={90}
                    flexShrink={0}
                    numberOfLines={1}
                  >
                    {email?.to ? extractSenderName(email.to) : 'No recipient'}
                  </Text>
                  <Text color={colors.secondary} fontSize={10} flex={1} numberOfLines={1}>
                    {email?.subject || '(no subject)'}
                  </Text>
                </XStack>
              );
            })
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No drafts found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Default Renderer ---

function DefaultGmailRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'done', variant: 'green' as const }
        : undefined;

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: shortName.replace(/-/g, ' '),
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          {input &&
            Object.keys(input).length > 0 &&
            Object.entries(input)
              .slice(0, 5)
              .map(([key, value]) => (
                <XStack key={key} alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={50}>
                    {key}
                  </Text>
                  <Text color={colors.secondary} fontSize={9} flex={1} numberOfLines={1}>
                    {typeof value === 'string' ? truncate(value, 50) : JSON.stringify(value)}
                  </Text>
                </XStack>
              ))}

          {status === 'completed' && output && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>
                result
              </Text>
              <Text color={colors.secondary} fontSize={9} flex={1} numberOfLines={2}>
                {truncate(output, 100)}
              </Text>
            </XStack>
          )}

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>
                error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}

          {!input && !output && !displayError && (
            <Text color={colors.muted} fontSize={10}>
              No details available
            </Text>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function GmailRendererBase(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const shortName = getShortToolName(props.toolName);

  const subProps: SubRendererProps = {
    ...props,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  switch (shortName) {
    case 'list-messages':
      return <ListMessagesRenderer {...subProps} />;
    case 'send-message':
      return <SendMessageRenderer {...subProps} />;
    case 'reply-message':
      return <ReplyMessageRenderer {...subProps} />;
    case 'search-messages':
      return <SearchMessagesRenderer {...subProps} />;
    case 'get-message':
      return <GetMessageRenderer {...subProps} />;
    case 'modify-labels':
      return <ModifyLabelsRenderer {...subProps} />;
    case 'create-draft':
      return <CreateDraftRenderer {...subProps} />;
    case 'list-drafts':
      return <ListDraftsRenderer {...subProps} />;
    default:
      return <DefaultGmailRenderer {...subProps} />;
  }
}

export const GmailToolCallRenderer = withPermissionSupport(GmailRendererBase);

// Default export for dynamic import
export default GmailToolCallRenderer;
