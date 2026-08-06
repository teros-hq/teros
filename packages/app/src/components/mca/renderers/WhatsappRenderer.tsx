/**
 * WhatsApp MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for WhatsApp tool calls.
 * Renders messaging operations with minimal footprint when collapsed,
 * expandable to show full details.
 *
 * Design based on mockup with:
 * - Status dot with glow effect
 * - App icon from manifest (be.teros.ai static)
 * - Contextual badges (count, sent, failed)
 * - Collapsed/expanded views
 * - Chat list with avatars and unread badges
 * - Message thread view with sender/me differentiation
 */

import type React from 'react';
import { Image, Text, XStack, YStack } from 'tamagui';
import { colors as semantic, type McaStatusType, ToolCallCard, useColors } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// WhatsApp icon from MCA manifest static folder
const WHATSAPP_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/mcas/mca.whatsapp/icon.png`;

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================
// Hook for the WhatsApp palette. Brand green (#25D366) stays as a literal
// — it's the official vendor identity color (regla
// `feedback_mca_brand_identity_three_mechanisms.md`).

function useWhatsappColors() {
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
    badgeRed: c.badges.err,

    // WhatsApp brand — official vendor green, do NOT replace
    waGreen: '#25D366',
    waUnreadBg: '#25D366',

    // Message sender colors — brand green for contacts, info text for me
    senderContact: '#25D366',
    senderMe: c.badges.info.text,

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,

    // Backgrounds (theme-adaptive)
    bgInner: c.bgInner,
    bgInnerDark: c.bgInner,
    border: c.border,
    borderLight: c.borderStrong,

    // Chevron (theme-adaptive)
    chevron: c.text3,
  };
}

// Avatar palette for chat contacts
const AVATAR_COLORS = [
  '#25D366', '#7C3AED', '#0ea5e9', '#f59e0b', '#6366f1',
  '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#06b6d4',
];

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

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function avatarColorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Format a Unix timestamp (seconds) or ISO string to HH:MM or "Yesterday" */
function formatChatTime(ts: number | string | undefined): string {
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

/** Format a phone chatId like "34612345678@c.us" → "+34 612 345 678" */
function formatChatId(chatId: string): string {
  const raw = chatId.replace(/@.*$/, '');
  if (/^\d+$/.test(raw)) return `+${raw}`;
  return chatId;
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
  const colors = useWhatsappColors();
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





// ============================================================================
// Output Types
// ============================================================================

interface WaChat {
  id?: string;
  name?: string;
  picture?: string;
  lastMessage?: { body?: string; timestamp?: number };
  unreadCount?: number;
  timestamp?: number;
  isGroup?: boolean;
}

interface WaMessage {
  id?: string;
  from?: string;
  fromMe?: boolean;
  body?: string;
  timestamp?: number;
  type?: string;
}

interface WaContact {
  id?: string;
  name?: string;
  pushname?: string;
  number?: string;
}

interface WaSession {
  name?: string;
  status?: string;
}

// ============================================================================
// Sub-Renderer props
// ============================================================================

// `expanded`/`onToggle` are no longer threaded — ToolCallCard owns its state.
type SubRendererProps = ToolCallRendererProps;

// ============================================================================
// send-text
// ============================================================================

function SendTextRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useWhatsappColors();
  const chatId: string = input?.chatId || '';
  const text: string = input?.text || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'sent', variant: 'green' as const }
        : undefined;

  const displayError = error || (status === 'failed' ? output : null);
  const headerProps = {
    status,
    description: `Send message to ${truncate(formatChatId(chatId), 28)}`,
    duration,
    badge,
  };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={36}>To</Text>
            <Text color={c.text} fontSize={10} flex={1} numberOfLines={1}>{chatId}</Text>
          </XStack>
          <XStack alignItems="flex-start" gap={6}>
            <Text color={c.text3} fontSize={9} width={36}>Text</Text>
            <Text color={c.text2} fontSize={10} flex={1} numberOfLines={3}>{text || '(empty)'}</Text>
          </XStack>
          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6} marginTop={2}>
              <Text color={c.text3} fontSize={9} width={36}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{displayError}</Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

// ============================================================================
// get-chats
// ============================================================================

function GetChatsRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useWhatsappColors();
  const data = parseOutput<{ chats?: WaChat[] } | WaChat[]>(output);
  const chats: WaChat[] = Array.isArray(data) ? data : (data as any)?.chats ?? [];
  const count = chats.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : { text: `${count} chat${count !== 1 ? 's' : ''}`, variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);
  const headerProps = { status, description: 'List chats', duration, badge };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
          {status === 'running' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={c.text3} fontSize={10}>Loading chats…</Text>
            </XStack>
          ) : status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{displayError || 'Unknown error'}</Text>
            </XStack>
          ) : chats.length > 0 ? (
            chats.slice(0, 10).map((chat, idx) => {
              const name = chat.name || chat.id || 'Unknown';
              const initials = getInitials(name);
              const avatarColor = avatarColorForId(chat.id || name);
              const preview = chat.lastMessage?.body || '';
              const time = formatChatTime(chat.lastMessage?.timestamp ?? chat.timestamp);
              const unread = chat.unreadCount ?? 0;

              return (
                <XStack
                  key={chat.id || idx}
                  paddingVertical={6}
                  paddingHorizontal={10}
                  alignItems="center"
                  gap={8}
                  borderBottomWidth={idx < chats.length - 1 ? 1 : 0}
                  borderBottomColor={c.border}
                >
                  {/* Avatar — real picture if available, else initials */}
                  {chat.picture ? (
                    <Image
                      source={{ uri: chat.picture as string }}
                      width={28}
                      height={28}
                      borderRadius={14}
                      flexShrink={0}
                    />
                  ) : (
                    <XStack
                      width={28}
                      height={28}
                      borderRadius={14}
                      backgroundColor={avatarColor}
                      alignItems="center"
                      justifyContent="center"
                      flexShrink={0}
                    >
                      <Text color="white" fontSize={11} fontWeight="600">{initials}</Text>
                    </XStack>
                  )}

                  {/* Name + preview */}
                  <YStack flex={1} minWidth={0}>
                    <Text color={c.text} fontSize={10} fontWeight="500" numberOfLines={1}>{name}</Text>
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
                        backgroundColor={colors.waUnreadBg}
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
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={c.text3} fontSize={10}>No chats found</Text>
            </XStack>
          )}
        </YStack>
        {count > 10 && (
          <XStack justifyContent="flex-end" marginTop={6}>
            <Text color={c.text3} fontSize={9} fontFamily="$mono">{count} chats total</Text>
          </XStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// get-messages
// ============================================================================

function GetMessagesRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useWhatsappColors();
  const data = parseOutput<{ messages?: WaMessage[] } | WaMessage[]>(output);
  const messages: WaMessage[] = Array.isArray(data) ? data : (data as any)?.messages ?? [];
  const chatId: string = input?.chatId || '';
  const count = messages.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : { text: `${count} msg${count !== 1 ? 's' : ''}`, variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);
  const headerProps = {
    status,
    description: `Get messages from ${truncate(formatChatId(chatId), 22)}`,
    duration,
    badge,
  };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
          {status === 'running' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={c.text3} fontSize={10}>Loading messages…</Text>
            </XStack>
          ) : status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{displayError || 'Unknown error'}</Text>
            </XStack>
          ) : messages.length > 0 ? (
            messages.slice(0, 15).map((msg, idx) => {
              const isMe = msg.fromMe === true;
              const senderColor = isMe ? colors.senderMe : colors.senderContact;
              const senderLabel = isMe ? 'You' : (msg.from ? formatChatId(msg.from) : 'Contact');
              const time = formatChatTime(msg.timestamp);

              return (
                <YStack
                  key={msg.id || idx}
                  paddingVertical={6}
                  paddingHorizontal={10}
                  gap={2}
                  borderBottomWidth={idx < messages.length - 1 ? 1 : 0}
                  borderBottomColor={c.border}
                >
                  <XStack alignItems="center" gap={6}>
                    <Text color={senderColor} fontSize={10} fontWeight="600">{senderLabel}</Text>
                    <Text color={c.text3} fontSize={9} fontFamily="$mono" marginLeft="auto">{time}</Text>
                  </XStack>
                  <Text
                    color={isMe ? c.text : c.text2}
                    fontSize={10}
                    lineHeight={14}
                    numberOfLines={3}
                  >
                    {msg.body || `[${msg.type || 'media'}]`}
                  </Text>
                </YStack>
              );
            })
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={c.text3} fontSize={10}>No messages found</Text>
            </XStack>
          )}
        </YStack>
        {count > 15 && (
          <XStack justifyContent="flex-end" marginTop={6}>
            <Text color={c.text3} fontSize={9} fontFamily="$mono">{count} messages total</Text>
          </XStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// get-contacts
// ============================================================================

function GetContactsRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useWhatsappColors();
  const data = parseOutput<{ contacts?: WaContact[] } | WaContact[]>(output);
  const contacts: WaContact[] = Array.isArray(data) ? data : (data as any)?.contacts ?? [];
  const count = contacts.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : { text: `${count} contact${count !== 1 ? 's' : ''}`, variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);
  const headerProps = { status, description: 'Get contacts', duration, badge };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
          {status === 'running' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={c.text3} fontSize={10}>Loading contacts…</Text>
            </XStack>
          ) : status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{displayError || 'Unknown error'}</Text>
            </XStack>
          ) : contacts.length > 0 ? (
            contacts.slice(0, 10).map((contact, idx) => {
              const name = contact.name || contact.pushname || contact.number || 'Unknown';
              const initials = getInitials(name);
              const avatarColor = avatarColorForId(contact.id || name);

              return (
                <XStack
                  key={contact.id || idx}
                  paddingVertical={6}
                  paddingHorizontal={10}
                  alignItems="center"
                  gap={8}
                  borderBottomWidth={idx < contacts.length - 1 ? 1 : 0}
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
                  <Text color={c.text} fontSize={10} fontWeight="500" flex={1} numberOfLines={1}>{name}</Text>
                  {contact.number && (
                    <Text color={c.text3} fontSize={9} fontFamily="$mono" flexShrink={0}>{contact.number}</Text>
                  )}
                </XStack>
              );
            })
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={c.text3} fontSize={10}>No contacts found</Text>
            </XStack>
          )}
        </YStack>
        {count > 10 && (
          <XStack justifyContent="flex-end" marginTop={6}>
            <Text color={c.text3} fontSize={9} fontFamily="$mono">{count} contacts total</Text>
          </XStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// session-status / start-session / stop-session
// ============================================================================

function SessionStatusRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useWhatsappColors();
  const data = parseOutput<{ status?: string; name?: string }>(output);
  const sessionStatus = data?.status;

  const statusBadgeVariant =
    sessionStatus === 'WORKING' ? 'green' :
    sessionStatus === 'SCAN_QR_CODE' ? 'blue' :
    status === 'failed' ? 'red' : 'gray';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : sessionStatus
        ? { text: sessionStatus, variant: statusBadgeVariant as BadgeProps['variant'] }
        : undefined;

  const headerProps = { status, description: 'Session status', duration, badge };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          {data?.name && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={48}>Session</Text>
              <Text color={c.text} fontSize={10} fontFamily="$mono">{data.name}</Text>
            </XStack>
          )}
          {sessionStatus && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={48}>Status</Text>
              <Text
                color={sessionStatus === 'WORKING' ? colors.success : sessionStatus === 'SCAN_QR_CODE' ? colors.running : c.text2}
                fontSize={10}
                fontWeight="500"
              >
                {sessionStatus}
              </Text>
            </XStack>
          )}
          {status === 'failed' && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={48}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output || 'Unknown error'}</Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

function StartSessionRenderer(props: SubRendererProps) {
  const c = useColors();
  const colors = useWhatsappColors();
  const badge =
    props.status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : props.status === 'completed'
        ? { text: 'started', variant: 'green' as const }
        : undefined;

  const headerProps = { ...props, description: 'Start session', badge };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          {props.input?.session && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={48}>Session</Text>
              <Text color={c.text} fontSize={10} fontFamily="$mono">{props.input.session}</Text>
            </XStack>
          )}
          {props.status === 'failed' && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={48}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{props.error || props.output || 'Unknown error'}</Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

// ============================================================================
// check-number
// ============================================================================

function CheckNumberRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useColors();
  const colors = useWhatsappColors();
  const data = parseOutput<{ exists?: boolean; id?: string }>(output);
  const phone: string = input?.phone || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : data?.exists === true
        ? { text: 'found', variant: 'green' as const }
        : data?.exists === false
          ? { text: 'not found', variant: 'gray' as const }
          : undefined;

  const headerProps = {
    status,
    description: `Check number ${phone}`,
    duration,
    badge,
  };
  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={48}>Phone</Text>
            <Text color={c.text} fontSize={10} fontFamily="$mono">{phone}</Text>
          </XStack>
          {data?.exists !== undefined && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={48}>WhatsApp</Text>
              <Text color={data.exists ? colors.success : c.text2} fontSize={10} fontWeight="500">
                {data.exists ? 'Yes' : 'No'}
              </Text>
            </XStack>
          )}
          {data?.id && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={48}>Chat ID</Text>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" flex={1} numberOfLines={1}>{data.id}</Text>
            </XStack>
          )}
          {status === 'failed' && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={48}>Error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{error || output || 'Unknown error'}</Text>
            </XStack>
          )}
        </YStack>
      </ToolShell>
  );
}

// ============================================================================
// Default renderer — generic key/value view
// ============================================================================

function DefaultWhatsappRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: SubRendererProps) {
  const c = useColors();
  const colors = useWhatsappColors();
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
    description: shortName,
    duration,
    badge,
  };
  return (
    <ToolShell {...headerProps}>
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

          {status === 'completed' && output && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={50}>result</Text>
              <Text color={c.text2} fontSize={9} flex={1} numberOfLines={2}>{truncate(output, 100)}</Text>
            </XStack>
          )}

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={50}>error</Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>{displayError}</Text>
            </XStack>
          )}

          {!input && !output && !displayError && (
            <Text color={c.text3} fontSize={10}>No details available</Text>
          )}
        </YStack>
      </ToolShell>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function WhatsappRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const subProps: SubRendererProps = { ...props };

  switch (shortName) {
    case 'send-text':
    case 'send-message':
      return <SendTextRenderer {...subProps} />;
    case 'get-chats':
    case 'search-chats':
      return <GetChatsRenderer {...subProps} />;
    case 'get-messages':
      return <GetMessagesRenderer {...subProps} />;
    case 'get-contacts':
      return <GetContactsRenderer {...subProps} />;
    case 'session-status':
      return <SessionStatusRenderer {...subProps} />;
    case 'start-session':
      return <StartSessionRenderer {...subProps} />;
    case 'stop-session':
      return <StartSessionRenderer {...subProps} />; // same layout, different label handled by default
    case 'check-number':
      return <CheckNumberRenderer {...subProps} />;
    default:
      return <DefaultWhatsappRenderer {...subProps} />;
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
      iconUri={WHATSAPP_ICON}
      badge={badge ? <Badge text={badge.text} variant={badge.variant} /> : null}
      irreversible={irreversible}
    >
      {children}
    </ToolCallCard>
  );
}

export const WhatsappToolCallRenderer = withPermissionSupport(WhatsappRendererBase);

// Default export for dynamic import
export default WhatsappToolCallRenderer;
