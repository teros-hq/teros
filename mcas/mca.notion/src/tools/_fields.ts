/**
 * Field whitelists for curated tool responses.
 *
 * The raw Notion API returns verbose objects with 20+ nested fields per entity.
 * These whitelists define what travels over the wire to the agent — anything
 * outside the list is dropped. Keep visual fields (icon, cover, url, avatarUrl)
 * always included: without them the renderer falls back to initials.
 *
 * COMPACT variants are for list endpoints (search, query, list-*).
 * DETAIL variants add heavier payloads (properties, schema) for single-resource endpoints.
 *
 * SDK v5 / API 2026-03-11: `archived` was renamed to `in_trash`. The
 * extractor still exposes both keys (`inTrash` is canonical, `archived` is
 * the legacy alias) so older agent prompts and renderers don't break.
 */

// ============================================================================
// PAGES
// ============================================================================

export const PAGE_COMPACT_FIELDS = [
  'id',
  'url',
  'title',
  'icon',
  'cover',
  'createdTime',
  'lastEditedTime',
  'parentType',
  'parentId',
  'databaseId',
  'inTrash',
  'archived',
] as const;

export const PAGE_DETAIL_FIELDS = [
  ...PAGE_COMPACT_FIELDS,
  'properties',
] as const;

// ============================================================================
// DATABASES
// ============================================================================

export const DATABASE_COMPACT_FIELDS = [
  'id',
  'url',
  'title',
  'description',
  'icon',
  'cover',
  'createdTime',
  'lastEditedTime',
  'parentType',
  'parentId',
  'inTrash',
  'archived',
  'isInline',
  'dataSources',
  'isMultiSource',
] as const;

export const DATABASE_DETAIL_FIELDS = [
  ...DATABASE_COMPACT_FIELDS,
  'schema',
] as const;

// ============================================================================
// BLOCKS
// ============================================================================

export const BLOCK_COMPACT_FIELDS = [
  'id',
  'type',
  'hasChildren',
  'createdTime',
  'lastEditedTime',
  'inTrash',
  'archived',
  'parentType',
  'parentId',
] as const;

export const BLOCK_DETAIL_FIELDS = [
  ...BLOCK_COMPACT_FIELDS,
  'content',
  'plainText',
  'language',
  'checked',
  'caption',
  'url',
  'summary',
  'hasTranscript',
] as const;

// ============================================================================
// USERS
// ============================================================================

export const USER_FIELDS = [
  'id',
  'name',
  'type',
  'avatarUrl',
  'email',
  'bot',
] as const;

// ============================================================================
// COMMENTS
// ============================================================================

export const COMMENT_FIELDS = [
  'id',
  'pageId',
  'parentBlockId',
  'discussionId',
  'authorId',
  'plainText',
  'createdTime',
  'lastEditedTime',
] as const;

// ============================================================================
// SEARCH RESULT (heterogeneous: page | database)
// ============================================================================

export const SEARCH_RESULT_FIELDS = [
  'id',
  'object',
  'url',
  'title',
  'icon',
  'cover',
  'createdTime',
  'lastEditedTime',
  'parentType',
  'parentId',
  'inTrash',
  'archived',
] as const;

// ============================================================================
// TYPES
// ============================================================================

export type FieldList = readonly string[];
