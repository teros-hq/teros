/**
 * Slack-specific shape extractors.
 *
 * The Slack Web API returns snake_case fields with significant noise (raw
 * Block Kit AST, internal team metadata, deprecated `bot_id` references,
 * `parent_user_id`, etc.). These helpers collapse each resource type into
 * a flat camelCase shape ready for the renderer to consume.
 *
 * Reactions ship as `[{ name, count, users[] }]` since a single message can
 * accumulate many; the curated form keeps users as ids — the renderer
 * resolves names from the parallel `list-users` cache when needed.
 */

// ============================================================================
// ID VALIDATION
// ============================================================================

/**
 * Slack channel ids start with C (public), G (private legacy), D (DM),
 * or M (multi-party DM). New private channels start with `C` too — Slack
 * unified the namespace circa 2018, but legacy `G` ids still resolve.
 */
const CHANNEL_RE = /^[CDGM][A-Z0-9]{8,12}$/;

/** Slack user ids start with U (regular) or W (enterprise grid). */
const USER_RE = /^[UW][A-Z0-9]{8,12}$/;

/** Slack file ids start with F. */
const FILE_RE = /^F[A-Z0-9]{8,12}$/;

/**
 * Slack timestamp format: `1234567890.123456` (seconds.microseconds). Used as
 * message id throughout the API.
 */
const TS_RE = /^\d{10}\.\d{6}$/;

export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_RE.test(value);
}

export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_RE.test(value);
}

export function isFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_RE.test(value);
}

export function isMessageTs(value: unknown): value is string {
  return typeof value === 'string' && TS_RE.test(value);
}

export function validateChannelId(id: string, label = 'channel'): string {
  if (!isChannelId(id)) {
    throw new Error(`Invalid ${label}: expected Slack channel id (C... / G... / D... / M...), got "${id}"`);
  }
  return id;
}

export function validateUserId(id: string, label = 'userId'): string {
  if (!isUserId(id)) {
    throw new Error(`Invalid ${label}: expected Slack user id (U... / W...), got "${id}"`);
  }
  return id;
}

export function validateMessageTs(ts: string, label = 'ts'): string {
  if (!isMessageTs(ts)) {
    throw new Error(`Invalid ${label}: expected Slack timestamp "1234567890.123456", got "${ts}"`);
  }
  return ts;
}

/**
 * Boundary normalisation for optional string params. JSON Schema cannot
 * distinguish absent and empty/whitespace-only string, so the LLM often
 * fills `""` for unused optionals. Treat those as undefined.
 */
export function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// ============================================================================
// TIMESTAMP HELPERS
// ============================================================================

/**
 * Convert a Slack `ts` (seconds.microseconds) or unix-seconds number into
 * an ISO 8601 string. Returns null for unparseable input.
 */
export function tsToIso(ts: unknown): string | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return new Date(ts * 1000).toISOString();
  }
  if (typeof ts === 'string' && ts.length > 0) {
    const seconds = Number.parseFloat(ts);
    if (!Number.isNaN(seconds)) {
      return new Date(seconds * 1000).toISOString();
    }
  }
  return null;
}

// ============================================================================
// CURATED SHAPES
// ============================================================================

export interface CuratedChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  isMember: boolean;
  numMembers: number | null;
  topic: string;
  purpose: string;
  created: string | null;
  creator: string | null;
  isGeneral?: boolean;
  isShared?: boolean;
  isOrgShared?: boolean;
  isExtShared?: boolean;
  unlinked?: number;
  nameNormalized?: string;
  previousNames?: string[];
}

export interface CuratedReaction {
  name: string;
  count: number;
  users: string[];
}

export interface CuratedMessage {
  ts: string;
  channel: string | null;
  user: string | null;
  userName: string | null;
  text: string;
  subtype: string | null;
  threadTs: string | null;
  replyCount: number;
  reactions: CuratedReaction[];
  permalink: string | null;
  createdAt: string | null;
  blocks?: unknown[];
  attachments?: unknown[];
  edited?: { user: string; ts: string } | null;
  replyUsers?: string[];
  parentUserId?: string | null;
  isStarred?: boolean;
  pinnedTo?: string[];
}

export interface CuratedUser {
  id: string;
  name: string;
  realName: string;
  displayName: string;
  email: string | null;
  imageUrl: string | null;
  isBot: boolean;
  isAdmin: boolean;
  isOwner: boolean;
  deleted: boolean;
  tz: string | null;
  title?: string | null;
  phone?: string | null;
  statusText?: string | null;
  statusEmoji?: string | null;
  tzOffset?: number | null;
  tzLabel?: string | null;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
  updated?: string | null;
}

export interface CuratedFile {
  id: string;
  name: string;
  title: string;
  mimetype: string;
  fileType: string;
  prettyType: string;
  size: number;
  user: string | null;
  userName: string | null;
  urlPrivate: string | null;
  permalink: string | null;
  thumbUrl: string | null;
  channels: string[];
  isPublic: boolean;
  createdAt: string | null;
}

export interface CuratedTeam {
  id: string;
  name: string;
  domain: string;
  emailDomain: string;
  iconUrl: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
}

export interface CuratedPresence {
  user: string;
  presence: 'active' | 'away' | string;
  online: boolean;
  autoAway: boolean;
  manualAway: boolean;
  connectionCount: number;
  lastActivity: string | null;
}

// ============================================================================
// EXTRACTORS
// ============================================================================

export function extractChannel(raw: any): CuratedChannel {
  const r = raw ?? {};
  return {
    id: r.id ?? '',
    name: r.name ?? '',
    isPrivate: !!r.is_private,
    isArchived: !!r.is_archived,
    isMember: !!r.is_member,
    numMembers: typeof r.num_members === 'number' ? r.num_members : null,
    topic: r.topic?.value ?? '',
    purpose: r.purpose?.value ?? '',
    created: tsToIso(r.created),
    creator: r.creator ?? null,
    isGeneral: r.is_general ?? undefined,
    isShared: r.is_shared ?? undefined,
    isOrgShared: r.is_org_shared ?? undefined,
    isExtShared: r.is_ext_shared ?? undefined,
    unlinked: r.unlinked ?? undefined,
    nameNormalized: r.name_normalized ?? undefined,
    previousNames: Array.isArray(r.previous_names) ? r.previous_names : undefined,
  };
}

function extractReaction(raw: any): CuratedReaction {
  const r = raw ?? {};
  return {
    name: r.name ?? '',
    count: typeof r.count === 'number' ? r.count : 0,
    users: Array.isArray(r.users) ? r.users : [],
  };
}

export function extractMessage(raw: any, ctx: { channel?: string; userName?: string | null; permalink?: string | null } = {}): CuratedMessage {
  const r = raw ?? {};
  const reactions = Array.isArray(r.reactions) ? r.reactions.map(extractReaction) : [];
  return {
    ts: r.ts ?? '',
    channel: ctx.channel ?? r.channel ?? null,
    user: r.user ?? r.bot_id ?? null,
    userName: ctx.userName ?? null,
    text: typeof r.text === 'string' ? r.text : '',
    subtype: r.subtype ?? null,
    threadTs: r.thread_ts ?? null,
    replyCount: typeof r.reply_count === 'number' ? r.reply_count : 0,
    reactions,
    permalink: ctx.permalink ?? r.permalink ?? null,
    createdAt: tsToIso(r.ts),
    blocks: Array.isArray(r.blocks) ? r.blocks : undefined,
    attachments: Array.isArray(r.attachments) ? r.attachments : undefined,
    edited: r.edited ? { user: r.edited.user ?? '', ts: r.edited.ts ?? '' } : null,
    replyUsers: Array.isArray(r.reply_users) ? r.reply_users : undefined,
    parentUserId: r.parent_user_id ?? null,
    isStarred: r.is_starred ?? undefined,
    pinnedTo: Array.isArray(r.pinned_to) ? r.pinned_to : undefined,
  };
}

export function extractUser(raw: any): CuratedUser {
  const r = raw ?? {};
  const profile = r.profile ?? {};
  return {
    id: r.id ?? '',
    name: r.name ?? '',
    realName: profile.real_name ?? r.real_name ?? '',
    displayName: profile.display_name ?? '',
    email: profile.email ?? null,
    imageUrl:
      profile.image_192 ?? profile.image_72 ?? profile.image_48 ?? profile.image_original ?? null,
    isBot: !!r.is_bot,
    isAdmin: !!r.is_admin,
    isOwner: !!r.is_owner,
    deleted: !!r.deleted,
    tz: r.tz ?? null,
    title: profile.title ?? null,
    phone: profile.phone ?? null,
    statusText: profile.status_text ?? null,
    statusEmoji: profile.status_emoji ?? null,
    tzOffset: typeof r.tz_offset === 'number' ? r.tz_offset : null,
    tzLabel: r.tz_label ?? null,
    isRestricted: r.is_restricted ?? undefined,
    isUltraRestricted: r.is_ultra_restricted ?? undefined,
    updated: tsToIso(r.updated),
  };
}

export function extractFile(raw: any, userName?: string | null): CuratedFile {
  const r = raw ?? {};
  return {
    id: r.id ?? '',
    name: r.name ?? '',
    title: r.title ?? '',
    mimetype: r.mimetype ?? '',
    fileType: r.filetype ?? '',
    prettyType: r.pretty_type ?? '',
    size: typeof r.size === 'number' ? r.size : 0,
    user: r.user ?? null,
    userName: userName ?? null,
    urlPrivate: r.url_private ?? null,
    permalink: r.permalink ?? null,
    thumbUrl: r.thumb_360 ?? r.thumb_240 ?? r.thumb_160 ?? r.thumb_80 ?? null,
    channels: Array.isArray(r.channels) ? r.channels : [],
    isPublic: !!r.is_public,
    createdAt: tsToIso(r.created),
  };
}

export function extractTeam(raw: any): CuratedTeam {
  const r = raw ?? {};
  const icon = r.icon ?? {};
  return {
    id: r.id ?? '',
    name: r.name ?? '',
    domain: r.domain ?? '',
    emailDomain: r.email_domain ?? '',
    iconUrl: icon.image_230 ?? icon.image_132 ?? icon.image_88 ?? icon.image_44 ?? null,
    enterpriseId: r.enterprise_id ?? null,
    enterpriseName: r.enterprise_name ?? null,
  };
}

export function extractPresence(userId: string, raw: any): CuratedPresence {
  const r = raw ?? {};
  return {
    user: userId,
    presence: r.presence ?? 'unknown',
    online: !!r.online,
    autoAway: !!r.auto_away,
    manualAway: !!r.manual_away,
    connectionCount: typeof r.connection_count === 'number' ? r.connection_count : 0,
    lastActivity: tsToIso(r.last_activity),
  };
}

// ============================================================================
// SEARCH HIT EXTRACTORS
// ============================================================================

export interface CuratedSearchMessageHit {
  ts: string;
  channel: string;
  channelName: string;
  user: string | null;
  userName: string | null;
  text: string;
  permalink: string;
  score: number | null;
}

export interface CuratedSearchFileHit {
  id: string;
  name: string;
  title: string;
  mimetype: string;
  permalink: string;
  thumbUrl: string | null;
  score: number | null;
  createdAt: string | null;
}

export function extractSearchMessageHit(raw: any): CuratedSearchMessageHit {
  const r = raw ?? {};
  return {
    ts: r.ts ?? '',
    channel: r.channel?.id ?? '',
    channelName: r.channel?.name ?? '',
    user: r.user ?? null,
    userName: r.username ?? null,
    text: typeof r.text === 'string' ? r.text : '',
    permalink: r.permalink ?? '',
    score: typeof r.score === 'number' ? r.score : null,
  };
}

export function extractSearchFileHit(raw: any): CuratedSearchFileHit {
  const r = raw ?? {};
  return {
    id: r.id ?? '',
    name: r.name ?? '',
    title: r.title ?? '',
    mimetype: r.mimetype ?? '',
    permalink: r.permalink ?? '',
    thumbUrl: r.thumb_360 ?? r.thumb_240 ?? null,
    score: typeof r.score === 'number' ? r.score : null,
    createdAt: tsToIso(r.created),
  };
}

export interface CuratedBookmark {
  id: string;
  channelId: string;
  title: string;
  link: string;
  emoji: string | null;
  type: string;
  dateCreated: string | null;
  dateUpdated: string | null;
  rank: string | null;
}

export function extractBookmark(raw: any): CuratedBookmark {
  return {
    id: raw?.id ?? '',
    channelId: raw?.channel_id ?? '',
    title: raw?.title ?? '',
    link: raw?.link ?? '',
    emoji: raw?.emoji ?? null,
    type: raw?.type ?? 'link',
    dateCreated: tsToIso(raw?.date_created),
    dateUpdated: tsToIso(raw?.date_updated),
    rank: raw?.rank ?? null,
  };
}
