/**
 * Field whitelists for curated tool responses.
 *
 * Slack Web API responses are noisy: a single message includes `bot_id`,
 * `team`, `attachments`, `blocks` (raw Block Kit AST), `client_msg_id`,
 * `parent_user_id`, `reply_count`, `reply_users_count`, etc. Without curating
 * the LLM context grows fast on a 50-item list. The whitelists below define
 * the camelCase shape the renderer + LLM consume; callers can override per
 * invocation via `fields`, or pass `includeRaw: true` to skip filtering.
 *
 * Visual fields (`color`, `icon`, `iconUrl`, `imageOriginal`) are kept so the
 * renderer can paint avatars/team logos without a second request.
 */

// ============================================================================
// CHANNELS
// ============================================================================

export const CHANNEL_COMPACT_FIELDS = [
  'id',
  'name',
  'isPrivate',
  'isArchived',
  'isMember',
  'numMembers',
  'topic',
  'purpose',
  'created',
] as const;

export const CHANNEL_DETAIL_FIELDS = [
  ...CHANNEL_COMPACT_FIELDS,
  'creator',
  'isGeneral',
  'isShared',
  'isOrgShared',
  'isExtShared',
  'unlinked',
  'nameNormalized',
  'previousNames',
] as const;

// ============================================================================
// MESSAGES
// ============================================================================

export const MESSAGE_COMPACT_FIELDS = [
  'ts',
  'channel',
  'user',
  'userName',
  'text',
  'subtype',
  'threadTs',
  'replyCount',
  'reactions',
  'permalink',
  'createdAt',
] as const;

export const MESSAGE_DETAIL_FIELDS = [
  ...MESSAGE_COMPACT_FIELDS,
  'blocks',
  'attachments',
  'edited',
  'replyUsers',
  'parentUserId',
  'isStarred',
  'pinnedTo',
] as const;

// ============================================================================
// USERS
// ============================================================================

export const USER_COMPACT_FIELDS = [
  'id',
  'name',
  'realName',
  'displayName',
  'email',
  'imageUrl',
  'isBot',
  'isAdmin',
  'isOwner',
  'deleted',
  'tz',
] as const;

export const USER_DETAIL_FIELDS = [
  ...USER_COMPACT_FIELDS,
  'title',
  'phone',
  'statusText',
  'statusEmoji',
  'tzOffset',
  'tzLabel',
  'isRestricted',
  'isUltraRestricted',
  'updated',
] as const;

// ============================================================================
// FILES
// ============================================================================

export const FILE_FIELDS = [
  'id',
  'name',
  'title',
  'mimetype',
  'fileType',
  'prettyType',
  'size',
  'user',
  'userName',
  'urlPrivate',
  'permalink',
  'thumbUrl',
  'channels',
  'isPublic',
  'createdAt',
] as const;

// ============================================================================
// REACTIONS
// ============================================================================

export const REACTION_FIELDS = [
  'name',
  'count',
  'users',
] as const;

// ============================================================================
// TEAM
// ============================================================================

export const TEAM_FIELDS = [
  'id',
  'name',
  'domain',
  'emailDomain',
  'iconUrl',
  'enterpriseId',
  'enterpriseName',
] as const;

// ============================================================================
// SEARCH HITS
// ============================================================================

export const SEARCH_MESSAGE_HIT_FIELDS = [
  'ts',
  'channel',
  'channelName',
  'user',
  'userName',
  'text',
  'permalink',
  'score',
] as const;

export const SEARCH_FILE_HIT_FIELDS = [
  'id',
  'name',
  'title',
  'mimetype',
  'permalink',
  'thumbUrl',
  'score',
  'createdAt',
] as const;

// ============================================================================
// TYPES
// ============================================================================

export type FieldList = readonly string[];
