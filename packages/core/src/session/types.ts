/**
 * Session Types - Cloned from the previous implementation
 *
 * This file replicates the previous implementation's session structure exactly.
 *
 *
 * Differences from the previous implementation:
 * - Added userId, chatId, threadId for multi-user Telegram support
 * - Using TypeScript types instead of Zod schemas (simpler)
 * - Removed projectID, directory, version (not needed for Iria)
 */

// ============================================================================
// SESSION
// ============================================================================

/**
 * Transport type identifier
 * Identifies the channel/protocol used to connect to this session
 */
export type TransportType = 'telegram' | 'rest-api' | 'websocket' | 'voice' | 'event' | 'channel';

/**
 * Transport connection data - flexible format per transport type
 *
 * Examples:
 * - Channel: { channelId: "ch-123", threadId?: 456, userId: 'user' }
 * - Telegram: { chatId: 123456789, threadId?: 456, username?: 'user' }
 * - REST API: { sessionToken: "abc123", userId: "user-id", ip?: "1.2.3.4" }
 * - WebSocket: { socketId: "socket-abc", connectionId: "conn-123" }
 * - Event: { eventId: "event-123", source: "webhook" }
 * - Voice: { callId: "call-123", phoneNumber: "+1234567890" }
 */
export type TransportConnectionData = Record<string, any>;

export interface Session {
  id: string; // session_xxx

  // Multi-user support (EXTRA for Iria)
  userId: string;
  chatId?: string; // For backwards compatibility with SQLite schema
  channelId: string;
  threadId?: number;

  // the previous implementation fields
  title: string;
  time: {
    created: number;
    updated: number;
    compacting?: number; // For message compaction
  };

  // Optional fields
  parentID?: string; // For child sessions (subagents)
  share?: {
    url: string;
  };
  revert?: {
    // For undo/revert functionality
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };

  // Generic metadata
  metadata?: Record<string, any>;

  // Transport information for reconnection
  // Allows the system to identify how to reconnect to this session
  transportType: TransportType;
  transportData: TransportConnectionData;

  // Dreaming status
  dreamed?: boolean; // Has this session been analyzed by the dreaming system?

  // Compaction data (auto-compact)
  compaction?: {
    /** Summary of compacted conversation history */
    summary: string;
    /** IDs of messages that have been compacted into the summary */
    compactedMessageIds: string[];
    /** When the last compaction occurred */
    lastCompactedAt: number;
    /** History of compaction operations for debugging */
    history?: Array<{
      timestamp: number;
      messagesCompacted: number;
      tokensBefore: number;
      tokensAfter: number;
    }>;
  };
}

// ============================================================================
// MESSAGE
// ============================================================================

export type Message = UserMessage | AssistantMessage;

export interface UserMessage {
  id: string; // message_xxx
  sessionID: string;
  role: 'user';
  time: {
    created: number;
  };
}

export interface AssistantMessage {
  id: string; // message_xxx
  sessionID: string;
  role: 'assistant';
  time: {
    created: number;
    completed?: number;
  };

  // Assistant specific
  system: string[]; // System prompts used
  modelID: string; // 'claude-3-5-sonnet-20241022'
  providerID: string; // 'anthropic' | 'openai' |
  mode: string; // 'build' | 'plan' | agent name

  path: {
    cwd: string; // Working directory
    root: string; // Project root
  };

  // Metrics
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number; // For extended thinking
    cache: {
      read: number;
      write: number;
    };
  };

  // Optional fields
  summary?: boolean; // If this is a summary message
  error?: MessageError;
}

export type MessageError =
  | { name: 'MessageAbortedError'; message: string }
  | { name: 'ProviderAuthError'; providerID: string; message: string }
  | { name: 'MessageOutputLengthError' }
  | { name: 'Unknown'; message: string };

// ============================================================================
// PARTS
// ============================================================================

export type Part =
  | TextPart
  | ToolPart
  | FilePart
  | ReasoningPart
  | StepStartPart
  | StepFinishPart
  | PatchPart
  | AgentPart
  | SnapshotPart;

interface PartBase {
  id: string; // part_xxx
  sessionID: string;
  messageID: string;
}

// ----------------------------------------------------------------------------
// Text Part
// ----------------------------------------------------------------------------

export interface TextPart extends PartBase {
  type: 'text';
  text: string;
  time?: {
    start: number;
    end?: number;
  };
  synthetic?: boolean; // Auto-generated message (not from user/LLM)
  metadata?: Record<string, any>;
}

// ----------------------------------------------------------------------------
// Tool Part
// ----------------------------------------------------------------------------

export interface ToolPart extends PartBase {
  type: 'tool';
  tool: string; // Tool name (e.g., 'read', 'bash', 'memory_search')
  callID: string; // Unique ID for this tool call
  state: ToolState;
  metadata?: Record<string, any>;
}

export type ToolState =
  | ToolStatePending
  | ToolStateRunning
  | ToolStatePendingApproval
  | ToolStateCompleted
  | ToolStateError;

/**
 * Tool is pending - initial state when tool call is received.
 * Also used when waiting for a previous tool to complete (sequential execution).
 */
export interface ToolStatePending {
  status: 'pending';
  input?: any;
  title?: string;
  metadata?: Record<string, any>;
}

export interface ToolStateRunning {
  status: 'running';
  input: any;
  title?: string;
  metadata?: Record<string, any>;
  time: {
    start: number;
  };
}

/**
 * Tool is waiting for user permission to execute.
 * The permissionRequest field contains the request ID needed to grant/deny.
 */
export interface ToolStatePendingApproval {
  status: 'pending_approval';
  input: any;
  title?: string;
  metadata?: Record<string, any>;
  time: {
    start: number;
  };
  /** Permission request info for restoration after page reload */
  permissionRequest: {
    requestId: string;
    appId: string;
    toolName: string;
    createdAt: number;
  };
}

export interface ToolStateCompleted {
  status: 'completed';
  input: Record<string, any>;
  output: string;
  title: string;
  metadata: Record<string, any>;
  time: {
    start: number;
    end: number;
    compacted?: number; // If output was compacted
  };
  attachments?: FilePart[]; // Files generated by the tool
}

export interface ToolStateError {
  status: 'error';
  input: Record<string, any>;
  error: string;
  metadata?: Record<string, any>;
  time: {
    start: number;
    end: number;
  };
}

// ----------------------------------------------------------------------------
// File Part
// ----------------------------------------------------------------------------

export interface FilePart extends PartBase {
  type: 'file';
  mime: string; // 'image/png', 'application/pdf', etc.
  url: string; // data:... or file://...
  filename?: string;
  source?: FilePartSource;
}

export type FilePartSource = FileSource | SymbolSource;

export interface FileSource {
  type: 'file';
  path: string;
  text: {
    value: string;
    start: number;
    end: number;
  };
}

export interface SymbolSource {
  type: 'symbol';
  path: string;
  name: string;
  kind: number; // LSP SymbolKind
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: {
    value: string;
    start: number;
    end: number;
  };
}

// ----------------------------------------------------------------------------
// Reasoning Part (Extended Thinking)
// ----------------------------------------------------------------------------

export interface ReasoningPart extends PartBase {
  type: 'reasoning';
  text: string; // Thinking/reasoning content
  time: {
    start: number;
    end?: number;
  };
  metadata?: Record<string, any>;
}

// ----------------------------------------------------------------------------
// Step Parts (for tracking LLM steps)
// ----------------------------------------------------------------------------

export interface StepStartPart extends PartBase {
  type: 'step-start';
  snapshot?: string; // Filesystem snapshot before step
}

export interface StepFinishPart extends PartBase {
  type: 'step-finish';
  snapshot?: string; // Filesystem snapshot after step
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
}

// ----------------------------------------------------------------------------
// Patch Part (Git diffs)
// ----------------------------------------------------------------------------

export interface PatchPart extends PartBase {
  type: 'patch';
  hash: string;
  files: string[]; // Array of file paths changed
}

// ----------------------------------------------------------------------------
// Agent Part (Subagent invocations)
// ----------------------------------------------------------------------------

export interface AgentPart extends PartBase {
  type: 'agent';
  name: string; // Agent name
  source?: {
    value: string;
    start: number;
    end: number;
  };
}

// ----------------------------------------------------------------------------
// Snapshot Part
// ----------------------------------------------------------------------------

export interface SnapshotPart extends PartBase {
  type: 'snapshot';
  snapshot: string;
}

// ============================================================================
// HELPER TYPES
// ============================================================================

/**
 * Message with its parts (the previous implementation MessageV2.WithParts)
 * This is the main structure returned by most operations
 */
export interface MessageWithParts {
  info: Message;
  parts: Part[];
  blocked?: boolean; // If execution was blocked (e.g., permission denied)
  streamingUsed?: boolean; // If real-time streaming was used (no need for traditional reply)
}

/**
 * Token usage structure (consistent across providers)
 */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning?: number;
  cache?: {
    read: number;
    write: number;
  };
}

/**
 * Path information (working directory context)
 */
export interface PathInfo {
  cwd: string; // Current working directory
  root: string; // Project/workspace root
}

// ============================================================================
// ID GENERATION
// ============================================================================

/**
 * Generate ascending IDs (like the previous implementation's Identifier.ascending())
 * Format: prefix_timestamp_random
 */
export function generateAscendingID(prefix: 'session' | 'message' | 'part'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Generate descending IDs (for sessions, ordered newest first)
 * Format: prefix_inverseTimestamp_random
 */
export function generateDescendingID(prefix: 'session'): string {
  const inverseTimestamp = Number.MAX_SAFE_INTEGER - Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${prefix}_${inverseTimestamp}_${random}`;
}
