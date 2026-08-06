/**
 * Field whitelists for curated tool responses.
 *
 * The Linear SDK returns issues / projects / users with nested relays
 * (assignee, state, team, project, cycle, labels, comments) that — together
 * with markdown descriptions and rich-text bodies — blow up the agent's
 * context window. These whitelists define what travels over the wire.
 *
 * Visual fields (`color`, `icon`, `avatarUrl`) are always included so the
 * renderer can paint branded chips and avatars without a second request.
 *
 * COMPACT variants are for list endpoints (list-issues, list-projects, …).
 * DETAIL variants add heavier payloads (description, labels, team, project)
 * for single-resource endpoints (get-issue).
 */

// ============================================================================
// ISSUES
// ============================================================================

export const ISSUE_COMPACT_FIELDS = [
  'id',
  'identifier',
  'title',
  'url',
  'status',
  'priority',
  'assignee',
  'team',
  'createdAt',
  'updatedAt',
] as const;

export const ISSUE_DETAIL_FIELDS = [
  ...ISSUE_COMPACT_FIELDS,
  'description',
  'labels',
  'project',
  'cycle',
  'parentId',
  'dueDate',
  'estimate',
  'archivedAt',
] as const;

// ============================================================================
// PROJECTS
// ============================================================================

export const PROJECT_COMPACT_FIELDS = [
  'id',
  'name',
  'url',
  'state',
  'icon',
  'color',
  'progress',
  'startDate',
  'targetDate',
  'createdAt',
  'updatedAt',
] as const;

export const PROJECT_DETAIL_FIELDS = [
  ...PROJECT_COMPACT_FIELDS,
  'description',
  'lead',
  'teams',
] as const;

// ============================================================================
// USERS
// ============================================================================

export const USER_FIELDS = [
  'id',
  'name',
  'displayName',
  'email',
  'avatarUrl',
  'active',
  'admin',
] as const;

// ============================================================================
// TEAMS
// ============================================================================

export const TEAM_FIELDS = [
  'id',
  'name',
  'key',
  'icon',
  'color',
  'description',
  'private',
] as const;

// ============================================================================
// LABELS
// ============================================================================

export const LABEL_FIELDS = [
  'id',
  'name',
  'color',
  'description',
  'isGroup',
  'parentId',
] as const;

// ============================================================================
// WORKFLOW STATES
// ============================================================================

export const WORKFLOW_STATE_FIELDS = [
  'id',
  'name',
  'type',
  'color',
  'position',
  'description',
] as const;

// ============================================================================
// CYCLES
// ============================================================================

export const CYCLE_FIELDS = [
  'id',
  'name',
  'number',
  'startsAt',
  'endsAt',
  'progress',
  'description',
] as const;

// ============================================================================
// COMMENTS
// ============================================================================

export const COMMENT_FIELDS = [
  'id',
  'body',
  'authorId',
  'authorName',
  'issueId',
  'url',
  'createdAt',
  'updatedAt',
] as const;

// ============================================================================
// TYPES
// ============================================================================

export type FieldList = readonly string[];
