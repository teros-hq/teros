/**
 * Outlook MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for Outlook tool calls.
 * Renders email operations with minimal footprint when collapsed,
 * expandable to show full details.
 *
 * Based on GmailRenderer design.
 */

import { ChevronRight } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { usePulseAnimation } from '../../../hooks/usePulseAnimation';

// Outlook icon served from backend static assets
const OUTLOOK_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/mcas/mca.microsoft.outlook/icon.png`;

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
  unread: '#0078d4', // Outlook blue

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
};

// ============================================================================
// Utilities
// ============================================================================

function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function parseOutput<T>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

function extractSenderName(from: string): string {
  const match = from.match(/^([^<]+)</);
  if (match) return match[1].trim();
  const atIndex = from.indexOf('@');
  return atIndex > 0 ? from.slice(0, atIndex) : from;
}

function getInitials(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

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

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
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
      borderBottomWidth={1}
      borderBottomColor="rgba(255,255,255,0.04)"
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

      <Image source={{ uri: OUTLOOK_ICON }} width={16} height={16} borderRadius={3} />

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          loading
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

function ExpandedContainer({ children }: { children: React.ReactNode }) {
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

function ExpandedBody({ children }: { children: React.ReactNode }) {
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
  isRead?: boolean;
  isDraft?: boolean;
  importance?: string;
  hasAttachments?: boolean;
}

interface ListMessagesOutput {
  account?: string;
  count: number;
  messages: EmailMessage[];
}

interface ListDraftsOutput {
  account?: string;
  count: number;
  drafts: EmailMessage[];
}

interface ListFoldersOutput {
  account?: string;
  count: number;
  folders: Array<{
    id: string;
    displayName: string;
    totalItemCount?: number;
    unreadItemCount?: number;
  }>;
}

interface SearchOutput {
  account?: string;
  count: number;
  messages: EmailMessage[];
  query?: string;
}

// ============================================================================
// Sub-Renderer props
// ============================================================================

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

// ============================================================================
// Sub-Renderers
// ============================================================================

// --- List Messages ---

function ListMessagesRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const data = parseOutput<ListMessagesOutput>(output);
  const count = data?.count ?? data?.messages?.length ?? 0;
  const folder = (input?.folderId as string) || 'Inbox';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} emails`, variant: 'gray' as const }
        : undefined;

  const headerProps = {
    status,
    description: `List ${folder} messages`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {error || output || 'Unknown error'}
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
                  backgroundColor={email.isRead === false ? colors.unread : 'transparent'}
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
                {email.hasAttachments && (
                  <Text color={colors.muted} fontSize={9}>
                    📎
                  </Text>
                )}
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

function GetMessageRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const data = parseOutput<EmailMessage>(output);
  const messageId = (input?.messageId as string) || '';
  const senderName = data?.from ? extractSenderName(data.from) : '';
  const initials = senderName ? getInitials(senderName) : '?';

  const headerProps = {
    status,
    description: 'Get message details',
    duration,
    badge: status === 'failed' ? { text: 'failed', variant: 'red' as const } : undefined,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={10}>
          {status === 'failed' ? (
            <YStack gap={4}>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={32}>ID</Text>
                <Text color={colors.secondary} fontSize={9} fontFamily="$mono" flex={1} numberOfLines={1}>
                  {messageId || '(unknown)'}
                </Text>
              </XStack>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={32}>Error</Text>
                <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                  {error || output || 'Unknown error'}
                </Text>
              </XStack>
            </YStack>
          ) : data ? (
            <>
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
                  backgroundColor="#0078d4"
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
              <Text color={colors.muted} fontSize={9}>ID:</Text>
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

// --- Send Message ---

function SendMessageRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const to = (input?.to as string) || '';
  const subject = (input?.subject as string) || '';
  const body = (input?.body as string) || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'sent', variant: 'green' as const }
        : undefined;

  const headerProps = {
    status,
    description: `Send email to ${truncate(to, 30)}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>To</Text>
            <Text color={colors.bright} fontSize={10} flex={1} numberOfLines={1}>{to || '(empty)'}</Text>
          </XStack>
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>Subj</Text>
            <Text color={colors.bright} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>
              {subject || '(empty)'}
            </Text>
          </XStack>
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>Body</Text>
            <Text color="#71717a" fontSize={10} flex={1} numberOfLines={2}>
              {truncate(body, 100) || '(empty)'}
            </Text>
          </XStack>
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={32}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {error || output}
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Reply Message ---

function ReplyMessageRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const body = (input?.body as string) || '';
  const replyAll = input?.replyAll as boolean | undefined;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: replyAll ? 'replied all' : 'replied', variant: 'green' as const }
        : undefined;

  const headerProps = {
    status,
    description: replyAll ? 'Reply all to message' : 'Reply to message',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="flex-start" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>Body</Text>
            <Text color="#71717a" fontSize={10} flex={1} numberOfLines={3}>
              {truncate(body, 150) || '(empty)'}
            </Text>
          </XStack>
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={32}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Forward Message ---

function ForwardMessageRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const to = (input?.to as string) || '';
  const comment = (input?.comment as string) || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'forwarded', variant: 'blue' as const }
        : undefined;

  const headerProps = {
    status,
    description: `Forward to ${truncate(to, 30)}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>To</Text>
            <Text color={colors.bright} fontSize={10} flex={1} numberOfLines={1}>{to || '(empty)'}</Text>
          </XStack>
          {comment && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={32}>Note</Text>
              <Text color="#71717a" fontSize={10} flex={1} numberOfLines={2}>{truncate(comment, 100)}</Text>
            </XStack>
          )}
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={32}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Search Messages ---

function SearchMessagesRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const data = parseOutput<SearchOutput>(output);
  const query = (input?.query as string) || '';
  const count = data?.count ?? data?.messages?.length ?? 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} found`, variant: 'blue' as const }
        : { text: '0 found', variant: 'gray' as const };

  const headerProps = {
    status,
    description: `Search: ${truncate(query, 25)}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          <XStack
            paddingVertical={6}
            paddingHorizontal={10}
            alignItems="center"
            gap={6}
            borderBottomWidth={1}
            borderBottomColor={colors.border}
          >
            <Text color={colors.muted} fontSize={9}>Query:</Text>
            <XStack backgroundColor={colors.badgeBlue.bg} paddingHorizontal={6} paddingVertical={2} borderRadius={3}>
              <Text color={colors.badgeBlue.text} fontSize={10} fontFamily="$mono">
                {query || '(empty)'}
              </Text>
            </XStack>
          </XStack>

          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
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
                  backgroundColor={email.isRead === false ? colors.unread : 'transparent'}
                  flexShrink={0}
                />
                <Text color={colors.primary} fontSize={10} fontWeight="500" width={90} flexShrink={0} numberOfLines={1}>
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
              <Text color={colors.muted} fontSize={10}>No messages found</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Modify Message ---

function ModifyMessageRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const isRead = input?.isRead as boolean | undefined;
  const importance = input?.importance as string | undefined;
  const flag = input?.flag as string | undefined;
  const categories = input?.categories as string[] | undefined;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'modified', variant: 'yellow' as const }
        : undefined;

  const headerProps = {
    status,
    description: 'Modify message',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          {isRead !== undefined && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={60}>Read</Text>
              <Badge text={isRead ? 'read' : 'unread'} variant={isRead ? 'green' : 'blue'} />
            </XStack>
          )}
          {importance && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={60}>Importance</Text>
              <Badge
                text={importance}
                variant={importance === 'high' ? 'red' : importance === 'low' ? 'gray' : 'blue'}
              />
            </XStack>
          )}
          {flag && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={60}>Flag</Text>
              <Badge
                text={flag}
                variant={flag === 'flagged' ? 'yellow' : flag === 'complete' ? 'green' : 'gray'}
              />
            </XStack>
          )}
          {categories && categories.length > 0 && (
            <XStack alignItems="center" gap={6} flexWrap="wrap">
              <Text color={colors.muted} fontSize={9} width={60}>Categories</Text>
              <XStack gap={4} flexWrap="wrap">
                {categories.map((cat) => (
                  <Badge key={cat} text={cat} variant="purple" />
                ))}
              </XStack>
            </XStack>
          )}
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={60}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Move Message ---

function MoveMessageRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const destination = (input?.destinationFolderId as string) || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'moved', variant: 'blue' as const }
        : undefined;

  const headerProps = {
    status,
    description: `Move to ${destination || 'folder'}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={60}>Destination</Text>
            <Badge text={destination || '(unknown)'} variant="blue" />
          </XStack>
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={60}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Delete Message ---

function DeleteMessageRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const permanent = input?.permanent as boolean | undefined;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: permanent ? 'deleted' : 'trashed', variant: 'red' as const }
        : undefined;

  const headerProps = {
    status,
    description: permanent ? 'Permanently delete message' : 'Move message to trash',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={60}>Mode</Text>
            <Badge text={permanent ? 'permanent' : 'trash'} variant={permanent ? 'red' : 'gray'} />
          </XStack>
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={60}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- List Drafts ---

function ListDraftsRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const data = parseOutput<ListDraftsOutput>(output);
  const count = data?.count ?? data?.drafts?.length ?? 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} drafts`, variant: 'gray' as const }
        : undefined;

  const headerProps = { status, description: 'List drafts', duration, badge, expanded, onToggle };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          ) : data?.drafts && data.drafts.length > 0 ? (
            data.drafts.slice(0, 8).map((draft, idx) => (
              <XStack
                key={draft.id || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < data.drafts.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <Text color={colors.muted} fontSize={9} width={30}>Draft</Text>
                <Text color={colors.secondary} fontSize={10} flex={1} numberOfLines={1}>
                  {draft.subject || '(no subject)'}
                </Text>
                <Text color={colors.muted} fontSize={9} flexShrink={0}>
                  {draft.date ? formatDate(draft.date) : ''}
                </Text>
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>No drafts found</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Create / Update Draft ---

function DraftWriteRenderer({ input, status, output, error, duration, expanded, onToggle, toolName }: SubRendererProps) {
  const to = (input?.to as string) || '';
  const subject = (input?.subject as string) || '';
  const draftId = (input?.draftId as string) || '';
  const isUpdate = getShortToolName(toolName) === 'update-draft';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: isUpdate ? 'updated' : 'created', variant: 'green' as const }
        : undefined;

  const headerProps = {
    status,
    description: isUpdate ? 'Update draft' : `Draft to ${truncate(to, 25)}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          {isUpdate && draftId && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={32}>ID</Text>
              <Text color={colors.secondary} fontSize={9} fontFamily="$mono" flex={1} numberOfLines={1}>
                {truncate(draftId, 30)}
              </Text>
            </XStack>
          )}
          {to && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={32}>To</Text>
              <Text color={colors.bright} fontSize={10} flex={1} numberOfLines={1}>{to}</Text>
            </XStack>
          )}
          {subject && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={32}>Subj</Text>
              <Text color={colors.bright} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>{subject}</Text>
            </XStack>
          )}
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={32}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Send Draft ---

function SendDraftRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const draftId = (input?.draftId as string) || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'sent', variant: 'green' as const }
        : undefined;

  const headerProps = { status, description: 'Send draft', duration, badge, expanded, onToggle };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={32}>ID</Text>
            <Text color={colors.secondary} fontSize={9} fontFamily="$mono" flex={1} numberOfLines={1}>
              {truncate(draftId, 40) || '(unknown)'}
            </Text>
          </XStack>
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={32}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- List Folders ---

function ListFoldersRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const data = parseOutput<ListFoldersOutput>(output);
  const count = data?.count ?? data?.folders?.length ?? 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} folders`, variant: 'gray' as const }
        : undefined;

  const headerProps = { status, description: 'List mail folders', duration, badge, expanded, onToggle };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          ) : data?.folders && data.folders.length > 0 ? (
            data.folders.slice(0, 10).map((folder, idx) => (
              <XStack
                key={folder.id || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < data.folders.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <Text color={colors.primary} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>
                  {folder.displayName}
                </Text>
                {folder.unreadItemCount !== undefined && folder.unreadItemCount > 0 && (
                  <Badge text={`${folder.unreadItemCount} unread`} variant="blue" />
                )}
                {folder.totalItemCount !== undefined && (
                  <Text color={colors.muted} fontSize={9}>{folder.totalItemCount}</Text>
                )}
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>No folders found</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Folder Write (create/delete) ---

function FolderWriteRenderer({ input, status, output, error, duration, expanded, onToggle, toolName }: SubRendererProps) {
  const short = getShortToolName(toolName);
  const isDelete = short === 'delete-folder';
  const name = (input?.displayName as string) || (input?.folderId as string) || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: isDelete ? 'deleted' : 'created', variant: isDelete ? 'red' as const : 'green' as const }
        : undefined;

  const headerProps = {
    status,
    description: isDelete ? `Delete folder` : `Create folder "${truncate(name, 20)}"`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={60}>{isDelete ? 'Folder ID' : 'Name'}</Text>
            <Text color={colors.bright} fontSize={10} flex={1} numberOfLines={1}>{name || '(unknown)'}</Text>
          </XStack>
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={60}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Attachment ---

function AttachmentRenderer({ input, status, output, error, duration, expanded, onToggle, toolName }: SubRendererProps) {
  const short = getShortToolName(toolName);
  const isStore = short === 'store-attachment';
  const data = parseOutput<{ name?: string; savedTo?: string; size?: number }>(output);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'saved', variant: 'green' as const }
        : undefined;

  const headerProps = {
    status,
    description: isStore ? 'Store attachment' : 'Get attachment',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          {data?.name && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>File</Text>
              <Text color={colors.bright} fontSize={10} flex={1} numberOfLines={1}>{data.name}</Text>
            </XStack>
          )}
          {data?.savedTo && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>Saved</Text>
              <Text color={colors.secondary} fontSize={9} fontFamily="$mono" flex={1} numberOfLines={1}>
                {data.savedTo}
              </Text>
            </XStack>
          )}
          {data?.size !== undefined && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>Size</Text>
              <Text color={colors.secondary} fontSize={9}>{(data.size / 1024).toFixed(1)} KB</Text>
            </XStack>
          )}
          {status === 'failed' && (error || output) && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={colors.muted} fontSize={9} width={50}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- List Rules ---

function ListRulesRenderer({ input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
  const data = parseOutput<{ count: number; rules: any[] }>(output);
  const count = data?.count ?? data?.rules?.length ?? 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} rules`, variant: 'gray' as const }
        : undefined;

  const headerProps = { status, description: 'List inbox rules', duration, badge, expanded, onToggle };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output}</Text>
            </XStack>
          ) : data?.rules && data.rules.length > 0 ? (
            data.rules.slice(0, 8).map((rule: any, idx: number) => (
              <XStack
                key={rule.id || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < data.rules.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <Text color={colors.primary} fontSize={10} flex={1} numberOfLines={1}>
                  {rule.displayName || rule.id || `Rule ${idx + 1}`}
                </Text>
                <Badge text={rule.isEnabled ? 'enabled' : 'disabled'} variant={rule.isEnabled ? 'green' : 'gray'} />
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>No rules found</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Default ---

function DefaultOutlookRenderer({ toolName, input, status, output, error, duration, expanded, onToggle }: SubRendererProps) {
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

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          {input &&
            Object.keys(input).length > 0 &&
            Object.entries(input)
              .slice(0, 5)
              .map(([key, value]) => (
                <XStack key={key} alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={50}>{key}</Text>
                  <Text color={colors.secondary} fontSize={9} flex={1} numberOfLines={1}>
                    {typeof value === 'string' ? truncate(value, 50) : JSON.stringify(value)}
                  </Text>
                </XStack>
              ))}
          {status === 'completed' && output && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>result</Text>
              <Text color={colors.secondary} fontSize={9} flex={1} numberOfLines={2}>
                {truncate(output, 100)}
              </Text>
            </XStack>
          )}
          {displayError && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{displayError}</Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function OutlookRendererBase(props: ToolCallRendererProps) {
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
    case 'get-message':
      return <GetMessageRenderer {...subProps} />;
    case 'send-message':
      return <SendMessageRenderer {...subProps} />;
    case 'reply-message':
      return <ReplyMessageRenderer {...subProps} />;
    case 'forward-message':
      return <ForwardMessageRenderer {...subProps} />;
    case 'search-messages':
      return <SearchMessagesRenderer {...subProps} />;
    case 'modify-message':
      return <ModifyMessageRenderer {...subProps} />;
    case 'move-message':
      return <MoveMessageRenderer {...subProps} />;
    case 'delete-message':
      return <DeleteMessageRenderer {...subProps} />;
    case 'list-drafts':
      return <ListDraftsRenderer {...subProps} />;
    case 'create-draft':
    case 'update-draft':
      return <DraftWriteRenderer {...subProps} />;
    case 'send-draft':
      return <SendDraftRenderer {...subProps} />;
    case 'delete-draft':
      return <DeleteMessageRenderer {...subProps} />;
    case 'list-folders':
      return <ListFoldersRenderer {...subProps} />;
    case 'create-folder':
    case 'delete-folder':
      return <FolderWriteRenderer {...subProps} />;
    case 'get-attachment':
    case 'store-attachment':
      return <AttachmentRenderer {...subProps} />;
    case 'list-rules':
      return <ListRulesRenderer {...subProps} />;
    default:
      return <DefaultOutlookRenderer {...subProps} />;
  }
}

export const OutlookToolCallRenderer = withPermissionSupport(OutlookRendererBase);

// Default export for dynamic import
export default OutlookToolCallRenderer;
