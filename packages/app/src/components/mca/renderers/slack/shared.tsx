/**
 * Slack — constants, types, helpers, and a compose-only `SlackToolShell`.
 *
 * Zero components are defined here. The global primitives (`IconChip`,
 * `IconTile`, `Avatar`, `EntityRow`, `ResourceCard`, `ActionBadge`,
 * `KeyValueGrid`, `PillList`, …) cover every Slack-specific UI case through
 * props. What lives here:
 *
 *  - Constants: official Slack brand palette (Aubergine + 4 hash colors)
 *    and the logo url.
 *  - Theme-adaptive hooks: `useSlackColors()` / `useScrollStyle()` built on
 *    the Design System `useColors()` + `useMcaTheme()` primitives.
 *  - Types for the curated shapes returned by the Slack MCA tools.
 *  - Shape-agnostic getters tolerant to legacy raw-Slack shapes.
 *  - Prop factories for the global primitives (channelChipProps,
 *    presenceChipProps, fileTypeTileProps, …).
 *  - Tool labels + short-name extraction.
 *  - `SlackToolShell` — compose-only wrapper over `<ToolCallCard/>`.
 *
 * Brand palette validated against the Slack media kit
 * (https://a.slack-edge.com/0f43e/marketing/img/media-kit/Slack-Brand-Guidelines.pdf):
 * Aubergine `#4A154B` is the primary brand color; the 4 hash logo colors
 * are `#E01E5A` (red), `#36C5F0` (blue), `#2EB67D` (green), `#ECB22E`
 * (yellow). NOT Tailwind defaults — verified against the live UI.
 */

import { Bot, Lock, MessageSquare, Smile } from '@tamagui/lucide-icons';
import type React from 'react';
import { Text } from 'tamagui';
import { Badge, ToolCallCard, useColors, useMcaTheme } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

// ============================================================================
// Constants
// ============================================================================

/**
 * Logo path follows the canonical `/static/mcas/<id>/icon.png` pattern (see
 * `feedback_mca_icon_path_canonical`). The manifest declares `icon: "icon.png"`
 * — `getMcaStaticUrl` adds the directory prefix server-side. Older MCAs in
 * the codebase use legacy `/static/<name>-icon.png` paths; new ones use
 * `/static/mcas/<id>/icon.png`.
 */
export const SLACK_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/mcas/mca.slack/icon.png`;

/**
 * Slack official brand palette. Source: Slack media kit PDF.
 * IMPORTANT: do not substitute with Tailwind defaults — Slack's red is
 * `#E01E5A` (not `#EF4444`), blue is `#36C5F0` (not `#3B82F6`), etc.
 */
export const SLACK_BRAND = {
  /** Primary brand purple. Used for `StatusDot running`, identifier accents,
   *  and as the default fallback when a backend field doesn't supply a color. */
  aubergine: '#4A154B',
  red: '#E01E5A',
  blue: '#36C5F0',
  green: '#2EB67D',
  yellow: '#ECB22E',
  black: '#000000',
} as const;

/**
 * Slack renderer palette. Combines the official Slack brand colors (kept
 * hardcoded per brand guidelines) with the Design System theme-adaptive surface
 * tokens from `useColors()`. The web scrollbar color switches between dark and
 * light variants so it remains visible on both card backgrounds.
 */
export function useSlackColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    ...c,
    theme,
    isDark,
    brand: SLACK_BRAND,
    // Scrollbar thumb must invert between themes to stay visible against the card surface.
    scrollbarColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
  };
}

/**
 * Theme-aware scrollbar style hook. Returns a web-only CSS object suitable for
 * `ScrollView style` on web. Must be called inside a component because it reads
 * the active theme via `useSlackColors()`.
 */
export function useScrollStyle(maxHeight: number) {
  const { scrollbarColor } = useSlackColors();
  return {
    maxHeight,
    // biome-ignore lint/suspicious/noExplicitAny: CSS scrollbar props are web-only, not in RN ViewStyle
    scrollbarWidth: 'thin',
    // biome-ignore lint/suspicious/noExplicitAny: idem — web-only
    scrollbarColor: `${scrollbarColor} transparent`,
  } as any;
}

/**
 * @deprecated Use `useScrollStyle()` instead — this plain function always
 * uses the dark-mode scrollbar color and does not adapt to light theme.
 * Kept for any callers that haven't been migrated yet. Pass `scrollbarColor`
 * from `useSlackColors()` to make it theme-aware without converting to a hook.
 */
export function scrollStyle(maxHeight: number, scrollbarColor?: string) {
  return {
    maxHeight,
    // biome-ignore lint/suspicious/noExplicitAny: CSS scrollbar props are web-only, not in RN ViewStyle
    scrollbarWidth: 'thin',
    // biome-ignore lint/suspicious/noExplicitAny: idem — web-only
    scrollbarColor: `${scrollbarColor ?? 'rgba(255,255,255,0.2)'} transparent`,
  } as any;
}

// ============================================================================
// Types — curated shapes returned by the Slack MCA tools
// ============================================================================

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
  isArchived?: boolean;
  isMember?: boolean;
  numMembers?: number | null;
  topic?: string;
  purpose?: string;
  created?: string | null;
  creator?: string | null;
  isGeneral?: boolean;
  isShared?: boolean;
  isOrgShared?: boolean;
  isExtShared?: boolean;
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export interface SlackMessage {
  ts: string;
  channel?: string | null;
  user?: string | null;
  userName?: string | null;
  text?: string;
  subtype?: string | null;
  threadTs?: string | null;
  replyCount?: number;
  reactions?: SlackReaction[];
  permalink?: string | null;
  createdAt?: string | null;
}

export interface SlackUser {
  id: string;
  name: string;
  realName?: string;
  displayName?: string;
  email?: string | null;
  imageUrl?: string | null;
  isBot?: boolean;
  isAdmin?: boolean;
  isOwner?: boolean;
  deleted?: boolean;
  tz?: string | null;
  title?: string | null;
  statusText?: string | null;
  statusEmoji?: string | null;
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  fileType?: string;
  prettyType?: string;
  size?: number;
  user?: string | null;
  userName?: string | null;
  urlPrivate?: string | null;
  permalink?: string | null;
  thumbUrl?: string | null;
  channels?: string[];
  isPublic?: boolean;
  createdAt?: string | null;
}

export interface SlackTeam {
  id: string;
  name: string;
  domain?: string;
  emailDomain?: string;
  iconUrl?: string | null;
  enterpriseId?: string | null;
  enterpriseName?: string | null;
}

export interface SlackPresence {
  user: string;
  presence: string;
  online?: boolean;
  autoAway?: boolean;
  manualAway?: boolean;
  connectionCount?: number;
  lastActivity?: string | null;
}

export interface SlackSearchMessageHit {
  ts: string;
  channel: string;
  channelName: string;
  user?: string | null;
  userName?: string | null;
  text: string;
  permalink: string;
  score?: number | null;
}

export interface SlackSearchFileHit {
  id: string;
  name: string;
  title?: string;
  mimetype?: string;
  permalink: string;
  thumbUrl?: string | null;
  score?: number | null;
  createdAt?: string | null;
}

// ============================================================================
// Tool labels + short-name extraction
// ============================================================================

export const TOOL_LABELS: Record<string, string> = {
  '-health-check': 'Health check',
  // Channels
  'list-channels': 'Channels',
  'get-channel': 'Channel details',
  'create-channel': 'Create channel',
  'archive-channel': 'Archive channel',
  'join-channel': 'Join channel',
  'invite-to-channel': 'Invite to channel',
  // Messages
  'send-message': 'Send message',
  'send-thread-reply': 'Reply in thread',
  'list-messages': 'Messages',
  // Reactions
  'add-reaction': 'Add reaction',
  'remove-reaction': 'Remove reaction',
  // Users
  'list-users': 'Users',
  'get-user': 'User details',
  'get-user-presence': 'User presence',
  // Files
  'upload-file': 'Upload file',
  'list-files': 'Files',
  // Search
  'search-messages': 'Search messages',
  'search-files': 'Search files',
  // Team
  'get-team-info': 'Team info',
};

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function humanize(name: string): string {
  const cleaned = name.startsWith('slack-') ? name.slice('slack-'.length) : name;
  const joined = cleaned.replace(/-/g, ' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? humanize(short);
}

// ============================================================================
// Generic helpers
// ============================================================================

export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

export function formatRelativeTime(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0 || Number.isNaN(ms)) return iso;
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d ago`;
    return iso.slice(0, 10);
  } catch {
    return iso;
  }
}

export function formatBytes(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function shortId(id: string | undefined | null, head = 8, tail = 4): string {
  if (!id) return '—';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function unwrap<T extends object>(
  parsed: unknown,
  wrapperKey: string,
  identifierField: keyof T,
): T | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const wrapped = obj[wrapperKey];
  if (wrapped && typeof wrapped === 'object' && (identifierField as string) in wrapped) {
    return wrapped as T;
  }
  if ((identifierField as string) in obj) return obj as T;
  return null;
}

export function unwrapList<T>(
  parsed: unknown,
  wrapperKey: string,
): { items: T[]; nextCursor?: string | null; total?: number; hasMore?: boolean } {
  if (!parsed) return { items: [] };
  if (Array.isArray(parsed)) return { items: parsed as T[] };
  if (typeof parsed !== 'object') return { items: [] };
  const obj = parsed as Record<string, unknown>;
  const list = obj[wrapperKey];
  const items = Array.isArray(list) ? (list as T[]) : [];
  const nextCursor = typeof obj.nextCursor === 'string' ? (obj.nextCursor as string) : null;
  const total = typeof obj.total === 'number' ? (obj.total as number) : undefined;
  const hasMore = typeof obj.hasMore === 'boolean' ? (obj.hasMore as boolean) : undefined;
  return { items, nextCursor, total, hasMore };
}

// ============================================================================
// Channel name helper (#-prefix, accent by privacy)
// ============================================================================

export function channelDisplayName(channel: SlackChannel): string {
  if (!channel.name) return shortId(channel.id);
  return channel.isPrivate ? channel.name : `#${channel.name}`;
}

export function channelLeadingProps(channel: SlackChannel): {
  accent: string;
  icon: React.ReactNode;
} {
  if (channel.isPrivate) {
    return { accent: SLACK_BRAND.aubergine, icon: <Lock size={12} color={SLACK_BRAND.aubergine} /> };
  }
  return {
    accent: SLACK_BRAND.green,
    icon: <MessageSquare size={12} color={SLACK_BRAND.green} />,
  };
}

// ============================================================================
// Presence helpers
// ============================================================================

export function presenceChipProps(
  presence: string | undefined | null,
  neutralColor?: string,
): { accent: string; text: string } | null {
  if (!presence) return null;
  if (presence === 'active') return { accent: SLACK_BRAND.green, text: 'Active' };
  const neutral = neutralColor ?? '#95A2B3';
  if (presence === 'away') return { accent: neutral, text: 'Away' };
  return { accent: neutral, text: presence };
}

// ============================================================================
// User helpers
// ============================================================================

export function userDisplayName(user: SlackUser): string {
  return user.displayName || user.realName || user.name || shortId(user.id);
}

export function userBotChipProps(user: SlackUser): { accent: string; icon: React.ReactNode; text: string } | null {
  if (!user.isBot) return null;
  return {
    accent: SLACK_BRAND.blue,
    icon: <Bot size={9} color={SLACK_BRAND.blue} />,
    text: 'BOT',
  };
}

// ============================================================================
// File type accents (mimetype-driven)
// ============================================================================

export function fileTypeAccent(mimetype?: string, fileType?: string, neutralColor?: string): string {
  const mt = (mimetype ?? '').toLowerCase();
  const ft = (fileType ?? '').toLowerCase();
  const neutral = neutralColor ?? '#95A2B3';
  if (mt.startsWith('image/') || ft === 'png' || ft === 'jpg' || ft === 'gif')
    return SLACK_BRAND.yellow;
  if (mt.startsWith('video/') || ft === 'mp4') return SLACK_BRAND.red;
  if (mt.startsWith('audio/')) return SLACK_BRAND.blue;
  if (mt === 'application/pdf' || ft === 'pdf') return SLACK_BRAND.red;
  if (mt.includes('zip') || ft === 'zip') return neutral;
  if (mt.includes('json') || mt.includes('javascript') || mt.includes('typescript'))
    return SLACK_BRAND.green;
  return SLACK_BRAND.aubergine;
}

// ============================================================================
// Reaction helpers
// ============================================================================

export function reactionChipProps(
  reaction: SlackReaction,
): { accent: string; icon: React.ReactNode; text: string } {
  return {
    accent: SLACK_BRAND.yellow,
    icon: <Smile size={9} color={SLACK_BRAND.yellow} />,
    text: `:${reaction.name}: ${reaction.count}`,
  };
}

// ============================================================================
// Identifier helpers (timestamps, IDs)
// ============================================================================

export function tsText(ts: string | null | undefined): React.ReactNode {
  if (!ts) return null;
  return (
    <Text color={SLACK_BRAND.aubergine} fontSize={9} fontFamily="$mono" fontWeight="600">
      {ts}
    </Text>
  );
}

// ============================================================================
// Status helpers
// ============================================================================

export function toolStatusForPrimitive(
  status: ToolCallRendererProps['status'],
): Exclude<ToolCallRendererProps['status'], 'pending'> {
  if (status === 'pending') return 'running';
  return status;
}

export function statusBadge(status: ToolCallRendererProps['status']): React.ReactNode {
  if (status === 'completed') return <Badge text="done" variant="success" />;
  if (status === 'failed') return <Badge text="failed" variant="error" />;
  if (status === 'pending_permission') return <Badge text="awaiting" variant="warning" />;
  if (status === 'running' || status === 'pending')
    return <Badge text="running" variant="info" />;
  return null;
}

// ============================================================================
// SlackToolShell — compose-only wrapper (no duplication)
// ============================================================================

interface SlackToolShellProps {
  toolName: string;
  status: ToolCallRendererProps['status'];
  duration?: number;
  description?: string;
  children?: React.ReactNode;
  defaultExpanded?: boolean;
  badge?: React.ReactNode;
}

export function SlackToolShell({
  toolName,
  status,
  duration,
  description,
  children,
  defaultExpanded,
  badge,
}: SlackToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description ?? getToolLabel(toolName)}
      duration={duration}
      iconUri={SLACK_ICON}
      badge={badge ?? statusBadge(status)}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  );
}

// ============================================================================
// Error presentation — translate raw `[CODE] slack_code` into user-friendly text
// ============================================================================
//
// Backend emits errors as `[BUSINESS_RULE] not_authorized` — the bracket
// prefix is for the LLM and the snake_case suffix is the Slack code. Neither
// is something a human user should see verbatim. `slackErrorPresentation()`
// produces:
//
//   - title:   one-word label for the error category (Permission denied,
//              Rate limit, Not found, Plan required…). Replaces the
//              generic "Error" header.
//   - message: a complete sentence in plain English describing what
//              happened, derived from the Slack code when known.
//   - hint:    a sentence suggesting what the user can try, when actionable.
//              Omitted for errors with no clean user remedy.
//   - details: the raw upstream string ("[BUSINESS_RULE] not_authorized")
//              for debugging — rendered subdued in the ErrorBlock.

export interface SlackErrorPresentation {
  title: string;
  message: string;
  hint?: string;
  details?: string;
}

interface SlackParts {
  bracketCode: string | null;
  slackCode: string | null;
  raw: string;
}

function parseSlackError(error: string): SlackParts {
  const bracket = error.match(/\[([A-Z_]+)\]/);
  const slack = error.match(/\]\s*([a-z0-9_]+)/i) ?? error.match(/^([a-z][a-z0-9_]+)$/i);
  return {
    bracketCode: bracket ? bracket[1] : null,
    slackCode: slack ? slack[1] : null,
    raw: error,
  };
}

// Human-readable text per Slack code. Only the cases we actually observed in
// QA + the most common ones from docs. The classifier-level fallback handles
// the rest with a generic-but-not-bad sentence.
const SLACK_CODE_TEXT: Record<string, { title?: string; message: string; hint?: string }> = {
  not_authorized: {
    title: 'Permission denied',
    message: "You don't have permission to perform this action on this resource.",
    hint: 'The bot may need to be invited to the channel, or this action may require an admin.',
  },
  not_allowed: {
    title: 'Action not allowed',
    message: 'Slack does not allow this action in the current workspace context.',
    hint: 'This often hits Slack Free-plan restrictions — try on a paid workspace.',
  },
  already_in_channel: {
    title: 'Already a member',
    message: 'The user is already in this channel — nothing to do.',
  },
  already_reacted: {
    title: 'Already reacted',
    message: 'That reaction already exists on the message.',
  },
  not_in_channel: {
    title: 'Bot not in channel',
    message: 'The bot is not a member of this channel.',
    hint: 'Invite the bot to the channel first.',
  },
  cant_invite_self: {
    title: 'Cannot invite self',
    message: "You can't invite yourself to a channel.",
  },
  cant_archive_general: {
    title: 'Cannot archive #general',
    message: 'The #general channel cannot be archived.',
  },
  last_member: {
    title: 'Last member',
    message: "You're the last member — you can't leave the channel.",
  },
  name_taken: {
    title: 'Name taken',
    message: 'A channel with this name already exists.',
    hint: 'Choose a different name.',
  },
  channel_not_found: {
    title: 'Channel not found',
    message: 'Slack could not find a channel with that id.',
    hint: 'Verify the id (starts with C/G/D) and that the bot can see it.',
  },
  user_not_found: {
    title: 'User not found',
    message: 'Slack could not find a user with that id.',
  },
  message_not_found: {
    title: 'Message not found',
    message: 'Slack could not find a message at that timestamp in this channel.',
  },
  file_not_found: {
    title: 'File not found',
    message: 'Slack could not find a file with that id.',
  },
  is_archived: {
    title: 'Channel archived',
    message: 'This channel is archived.',
    hint: 'Unarchive it before posting or modifying.',
  },
  missing_scope: {
    title: 'Scope missing',
    message: 'The connected Slack workspace is missing a scope this tool needs.',
    hint: 'Reconnect Slack from app settings — the new scope will be requested.',
  },
  not_allowed_token_type: {
    title: 'Wrong token type',
    message: 'This operation requires a different Slack token type (bot vs user) than the one granted.',
  },
  feature_not_enabled: {
    title: 'Feature disabled',
    message: 'This Slack feature is not enabled on the workspace plan.',
    hint: 'Upgrade the workspace plan or enable the feature in workspace settings.',
  },
  lists_disabled: {
    title: 'Lists not enabled',
    message: 'Slack Lists is not enabled on this workspace plan.',
  },
  canvases_disabled: {
    title: 'Canvas not enabled',
    message: 'Slack Canvas is not enabled on this workspace plan.',
  },
  lists_disabled_or_empty_response: {
    title: 'Lists not enabled',
    message: 'Slack Lists returned an empty response — Lists is gated by workspace plan.',
    hint: 'Upgrade the workspace plan or enable Lists in workspace settings.',
  },
  canvas_disabled_or_empty_response: {
    title: 'Canvas not enabled',
    message: 'Slack Canvas returned an empty response — Canvas is gated by workspace plan.',
  },
  channel_canvas_disabled_or_empty_response: {
    title: 'Channel canvas unavailable',
    message: 'Slack Channel Canvas returned an empty response — Canvas may be gated by plan, or this channel type rejects canvases.',
  },
  ratelimited: {
    title: 'Rate-limited',
    message: 'Slack temporarily rate-limited the request.',
    hint: 'The MCA already retries with backoff — try again in a moment.',
  },
  rate_limited: {
    title: 'Rate-limited',
    message: 'Slack temporarily rate-limited the request.',
    hint: 'The MCA already retries with backoff — try again in a moment.',
  },
  invalid_auth: {
    title: 'Authentication failed',
    message: 'Slack rejected the credentials.',
    hint: 'Reconnect Slack from app settings.',
  },
  token_expired: {
    title: 'Token expired',
    message: 'The Slack token has expired.',
    hint: 'Reconnect Slack from app settings.',
  },
  account_inactive: {
    title: 'Account inactive',
    message: 'The Slack account or workspace is inactive.',
  },
  invalid_arguments: {
    title: 'Invalid arguments',
    message: 'Slack rejected the arguments. The endpoint may also be gated by plan and surfacing this generic code.',
  },
};

// Bracket-code → category title fallback when the slack code is unknown.
const BRACKET_FALLBACK: Record<string, { title: string; message: string; hint?: string }> = {
  AUTH_REQUIRED: { title: 'Authentication required', message: 'No Slack credentials are connected for this workspace.', hint: 'Connect Slack from app settings.' },
  AUTH_INVALID: { title: 'Authentication failed', message: 'Slack rejected the credentials.', hint: 'Reconnect Slack from app settings.' },
  AUTH_EXPIRED: { title: 'Token expired', message: 'The Slack token has expired.', hint: 'Reconnect Slack from app settings.' },
  SCOPE_MISSING: { title: 'Scope missing', message: 'The connected Slack workspace is missing a scope this tool needs.', hint: 'Reconnect Slack from app settings.' },
  FEATURE_GATED: { title: 'Plan required', message: 'This Slack feature is gated by the workspace plan or admin policy.', hint: 'Upgrade the plan or have an admin enable the feature — reconnecting will not help.' },
  NOT_FOUND: { title: 'Not found', message: 'Slack could not find the requested resource.' },
  CHANNEL_ARCHIVED: { title: 'Channel archived', message: 'This channel is archived.', hint: 'Unarchive it before posting or modifying.' },
  NOT_IN_CHANNEL: { title: 'Bot not in channel', message: 'The bot is not a member of this channel.', hint: 'Invite the bot first.' },
  NAME_CONFLICT: { title: 'Name taken', message: 'A channel with this name already exists.', hint: 'Choose a different name.' },
  INVALID_NAME: { title: 'Invalid name', message: 'Channel names must be lowercase, ≤80 chars, no spaces or special chars besides - and _.' },
  INVALID_ARGUMENT: { title: 'Invalid arguments', message: 'Slack rejected the request arguments.' },
  BUSINESS_RULE: { title: 'Action rejected', message: 'Slack rejected the operation for a per-resource rule.' },
  RATE_LIMITED: { title: 'Rate-limited', message: 'Slack temporarily rate-limited the request.', hint: 'The MCA retries automatically — try again in a moment.' },
  DEPENDENCY_UNAVAILABLE: { title: 'Slack unavailable', message: 'Slack API is temporarily unavailable.', hint: 'Retry in a moment.' },
  TIMEOUT: { title: 'Network timeout', message: 'The request timed out reaching Slack.', hint: 'Check connectivity and retry.' },
  UNKNOWN: { title: 'Unknown error', message: 'Slack returned an error that could not be classified.' },
};

export function slackErrorPresentation(
  error: string | undefined | null,
  toolName?: string,
): SlackErrorPresentation | null {
  if (!error) return null;
  const parts = parseSlackError(error);
  const specific = parts.slackCode ? SLACK_CODE_TEXT[parts.slackCode] : undefined;
  const bracket = parts.bracketCode ? BRACKET_FALLBACK[parts.bracketCode] : undefined;

  const title = specific?.title ?? bracket?.title ?? 'Error';
  const message =
    specific?.message ??
    bracket?.message ??
    (toolName ? `The ${toolName} tool failed.` : 'The Slack tool failed.');
  const hint = specific?.hint ?? bracket?.hint;

  // Keep the raw upstream string as collapsable detail for power users /
  // debugging. Stripped of the leading [CODE] which lives in the title.
  const rawDetail = error.replace(/^\[[A-Z_]+\]\s*/, '').trim();
  const details = rawDetail && rawDetail !== parts.slackCode ? rawDetail : undefined;

  return { title, message, hint, details };
}

/** @deprecated use `slackErrorPresentation` — kept for any straggler callers. */
export function slackErrorHint(error: string | undefined | null, toolName?: string): string | null {
  return slackErrorPresentation(error, toolName)?.hint ?? null;
}
