/**
 * Todo List MCA v2.0.0 — Shared types
 *
 * Single-tree architecture: no lists, every node is part of one tree per workspace.
 * Root nodes have parentId: null.
 */

/** Task states (groups have none). `cancelled` (Pablo, 2026-10-30): reachable from every open state, reopens to pending. */
export type NodeState = 'planning' | 'pending' | 'working' | 'blocked' | 'review' | 'done' | 'cancelled';

/** A group is a non-completable container; absent kind = task. */
export type NodeKind = 'group' | 'task';

/** A form field (same shape as @teros/shared FormField). */
export interface FormField {
  id: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'radio' | 'checkbox' | 'date' | 'time' | 'datetime';
  label: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number | string;
  max?: number | string;
}

/** Data a task starts from / the result it delivers, as stored and returned. */
export type NodeIO =
  | { format: 'markdown'; markdown: string }
  | { format: 'form'; fields: FormField[]; values: Record<string, string | number | boolean> }
  | { format: 'file'; objectId: string; url: string; name: string; mime: string; size: number };

/**
 * A NodeIO as sent to set-input / set-output. A file travels either as base64
 * `data` (in-memory files) or as `path` — an absolute path inside the workspace
 * volume ('/workspace/...') that the backend reads and uploads, so large files
 * never have to be generated as base64 inside the tool-call payload.
 */
export type NodeIOInput =
  | Exclude<NodeIO, { format: 'file' }>
  | { format: 'file'; name: string; mime: string; data: string }
  | { format: 'file'; path: string; name?: string; mime?: string };

/** A single log entry in a node's chronological history. */
export interface LogEntry {
  timestamp: number;
  text: string;
  /** Who wrote it (TODOLG-REQ-1); absent on entries written before actors existed. */
  actor?: { kind: 'user' | 'agent' | 'system'; id?: string };
}

/** A single bullet/node in the outliner tree. */
export interface TodoNode {
  nodeId: string;
  parentId: string | null;
  workspaceId: string;
  text: string;
  description: string;
  instructions: string;
  /** Mirror of state === 'done' (compatibility). */
  completed: boolean;
  collapsed: boolean;
  position: number;
  log: LogEntry[];
  createdAt: number;
  updatedAt: number;
  kind?: NodeKind;
  state?: NodeState;
  blockedReason?: string | null;
  progress?: number | null;
  input?: NodeIO | null;
  output?: NodeIO | null;
  /** Planned day 'YYYY-MM-DD' (tasks only). */
  plannedFor?: string | null;
  /** Position within the planned day. */
  dayOrder?: number | null;
  /** Planned time 'HH:MM'. */
  plannedTime?: string | null;
}

/** Lightweight node for tree API responses (no instructions/log — use getNode for detail). */
export interface FormattedNode {
  nodeId: string;
  parentId: string | null;
  text: string;
  description: string;
  kind: NodeKind;
  /** null for groups. */
  state: NodeState | null;
  blockedReason: string | null;
  completed: boolean;
  collapsed: boolean;
  position: number;
  /** Effective progress: reported, else 100 for review/done, else derived from the children. */
  progress: number | null;
  reportedProgress: number | null;
  hasInput: boolean;
  hasOutput: boolean;
  childCount: number;
  completedChildren: number;
  children?: FormattedNode[];
}

/** Full node detail for get-node API responses. */
export interface NodeDetail {
  nodeId: string;
  parentId: string | null;
  text: string;
  description: string;
  instructions: string;
  kind: NodeKind;
  state: NodeState | null;
  blockedReason: string | null;
  /** States set-state accepts from the current one (empty for groups). */
  allowedTransitions: NodeState[];
  progress: number | null;
  reportedProgress: number | null;
  input: NodeIO | null;
  output: NodeIO | null;
  hasInput: boolean;
  hasOutput: boolean;
  completed: boolean;
  collapsed: boolean;
  position: number;
  log: LogEntry[];
  createdAt: number;
  updatedAt: number;
}
