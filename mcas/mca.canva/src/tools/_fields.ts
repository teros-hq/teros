/**
 * Field whitelists for curated Canva tool responses.
 *
 * Visual fields (`thumbnailUrl`, `thumbnailWidth`, `thumbnailHeight`,
 * `viewUrl`, `editUrl`) are always included so the renderer can paint
 * polaroid previews without a second request.
 *
 * COMPACT variants are for list endpoints; DETAIL variants add heavier
 * payloads for single-resource endpoints.
 */

// ============================================================================
// DESIGNS
// ============================================================================

export const DESIGN_COMPACT_FIELDS = [
  'id',
  'title',
  'thumbnailUrl',
  'thumbnailWidth',
  'thumbnailHeight',
  'pageCount',
  'updatedAt',
] as const;

export const DESIGN_DETAIL_FIELDS = [
  ...DESIGN_COMPACT_FIELDS,
  'ownerUserId',
  'ownerTeamId',
  'editUrl',
  'viewUrl',
  'createdAt',
] as const;

// ============================================================================
// FOLDERS
// ============================================================================

export const FOLDER_FIELDS = [
  'id',
  'name',
  'thumbnailUrl',
  'createdAt',
  'updatedAt',
] as const;

export const FOLDER_ITEM_FIELDS = [
  'type',
  'id',
  'name',
  'thumbnailUrl',
  'pinStatus',
] as const;

// ============================================================================
// ASSETS
// ============================================================================

export const ASSET_COMPACT_FIELDS = [
  'id',
  'name',
  'type',
  'thumbnailUrl',
  'updatedAt',
] as const;

export const ASSET_DETAIL_FIELDS = [
  ...ASSET_COMPACT_FIELDS,
  'tags',
  'thumbnailWidth',
  'thumbnailHeight',
  'metadata',
  'createdAt',
] as const;

// ============================================================================
// BRAND TEMPLATES
// ============================================================================

export const BRAND_TEMPLATE_COMPACT_FIELDS = [
  'id',
  'title',
  'thumbnailUrl',
  'updatedAt',
] as const;

export const BRAND_TEMPLATE_DETAIL_FIELDS = [
  ...BRAND_TEMPLATE_COMPACT_FIELDS,
  'viewUrl',
  'createUrl',
  'createdAt',
] as const;

// ============================================================================
// JOBS — uniform across export, import, autofill, resize, asset upload
// ============================================================================

export const JOB_FIELDS = ['id', 'status', 'error', 'result'] as const;

// ============================================================================
// COMMENTS
// ============================================================================

export const THREAD_FIELDS = [
  'id',
  'designId',
  'authorUserId',
  'messagePlaintext',
  'resolved',
  'createdAt',
  'updatedAt',
] as const;

export const REPLY_FIELDS = [
  'id',
  'threadId',
  'authorUserId',
  'messagePlaintext',
  'createdAt',
  'updatedAt',
] as const;

// ============================================================================
// USERS
// ============================================================================

export const USER_FIELDS = ['userId', 'teamId'] as const;
export const USER_PROFILE_FIELDS = ['displayName'] as const;
export const USER_CAPABILITIES_FIELDS = ['capabilities'] as const;

// ============================================================================
// DESIGN PAGES + EXPORT FORMATS
// ============================================================================

export const DESIGN_PAGES_FIELDS = ['pages'] as const;
export const EXPORT_FORMATS_FIELDS = ['formats'] as const;

// ============================================================================
// TYPES
// ============================================================================

export type FieldList = readonly string[];
