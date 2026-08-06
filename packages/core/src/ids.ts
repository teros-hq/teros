/**
 * ID Generation utilities
 *
 * Provides consistent ID generation across the platform.
 * All IDs follow the format: <prefix>_<hex16>
 *
 * The hex portion is 16 characters (8 bytes = 64 bits of entropy)
 * which provides ~18 quintillion unique values per prefix.
 */

import { randomBytes } from 'crypto';

/**
 * Generate a random hex string of specified byte length
 * 8 bytes = 16 hex chars = 64 bits of entropy
 */
function randomHex(bytes: number = 8): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Generate a user ID
 * Format: user_<hex16>
 */
export function generateUserId(): string {
  return `user_${randomHex()}`;
}

/**
 * Generate a channel ID
 * Format: ch_<hex16>
 */
export function generateChannelId(): string {
  return `ch_${randomHex()}`;
}

/**
 * Generate a message ID
 * Format: msg_<hex16>
 */
export function generateMessageId(): string {
  return `msg_${randomHex()}`;
}

/**
 * Generate a session ID
 * Format: session_<hex16>
 */
export function generateSessionId(): string {
  return `session_${randomHex()}`;
}

/**
 * Generate an app ID (for MCA instances)
 * Format: app_<hex16>
 */
export function generateAppId(): string {
  return `app_${randomHex()}`;
}

/**
 * Generate an agent ID
 * Format: agent_<hex16>
 */
export function generateAgentId(): string {
  return `agent_${randomHex()}`;
}

/**
 * Generate an event ID
 * Format: evt_<hex16>
 */
export function generateEventId(): string {
  return `evt_${randomHex()}`;
}

/**
 * Generate a workspace ID
 * Format: work_<hex16>
 */
export function generateWorkspaceId(): string {
  return `work_${randomHex()}`;
}

/**
 * Generate a user volume ID
 * Format: vol_user_<hex16>
 */
export function generateUserVolumeId(): string {
  return `vol_user_${randomHex()}`;
}

/**
 * Generate a workspace volume ID
 * Format: vol_work_<hex16>
 */
export function generateWorkspaceVolumeId(): string {
  return `vol_work_${randomHex()}`;
}

/**
 * Generate a project ID
 * Format: proj_<hex16>
 */
export function generateProjectId(): string {
  return `proj_${randomHex()}`;
}

/**
 * Generate a board ID
 * Format: board_<hex16>
 */
export function generateBoardId(): string {
  return `board_${randomHex()}`;
}

/**
 * Generate a task ID
 * Format: task_<hex16>
 */
export function generateTaskId(): string {
  return `task_${randomHex()}`;
}

/**
 * Generate a column ID
 * Format: col_<hex16>
 */
export function generateColumnId(): string {
  return `col_${randomHex()}`;
}

/**
 * Generate a skill ID
 * Format: sk_<hex16>
 */
export function generateSkillId(): string {
  return `sk_${randomHex()}`;
}

/**
 * Generate an agent usage session ID
 * Format: usess_<hex16>
 *
 * Identifies one "session of use" = one full turn of the ConversationManager
 * (one prompt() call). Persisted in `agent_usage_sessions`.
 */
export function generateSessionUsageId(): string {
  return `usess_${randomHex()}`;
}

/**
 * Generate a tool execution ID
 * Format: tex_<hex16>
 *
 * Identifies one tool invocation by the agent within a session. Persisted in
 * `tool_executions`.
 */
export function generateToolExecutionId(): string {
  return `tex_${randomHex()}`;
}

/**
 * Generate a usage event ID
 * Format: usev_<hex16>
 *
 * Idempotency key for the usage instrumentation event sourcing layer.
 * Persisted in `agent_usage_events` and `agent_usage_event_applications`.
 */
export function generateUsageEventId(): string {
  return `usev_${randomHex()}`;
}

/**
 * Generate a usage rollup ID
 * Format: usro_<hex16>
 *
 * Identifies a row in the hourly rollup projections
 * (`agent_usage_rollups_hourly`, `agent_usage_rollups_user_hourly`).
 */
export function generateUsageRollupId(): string {
  return `usro_${randomHex()}`;
}

/**
 * Generate a generic ID with custom prefix
 * Format: <prefix>_<hex16>
 */
export function generateId(prefix: string): string {
  return `${prefix}_${randomHex()}`;
}

/**
 * ID prefixes used in the system
 */
export const ID_PREFIXES = {
  USER: 'user',
  CHANNEL: 'ch',
  MESSAGE: 'msg',
  SESSION: 'session',
  APP: 'app',
  EVENT: 'evt',
  AGENT: 'agent',
  CORE: 'core',
  WORKSPACE: 'work',
  VOLUME_USER: 'vol_user',
  VOLUME_WORK: 'vol_work',
  PROJECT: 'proj',
  BOARD: 'board',
  TASK: 'task',
  COLUMN: 'col',
  SKILL: 'sk',
  // Usage instrumentation
  SESSION_USAGE: 'usess',
  TOOL_EXECUTION: 'tex',
  USAGE_EVENT: 'usev',
  USAGE_ROLLUP: 'usro',
} as const;

/**
 * Validate that an ID has the expected prefix
 */
export function validateIdPrefix(id: string, prefix: string): boolean {
  return id.startsWith(`${prefix}_`);
}

/**
 * Extract the prefix from an ID
 */
export function getIdPrefix(id: string): string | null {
  const match = id.match(/^([a-z]+)_/);
  return match ? match[1] : null;
}
