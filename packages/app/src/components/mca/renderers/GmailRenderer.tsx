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

import type React from 'react';
import { Image, Text, XStack, YStack } from 'tamagui';
import { colors as semantic, Empty, type McaStatusType, ToolCallCard, useColors } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// Gmail icon from manifest
const GMAIL_ICON = 'https://www.gstatic.com/images/branding/product/1x/gmail_2020q4_48dp.png';

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================

function useGmailColors() {
  const c = useColors();
  return {
    // Status dot (semantic theme-agnostic)
    success: semantic.green,
    running: semantic.indigo,
    failed: semantic.red,

    // Status glow
    glowSuccess: 'rgba(34, 197, 94, 0.5)',
    glowRunning: 'rgba(94, 106, 210, 0.7)',
    glowFailed: 'rgba(239, 68, 68, 0.5)',

    // Badges (theme-adaptive)
    badgeGray: c.badges.gray,
    badgeGreen: c.badges.ok,
    badgeBlue: c.badges.info,
    badgeYellow: c.badges.warn,
    badgeRed: c.badges.err,
    badgePurple: { text: '#c4b5fd', bg: 'rgba(139,92,246,0.1)' },

    // Email unread dot — system info indigo (theme-agnostic)
    unread: semantic.indigo,

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,
    white: '#fafafa',

    // Backgrounds (theme-adaptive)
    bgInner: c.bgInner,
    bgInnerDark: c.bgInner,
    border: c.border,
    borderLight: c.borderStrong,

    // Labels — added/removed semantic accents (theme-adaptive via badges)
    labelAdded: { text: c.badges.ok.text, bg: c.badges.ok.bg, border: c.badges.ok.border },
    labelRemoved: { text: c.badges.err.text, bg: c.badges.err.bg, border: c.badges.err.border },

    // Chevron (theme-adaptive)
    chevron: c.text3,
  };
}

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



interface BadgeProps {
  text: string;
  variant: 'gray' | 'green' | 'blue' | 'yellow' | 'red' | 'purple';
}

function Badge({ text, variant }: BadgeProps) {
  const c = useColors();
  const colors = useGmailColors();
  const colorMap = {
    gray: c.badges.gray,
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



/** Wrapper for expanded state - contains header + body */
interface ExpandedContainerProps {
  children: React.ReactNode;
}


/** Body wrapper for expanded content */
interface ExpandedBodyProps {
  children: React.ReactNode;
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

// `expanded`/`onToggle` no longer threaded — ToolCallCard owns its state.
type SubRendererProps = ToolCallRendererProps;

// --- List Messages ---

function ListMessagesRenderer({
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
  const data = parseOutput<ListMessagesOutput>(output);
  const count = data?.messages?.length ?? 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} emails`, variant: 'gray' as const }
        : undefined;

  const displayError = error || output;

  // ToolCallCard handles collapsed/expanded internally.
  return (
    <ToolShell
      status={status}
      description="List inbox messages"
      badge={badge}
    >
        <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
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
                borderBottomColor={c.border}
              >
                <XStack
                  width={5}
                  height={5}
                  borderRadius={2.5}
                  backgroundColor={isEmailUnread(email) ? colors.unread : 'transparent'}
                  flexShrink={0}
                />
                <Text
                  color={c.text}
                  fontSize={10}
                  fontWeight="500"
                  width={90}
                  flexShrink={0}
                  numberOfLines={1}
                >
                  {extractSenderName(email.from)}
                </Text>
                <Text color={c.text2} fontSize={10} flex={1} numberOfLines={1}>
                  {email.subject}
                </Text>
                <Text color={c.text3} fontSize={9} flexShrink={0}>
                  {formatDate(email.date)}
                </Text>
              </XStack>
            ))
          ) : (
            <Empty message="No messages in this label" hint="Try a different filter" />
          )}
        </YStack>
      </ToolShell>
  );
}

// --- Send Message ---

function SendMessageRenderer({
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
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
  };
  // Expanded view
  return (
    <ToolShell {...headerProps}>
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={32}>
              To
            </Text>
            <Text color={c.text} fontSize={10} flex={1} numberOfLines={1}>
              {to || '(empty)'}
            </Text>
          </XStack>

          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={32}>
              Subj
            </Text>
            <Text color={c.text} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>
              {subject || '(empty)'}
            </Text>
          </XStack>

          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={32}>
              Body
            </Text>
            <Text color={c.text3} fontSize={10} flex={1} numberOfLines={2}>
              {truncate(body, 100) || '(empty)'}
            </Text>
          </XStack>

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={c.text3} fontSize={9} width={32}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

// --- Reply Message ---

function ReplyMessageRenderer({
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
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
  };
  return (
    <ToolShell {...headerProps}>
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          {messageId && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={32}>
                To
              </Text>
              <Text
                color={c.text2}
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
            <Text color={c.text3} fontSize={9} width={32}>
              Body
            </Text>
            <Text color={c.text3} fontSize={10} flex={1} numberOfLines={3}>
              {truncate(body, 150) || '(empty)'}
            </Text>
          </XStack>

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={c.text3} fontSize={9} width={32}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

// --- Search Messages ---

function SearchMessagesRenderer({
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
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
  };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
          {/* Query row */}
          <XStack
            paddingVertical={6}
            paddingHorizontal={10}
            alignItems="center"
            gap={6}
            borderBottomWidth={1}
            borderBottomColor={c.border}
          >
            <Text color={c.text3} fontSize={9}>
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
                borderBottomColor={c.border}
              >
                <XStack
                  width={5}
                  height={5}
                  borderRadius={2.5}
                  backgroundColor={isEmailUnread(email) ? colors.unread : 'transparent'}
                  flexShrink={0}
                />
                <Text
                  color={c.text}
                  fontSize={10}
                  fontWeight="500"
                  width={90}
                  flexShrink={0}
                  numberOfLines={1}
                >
                  {extractSenderName(email.from)}
                </Text>
                <Text color={c.text2} fontSize={10} flex={1} numberOfLines={1}>
                  {email.subject}
                </Text>
                <Text color={c.text3} fontSize={9} flexShrink={0}>
                  {formatDate(email.date)}
                </Text>
              </XStack>
            ))
          ) : (
            <Empty message="No messages match this query" hint="Try a different search" />
          )}
        </YStack>
      </ToolShell>
  );
}

// --- Get Message ---

function GetMessageRenderer({
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
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
  };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={10}>
          {status === 'failed' ? (
            <YStack gap={4}>
              <XStack alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={32}>
                  ID
                </Text>
                <Text
                  color={c.text2}
                  fontSize={9}
                  fontFamily="$mono"
                  flex={1}
                  numberOfLines={1}
                >
                  {messageId || '(unknown)'}
                </Text>
              </XStack>
              <XStack alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={32}>
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
                  <Text color={c.text} fontSize={11} fontWeight="500">
                    {senderName}
                  </Text>
                  <Text color={c.text3} fontSize={10} numberOfLines={1}>
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
                <Text color={c.text3} fontSize={10} lineHeight={15}>
                  {truncate(data.body || data.snippet || '', 300)}
                </Text>
              )}
            </>
          ) : (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9}>
                ID:
              </Text>
              <Text color={c.text2} fontSize={9} fontFamily="$mono">
                {messageId || '(unknown)'}
              </Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

// --- Modify Labels ---

function ModifyLabelsRenderer({
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
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
  };
  return (
    <ToolShell {...headerProps}>
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          {hasChanges && (
            <>
              <Text color={c.text3} fontSize={9} textTransform="uppercase" letterSpacing={0.5}>
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
              <Text color={c.text3} fontSize={9}>
                ID:
              </Text>
              <Text color={c.text2} fontSize={9} fontFamily="$mono">
                {messageId || '(unknown)'}
              </Text>
            </XStack>
          )}

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={hasChanges ? 4 : 0}>
              <Text color={c.text3} fontSize={9} width={32}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

// --- Create Draft ---

function CreateDraftRenderer({
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
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
  };
  return (
    <ToolShell {...headerProps}>
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={32}>
              To
            </Text>
            <Text color={c.text} fontSize={10} flex={1} numberOfLines={1}>
              {to || '(empty)'}
            </Text>
          </XStack>

          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={32}>
              Subj
            </Text>
            <Text color={c.text} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>
              {subject || '(empty)'}
            </Text>
          </XStack>

          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={32}>
              Body
            </Text>
            <Text color={c.text3} fontSize={10} flex={1} numberOfLines={2}>
              {truncate(body, 100) || '(empty)'}
            </Text>
          </XStack>

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={c.text3} fontSize={9} width={32}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

// --- List Drafts ---

function ListDraftsRenderer({
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
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
  };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
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
                  borderBottomColor={c.border}
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
                    color={c.text}
                    fontSize={10}
                    fontWeight="500"
                    width={90}
                    flexShrink={0}
                    numberOfLines={1}
                  >
                    {email?.to ? extractSenderName(email.to) : 'No recipient'}
                  </Text>
                  <Text color={c.text2} fontSize={10} flex={1} numberOfLines={1}>
                    {email?.subject || '(no subject)'}
                  </Text>
                </XStack>
              );
            })
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={c.text3} fontSize={10}>
                No drafts found
              </Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
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
}: SubRendererProps) {
  const c = useColors();
  const colors = useGmailColors();
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
  };
  return (
    <ToolShell {...headerProps}>
        <YStack
          backgroundColor={c.bgInner}
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
                  <Text color={c.text3} fontSize={9} width={50}>
                    {key}
                  </Text>
                  <Text color={c.text2} fontSize={9} flex={1} numberOfLines={1}>
                    {/* Renderer UX Guide §0: objects → `{…}`, arrays → `[…]`. */}
                    {typeof value === 'string'
                      ? truncate(value, 50)
                      : Array.isArray(value)
                        ? value.length === 0 ? '[]' : `[…${value.length}]`
                        : value === null
                          ? 'null'
                          : typeof value === 'object' ? '{…}' : String(value)}
                  </Text>
                </XStack>
              ))}

          {status === 'completed' && output && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={50}>
                result
              </Text>
              <Text color={c.text2} fontSize={9} flex={1} numberOfLines={2}>
                {truncate(output, 100)}
              </Text>
            </XStack>
          )}

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={50}>
                error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}

          {!input && !output && !displayError && (
            <Text color={c.text3} fontSize={10}>
              No details available
            </Text>
          )}
        </YStack>
      </ToolShell>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function GmailRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const subProps: SubRendererProps = { ...props };

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


// ============================================================================
// ToolShell — compose-only adapter over <ToolCallCard>
// ============================================================================
//
// Sub-renderers feed `headerProps` from their existing computation; this
// shell hands status/description/badge to the canonical primitive. The
// `duration`/`expanded`/`onToggle` keys are silently ignored (the primitive
// owns its own state).

interface ToolShellHeaderProps {
  status: McaStatusType;
  description: string;
  duration?: number;
  badge?: { text: string; variant: BadgeProps['variant'] };
  expanded?: boolean;
  onToggle?: () => void;
  isInContainer?: boolean;
  irreversible?: boolean;
}

function ToolShell({
  status,
  description,
  badge,
  irreversible,
  children,
}: ToolShellHeaderProps & { children?: React.ReactNode }) {
  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={GMAIL_ICON}
      badge={badge ? <Badge text={badge.text} variant={badge.variant} /> : null}
      irreversible={irreversible}
    >
      {children}
    </ToolCallCard>
  );
}

export const GmailToolCallRenderer = withPermissionSupport(GmailRendererBase);

// Default export for dynamic import
export default GmailToolCallRenderer;
