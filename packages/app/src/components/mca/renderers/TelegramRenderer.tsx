/**
 * Telegram MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for Telegram tool calls (mirrors WhatsappRenderer).
 * Renders messaging operations with minimal footprint when collapsed,
 * expandable to show full details.
 *
 * Design:
 * - Status dot with glow effect
 * - App icon from manifest (be.teros.ai static)
 * - Contextual badges (count, sent, failed)
 * - Chat list with avatars and unread badges
 * - Message thread view with sender/me differentiation
 *
 * Note: mca.telegram tools surface structured errors via runCatched
 * ({ success: false, error }) while the tool call status stays 'completed'
 * (unlike WhatsApp, where the gateway throws). Sub-renderers detect both
 * paths and show the error either way.
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { colors as semantic, type McaStatusType, ToolCallCard, useColors } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { backendUrl } from '../../../config/runtime';

// Telegram icon from MCA manifest static folder
const TELEGRAM_ICON = `${backendUrl()}/static/mcas/mca.telegram/icon.svg`;

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================
// Hook for the Telegram palette. Brand blue (#229ED9) stays as a literal
// — it's the official vendor identity color (regla
// `feedback_mca_brand_identity_three_mechanisms.md`).

function useTelegramColors() {
  const c = useColors();
  return {
    // Status dot (semantic theme-agnostic)
    success: semantic.green,
    running: semantic.indigo,
    failed: semantic.red,

    // Badges (theme-adaptive)
    badgeGray: c.badges.gray,
    badgeGreen: c.badges.ok,
    badgeBlue: c.badges.info,
    badgeRed: c.badges.err,

    // Telegram brand — official vendor blue, do NOT replace
    tgBlue: '#229ED9',
    tgUnreadBg: '#229ED9',

    // Message sender colors — brand blue for contacts, info text for me
    senderContact: '#229ED9',
    senderMe: c.badges.info.text,

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,

    // Backgrounds (theme-adaptive)
    bgInner: c.bgInner,
    border: c.border,
  };
}

// Avatar palette for chats and members
const AVATAR_COLORS = [
  '#229ED9', '#7C3AED', '#0ea5e9', '#f59e0b', '#6366f1',
  '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#06b6d4',
];

// ============================================================================
// Utilities
// ============================================================================

function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function parseOutput<T>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

function getInitials(name: string): string {
  const clean = name.replace(/^@+/, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

function avatarColorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Format an ISO timestamp or Unix seconds to HH:MM / "Yesterday" / "Oct 5" */
function formatChatTime(ts: number | string | undefined | null): string {
  if (!ts) return '';
  try {
    const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function formatBytes(bytes?: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Map a TL media className to a friendly label */
function mediaLabel(mediaType: string | null | undefined): string | null {
  if (!mediaType) return null;
  const map: Record<string, string> = {
    MessageMediaPhoto: 'Photo',
    MessageMediaDocument: 'Document',
    MessageMediaGeo: 'Location',
    MessageMediaContact: 'Contact',
    MessageMediaPoll: 'Poll',
    MessageMediaDice: 'Dice',
    MessageMediaGame: 'Game',
    MessageMediaInvoice: 'Invoice',
    MessageMediaWebPage: 'Link',
    MessageMediaVenue: 'Venue',
  };
  return map[mediaType] ?? mediaType.replace(/^MessageMedia/, '');
}

// ============================================================================
// Failure detection — Telegram tools return { success: false, error } with
// tool status 'completed' (runCatched), so both paths must be covered.
// ============================================================================

type ToolData = { success?: boolean; error?: string } | null | undefined;

function extractError(data: unknown, error?: string, output?: string, status?: string): string | null {
  if (error) return error;
  const d = data as ToolData;
  if (d?.success === false && d.error) return String(d.error);
  if (status === 'failed' && output) return output;
  return null;
}

// ============================================================================
// Output Types (mirror of mca.telegram serializers)
// ============================================================================

interface TgAccount {
  id?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  phone?: string | null;
  isPremium?: boolean;
}

interface TgChat {
  id?: string | null;
  chatId?: string;
  type?: string; // 'user' | 'group' | 'supergroup' | 'channel'
  title?: string | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  membersCount?: number | null;
  unreadCount?: number;
  isPinned?: boolean;
  isArchived?: boolean;
  lastMessageDate?: string | null;
  lastMessagePreview?: string | null;
}

interface TgMessage {
  id?: number;
  chatId?: string | null;
  date?: string | null;
  text?: string;
  fromId?: string | null;
  fromMe?: boolean;
  replyToMsgId?: number | null;
  hasMedia?: boolean;
  mediaType?: string | null;
  editDate?: string | null;
  // search-messages (global scope) extras
  fromName?: string | null;
  chatTitle?: string | null;
}

interface TgUser {
  id?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  phone?: string | null;
  isBot?: boolean;
}

// ============================================================================
// Name helpers
// ============================================================================

function accountName(account?: TgAccount | null): string {
  if (!account) return '';
  const name = [account.firstName, account.lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (account.username) return `@${account.username}`;
  return account.id ? `User ${account.id}` : 'Unknown';
}

function chatDisplayName(chat: TgChat): string {
  if (chat.title) return chat.title;
  const name = [chat.firstName, chat.lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (chat.username) return `@${chat.username}`;
  return chat.chatId || (chat.id != null ? String(chat.id) : 'Unknown');
}

/** "142 members" / "1.2K subscribers · @username" metadata for a chat row */
function chatMetaLine(chat: TgChat): string {
  const bits: string[] = [];
  if (chat.type === 'channel' && chat.membersCount != null) {
    bits.push(`${chat.membersCount} subscribers`);
  } else if (chat.type && chat.type !== 'user' && chat.membersCount != null) {
    bits.push(`${chat.membersCount} members`);
  }
  if (chat.username) bits.push(`@${chat.username}`);
  return bits.join(' · ');
}

// ============================================================================
// Shared Components
// ============================================================================

interface BadgeProps {
  text: string;
  variant: 'gray' | 'green' | 'blue' | 'red';
}

function Badge({ text, variant }: BadgeProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const colorMap = {
    gray: c.badges.gray,
    green: colors.badgeGreen,
    blue: colors.badgeBlue,
    red: colors.badgeRed,
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

/** Label + value row (the workhorse of detail views) */
function Row({
  label,
  value,
  mono,
  valueColor,
  lines = 1,
  width = 48,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueColor?: string;
  lines?: number;
  width?: number;
}) {
  const c = useColors();
  return (
    <XStack alignItems="flex-start" gap={6}>
      <Text color={c.text3} fontSize={9} width={width} marginTop={1}>{label}</Text>
      <Text
        color={valueColor ?? c.text}
        fontSize={10}
        fontFamily={mono ? '$mono' : undefined}
        flex={1}
        numberOfLines={lines}
      >
        {value}
      </Text>
    </XStack>
  );
}

/** Inner surface for list-like bodies */
function ListBody({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return (
    <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
      {children}
    </YStack>
  );
}

/** Single-line status/error/empty row inside a ListBody */
function StatusRow({ text, color }: { text: string; color?: string }) {
  const c = useColors();
  return (
    <XStack paddingVertical={6} paddingHorizontal={10}>
      <Text color={color ?? c.text3} fontSize={10} flex={1}>{text}</Text>
    </XStack>
  );
}

/** "N total" footer under a truncated list */
function Footer({ text }: { text: string }) {
  const c = useColors();
  return (
    <XStack justifyContent="flex-end" marginTop={6}>
      <Text color={c.text3} fontSize={9} fontFamily="$mono">{text}</Text>
    </XStack>
  );
}

// ============================================================================
// Sub-Renderer props
// ============================================================================

// `expanded`/`onToggle` are no longer threaded — ToolCallCard owns its state.
type SubRendererProps = ToolCallRendererProps;

// ============================================================================
// auth-status
// ============================================================================

function AuthStatusRenderer({ status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ connected?: boolean; account?: TgAccount; message?: string }>(output);
  const connected = data?.connected === true;
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : connected
        ? { text: 'connected', variant: 'green' as const }
        : { text: 'not connected', variant: 'gray' as const };

  const account = data?.account;
  const name = accountName(account);
  return (
    <ToolShell status={status} description="Telegram connection" badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        {structuredError ? (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        ) : connected && account ? (
          <>
            <XStack alignItems="center" gap={8}>
              <XStack
                width={28}
                height={28}
                borderRadius={14}
                backgroundColor={colors.tgBlue}
                alignItems="center"
                justifyContent="center"
                flexShrink={0}
              >
                <Text color="white" fontSize={11} fontWeight="600">{getInitials(name)}</Text>
              </XStack>
              <YStack flex={1} minWidth={0}>
                <Text color={c.text} fontSize={10} fontWeight="500" numberOfLines={1}>{name}</Text>
                {account.username && (
                  <Text color={colors.senderContact} fontSize={9}>@{account.username}</Text>
                )}
              </YStack>
            </XStack>
            {account.phone && <Row label="Phone" value={account.phone} mono />}
            {account.isPremium && <Row label="Premium" value="Yes" />}
          </>
        ) : (
          <Row
            label="Status"
            value={data?.message || 'Not connected — run auth-send-code to link an account'}
            valueColor={c.text2}
            lines={2}
          />
        )}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// auth-send-code / auth-sign-in / auth-disconnect
// ============================================================================

function AuthSendCodeRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; sentTo?: string; viaApp?: boolean; message?: string }>(output);
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'code sent', variant: 'green' as const }
        : undefined;

  return (
    <ToolShell status={status} description="Link Telegram account — step 1" badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        {input?.phoneNumber && <Row label="Phone" value={String(input.phoneNumber)} mono />}
        {data?.viaApp != null && (
          <Row label="Via" value={data.viaApp ? 'Telegram app' : 'SMS'} />
        )}
        {structuredError ? (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        ) : (
          data?.message && <Row label="Next" value={data.message} valueColor={c.text2} lines={2} />
        )}
      </YStack>
    </ToolShell>
  );
}

function AuthSignInRenderer({ status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{
    success?: boolean;
    connected?: boolean;
    account?: TgAccount;
    needsPassword?: boolean;
    message?: string;
  }>(output);
  const structuredError = extractError(data, error, output, status);
  const linked = data?.success === true && data.connected === true;

  const badge =
    structuredError
      ? { text: data?.needsPassword ? '2FA needed' : 'failed', variant: data?.needsPassword ? ('blue' as const) : ('red' as const) }
      : linked
        ? { text: 'linked', variant: 'green' as const }
        : undefined;

  const account = data?.account;
  const name = accountName(account);
  return (
    <ToolShell status={status} description="Link Telegram account — step 2" badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        {structuredError ? (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        ) : linked && account ? (
          <>
            <Row label="Account" value={name} />
            {account.username && <Row label="Username" value={`@${account.username}`} mono valueColor={colors.senderContact} />}
            {data?.message && <Row label="Note" value={data.message} valueColor={c.text2} lines={2} />}
          </>
        ) : null}
      </YStack>
    </ToolShell>
  );
}

function AuthDisconnectRenderer({ status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; connected?: boolean; message?: string }>(output);
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'disconnected', variant: 'gray' as const }
        : undefined;

  return (
    <ToolShell status={status} description="Disconnect Telegram account" badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        {structuredError ? (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        ) : (
          data?.message && <Row label="Result" value={data.message} valueColor={c.text2} lines={2} />
        )}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// list-chats
// ============================================================================

function ListChatsRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ chats?: TgChat[] } | TgChat[]>(output);
  const chats: TgChat[] = Array.isArray(data) ? data : (data as any)?.chats ?? [];
  const count = chats.length;
  const structuredError = extractError(data, error, output, status);
  const archived = input?.archived === true;

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : { text: `${count} chat${count !== 1 ? 's' : ''}`, variant: 'gray' as const };

  return (
    <ToolShell status={status} description={archived ? 'List archived chats' : 'List chats'} badge={badge}>
      <ListBody>
        {structuredError ? (
          <StatusRow text={structuredError} color={colors.badgeRed.text} />
        ) : status === 'running' ? (
          <StatusRow text="Loading chats…" />
        ) : count > 0 ? (
          chats.slice(0, 10).map((chat, idx) => {
            const name = chatDisplayName(chat);
            const isUser = chat.type === 'user';
            const initials = getInitials(name);
            const avatarColor = avatarColorForId(chat.chatId || chat.id || name);
            const preview = chat.lastMessagePreview || '';
            const time = formatChatTime(chat.lastMessageDate);
            const unread = chat.unreadCount ?? 0;

            return (
              <XStack
                key={chat.chatId || chat.id || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < Math.min(count, 10) - 1 ? 1 : 0}
                borderBottomColor={c.border}
              >
                {/* Avatar — chat initials with type-aware shape */}
                <XStack
                  width={28}
                  height={28}
                  borderRadius={isUser ? 14 : 8}
                  backgroundColor={avatarColor}
                  alignItems="center"
                  justifyContent="center"
                  flexShrink={0}
                >
                  <Text color="white" fontSize={11} fontWeight="600">{initials}</Text>
                </XStack>

                {/* Name + preview */}
                <YStack flex={1} minWidth={0}>
                  <XStack alignItems="center" gap={4}>
                    {!isUser && chat.type && (
                      <Text color={c.text3} fontSize={8} fontFamily="$mono" flexShrink={0}>
                        {chat.type === 'channel' ? 'CH' : chat.type === 'supergroup' ? 'SG' : 'GR'}
                      </Text>
                    )}
                    <Text color={c.text} fontSize={10} fontWeight="500" numberOfLines={1}>{name}</Text>
                  </XStack>
                  <Text color={c.text3} fontSize={10} numberOfLines={1}>{truncate(preview, 40)}</Text>
                </YStack>

                {/* Time + unread */}
                <YStack alignItems="flex-end" gap={3} flexShrink={0}>
                  <Text color={c.text3} fontSize={9}>{time}</Text>
                  {unread > 0 && (
                    <XStack
                      minWidth={16}
                      height={16}
                      borderRadius={8}
                      backgroundColor={colors.tgUnreadBg}
                      alignItems="center"
                      justifyContent="center"
                      paddingHorizontal={4}
                    >
                      <Text color="white" fontSize={8} fontWeight="700">{unread}</Text>
                    </XStack>
                  )}
                </YStack>
              </XStack>
            );
          })
        ) : (
          <StatusRow text="No chats found" />
        )}
      </ListBody>
      {count > 10 && <Footer text={`${count} chats total`} />}
    </ToolShell>
  );
}

// ============================================================================
// get-chat-history
// ============================================================================

function GetChatHistoryRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ messages?: TgMessage[] } | TgMessage[]>(output);
  const messages: TgMessage[] = Array.isArray(data) ? data : (data as any)?.messages ?? [];
  const chat: string = input?.chat || '';
  const count = messages.length;
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : { text: `${count} msg${count !== 1 ? 's' : ''}`, variant: 'gray' as const };

  return (
    <ToolShell
      status={status}
      description={`History of ${truncate(chat, 22)}`}
      badge={badge}
    >
      <ListBody>
        {structuredError ? (
          <StatusRow text={structuredError} color={colors.badgeRed.text} />
        ) : status === 'running' ? (
          <StatusRow text="Loading messages…" />
        ) : count > 0 ? (
          messages.slice(0, 15).map((msg, idx) => {
            const isMe = msg.fromMe === true;
            const senderColor = isMe ? colors.senderMe : colors.senderContact;
            const senderLabel = isMe
              ? 'You'
              : msg.fromName || (msg.fromId ? `#${msg.fromId}` : 'Unknown');
            const time = formatChatTime(msg.date);
            const media = mediaLabel(msg.mediaType);
            const edited = msg.editDate ? ' (edited)' : '';

            return (
              <YStack
                key={msg.id ?? idx}
                paddingVertical={6}
                paddingHorizontal={10}
                gap={2}
                borderBottomWidth={idx < Math.min(count, 15) - 1 ? 1 : 0}
                borderBottomColor={c.border}
              >
                <XStack alignItems="center" gap={6}>
                  <Text color={senderColor} fontSize={10} fontWeight="600">{senderLabel}</Text>
                  {msg.replyToMsgId != null && (
                    <Text color={c.text3} fontSize={8} fontFamily="$mono">↩ {msg.replyToMsgId}</Text>
                  )}
                  <Text color={c.text3} fontSize={9} fontFamily="$mono" marginLeft="auto">{time}</Text>
                </XStack>
                {msg.text ? (
                  <Text
                    color={isMe ? c.text : c.text2}
                    fontSize={10}
                    lineHeight={14}
                    numberOfLines={3}
                  >
                    {truncate(msg.text, 200)}{edited}
                  </Text>
                ) : media ? (
                  <Text color={c.text3} fontSize={10} fontStyle="italic">[{media}]{edited}</Text>
                ) : (
                  <Text color={c.text3} fontSize={10} fontStyle="italic">[empty message]{edited}</Text>
                )}
              </YStack>
            );
          })
        ) : (
          <StatusRow text="No messages found" />
        )}
      </ListBody>
      {count > 15 && <Footer text={`${count} messages total`} />}
    </ToolShell>
  );
}

// ============================================================================
// search-messages
// ============================================================================

function SearchMessagesRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ scope?: string; count?: number; messages?: TgMessage[] }>(output);
  const messages = data?.messages ?? [];
  const count = data?.count ?? messages.length;
  const query: string = input?.query || '';
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : { text: `${count} hit${count !== 1 ? 's' : ''}`, variant: 'gray' as const };

  return (
    <ToolShell status={status} description={`Search “${truncate(query, 24)}”`} badge={badge}>
      <ListBody>
        {structuredError ? (
          <StatusRow text={structuredError} color={colors.badgeRed.text} />
        ) : status === 'running' ? (
          <StatusRow text="Searching…" />
        ) : count > 0 ? (
          messages.slice(0, 10).map((msg, idx) => (
            <YStack
              key={msg.id ?? idx}
              paddingVertical={6}
              paddingHorizontal={10}
              gap={2}
              borderBottomWidth={idx < Math.min(count, 10) - 1 ? 1 : 0}
              borderBottomColor={c.border}
            >
              <XStack alignItems="center" gap={6}>
                {msg.chatTitle && (
                  <Text color={c.text3} fontSize={9} numberOfLines={1} flexShrink={1}>
                    {msg.chatTitle}
                  </Text>
                )}
                <Text color={colors.senderContact} fontSize={10} fontWeight="600" numberOfLines={1}>
                  {msg.fromName || (msg.fromId ? `#${msg.fromId}` : '')}
                </Text>
                <Text color={c.text3} fontSize={9} fontFamily="$mono" marginLeft="auto">
                  {formatChatTime(msg.date)}
                </Text>
              </XStack>
              <Text color={c.text2} fontSize={10} lineHeight={14} numberOfLines={2}>
                {truncate(msg.text || '[media]', 160)}
              </Text>
            </YStack>
          ))
        ) : (
          <StatusRow text="No results" />
        )}
      </ListBody>
      {count > 10 && <Footer text={`${count} results total`} />}
    </ToolShell>
  );
}

// ============================================================================
// send-message / send-media
// ============================================================================

function SendMessageRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; message?: TgMessage }>(output);
  const chat: string = input?.chat || '';
  const text: string = input?.text || '';
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'sent', variant: 'green' as const }
        : undefined;

  return (
    <ToolShell status={status} description={`Send message to ${truncate(chat, 28)}`} badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        <Row label="To" value={chat} mono />
        <Row label="Text" value={text || '(empty)'} valueColor={c.text2} lines={3} />
        {input?.replyToMsgId != null && <Row label="Reply to" value={`#${input.replyToMsgId}`} mono />}
        {structuredError && (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        )}
      </YStack>
    </ToolShell>
  );
}

function SendMediaRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; message?: TgMessage }>(output);
  const chat: string = input?.chat || '';
  const file: string = input?.file || '';
  const filename = file.split('/').pop() || file;
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'sent', variant: 'green' as const }
        : undefined;

  return (
    <ToolShell status={status} description={`Send media to ${truncate(chat, 24)}`} badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        <Row label="To" value={chat} mono />
        <Row label="File" value={filename} mono lines={1} />
        {input?.caption && <Row label="Caption" value={String(input.caption)} valueColor={c.text2} lines={2} />}
        {structuredError && (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        )}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// download-media
// ============================================================================

function DownloadMediaRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; outputPath?: string; sizeBytes?: number }>(output);
  const chat: string = input?.chat || '';
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: data?.sizeBytes != null ? formatBytes(data.sizeBytes) : 'saved', variant: 'gray' as const }
        : undefined;

  return (
    <ToolShell status={status} description={`Download media from ${truncate(chat, 22)}`} badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        {structuredError ? (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        ) : (
          <>
            {data?.outputPath && <Row label="Saved to" value={data.outputPath} mono lines={2} />}
            {data?.sizeBytes != null && <Row label="Size" value={formatBytes(data.sizeBytes)} />}
            {input?.thumb === true && <Row label="Mode" value="Thumbnail only" />}
          </>
        )}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// edit-message / delete-messages / mark-as-read
// ============================================================================

function EditMessageRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; message?: TgMessage }>(output);
  const chat: string = input?.chat || '';
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'edited', variant: 'green' as const }
        : undefined;

  return (
    <ToolShell status={status} description={`Edit message in ${truncate(chat, 24)}`} badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        <Row label="Chat" value={chat} mono />
        {input?.messageId != null && <Row label="Message" value={`#${input.messageId}`} mono />}
        <Row label="New text" value={String(input?.text || '(empty)')} valueColor={c.text2} lines={3} />
        {structuredError && (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        )}
      </YStack>
    </ToolShell>
  );
}

function DeleteMessagesRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; deleted?: number[]; forEveryone?: boolean }>(output);
  const chat: string = input?.chat || '';
  const structuredError = extractError(data, error, output, status);
  const deletedCount = data?.deleted?.length ?? (Array.isArray(input?.messageIds) ? input.messageIds.length : 0);
  const forEveryone = data?.forEveryone ?? input?.revoke !== false;

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: `${deletedCount} deleted`, variant: 'gray' as const }
        : undefined;

  return (
    <ToolShell status={status} description={`Delete messages in ${truncate(chat, 22)}`} badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        <Row label="Chat" value={chat} mono />
        <Row
          label="Scope"
          value={forEveryone ? 'For everyone' : 'Only for me'}
          valueColor={forEveryone ? colors.badgeRed.text : c.text2}
        />
        {structuredError && (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        )}
      </YStack>
    </ToolShell>
  );
}

function MarkAsReadRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; chat?: string; markedUpTo?: number | string }>(output);
  const chat: string = input?.chat || '';
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'read', variant: 'green' as const }
        : undefined;

  return (
    <ToolShell status={status} description={`Mark as read ${truncate(chat, 28)}`} badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        <Row label="Chat" value={chat} mono />
        {(data?.markedUpTo != null || input?.maxId != null) && (
          <Row label="Up to" value={`#${data?.markedUpTo ?? input?.maxId}`} mono />
        )}
        {structuredError && (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        )}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// create-group
// ============================================================================

function CreateGroupRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; kind?: string; chat?: TgChat; invited?: string[] }>(output);
  const title: string = input?.title || '';
  const kind = data?.kind || input?.kind || 'group';
  const structuredError = extractError(data, error, output, status);
  const chat = data?.chat;

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: kind, variant: 'green' as const }
        : undefined;

  return (
    <ToolShell status={status} description={`Create ${kind} “${truncate(title, 20)}”`} badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        {structuredError ? (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        ) : (
          <>
            <Row label="Title" value={title} />
            {chat?.chatId && <Row label="Chat ID" value={chat.chatId} mono valueColor={colors.senderContact} />}
            {(data?.invited?.length ?? 0) > 0 && (
              <Row label="Members" value={data?.invited?.map((m) => m.startsWith('@') ? m : `#${m}`).join(', ') || ''} lines={2} />
            )}
            {input?.about && <Row label="About" value={String(input.about)} valueColor={c.text2} lines={2} />}
          </>
        )}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// manage-members
// ============================================================================

const MEMBER_ACTION_LABEL: Record<string, string> = {
  list: 'List members',
  add: 'Add member',
  remove: 'Remove member',
  ban: 'Ban member',
  unban: 'Unban member',
};

function ManageMembersRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const data = parseOutput<{ success?: boolean; action?: string; count?: number; members?: TgUser[]; message?: string }>(output);
  const chat: string = input?.chat || '';
  const action = input?.action || 'list';
  const structuredError = extractError(data, error, output, status);
  const members = data?.members ?? [];
  const count = data?.count ?? members.length;
  const isList = action === 'list';

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : isList
        ? { text: `${count} member${count !== 1 ? 's' : ''}`, variant: 'gray' as const }
        : status === 'completed'
          ? { text: action, variant: 'green' as const }
          : undefined;

  return (
    <ToolShell
      status={status}
      description={`${MEMBER_ACTION_LABEL[action] ?? 'Members'} · ${truncate(chat, 18)}`}
      badge={badge}
    >
      {isList ? (
        <ListBody>
          {structuredError ? (
            <StatusRow text={structuredError} color={colors.badgeRed.text} />
          ) : status === 'running' ? (
            <StatusRow text="Loading members…" />
          ) : count > 0 ? (
            members.slice(0, 10).map((member, idx) => {
              const name = [member.firstName, member.lastName].filter(Boolean).join(' ').trim()
                || (member.username ? `@${member.username}` : `#${member.id ?? '?'}`);
              const initials = getInitials(name);
              const avatarColor = avatarColorForId(member.id || name);

              return (
                <XStack
                  key={member.id || idx}
                  paddingVertical={6}
                  paddingHorizontal={10}
                  alignItems="center"
                  gap={8}
                  borderBottomWidth={idx < Math.min(count, 10) - 1 ? 1 : 0}
                  borderBottomColor={c.border}
                >
                  <XStack
                    width={24}
                    height={24}
                    borderRadius={12}
                    backgroundColor={avatarColor}
                    alignItems="center"
                    justifyContent="center"
                    flexShrink={0}
                  >
                    <Text color="white" fontSize={10} fontWeight="600">{initials}</Text>
                  </XStack>
                  <Text color={c.text} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>
                    {name}{member.isBot ? ' 🤖' : ''}
                  </Text>
                  {member.username && (
                    <Text color={c.text3} fontSize={9} fontFamily="$mono" flexShrink={0}>@{member.username}</Text>
                  )}
                </XStack>
              );
            })
          ) : (
            <StatusRow text="No members found" />
          )}
        </ListBody>
      ) : (
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <Row label="Chat" value={chat} mono />
          {input?.user && <Row label="User" value={String(input.user)} mono />}
          {structuredError && (
            <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
          )}
        </YStack>
      )}
      {isList && count > 10 && <Footer text={`${count} members total`} />}
    </ToolShell>
  );
}

// ============================================================================
// events-start / events-status
// ============================================================================

function EventsRenderer({ toolName, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const isStart = getShortToolName(toolName) === 'events-start';
  const data = parseOutput<{
    success?: boolean;
    active?: boolean;
    topics?: string[];
    startedAt?: string | null;
    counters?: { received?: number; edited?: number; deleted?: number; errors?: number };
    message?: string;
  }>(output);
  const structuredError = extractError(data, error, output, status);
  const active = data?.active === true;

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : active
        ? { text: 'active', variant: 'green' as const }
        : { text: 'inactive', variant: 'gray' as const };

  const counters = data?.counters;
  const counterText = counters
    ? `${counters.received ?? 0} received · ${counters.edited ?? 0} edited · ${counters.deleted ?? 0} deleted`
    : null;

  return (
    <ToolShell
      status={status}
      description={isStart ? 'Start event forwarding' : 'Event forwarding status'}
      badge={badge}
    >
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        {structuredError ? (
          <Row label="Error" value={structuredError} valueColor={colors.badgeRed.text} lines={3} />
        ) : (
          <>
            {data?.startedAt && <Row label="Since" value={formatChatTime(data.startedAt)} />}
            {counterText && <Row label="Events" value={counterText} valueColor={c.text2} />}
            {(data?.topics?.length ?? 0) > 0 && (
              <Row label="Topics" value={data?.topics?.join(', ') || ''} mono lines={2} valueColor={c.text2} />
            )}
            {!data?.startedAt && !counterText && !(data?.topics?.length) && data?.message && (
              <Row label="Info" value={data.message} valueColor={c.text2} lines={2} />
            )}
          </>
        )}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// Default renderer — generic key/value view
// ============================================================================

function DefaultTelegramRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useTelegramColors();
  const shortName = getShortToolName(toolName);
  const data = parseOutput<Record<string, unknown>>(output);
  const structuredError = extractError(data, error, output, status);

  const badge =
    structuredError
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'done', variant: 'green' as const }
        : undefined;

  return (
    <ToolShell status={status} description={shortName} badge={badge}>
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
        {input &&
          Object.keys(input).length > 0 &&
          Object.entries(input)
            .slice(0, 5)
            .map(([key, value]) => (
              <XStack key={key} alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={50}>{key}</Text>
                <Text color={c.text2} fontSize={9} flex={1} numberOfLines={1}>
                  {/* Renderer UX Guide §0: objects → `{…}`, arrays → `[…]`. */}
                  {typeof value === 'string'
                    ? truncate(value, 60)
                    : Array.isArray(value)
                      ? value.length === 0 ? '[]' : `[…${value.length}]`
                      : value === null
                        ? 'null'
                        : typeof value === 'object' ? '{…}' : String(value)}
                </Text>
              </XStack>
            ))}

        {structuredError && (
          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={50}>error</Text>
            <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{structuredError}</Text>
          </XStack>
        )}

        {!input && !output && !structuredError && (
          <Text color={c.text3} fontSize={10}>No details available</Text>
        )}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function TelegramRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const subProps: SubRendererProps = { ...props };

  switch (shortName) {
    case 'auth-status':
      return <AuthStatusRenderer {...subProps} />;
    case 'auth-send-code':
      return <AuthSendCodeRenderer {...subProps} />;
    case 'auth-sign-in':
      return <AuthSignInRenderer {...subProps} />;
    case 'auth-disconnect':
      return <AuthDisconnectRenderer {...subProps} />;
    case 'list-chats':
      return <ListChatsRenderer {...subProps} />;
    case 'get-chat-history':
      return <GetChatHistoryRenderer {...subProps} />;
    case 'search-messages':
      return <SearchMessagesRenderer {...subProps} />;
    case 'send-message':
      return <SendMessageRenderer {...subProps} />;
    case 'send-media':
      return <SendMediaRenderer {...subProps} />;
    case 'download-media':
      return <DownloadMediaRenderer {...subProps} />;
    case 'edit-message':
      return <EditMessageRenderer {...subProps} />;
    case 'delete-messages':
      return <DeleteMessagesRenderer {...subProps} />;
    case 'mark-as-read':
      return <MarkAsReadRenderer {...subProps} />;
    case 'create-group':
      return <CreateGroupRenderer {...subProps} />;
    case 'manage-members':
      return <ManageMembersRenderer {...subProps} />;
    case 'events-start':
    case 'events-status':
      return <EventsRenderer {...subProps} />;
    default:
      return <DefaultTelegramRenderer {...subProps} />;
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
      iconUri={TELEGRAM_ICON}
      badge={badge ? <Badge text={badge.text} variant={badge.variant} /> : null}
      irreversible={irreversible}
    >
      {children}
    </ToolCallCard>
  );
}

export const TelegramToolCallRenderer = withPermissionSupport(TelegramRendererBase);

// Default export for dynamic import
export default TelegramToolCallRenderer;
