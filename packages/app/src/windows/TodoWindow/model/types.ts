/**
 * To Do data shapes, as the todo-list backend actions return them
 * (packages/backend/src/mca-actions/todo.ts).
 */

import type { FormField } from "@teros/shared"

export type NodeState = "planning" | "pending" | "working" | "blocked" | "review" | "done" | "cancelled"
export type NodeKind = "group" | "task"

/** Who does a task. */
export interface Assignee {
  kind: "agent" | "user"
  id: string
}

/**
 * The dependency semaforo (TODODEP - Option A, board parity): green = no
 * dependencies or all released; orange = every blocker started but some
 * unreleased; red = some blocker not started; circular = defensive (the
 * backend rejects cycles at write time).
 */
export type BlockStatus = "green" | "orange" | "red" | "circular"

/** A dependency as the reads expose it: the task plus its current state. */
export interface DependencyRef {
  nodeId: string
  text: string
  state: NodeState | null
}

export interface FormFieldDef {
  id: string
  type: string
  label: string
  description?: string
  options?: Array<{ value: string; label: string }>
}

export type NodeIO =
  | { format: "markdown"; markdown: string }
  | { format: "form"; fields: FormFieldDef[]; values: Record<string, unknown> }
  | { format: "file"; objectId: string; url: string; name: string; mime: string; size: number }

/** Format of a task's expected output (TODOAP-REQ-14). */
export type OutputFormat = "markdown" | "form" | "file"

/** File types a `file` expected output can name (TODOAP-REQ-14). */
export const EXPECTED_FILE_TYPES = ["pdf", "docx", "xlsx", "csv", "png", "jpg", "json", "md", "txt", "html", "other"] as const
export type ExpectedFileType = (typeof EXPECTED_FILE_TYPES)[number]

/**
 * Expected output definition (TODOAP-REQ-14): `fields` uses the form output's
 * `@teros/shared` FormField schema and only goes with `form`; `fileType` only
 * with `file`.
 */
export interface ExpectedOutput {
  format: OutputFormat
  description?: string
  fileType?: ExpectedFileType
  fields?: FormField[]
}

/**
 * The pluggable engine working a task when it has no conversation (CCR-REQ-8):
 * today Claude Code. `sessionId` is Claude Code's own conversation id — the
 * `--resume` key; `status` is where the session is in its life (the bubble
 * reflects it: live = awake, sleeping = dimmed, gone = recreated on click).
 */
export interface RunnerFields {
  kind: "claude-code"
  terminalId: string
  sessionId?: string
  startedAt: number
  lastAliveAt?: number
  status?: "live" | "sleeping" | "gone"
  /**
   * The terminal question the session's watch blocked the task on — the
   * only block it ever auto-lifts (reminder-loop fix, 1-nov). Backend
   * bookkeeping; the UI does not read it.
   */
  sessionQuestion?: string | null
  reviewTerminalId?: string
  reviewSessionId?: string
  reviewStartedAt?: number
  reviewLastAliveAt?: number
  reviewStatus?: "live" | "sleeping" | "gone"
}

/**
 * Autoplay fields every node read carries (TODOAP data model; absent on
 * nodes that never ran): the linked conversation, the runner record (CCR),
 * whether an agent turn runs in it, the re-wakes since the last progress,
 * the expected output definition.
 */
export interface AutoplayFields {
  channelId?: string
  runner?: RunnerFields | null
  running?: boolean
  autoWakeCount?: number
  /** Consecutive failed autoplay starts (TODOAP-REQ-32). */
  startFailCount?: number
  expectedOutput?: ExpectedOutput | null
  /** When the output was last written (epoch ms; absent on older nodes). */
  outputUpdatedAt?: number
}

/** A node as get-tree returns it (nested `children` flattened by the store). */
export interface TreeNode extends AutoplayFields {
  nodeId: string
  parentId: string | null
  text: string
  description: string
  kind: NodeKind
  /** null for groups. */
  state: NodeState | null
  blockedReason: string | null
  completed: boolean
  collapsed: boolean
  position: number
  /** Effective progress (reported, else 100 for review/done, else derived). */
  progress: number | null
  reportedProgress: number | null
  hasInput: boolean
  hasOutput: boolean
  plannedFor: string | null
  dayOrder: number | null
  plannedTime: string | null
  assignee: Assignee | null
  /** Who reviews it when it enters review (TODORV); absent/null = manual validation (nobody evaluates). */
  reviewer?: Assignee | null
  /** TODODEP - nodeIds this task waits on ([] when none). */
  dependencies?: string[]
  /** TODODEP - the semaforo (board parity). */
  blockStatus?: BlockStatus
  /** TODODEP - direct blockers with their current state. */
  blockers?: DependencyRef[]
  /** TODODEP - the tasks that wait on this one (the inverse). */
  dependents?: DependencyRef[]
  /** Archive: whether this node is archived (hidden from the default views). */
  archived?: boolean
  /** Archive: when it was archived (epoch ms; null while active). */
  archivedAt?: number | null
  /** Archive: when the task reached done/cancelled (epoch ms; null while open). */
  completedAt?: number | null
  childCount: number
  completedChildren: number
}

/** Who wrote a log entry (TODOLG-REQ-1): a user, an agent or the system. */
export interface LogActor {
  kind: "user" | "agent" | "system"
  id?: string
}

export interface LogEntry {
  timestamp: number
  text: string
  /** Absent on entries written before actors existed (unknown). */
  actor?: LogActor
}

/** get-node */
export interface NodeDetail extends AutoplayFields {
  nodeId: string
  parentId: string | null
  text: string
  description: string
  instructions: string
  kind: NodeKind
  state: NodeState | null
  blockedReason: string | null
  allowedTransitions: NodeState[]
  progress: number | null
  reportedProgress: number | null
  input: NodeIO | null
  output: NodeIO | null
  hasInput: boolean
  hasOutput: boolean
  plannedFor: string | null
  dayOrder: number | null
  plannedTime: string | null
  assignee: Assignee | null
  assignedAt: number | null
  /** Who reviews it when it enters review (TODORV); absent/null = manual validation (nobody evaluates). */
  reviewer?: Assignee | null
  reviewedAt?: number | null
  /** TODODEP - nodeIds this task waits on ([] when none). */
  dependencies?: string[]
  /** TODODEP - the semaforo (board parity). */
  blockStatus?: BlockStatus
  /** TODODEP - direct blockers with their current state. */
  blockers?: DependencyRef[]
  /** TODODEP - the tasks that wait on this one (the inverse). */
  dependents?: DependencyRef[]
  /** Archive: whether this node is archived (get-node carries it like get-tree does). */
  archived?: boolean
  /** Archive: when it was archived (epoch ms; null while active). */
  archivedAt?: number | null
  completed: boolean
  collapsed: boolean
  position: number
  log: LogEntry[]
  createdAt: number
  updatedAt: number
}

/** get-day entries */
export interface DayTask extends AutoplayFields {
  nodeId: string
  parentId: string | null
  text: string
  state: NodeState
  blockedReason: string | null
  progress: number | null
  reportedProgress: number | null
  plannedFor: string | null
  dayOrder: number | null
  plannedTime: string | null
  hasOutput: boolean
  assignee: Assignee | null
  /** Who reviews it when it enters review (TODORV); absent/null = manual validation (nobody evaluates). */
  reviewer?: Assignee | null
  /** TODODEP - nodeIds this task waits on ([] when none). */
  dependencies?: string[]
  /** TODODEP - the semaforo (board parity). */
  blockStatus?: BlockStatus
  /** TODODEP - direct blockers with their current state. */
  blockers?: DependencyRef[]
  /** TODODEP - the tasks that wait on this one (the inverse). */
  dependents?: DependencyRef[]
  /** Archive: defensive — get-day never returns archived tasks (backend cascade); the view filters again. */
  archived?: boolean
  path: string[]
}

export interface DayData {
  day: string
  today: string
  tasks: DayTask[]
  overdue: DayTask[]
  unplanned: DayTask[]
}
