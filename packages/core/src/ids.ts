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
