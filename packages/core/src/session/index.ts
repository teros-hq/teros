/**
 * Session Management - Cloned from the previous implementation
 *
 * This module provides the previous implementation-compatible session management:
 * - Session, Message, Part types (exact clones)
 * - SessionStore (replicates Storage operations)
 * - SessionLockManager (replicates SessionLock)
 *
 * All structures and behaviors are cloned from the previous implementation for consistency.
 */

// Locks
export {
  type LockHandle,
  SessionLockedError,
  SessionLockManager,
} from './SessionLockManager';
// Storage
export { SessionStore } from './SessionStore';
// Types (the previous implementation-compatible)
export type {
  AgentPart,
  AssistantMessage,
  FilePart,
  FilePartSource,
  FileSource,
  Message,
  MessageError,
  MessageWithParts,
  Part,
  PatchPart,
  PathInfo,
  ReasoningPart,
  Session,
  SnapshotPart,
  StepFinishPart,
  StepStartPart,
  SymbolSource,
  TextPart,
  TokenUsage,
  ToolPart,
  ToolState,
  ToolStateCompleted,
  ToolStateError,
  ToolStatePending,
  ToolStatePendingApproval,
  ToolStateRunning,
  UserMessage,
} from './types';
export {
  generateAscendingID,
  generateDescendingID,
} from './types';
