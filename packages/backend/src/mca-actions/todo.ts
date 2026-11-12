/**
 * todo actions — mca.teros.todo-list, APIfied.
 *
 * The Workflowy-style outliner used to run inside the MCA container with its
 * own MongoClient against `todo_nodes`. It is now a thin client: every tool
 * forwards to a named action here (`todo/<action>`) and the backend executes
 * it against the SAME collection, with the SAME document shape, ids and
 * indexes — no data migration (datastore-isolation, P1b).
 *
 * SELF-CONTAINED ON PURPOSE. `todo_nodes` is private to this capability
 * (nothing else in the backend reads it) and the todo-list may later leave the
 * Teros core, so this file imports nothing from the sibling capabilities: the
 * id generator, validation helper and error helpers are local copies. Deleting
 * the capability = deleting this file and its registry line.
 *
 * Tenancy model — identical for every action except `ping`:
 *   - The workspace is derived SERVER-SIDE from the verified token; the body
 *     is never consulted for scope (any `workspaceId` the caller sends is
 *     ignored). This preserves today's keying exactly, so no data splits:
 *       * the agent path keyed by `channel.workspaceId`
 *         (message-handler.ts processAgentResponse);
 *       * the window path keyed by `app.ownerId`
 *         (handlers/domains/app/execute-tool.ts getExecutionContext).
 *     `requireTenant` resolves the same values: the app named by the token's
 *     `appId` must be a `mca.teros.todo-list` installation (403 otherwise);
 *     when the callback carries a `channelId` whose channel has a non-empty
 *     `workspaceId`, that is the workspace; otherwise `app.ownerId` is (and it
 *     must be a non-empty string, else 403).
 *   - `ctx.channelId` is trustworthy: it is the URL segment of the
 *     authenticated callback, which the router binds to the authenticated
 *     user (a channel owned by someone else is rejected before any handler
 *     runs), so it is not forgeable from the body. NOTE: today both spawn
 *     paths build the callback URL as `/mca/callback/<appId>`, so in practice
 *     the channel lookup misses and the workspace is `app.ownerId`; the
 *     channel branch becomes live the day the callback URL carries a real
 *     channelId. Once production data confirms that every channel using an
 *     app has `channel.workspaceId === app.ownerId`, strict mode is a one-line
 *     tightening: drop the channel branch and key on `app.ownerId` only.
 *   - Every Mongo operation carries `workspaceId: wsId`; a node of another
 *     workspace answers NOT_FOUND (its existence is not revealed).
 *
 * Result shapes and error codes/messages are EXACTLY what the former MCA tools
 * returned: TodoWindow, the TodoListRenderer and the backend broadcast blocks
 * in execute-tool.ts / agent-loop.ts read `node`, `node.nodeId ?? output.nodeId`
 * and `node.parentId` from them, and the thin client rebuilds the
 * `[CODE] message suggestion` error string from `{ error, code, suggestion }`.
 *
 * Two deliberate behaviour changes versus the direct-Mongo MCA:
 *   1. `search-nodes` ESCAPES the query before building the `$regex`. The old
 *      code passed user input straight to Mongo, so `(` errored and `.*` ran
 *      arbitrary regexes against the backend's database. Semantics change
 *      only for queries containing regex metacharacters (they now match
 *      literally); plain text searches behave as before (case-insensitive
 *      substring).
 *   2. `get-tree` and the `search-nodes` breadcrumb builder load the whole
 *      workspace into memory. That is now capped: a workspace with more than
 *      MAX_WORKSPACE_NODES nodes fails with TOO_MANY_NODES (400) instead of
 *      loading unbounded data into the backend process.
 *
 * States, groups, progress and input/output (docs/specs/tasks/
 * 20261024_todo-improvements-plan.md, task-states spec §7/§7bis):
 *   - A node is a `task` (default; a missing `kind` reads as task) or a
 *     `group` (a non-completable container: no state, progress or output).
 *     A group contains groups and tasks; a task contains only tasks.
 *   - A task has a `state` (planning · pending · working · blocked · review ·
 *     done · cancelled) moved by `set-state` along the human-actor transitions
 *     of §7. `cancelled` (Pablo, 2026-10-30) is reachable from every open
 *     state, reopens to `pending`, leaves the day plan, is ignored by the
 *     autoplay eligibility and contributes nothing to derived progress.
 *     `completed` keeps being written as `state === 'done'` for one release so
 *     older readers keep working; a node without `state` (written before the
 *     20261024_001 migration) reads as done/pending from `completed`.
 *   - `progress` is the reported % (0–100 or null), editable in ANY task
 *     state. Entering `review` or `done` sets it to 100; leaving them for an
 *     open state clears a stored 100 (the automatic value) and keeps any other
 *     value. Readers get the EFFECTIVE progress: the reported value, else 100
 *     for review/done, else derived from the children (mean of their
 *     effective progress, an open task without a report counting 0), else null.
 *   - `input` / `output` are a NodeIO: markdown or a form live on the node; a
 *     file is uploaded to the agent-apps object storage (the same store as
 *     `file_object_put`, served publicly by GET /objects/:objectId) and only
 *     its reference is stored.
 *   - State, progress, kind, input and output changes append a log entry.
 *
 * Dependencies (TODODEP — Option A "ver y respetar", Pablo 2-nov): a task may
 * carry `dependencies` (nodeIds of tasks it waits on, same workspace only —
 * any group, never cross-workspace). A dependency releases when its blocker
 * reaches done or cancelled (review does NOT release — board parity);
 * cycles are rejected at write time (CIRCULAR_DEPENDENCY, clear error) and
 * delete purges every reference (zero orphans). Reads expose per node the
 * semáforo `blockStatus` (green/orange/red, board parity with getBlockStatus)
 * plus `blockers` (with state) and `dependents` (the inverse); the autoplay
 * gate (startableTasks) skips waiting tasks with a visible reason and starts
 * them once the blocker releases (≤ the 60 s safety net).
 *
 * Day planning ("Por día" view, docs/specs/tasks/20261024_todo-improvements-plan.md):
 *   - A task may be planned for a calendar day: `plannedFor` ('YYYY-MM-DD' or
 *     null), its position in that day's plan `dayOrder` (0..N-1, renumbered
 *     per day by `plan-node`) and an optional `plannedTime` ('HH:MM').
 *   - Days are plain calendar strings in the user's local calendar; the
 *     backend never converts time zones. `get-day` takes the caller's `today`
 *     to decide what is overdue (plannedFor < today and not done).
 *   - Groups are never planned.
 *
 * Assignment ("who does what"): a task may carry `assignee` { kind: 'agent' |
 * 'user', id } — an agent usable in the node's workspace or a member of it —
 * and `assignedAt` (the autoplay queue order). Groups are never assigned.
 *
 * Autoplay (docs/specs/todo/autoplay/spec.md, TODOAP): runners per
 * (workspace, agent) live in `todo_autoplay_runners` and are scheduled by
 * services/todo-autoplay-service.ts (injected through McaActionDeps as
 * `todoAutoplay`). A task carries `channelId` (its conversation), `running`
 * (an agent turn is running in it), `autoWakeCount` (re-wakes since the last
 * progress/state change), `startFailCount` (consecutive failed autoplay
 * starts, TODOAP-REQ-32) and `expectedOutput` (the output it must deliver:
 * format, description, file type or form fields), which `set-output`
 * enforces (OUTPUT_MISMATCH).
 * The runner actions (get-autoplay, set-agent-slots, set-agent-play, set-agent-scope,
 * remove-agent), start-node and set-state's `reply` live here; the
 * scheduling triggers (assign-node, plan-node, set-state) fire the service
 * without waiting for it. Actions that act FOR a person (runner changes,
 * start-node, a reply) read the caller from `callerUserId`, which the thin
 * client fills from the tool's execution context (never from tool args); it
 * must be the owner or an active member of the token's workspace.
 *
 * Io shares (docs/specs/todo/output-window.md, TODOOV): share-io,
 * get-io-share and unshare-io resolve the workspace and the caller here and
 * delegate to handlers/domains/todo-share (public links in `shared_files`).
 */

import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { FormFieldSchema, FormValuesSchema, type FormField } from '@teros/shared';
import { COLLECTIONS, collection, ensureCollectionIndexes } from '../db';
import type { Collection, Db, Document } from 'mongodb';
import { z, type ZodTypeAny } from 'zod';
import { config } from '../config';
import { CallbackHandlers } from '../services/agent-apps/callback-handlers';
import { resolveVolumeHostPath } from '../lib/volume-path-resolver';
import { McaActionError, getMcaActionDeps, type McaActionCapability, type McaActionCtx } from './index';
import type { TodoAutoplayService } from '../services/todo-autoplay-service';
import type { TaskRunnerRecord } from '../services/terminal/claude-code-runner';
import type { VolumeService } from '../services/volume-service';
import { getIoShare, shareIo, unshareIo } from '../handlers/domains/todo-share';
import { SYSTEM_ACTOR, logEntry, pushLogEntry, resolveActor, type LogActor, type LogEntry, type LogWrite } from './todo-log';
import { TodoSubscriptionService } from '../services/todo-subscription-service';
import {
  actorFromLogActor,
  emitAgentPlayChanged,
  emitAgentSlotsChanged,
  emitGlobalPlayChanged,
  emitTaskAssigned,
  emitTaskBlocked,
  emitTaskCompleted,
  emitTaskCreated,
  emitTaskDeleted,
  emitTaskDependencyAdded,
  emitTaskDependencyRemoved,
  emitTaskMoved,
  emitTaskOutputDelivered,
  emitTaskPlanned,
  emitTaskProgress,
  emitTaskStarted,
  emitTaskStateChanged,
  emitTaskUnassigned,
  emitTaskUpdated,
} from '../services/todo-event-emitters';

const MCA_ID = 'mca.teros.todo-list';
const COLLECTION = 'todo_nodes';

/** Hard cap on whole-workspace scans (get-tree, search breadcrumbs). */
const MAX_WORKSPACE_NODES = 10000;

/** Max decoded size of a file uploaded as a node input/output. */
export const MAX_IO_FILE_BYTES = 10 * 1024 * 1024;

/** Max markdown length of a node input/output. */
const MAX_IO_MARKDOWN = 50000;

/** Max number of fields in a node input/output form. */
const MAX_IO_FORM_FIELDS = 50;

// =============================================================================
// Document types (same shape the MCA stored — no migration)
// =============================================================================

export const NODE_STATES = ['planning', 'pending', 'working', 'blocked', 'review', 'done', 'cancelled'] as const;
export type NodeState = (typeof NODE_STATES)[number];
export type NodeKind = 'group' | 'task';

/**
 * Allowed state transitions for a human actor (task-states spec §7, without
 * the reviewer role: the To Do has no assignee, so the user is owner and
 * evaluator). `pending|working|review → done` is the "Complete" shortcut.
 * `cancelled` (Pablo, 2026-10-30): any OPEN state may cancel ("this task is
 * no longer happening"); `done` never cancels (done is done). A cancelled
 * task reopens to `pending` (like blocked → working, it is not a blind
 * terminal state).
 */
export const STATE_TRANSITIONS: Record<NodeState, readonly NodeState[]> = {
  planning: ['pending', 'cancelled'],
  pending: ['working', 'done', 'planning', 'cancelled'],
  working: ['review', 'blocked', 'pending', 'done', 'cancelled'],
  blocked: ['working', 'planning', 'cancelled'],
  review: ['done', 'working', 'cancelled'],
  done: ['working'],
  cancelled: ['pending'],
};

/** States a task can be cancelled FROM (every open state; done never cancels). */
export const CANCELLABLE_FROM: readonly NodeState[] = ['planning', 'pending', 'working', 'blocked', 'review'];

/** Data a task starts from / the result it delivers. */
export type NodeIO =
  | { format: 'markdown'; markdown: string }
  | { format: 'form'; fields: FormField[]; values: Record<string, unknown> }
  | { format: 'file'; objectId: string; url: string; name: string; mime: string; size: number };

/** Output formats a task may declare it delivers (TODOAP-REQ-14). */
export const OUTPUT_FORMATS = ['markdown', 'form', 'file'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** File types an expected `file` output may name (TODOAP-REQ-14); `other` = any file. */
export const OUTPUT_FILE_TYPES = ['pdf', 'docx', 'xlsx', 'csv', 'png', 'jpg', 'json', 'md', 'txt', 'html', 'other'] as const;
export type OutputFileType = (typeof OUTPUT_FILE_TYPES)[number];

/**
 * The output a task declares it delivers. `fileType` only with `file`,
 * `fields` (1–40) only with `form`.
 * @spec TODOAP-REQ-14
 */
export interface ExpectedOutput {
  format: OutputFormat;
  description?: string;
  fileType?: OutputFileType;
  fields?: FormField[];
}

/**
 * A single bullet/node in the outliner tree, as stored in `todo_nodes`.
 * @spec TODOAP-REQ-5
 */
export interface TodoNode {
  nodeId: string;
  parentId: string | null;
  workspaceId: string;
  text: string;
  description: string;
  instructions: string;
  /** Mirror of `state === 'done'` (compatibility, one release). */
  completed: boolean;
  collapsed: boolean;
  position: number;
  log: LogEntry[];
  createdAt: number;
  updatedAt: number;
  /** Absent = task (every node written before groups existed). */
  kind?: NodeKind;
  /** Tasks only. Absent on nodes written before the 20261024_001 migration. */
  state?: NodeState;
  /** Set while `state === 'blocked'`, null otherwise. */
  blockedReason?: string | null;
  /** Reported progress 0–100 (tasks only). */
  progress?: number | null;
  input?: NodeIO | null;
  /** Tasks only. */
  output?: NodeIO | null;
  /** Day the task is planned for ('YYYY-MM-DD', the user's calendar), tasks only. */
  plannedFor?: string | null;
  /** Position within its planned day (0..N-1). */
  dayOrder?: number | null;
  /** Optional planned time of day ('HH:MM'). */
  plannedTime?: string | null;
  /** Who does it (tasks only). */
  assignee?: Assignee | null;
  /** When the current assignee was set (epoch ms). */
  assignedAt?: number | null;
  /**
   * Who reviews it when it enters `review` (tasks only; TODORV). Absent/empty
   * = manual validation — nobody evaluates (Pablo, 31-oct: the old "owner
   * evaluates" default made no sense), exactly the pre-reviewer behaviour.
   * No migration:
   * nodes written before this field keep working unchanged.
   */
  reviewer?: Assignee | null;
  /** When the current reviewer was set (epoch ms). */
  reviewedAt?: number | null;
  /** Linked conversation, set on the first start and kept afterwards (TODOAP-REQ-5). */
  channelId?: string | null;
  /**
   * The engine working this task when it has no conversation (CCR-REQ-8).
   * Mental model (Pablo, 31-oct): the agent is an empty identity/seat; the
   * runner is a pluggable engine — teros-core today, claude-code now, Gemini
   * CLI / Codex later. This field is the seed of a first-class
   * "identity + runner" selector in agent creation.
   * @spec CCR-REQ-8
   */
  runner?: TaskRunnerRecord | null;
  /** True while an agent turn runs in `channelId` (TODOAP-REQ-8). */
  running?: boolean;
  /** Re-wakes since the last progress/state change (TODOAP-REQ-7). */
  autoWakeCount?: number;
  /** Consecutive failed autoplay starts (TODOAP-REQ-32); any state transition, progress note or successful start resets it. */
  startFailCount?: number;
  /** Expected output definition (TODOAP-REQ-14), tasks only. */
  expectedOutput?: ExpectedOutput | null;
  /** Last successful set-output on the node, epoch ms (TODOAP-REQ-17). */
  outputUpdatedAt?: number | null;
  /**
   * nodeIds of the tasks this task waits on (TODODEP — Option A, Pablo
   * 2-nov). Tasks only; a dependency releases when its blocker reaches done
   * or cancelled (review does NOT — board parity). Absent/[] = waits on
   * nothing. Cycles are rejected at write time (add-dependency).
   */
  dependencies?: string[];
  /**
   * True when the node is archived (finished work hidden from the default
   * views). Absent = false — nodes written before the field existed are
   * active. An archived node hides its whole subtree at read time.
   */
  archived?: boolean;
  /** When it was archived (epoch ms); null/absent while active. */
  archivedAt?: number | null;
  /**
   * When the task finished — reached done or cancelled (epoch ms; powers
   * archive-finished's olderThanDays). Set by the done/cancelled transitions,
   * cleared when the task leaves them; null for open tasks and groups. Nodes
   * that finished before the field existed derive it at read time
   * (completedAtOf: the last done/cancelled log line, else updatedAt).
   */
  completedAt?: number | null;
}

export interface Assignee {
  kind: 'agent' | 'user';
  id: string;
}

/**
 * The dependency semáforo of a task (TODODEP) — board parity with the
 * board's BlockStatus: green = no dependencies or all released; orange =
 * every blocker started but some unreleased; red = some blocker not started;
 * circular = the task sits on a dependency cycle (defensive — add-dependency
 * prevents them, a direct DB write could still create one).
 */
export type BlockStatus = 'green' | 'orange' | 'red' | 'circular';

/** A dependency as the reads expose it: the node plus its current state. */
export interface DependencyRef {
  nodeId: string;
  text: string;
  state: NodeState | null;
}

/** Lightweight node for get-tree responses (no instructions/log/input/output). */
interface FormattedNode {
  nodeId: string;
  parentId: string | null;
  text: string;
  description: string;
  kind: NodeKind;
  state: NodeState | null;
  blockedReason: string | null;
  completed: boolean;
  collapsed: boolean;
  position: number;
  /** Effective progress (reported, else derived from the children). */
  progress: number | null;
  reportedProgress: number | null;
  hasInput: boolean;
  hasOutput: boolean;
  plannedFor: string | null;
  dayOrder: number | null;
  plannedTime: string | null;
  assignee: Assignee | null;
  reviewer: Assignee | null;
  channelId: string | null;
  running: boolean;
  autoWakeCount: number;
  startFailCount: number;
  expectedOutput: ExpectedOutput | null;
  outputUpdatedAt: number | null;
  /** TODODEP — nodeIds this task waits on ([] when none). */
  dependencies: string[];
  /** TODODEP — the semáforo (board parity). */
  blockStatus: BlockStatus;
  /** TODODEP — direct blockers with their current state. */
  blockers: DependencyRef[];
  /** TODODEP — the tasks that wait on this one (the inverse). */
  dependents: DependencyRef[];
  /** Archive: whether this node is archived (absent in default reads when false). */
  archived: boolean;
  /** Archive: when it was archived (epoch ms, null while active). */
  archivedAt: number | null;
  /** Archive: when the task finished — done/cancelled (epoch ms, null while open). */
  completedAt: number | null;
  childCount: number;
  completedChildren: number;
  children?: FormattedNode[];
}

/** The nodes collection name, for scoped readers outside the capability (CCR-REQ-5). @spec CCR-REQ-5 */
export const TODO_NODES_COLLECTION: string = COLLECTION;

function nodes(db: Db): Collection<TodoNode> {
  return db.collection<TodoNode>(COLLECTION);
}

// =============================================================================
// Errors
// =============================================================================

/** Domain error (400 unless stated) with the same code/message/suggestion the MCA tools used. */
function fail(code: string, message: string, suggestion?: string, status = 400): never {
  throw new McaActionError(code, message, status, suggestion);
}

function notFound(message: string, suggestion?: string): never {
  return fail('NOT_FOUND', message, suggestion, 404);
}

function nodeNotFound(nodeId: string): never {
  return notFound(`Node "${nodeId}" not found.`);
}

const FORBIDDEN_MSG = 'todo actions require a workspace-owned todo-list app';

function forbidden(): never {
  return fail('FORBIDDEN', FORBIDDEN_MSG, undefined, 403);
}

// =============================================================================
// Ids (copied from the former MCA db.ts — same alphabet, same length)
// =============================================================================

/** Generate a short random ID: `<prefix>_<16 base62 chars>`. */
function generateId(prefix: string): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(16);
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return `${prefix}_${id}`;
}

// =============================================================================
// Indexes — lazy, once per process (the MCA created them on connect)
// =============================================================================

let indexesReady: Promise<void> | null = null;

/**
 * Create the three `todo_nodes` indexes the MCA used to create at startup.
 * `createIndex` is idempotent; the promise is cached so the work happens once
 * per backend process (and concurrent first calls share it). A failure clears
 * the cache so the next action retries instead of staying broken.
 */
function ensureTodoIndexes(db: Db): Promise<void> {
  if (!indexesReady) {
    // Declared in src/db/indexes.ts (GOV-4); boot applies them too, this lazy
    // call only covers a process that skipped boot (tests, scripts).
    indexesReady = ensureCollectionIndexes(nodes(db), COLLECTIONS.todoNodes).catch((err) => {
      indexesReady = null;
      throw err;
    });
  }
  return indexesReady;
}

// =============================================================================
// Input validation (same zod schemas the MCA tools validated with)
// =============================================================================

function validateInput<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
    return fail(
      'INVALID_INPUT',
      `Invalid input at "${path}": ${issue.message}`,
      'Check the tool description for the expected shape.',
    );
  }
  return parsed.data;
}

const StateSchema = z.enum(NODE_STATES);
const KindSchema = z.enum(['group', 'task']);

/** Max description length and field count of an expected output (TODOAP-REQ-14). */
const MAX_EXPECTED_DESCRIPTION = 500;
const MAX_EXPECTED_FIELDS = 40;

/** @spec TODOAP-REQ-14 */
const ExpectedOutputSchema = z
  .object({
    format: z.enum(OUTPUT_FORMATS),
    description: z.string().max(MAX_EXPECTED_DESCRIPTION).optional(),
    fileType: z.enum(OUTPUT_FILE_TYPES).optional(),
    fields: z.array(FormFieldSchema).min(1).max(MAX_EXPECTED_FIELDS).optional(),
  })
  .superRefine((v, issue) => {
    if (v.fields !== undefined && v.format !== 'form') {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['fields'], message: '"fields" is only valid with format "form"' });
    }
    if (v.fileType !== undefined && v.format !== 'file') {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['fileType'], message: '"fileType" is only valid with format "file"' });
    }
  });

const AddNodeSchema = z.object({
  parentId: z.string().min(1).nullable().optional(),
  text: z.string().min(1).max(2000),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(10000).optional(),
  kind: KindSchema.optional(),
  state: StateSchema.optional(),
  expectedOutput: ExpectedOutputSchema.nullable().optional(),
});

const NodeIdSchema = z.object({
  nodeId: z.string().min(1),
});

const GetTreeSchema = z.object({
  nodeId: z.string().min(1).optional(),
  depth: z.number().int().min(-1).max(100).default(-1),
  /** Only tasks with this assignee, plus their ancestors (the path to them). */
  assignee: z.object({ kind: z.enum(['agent', 'user']), id: z.string().min(1) }).optional(),
  /**
   * Only tasks with this reviewer (any state — the reviewer's "my tasks" view;
   * pair with the UI's review filter for the pending-review slice), plus their
   * ancestors. TODORV.
   */
  reviewer: z.object({ kind: z.enum(['agent', 'user']), id: z.string().min(1) }).optional(),
  /** Include archived nodes (and the subtrees under archived ancestors). Default false. */
  includeArchived: z.boolean().optional(),
});

const UpdateNodeSchema = z
  .object({
    nodeId: z.string().min(1),
    text: z.string().min(1).max(2000).optional(),
    description: z.string().max(2000).optional(),
    instructions: z.string().max(10000).optional(),
    expectedOutput: ExpectedOutputSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.text !== undefined ||
      v.description !== undefined ||
      v.instructions !== undefined ||
      v.expectedOutput !== undefined,
    {
      message: 'At least one of "text", "description", "instructions" or "expectedOutput" must be provided.',
    },
  );

/**
 * `newParentId` distinguishes OMITTED (undefined → keep the current parent,
 * reorder only) from explicit `null` (move to root). JSON keeps that
 * distinction (a missing key vs. `null`), and so does zod's `.nullable().optional()`.
 */
const MoveNodeSchema = z.object({
  nodeId: z.string().min(1),
  newParentId: z.string().min(1).nullable().optional(),
  newPosition: z.number().int().min(0).default(0),
});

const SearchNodesSchema = z.object({
  query: z.string().min(1).max(500),
  /** Include archived nodes in the results. Default false. */
  includeArchived: z.boolean().optional(),
});

const AddLogEntrySchema = z.object({
  nodeId: z.string().min(1),
  text: z.string().min(1).max(2000),
});

const SetStateSchema = z.object({
  nodeId: z.string().min(1),
  state: StateSchema,
  reason: z.string().max(2000).optional(),
  /** blocked/review → working only: the operator's answer (TODOAP-REQ-10) or send-back note (TODOAP-REQ-21). */
  reply: z.string().min(1).max(2000).optional(),
  callerUserId: z.string().min(1).optional(),
});

/** Archive / unarchive one node (set-archived). */
const SetArchivedSchema = z.object({
  nodeId: z.string().min(1),
  archived: z.boolean(),
});

/** Bulk-archive finished tasks (archive-finished). */
const ArchiveFinishedSchema = z.object({
  /** Also archive cancelled tasks (default true). */
  includeCancelled: z.boolean().optional(),
  /** Only archive tasks finished (done/cancelled) at least this many days ago. */
  olderThanDays: z.number().int().min(1).max(3650).optional(),
});

/** Who a person-scoped action acts for (filled by the thin client from the execution context). */
const CallerSchema = z.object({
  callerUserId: z.string().min(1).optional(),
  /** The calling agent and its conversation, when an agent calls (TODOLG-REQ-1). */
  callerAgentId: z.string().min(1).optional(),
  callerChannelId: z.string().min(1).optional(),
});

const AgentIdSchema = CallerSchema.extend({ agentId: z.string().min(1).max(200) });

const SetAgentSlotsSchema = AgentIdSchema.extend({ slots: z.number().int().min(0) });

const SetAgentPlaySchema = AgentIdSchema.extend({ enabled: z.boolean() });

/** @spec TODOAP-REQ-30 — the workspace's global play/pause (no agentId). */
const SetGlobalPlaySchema = CallerSchema.extend({ playing: z.boolean() });

/** @spec TODOAP-REQ-22 */
const SetAgentScopeSchema = AgentIdSchema.extend({
  scopeNodeId: z.string().min(1).nullable(),
  pickUnassigned: z.boolean(),
});

const StartNodeSchema = CallerSchema.extend({ nodeId: z.string().min(1) });

const OpenRunnerTerminalSchema = CallerSchema.extend({ nodeId: z.string().min(1) });

const IoShareSchema = CallerSchema.extend({ nodeId: z.string().min(1), io: z.enum(['output', 'input']) });

const UnshareIoSchema = CallerSchema.extend({ shareId: z.string().min(1) });

// ─── Event subscriptions (todo/events spec — board parity) ──────────────────

/** The 15 todo event types (TodoEventType in types/database.ts). */
const TODO_EVENT_TYPES = [
  'task_created',
  'task_started',
  'task_completed',
  'task_blocked',
  'task_state_changed',
  'task_assigned',
  'task_unassigned',
  'task_planned',
  'task_output_delivered',
  'task_progress',
  'task_updated',
  'task_moved',
  'task_deleted',
  'agent_play_changed',
  'agent_slots_changed',
  'global_play_changed',
  'dependency_added',
  'dependency_removed',
] as const;

const TODO_STATES_ENUM = NODE_STATES;

/** Filter of a to-do subscription (TodoSubscriptionFilter in types/database.ts). */
const SubscriptionFilterSchema = z
  .object({
    nodeIds: z.array(z.string().min(1)).optional(),
    assigneeIds: z.array(z.string().min(1)).optional(),
    reviewerIds: z.array(z.string().min(1)).optional(),
    states: z.array(z.enum(TODO_STATES_ENUM)).optional(),
    groupNodeIds: z.array(z.string().min(1)).optional(),
    eventTypes: z.array(z.enum(TODO_EVENT_TYPES)).optional(),
    wakeUpOn: z.array(z.enum(TODO_EVENT_TYPES)).optional(),
  })
  .strict();

const SubscribeSchema = CallerSchema.extend({
  /** The conversation that receives the events. Defaults to the calling agent's channel. */
  channelId: z.string().min(1).optional(),
  filter: SubscriptionFilterSchema.optional(),
});

const UnsubscribeSchema = CallerSchema.extend({
  channelId: z.string().min(1).optional(),
});

const ListSubscriptionsSchema = CallerSchema.extend({
  channelId: z.string().min(1).optional(),
});

const SetKindSchema = z.object({
  nodeId: z.string().min(1),
  kind: KindSchema,
});

const SetProgressSchema = z.object({
  nodeId: z.string().min(1),
  progress: z.number().int().min(0).max(100).nullable(),
});

const ToggleInstructionItemSchema = z.object({
  nodeId: z.string().min(1),
  index: z.number().int().min(0),
});

/** Max base64 length for MAX_IO_FILE_BYTES decoded bytes. */
const MAX_IO_FILE_BASE64 = Math.ceil(MAX_IO_FILE_BYTES / 3) * 4;

/**
 * A NodeIO as the CALLER sends it. Markdown and form are stored as given; a
 * file arrives EITHER as base64 `data` + `name` + `mime` (in-memory files) OR
 * as `path` — an absolute path inside the workspace volume (e.g.
 * '/workspace/roadmap/roadmap.html'): the backend reads the file from the
 * volume and uploads it, so the base64 never travels through the tool-call
 * payload (large files truncated mid-generation otherwise — the roadmap
 * incident, 28-oct). Either way it is stored as an object storage reference
 * `{ objectId, url, name, mime, size }`.
 *
 * The data-or-path check runs in storeIO (not as a zod refinement): zod v3
 * discriminates unions by literal only and chokes on refined members.
 */
const IOInputSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('markdown'),
    markdown: z.string().max(MAX_IO_MARKDOWN),
  }),
  z.object({
    format: z.literal('form'),
    fields: z.array(FormFieldSchema).min(1).max(MAX_IO_FORM_FIELDS),
    values: FormValuesSchema.default({}),
  }),
  z.object({
    format: z.literal('file'),
    name: z.string().min(1).max(255).optional(),
    mime: z.string().min(1).max(255).optional(),
    data: z
      .string()
      .min(1)
      .max(MAX_IO_FILE_BASE64, `File too large (max ${MAX_IO_FILE_BYTES} bytes)`)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'data must be base64 (no data: URL prefix)')
      .optional(),
    /** Absolute path inside the workspace volume ('/workspace/...'); the backend reads and uploads the file. */
    path: z.string().min(1).max(1024).optional(),
  }),
]);
type IOInput = z.infer<typeof IOInputSchema>;

/**
 * An IOInput whose file variant carries a filled name/mime (normalizeFileIO
 * output): the shape checks (outputMismatch, requireOverwrite) and storeIO
 * work on this — name/mime are optional only in what the CALLER may send.
 */
type NormalizedIO =
  | Extract<IOInput, { format: 'markdown' }>
  | Extract<IOInput, { format: 'form' }>
  | (Extract<IOInput, { format: 'file' }> & { name: string; mime: string });

/** A calendar day 'YYYY-MM-DD' that exists (2026-02-30 is rejected). */
const DaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD')
  .refine((d) => {
    const [y, m, dd] = d.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, dd));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === dd;
  }, 'day is not a valid date');

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM (24 h)');

/**
 * `time` distinguishes OMITTED (keep the current time) from explicit null
 * (clear it). `index` omitted = append at the end of the day (or keep the
 * current slot when the day does not change).
 */
const PlanNodeSchema = z.object({
  nodeId: z.string().min(1),
  day: DaySchema.nullable(),
  index: z.number().int().min(0).optional(),
  time: TimeSchema.nullable().optional(),
});

const AssigneeSchema = z.object({
  kind: z.enum(['agent', 'user']),
  id: z.string().min(1).max(200),
});

const AssignNodeSchema = z.object({
  nodeId: z.string().min(1),
  assignee: AssigneeSchema.nullable(),
});

/**
 * `set-reviewer` (TODORV): same shape as assign-node, for the reviewer role.
 * `reviewer: null` clears it (back to manual validation — nobody evaluates).
 */
const SetReviewerSchema = z.object({
  nodeId: z.string().min(1),
  reviewer: AssigneeSchema.nullable(),
});

/** TODODEP — make `nodeId` wait on `blockerNodeId`. */
const AddDependencySchema = z.object({
  nodeId: z.string().min(1),
  blockerNodeId: z.string().min(1),
});

/** TODODEP — `nodeId` stops waiting on `blockerNodeId`. */
const RemoveDependencySchema = z.object({
  nodeId: z.string().min(1),
  blockerNodeId: z.string().min(1),
});

const GetDaySchema = z.object({
  day: DaySchema,
  today: DaySchema.optional(),
});

const SetInputSchema = z.object({
  nodeId: z.string().min(1),
  input: IOInputSchema.nullable(),
  /** Required to replace an existing input that would actually change (see requireOverwrite). */
  overwrite: z.boolean().optional(),
});

const SetOutputSchema = z.object({
  nodeId: z.string().min(1),
  output: IOInputSchema.nullable(),
  /** Required to replace an existing output that would actually change (see requireOverwrite). */
  overwrite: z.boolean().optional(),
});

// =============================================================================
// Tenancy
// =============================================================================

interface Tenant {
  /** The workspace every query is scoped to. */
  wsId: string;
}

/**
 * Resolve the calling app's workspace from the verified token (see the header
 * for the full rationale). The body is never consulted.
 *
 *   1. `ctx.appId` must name an existing `mca.teros.todo-list` app (403).
 *   2. If the callback carries a `channelId` whose channel has a non-empty
 *      `workspaceId`, that is the workspace (today's agent-path keying).
 *   3. Otherwise `app.ownerId` (today's window-path keying); must be a
 *      non-empty string (403).
 */
async function requireTenant(db: Db, ctx: McaActionCtx): Promise<Tenant> {
  if (!ctx.appId) return forbidden();
  const app = await db.collection('apps').findOne({ appId: ctx.appId, mcaId: MCA_ID });
  if (!app) return forbidden();

  if (ctx.channelId) {
    const channel = await db
      .collection('channels')
      .findOne({ channelId: ctx.channelId }, { projection: { workspaceId: 1 } });
    const channelWs = channel?.workspaceId;
    if (typeof channelWs === 'string' && channelWs !== '') return { wsId: channelWs };
  }

  const wsId = app.ownerId;
  if (typeof wsId !== 'string' || wsId === '') return forbidden();
  return { wsId };
}

// =============================================================================
// Internal helpers (ported 1:1 from the former MCA db.ts)
// =============================================================================

/** Escape a user string so it matches literally inside a `$regex`. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Load every node of the workspace (optionally sorted / projected), refusing
 * to load more than MAX_WORKSPACE_NODES. Scope: { workspaceId }.
 */
async function loadWorkspaceNodes(
  db: Db,
  wsId: string,
  options: { sort?: Document; projection?: Document } = {},
): Promise<TodoNode[]> {
  const all: TodoNode[] = await nodes(db)
    .find({ workspaceId: wsId }, { sort: options.sort, projection: options.projection })
    .limit(MAX_WORKSPACE_NODES + 1)
    .toArray();
  if (all.length > MAX_WORKSPACE_NODES) {
    return fail(
      'TOO_MANY_NODES',
      `This workspace has more than ${MAX_WORKSPACE_NODES} nodes; whole-tree operations are disabled.`,
      'Use get-tree with a nodeId and a small depth, or delete nodes you no longer need.',
    );
  }
  return all;
}

/** Collect all descendant node IDs of a node (not including the node itself). BFS, one query per level node. */
async function collectSubtree(db: Db, wsId: string, nodeId: string): Promise<string[]> {
  const result: string[] = [];
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = await nodes(db)
      .find({ workspaceId: wsId, parentId: current })
      .project<{ nodeId: string }>({ nodeId: 1 })
      .toArray();
    for (const child of children) {
      result.push(child.nodeId);
      queue.push(child.nodeId);
    }
  }
  return result;
}

/** Reindex sibling positions to be contiguous 0..N-1 (after a delete / cross-parent move). Does NOT touch updatedAt. */
async function reindexSiblings(db: Db, wsId: string, parentId: string | null): Promise<void> {
  const siblings = await nodes(db)
    .find({ workspaceId: wsId, parentId: parentId ?? null })
    .sort({ position: 1 })
    .project<{ nodeId: string }>({ nodeId: 1 })
    .toArray();

  const bulkOps = siblings.map((s, i) => ({
    updateOne: {
      filter: { workspaceId: wsId, nodeId: s.nodeId },
      update: { $set: { position: i } },
    },
  }));

  if (bulkOps.length > 0) {
    await nodes(db).bulkWrite(bulkOps);
  }
}

/** Reorder a node within its siblings (same parent). Touches updatedAt on ALL siblings, as before. */
async function reorderSiblings(
  db: Db,
  wsId: string,
  parentId: string | null,
  nodeId: string,
  newPosition: number,
): Promise<void> {
  const siblings = await nodes(db)
    .find({ workspaceId: wsId, parentId: parentId ?? null })
    .sort({ position: 1 })
    .project<{ nodeId: string }>({ nodeId: 1 })
    .toArray();

  const clampedPos = Math.min(Math.max(0, newPosition), siblings.length - 1);

  const withoutNode = siblings.filter((s) => s.nodeId !== nodeId);
  const node = siblings.find((s) => s.nodeId === nodeId);
  if (!node) return;

  withoutNode.splice(clampedPos, 0, node);

  const bulkOps = withoutNode.map((s, i) => ({
    updateOne: {
      filter: { workspaceId: wsId, nodeId: s.nodeId },
      update: { $set: { position: i, updatedAt: Date.now() } },
    },
  }));

  if (bulkOps.length > 0) {
    await nodes(db).bulkWrite(bulkOps);
  }
}

// =============================================================================
// Kind, state, progress, input/output helpers
// =============================================================================

/** Projection-friendly subset of a node used for progress/children math. */
type NodeCore = Pick<TodoNode, 'nodeId' | 'parentId' | 'completed'> &
  Partial<Pick<TodoNode, 'kind' | 'state' | 'progress'>>;

function kindOf(node: Pick<TodoNode, 'kind'>): NodeKind {
  return node.kind === 'group' ? 'group' : 'task';
}

/** A task's state (legacy nodes without `state` read from `completed`); null for a group. */
function stateOf(node: Pick<TodoNode, 'kind' | 'state' | 'completed'>): NodeState | null {
  if (kindOf(node) === 'group') return null;
  return node.state ?? (node.completed ? 'done' : 'pending');
}

/** Whether the node is archived (absent = false — nodes written before the field). */
function archivedOf(node: Pick<TodoNode, 'archived'>): boolean {
  return node.archived === true;
}

/**
 * When the task finished (done/cancelled), for archive-finished's
 * olderThanDays. The stored `completedAt` when present; a legacy node that
 * finished before the field existed derives it from its log (the last
 * "… → done" / "… → cancelled" entry) or, failing that, its updatedAt.
 * Groups and open tasks have none (null).
 */
function completedAtOf(node: TodoNode): number | null {
  if (kindOf(node) === 'group') return null;
  const state = stateOf(node);
  if (state !== 'done' && state !== 'cancelled') return null;
  if (typeof node.completedAt === 'number') return node.completedAt;
  const log = Array.isArray(node.log) ? node.log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const text = log[i]?.text ?? '';
    if (text.endsWith('→ done') || text.endsWith('→ cancelled')) {
      return typeof log[i].timestamp === 'number' ? log[i].timestamp : (node.updatedAt ?? null);
    }
  }
  return node.updatedAt ?? null;
}

/**
 * The IDs hidden by archiving: every archived node plus its whole subtree
 * (archive cascades down at read time — a node is hidden when it or any
 * ancestor is archived). `all` must be the full workspace load.
 */
function archiveHiddenIds(all: Pick<TodoNode, 'nodeId' | 'parentId' | 'archived'>[]): Set<string> {
  const childrenMap = new Map<string | null, string[]>();
  for (const n of all) {
    const key = n.parentId ?? null;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(n.nodeId);
  }
  const hidden = new Set<string>();
  const walk = (id: string) => {
    if (hidden.has(id)) return;
    hidden.add(id);
    for (const kid of childrenMap.get(id) ?? []) walk(kid);
  };
  for (const n of all) {
    if (archivedOf(n)) walk(n.nodeId);
  }
  return hidden;
}

/** Reported progress of a task (null for groups and when unreported). */
function reportedProgressOf(node: NodeCore): number | null {
  return kindOf(node) === 'task' && typeof node.progress === 'number' ? node.progress : null;
}

/**
 * Effective progress of every node in `all`, memoised: the reported %; else
 * 100 for a task in review or done; else the mean of the children's contributions, where a child
 * contributes its effective progress, an open task without one counts 0, and
 * an empty group is ignored; null when nothing contributes.
 */
function effectiveProgressMap(all: NodeCore[]): Map<string, number | null> {
  const childrenMap = new Map<string | null, NodeCore[]>();
  for (const n of all) {
    const key = n.parentId ?? null;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(n);
  }
  const memo = new Map<string, number | null>();
  const visiting = new Set<string>();

  function effective(n: NodeCore): number | null {
    if (memo.has(n.nodeId)) return memo.get(n.nodeId)!;
    if (visiting.has(n.nodeId)) return null; // defensive: corrupt parent cycle
    visiting.add(n.nodeId);
    let value: number | null;
    const reported = reportedProgressOf(n);
    const state = stateOf(n);
    if (state === 'cancelled') {
      // A cancelled task does not count (Pablo, 2026-10-30): it contributes
      // nothing to its parent's derived progress, exactly like an empty
      // group is ignored — it neither blocks the parent nor counts as 0.
      value = null;
    } else if (reported !== null) {
      value = reported;
    } else if (state === 'review' || state === 'done') {
      value = 100;
    } else {
      const contributions: number[] = [];
      for (const kid of childrenMap.get(n.nodeId) ?? []) {
        const v = effective(kid);
        if (v !== null) contributions.push(v);
        else if (kindOf(kid) === 'task' && stateOf(kid) !== 'cancelled') contributions.push(0);
      }
      value =
        contributions.length > 0
          ? Math.round(contributions.reduce((a, b) => a + b, 0) / contributions.length)
          : null;
    }
    visiting.delete(n.nodeId);
    memo.set(n.nodeId, value);
    return value;
  }

  for (const n of all) effective(n);
  return memo;
}

/**
 * Load a node's descendants (projection: what progress math needs), one query
 * per tree level, capped at MAX_WORKSPACE_NODES. Scope: { workspaceId }.
 */
async function loadDescendantCores(db: Db, wsId: string, nodeId: string): Promise<NodeCore[]> {
  const result: NodeCore[] = [];
  let level = [nodeId];
  while (level.length > 0 && result.length <= MAX_WORKSPACE_NODES) {
    const kids = await nodes(db)
      .find({ workspaceId: wsId, parentId: { $in: level } })
      .project<NodeCore>({ _id: 0, nodeId: 1, parentId: 1, completed: 1, kind: 1, state: 1, progress: 1 })
      .toArray();
    result.push(...kids);
    level = kids.map((k) => k.nodeId);
  }
  return result;
}

/**
 * The compact node every new write action answers with (TodoWindow and the
 * WS broadcast read `node.nodeId` / `node.parentId` from it). The autoplay
 * service broadcasts it too.
 * @spec TODOAP-REQ-5
 */
export function nodeSummary(n: TodoNode) {
  return {
    nodeId: n.nodeId,
    parentId: n.parentId,
    text: n.text,
    description: n.description ?? '',
    kind: kindOf(n),
    state: stateOf(n),
    blockedReason: n.blockedReason ?? null,
    reportedProgress: reportedProgressOf(n),
    completed: n.completed,
    collapsed: n.collapsed,
    position: n.position,
    hasInput: Boolean(n.input),
    hasOutput: Boolean(n.output),
    ...planOf(n),
    assignee: assigneeOf(n),
    assignedAt: assigneeOf(n) ? (n.assignedAt ?? null) : null,
    reviewer: reviewerOf(n),
    reviewedAt: reviewerOf(n) ? (n.reviewedAt ?? null) : null,
    ...autoplayOf(n),
    dependencies: dependenciesOf(n),
    /** Archive (this file's archive section): the flag and when it finished. */
    archived: archivedOf(n),
    archivedAt: n.archivedAt ?? null,
    completedAt: completedAtOf(n),
    updatedAt: n.updatedAt,
  };
}

/**
 * The autoplay fields of a node, normalised for readers (absent on nodes that
 * never ran): conversation, running flag, re-wake count and expected output
 * definition (groups declare none) and when the output was last saved.
 * @spec TODOAP-REQ-14, TODOAP-REQ-17
 */
function autoplayOf(
  n: Pick<TodoNode, 'kind' | 'channelId' | 'running' | 'autoWakeCount' | 'startFailCount' | 'expectedOutput' | 'outputUpdatedAt' | 'runner'>,
): {
  channelId: string | null;
  runner: TaskRunnerRecord | null;
  running: boolean;
  autoWakeCount: number;
  startFailCount: number;
  expectedOutput: ExpectedOutput | null;
  outputUpdatedAt: number | null;
} {
  return {
    channelId: n.channelId ?? null,
    // CCR-REQ-8: the pluggable engine working the task (tasks only).
    runner: kindOf(n) === 'task' ? (n.runner ?? null) : null,
    running: n.running === true,
    autoWakeCount: typeof n.autoWakeCount === 'number' ? n.autoWakeCount : 0,
    startFailCount: typeof n.startFailCount === 'number' ? n.startFailCount : 0,
    expectedOutput: kindOf(n) === 'task' ? (n.expectedOutput ?? null) : null,
    outputUpdatedAt: typeof n.outputUpdatedAt === 'number' ? n.outputUpdatedAt : null,
  };
}

/** The day-planning fields of a node, normalised (groups are never planned). */
function planOf(n: Pick<TodoNode, 'kind' | 'plannedFor' | 'dayOrder' | 'plannedTime'>): {
  plannedFor: string | null;
  dayOrder: number | null;
  plannedTime: string | null;
} {
  if (kindOf(n) === 'group' || !n.plannedFor) return { plannedFor: null, dayOrder: null, plannedTime: null };
  return {
    plannedFor: n.plannedFor,
    dayOrder: typeof n.dayOrder === 'number' ? n.dayOrder : 0,
    plannedTime: n.plannedTime ?? null,
  };
}

/** The assignee of a node, normalised (groups are never assigned). */
function assigneeOf(n: Pick<TodoNode, 'kind' | 'assignee'>): Assignee | null {
  if (kindOf(n) === 'group' || !n.assignee || !n.assignee.id) return null;
  return { kind: n.assignee.kind === 'agent' ? 'agent' : 'user', id: n.assignee.id };
}

/**
 * The reviewer of a node, normalised (groups are never reviewed; TODORV).
 * Absent/empty on every node written before the field existed — the owner
 * evaluates, exactly the previous behaviour.
 */
function reviewerOf(n: Pick<TodoNode, 'kind' | 'reviewer'>): Assignee | null {
  if (kindOf(n) === 'group' || !n.reviewer || !n.reviewer.id) return null;
  return { kind: n.reviewer.kind === 'agent' ? 'agent' : 'user', id: n.reviewer.id };
}

// =============================================================================
// Dependencies (TODODEP — Option A "ver y respetar", Pablo 2-nov)
// =============================================================================

/**
 * The dependency list of a node, normalised (groups never wait; a non-array
 * or non-string entries read as none).
 */
function dependenciesOf(n: Pick<TodoNode, 'kind' | 'dependencies'> | null | undefined): string[] {
  if (!n || kindOf(n) === 'group' || !Array.isArray(n.dependencies)) return [];
  return n.dependencies.filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * Does this state release a dependency? done or cancelled (Pablo, 2-nov) —
 * review does NOT release (board parity: a blocker in review is still working
 * toward its verdict). Both can reopen, so an inbound reference is never an
 * orphan: it simply blocks again if the blocker reopens.
 */
function isReleased(state: NodeState | null): boolean {
  return state === 'done' || state === 'cancelled';
}

/**
 * The semáforo of one node from its DIRECT dependencies — board parity with
 * getBlockStatus (no transitive walk): red = some blocker not started
 * (planning/pending); orange = every blocker started (working/blocked/review)
 * but some unreleased; green = no blockers or all released. A blocker that no
 * longer exists is ignored (delete purges the reference — a deleted blocker
 * never keeps a task waiting). `circular` is decided by the graph walks
 * (dependencyStatusMap / loadDependencyFields), not here.
 */
export function blockStatusOf(
  node: Pick<TodoNode, 'kind' | 'dependencies'>,
  byId: Map<string, Pick<TodoNode, 'kind' | 'state' | 'completed'>>,
): BlockStatus {
  const deps = dependenciesOf(node);
  if (deps.length === 0) return 'green';
  let hasInProgress = false;
  for (const depId of deps) {
    const dep = byId.get(depId);
    if (!dep) continue;
    const state = stateOf(dep);
    if (isReleased(state)) continue;
    if (state === 'planning' || state === 'pending') return 'red';
    hasInProgress = true; // working | blocked | review — started, not released
  }
  return hasInProgress ? 'orange' : 'green';
}

/**
 * The semáforo of every node in `all` (get-tree / get-day): blockStatusOf per
 * node plus defensive `circular` marking — add-dependency rejects cycles, but
 * a direct DB write could still create one, and the board marks them too. A
 * blocker that is itself on a cycle can never release, so it reads as red.
 */
export function dependencyStatusMap(all: TodoNode[]): Map<string, BlockStatus> {
  const byId = new Map(all.map((n) => [n.nodeId, n]));

  // White/grey/black DFS over the dependency edges, iterative (a 10 000-node
  // chain must not blow the call stack). `path` holds the current walk.
  const onCycle = new Set<string>();
  const done = new Set<string>();
  for (const root of all) {
    if (done.has(root.nodeId)) continue;
    const onPath = new Set<string>();
    const path: string[] = [];
    const frames: Array<{ id: string; deps: string[]; i: number }> = [];
    const start = (id: string) => {
      onPath.add(id);
      path.push(id);
      frames.push({ id, deps: dependenciesOf(byId.get(id)), i: 0 });
    };
    start(root.nodeId);
    while (frames.length > 0) {
      const f = frames[frames.length - 1];
      if (f.i >= f.deps.length) {
        frames.pop();
        path.pop();
        onPath.delete(f.id);
        done.add(f.id);
        continue;
      }
      const next = f.deps[f.i++];
      if (!byId.has(next) || done.has(next)) continue;
      if (onPath.has(next)) {
        // Back-edge: every node on the path from `next` down is on a cycle.
        const at = path.indexOf(next);
        for (let k = at; k < path.length; k++) onCycle.add(path[k]);
        continue;
      }
      start(next);
    }
  }

  const memo = new Map<string, BlockStatus>();
  const statusOf = (id: string): BlockStatus => {
    const hit = memo.get(id);
    if (hit) return hit;
    memo.set(id, 'green'); // provisional — only re-entered by cycle members, overwritten below
    const node = byId.get(id);
    let value: BlockStatus = 'green';
    if (node) {
      value = blockStatusOf(node, byId);
      if (value !== 'red' && dependenciesOf(node).some((d) => onCycle.has(d))) value = 'red';
      if (onCycle.has(id)) value = 'circular';
    }
    memo.set(id, value);
    return value;
  };
  for (const n of all) statusOf(n.nodeId);
  return memo;
}

/** The inverse dependency edges of `all`: blocker nodeId → the tasks waiting on it. */
function dependentsMapOf(all: TodoNode[]): Map<string, TodoNode[]> {
  const dependents = new Map<string, TodoNode[]>();
  for (const n of all) {
    for (const depId of dependenciesOf(n)) {
      const list = dependents.get(depId) ?? [];
      list.push(n);
      dependents.set(depId, list);
    }
  }
  return dependents;
}

/** A dependency reference for reads: the node's id, title and current state. */
function dependencyRefOf(
  n: Pick<TodoNode, 'nodeId' | 'text' | 'kind' | 'state' | 'completed'> | undefined,
): DependencyRef | null {
  if (!n) return null;
  return { nodeId: n.nodeId, text: n.text, state: stateOf(n) };
}

/** The dependency fields of a node from precomputed maps (get-tree / get-day). */
function dependencyFieldsOf(
  n: TodoNode,
  byId: Map<string, TodoNode>,
  depStatus: Map<string, BlockStatus>,
  dependents: Map<string, TodoNode[]>,
): { dependencies: string[]; blockStatus: BlockStatus; blockers: DependencyRef[]; dependents: DependencyRef[] } {
  const deps = dependenciesOf(n);
  return {
    dependencies: deps,
    blockStatus: depStatus.get(n.nodeId) ?? 'green',
    blockers: deps.map((id) => dependencyRefOf(byId.get(id))).filter((r): r is DependencyRef => r !== null),
    dependents: (dependents.get(n.nodeId) ?? [])
      .map((d) => dependencyRefOf(d))
      .filter((r): r is DependencyRef => r !== null),
  };
}

/**
 * Is `target` reachable from `sources` following dependency edges (blocker
 * → its own blockers)? The cycle check of add-dependency (board parity: a
 * clear CIRCULAR_DEPENDENCY error, never a stored cycle) and the defensive
 * `circular` semáforo of get-node both reduce to this reachability walk.
 * Scope: { workspaceId, nodeId } reads, projection dependencies only.
 */
async function dependencyReachable(db: Db, wsId: string, sources: string[], target: string): Promise<boolean> {
  const seen = new Set<string>(sources);
  const queue = [...sources];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) return true;
    const doc = await nodes(db).findOne(
      { workspaceId: wsId, nodeId: current },
      { projection: { _id: 0, dependencies: 1 } },
    );
    for (const depId of dependenciesOf(doc)) {
      if (depId === target) return true;
      if (!seen.has(depId)) {
        seen.add(depId);
        queue.push(depId);
      }
    }
  }
  return false;
}

/** Would `nodeId` → `blockerId` close a dependency cycle (self or transitive)? */
async function wouldCreateCycle(db: Db, wsId: string, nodeId: string, blockerId: string): Promise<boolean> {
  return nodeId === blockerId || (await dependencyReachable(db, wsId, [blockerId], nodeId));
}

/**
 * Delete cleanup (TODODEP): strip every reference to the gone nodes from the
 * workspace's `dependencies` arrays, so no task is left waiting on a missing
 * node — zero orphans ($pull on a missing field is a no-op). The gone nodes'
 * own arrays die with their documents.
 */
async function purgeDependencyReferences(db: Db, wsId: string, goneIds: string[]): Promise<void> {
  if (goneIds.length === 0) return;
  await nodes(db).updateMany({ workspaceId: wsId }, { $pull: { dependencies: { $in: goneIds } } });
}

/**
 * The dependency fields of ONE node for get-node: direct blockers with their
 * state, the inverse (dependents) and the semáforo (blockStatusOf over the
 * direct blockers — board parity; `circular` only when a direct DB write
 * created a cycle, which add-dependency prevents).
 * Scope: two { workspaceId } finds + the reachability walk when it has deps.
 */
async function loadDependencyFields(
  db: Db,
  wsId: string,
  node: TodoNode,
): Promise<{ dependencies: string[]; blockStatus: BlockStatus; blockers: DependencyRef[]; dependents: DependencyRef[] }> {
  const deps = dependenciesOf(node);
  const projection = { _id: 0, nodeId: 1, text: 1, kind: 1, state: 1, completed: 1 } as const;
  const dependents = await nodes(db)
    .find({ workspaceId: wsId, dependencies: node.nodeId }, { projection })
    .toArray();
  const blockers =
    deps.length > 0
      ? await nodes(db)
          .find({ workspaceId: wsId, nodeId: { $in: deps } }, { projection })
          .toArray()
      : [];
  const byId = new Map([...blockers, ...dependents].map((n) => [n.nodeId, n]));
  const circular = deps.length > 0 && (await dependencyReachable(db, wsId, deps, node.nodeId));
  return {
    dependencies: deps,
    blockStatus: circular ? 'circular' : blockStatusOf(node, byId),
    blockers: deps.map((id) => dependencyRefOf(byId.get(id))).filter((r): r is DependencyRef => r !== null),
    dependents: dependents
      .map((d) => dependencyRefOf(d))
      .filter((r): r is DependencyRef => r !== null),
  };
}

/**
 * The dependency gate of the autoplay pickups (TODODEP — Option A "ver y
 * respetar"): a candidate with an unresolved dependency — any blocker not
 * done/cancelled — is NOT started; it stays pending with its visible wait
 * (the semáforo + "Espera a" the reads carry) and a later cycle picks it up
 * once the blocker releases. Missing blockers never wait (delete purges
 * them). Exported for todo-autoplay-service (both pickup paths). In-flight
 * work is never interrupted: stuck re-wakes and orphaned working starts are
 * NOT gated — only new starts are.
 */
export async function startableTasks<T extends TodoNode>(
  db: Db,
  wsId: string,
  candidates: T[],
): Promise<{ startable: T[]; waiting: Array<{ node: T; reason: string }> }> {
  const ids = [...new Set(candidates.flatMap((n) => dependenciesOf(n)))];
  if (ids.length === 0) return { startable: candidates, waiting: [] };
  const blockers = await nodes(db)
    .find(
      { workspaceId: wsId, nodeId: { $in: ids } },
      { projection: { _id: 0, nodeId: 1, text: 1, kind: 1, state: 1, completed: 1 } },
    )
    .toArray();
  const byId = new Map<string, TodoNode>(blockers.map((b) => [b.nodeId, b as TodoNode]));
  const startable: T[] = [];
  const waiting: Array<{ node: T; reason: string }> = [];
  for (const n of candidates) {
    const deps = dependenciesOf(n);
    if (deps.length === 0) {
      startable.push(n);
      continue;
    }
    const unresolved: TodoNode[] = [];
    for (const id of deps) {
      const b = byId.get(id);
      if (b && !isReleased(stateOf(b))) unresolved.push(b);
    }
    if (unresolved.length === 0) startable.push(n);
    else {
      waiting.push({
        node: n,
        reason: `waits on ${unresolved.map((b) => `"${b.text}" (${stateOf(b)})`).join(', ')}`,
      });
    }
  }
  return { startable, waiting };
}

/**
 * Release trigger (TODODEP): tasks that just reached done/cancelled may
 * unblock their dependents — run their assignees' scheduling cycles (and the
 * unassigned pickers when a waiting task has no assignee), so a released
 * task starts on the next cycle (≤ the 60 s safety net when the trigger
 * races). Fire-and-forget per dependent, like every scheduling trigger.
 */
async function scheduleDependentsOf(db: Db, wsId: string, finishedIds: string[]): Promise<void> {
  if (finishedIds.length === 0) return;
  const dependents = await nodes(db)
    .find(
      { workspaceId: wsId, dependencies: { $in: finishedIds }, kind: { $ne: 'group' } },
      { projection: { _id: 0, nodeId: 1, kind: 1, assignee: 1 } },
    )
    .toArray();
  for (const d of dependents) scheduleFor(wsId, d);
  if (dependents.some((d) => !assigneeOf(d))) void autoplay()?.scheduleUnassignedPickers(wsId);
}

/** Today's calendar day in UTC — only a fallback; callers should send their own `today`. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function notATask(nodeId: string, what: string): never {
  return fail(
    'NOT_A_TASK',
    `Node "${nodeId}" is a group; groups have no ${what}.`,
    'Convert it to a task first with set-kind, or use a task node.',
  );
}

function groupInTask(): never {
  return fail(
    'GROUP_IN_TASK',
    'A task cannot contain groups.',
    'Put the group at root level or inside another group, or convert the parent to a group with set-kind.',
  );
}

/**
 * Atomic write of one node: `$set` (+ `updatedAt`), optional `$unset` and an
 * optional log entry (text + actor, TODOLG-REQ-1), in a single
 * findOneAndUpdate. `guard` adds conditions to the filter (optimistic
 * concurrency). Scope: { workspaceId, nodeId }.
 * Exported for the autoplay service (channel link, re-wake count).
 * @spec TODOAP-REQ-5
 * @spec TODOLG-REQ-1
 */
export async function writeNode(
  db: Db,
  wsId: string,
  nodeId: string,
  changes: { $set?: Record<string, unknown>; $unset?: string[]; log?: LogWrite; guard?: Document },
): Promise<TodoNode | null> {
  const now = Date.now();
  const update: Document = { $set: { ...(changes.$set ?? {}), updatedAt: now } };
  if (changes.$unset && changes.$unset.length > 0) {
    update.$unset = Object.fromEntries(changes.$unset.map((f) => [f, '']));
  }
  if (changes.log) {
    update.$push = { log: logEntry(changes.log, now) };
  }
  const result = await nodes(db).findOneAndUpdate(
    { ...(changes.guard ?? {}), workspaceId: wsId, nodeId },
    update,
    { returnDocument: 'after' },
  );
  return result || null;
}

/**
 * Auto-escalation (Pablo, 2026-10-25): a task entering `working` pulls its
 * pending ancestors into `working` too, so the parent shows the working tint
 * instead of staying "to do" while work happens inside. Walks up the parentId
 * chain and escalates only ancestors that are tasks in `pending` (the
 * pending → working transition); the first ancestor in any other state —
 * planning, blocked, review, done, already working, a group or a missing
 * node — stops the walk, so a human-set state is never overwritten. Each
 * escalation is its own write with an optimistic guard and the distinguishable
 * log "Auto: child started working". No automatic reverse in v1: a child
 * leaving `working` never degrades its parent.
 */
async function escalatePendingAncestors(db: Db, wsId: string, leafParentId: string | null): Promise<void> {
  let parentId = leafParentId;
  while (parentId !== null) {
    const ancestor = await nodes(db).findOne(
      { workspaceId: wsId, nodeId: parentId },
      { projection: { _id: 0, nodeId: 1, kind: 1, state: 1, parentId: 1, completed: 1 } },
    );
    if (!ancestor || kindOf(ancestor) === 'group' || stateOf(ancestor) !== 'pending') return;
    // Legacy-aware optimistic guard, same pattern as set-state's own guard.
    const guard: Document = ancestor.state ? { state: 'pending' } : { state: { $exists: false } };
    const escalated = await writeNode(db, wsId, ancestor.nodeId, {
      $set: { state: 'working', completed: false },
      guard,
      log: { text: 'Auto: child started working', actor: SYSTEM_ACTOR },
    });
    if (!escalated) return; // raced with a concurrent change — leave the chain alone
    parentId = ancestor.parentId ?? null;
  }
}

/**
 * The state write every transition goes through — set-state, the autoplay
 * start (TODOAP-REQ-5) and the auto-wake exhaustion (TODOAP-REQ-7):
 *   - `blockedReason` is the reason when entering `blocked`, null otherwise;
 *   - entering review/done sets progress 100, leaving them for an open state
 *     clears a stored 100 (the automatic value) and keeps any other value;
 *   - the re-wake count resets (TODOAP-REQ-7) and leaving `working` clears the
 *     running flag (TODOAP-REQ-8);
 *   - optimistic guard on the state the transition was validated from;
 *   - entering `working` escalates the pending ancestors.
 * Returns the post-write node, or null when the guard missed (CONFLICT).
 * The caller validates the transition and names the actor of the log line
 * (TODOLG-REQ-1). Scope: { workspaceId, nodeId }.
 * @spec TODOAP-REQ-5
 * @spec TODOLG-REQ-1
 */
export async function writeStateTransition(
  db: Db,
  wsId: string,
  node: TodoNode,
  to: NodeState,
  options: { reason?: string | null; log?: string; actor: LogActor },
): Promise<TodoNode | null> {
  const from = stateOf(node) as NodeState;
  const reason = options.reason ?? null;
  const $set: Record<string, unknown> = {
    state: to,
    completed: to === 'done',
    blockedReason: to === 'blocked' ? reason : null,
    autoWakeCount: 0,
    startFailCount: 0,
  };
  // Archive: when the task finished (done/cancelled) and when it left those
  // states. Powers archive-finished's olderThanDays.
  if (to === 'done' || to === 'cancelled') $set.completedAt = Date.now();
  else if (from === 'done' || from === 'cancelled') $set.completedAt = null;
  // Leaving `blocked` spends the Claude Code runner's session-block marker
  // (runner.sessionQuestion — the terminal question its watch blocked on):
  // the block it referred to is gone, and a later block that just happens to
  // reuse the same words must never be mistaken for it and auto-lifted
  // (reminder-loop fix, 1-nov). $unset, not $set: null — a task without a
  // runner record must not grow one.
  const $unset = from === 'blocked' && to !== 'blocked' ? ['runner.sessionQuestion'] : undefined;
  // review/done mean "work finished": entering them sets 100%. Leaving them
  // for an open state clears a stored 100 (taken as the automatic value)
  // and keeps any other value a human or agent set.
  const finished = (s: NodeState) => s === 'review' || s === 'done';
  if (finished(to)) $set.progress = 100;
  else if (finished(from) && node.progress === 100) $set.progress = null;
  if (from === 'working' && to !== 'working') $set.running = false;
  // cancelled (Pablo, 2026-10-30): the task leaves the day plan entirely —
  // it shows in neither the day's list, overdue nor unplanned-open. The
  // stored progress is dropped (a cancelled task reports nothing); reopening
  // to pending starts clean.
  if (to === 'cancelled') {
    $set.plannedFor = null;
    $set.dayOrder = null;
    $set.plannedTime = null;
    $set.progress = null;
    // TODODEP: a cancelled task waits on nothing (it is not happening); like
    // the plan fields, reopening starts clean. Inbound references are KEPT —
    // cancelled releases them (green), and the block returns if it reopens.
    $set.dependencies = [];
  }

  // Optimistic guard: the state we validated the transition from.
  const guard: Document = node.state ? { state: node.state } : { state: { $exists: false } };
  const updated = await writeNode(db, wsId, node.nodeId, {
    $set,
    ...($unset ? { $unset } : {}),
    guard,
    log: { text: options.log ?? `${from} → ${to}${reason ? `: ${reason}` : ''}`, actor: options.actor },
  });
  if (!updated) return null;
  // Auto-escalation (Pablo, 2026-10-25): a task entering `working` pulls
  // its pending ancestors into `working` too (see escalatePendingAncestors).
  if (to === 'working') {
    await escalatePendingAncestors(db, wsId, updated.parentId);
  }
  return updated;
}

/** The autoplay service, when the backend wired it (McaActionDeps). */
function autoplay(): TodoAutoplayService | undefined {
  return getMcaActionDeps().todoAutoplay;
}

function requireAutoplay(): TodoAutoplayService {
  const svc = autoplay();
  if (!svc) return fail('UNAVAILABLE', 'Tasks autoplay is not available.', undefined, 503);
  return svc;
}

/**
 * The to-do subscription service, when the backend wired it (McaActionDeps).
 * Event emission is best-effort: when the service is missing (tests, partial
 * boot) the mutations still succeed, they just emit nothing.
 */
function subscriptions(): TodoSubscriptionService | undefined {
  return getMcaActionDeps().todoSubscriptions;
}

/** Output reference for completion events: format + file name/url when set. */
function outputRefOf(
  node: Pick<TodoNode, 'output'>,
): { format: string; name?: string; url?: string } | null {
  const o = node.output;
  if (!o) return null;
  return o.format === 'file'
    ? { format: o.format, name: o.name, url: o.url }
    : { format: o.format };
}

/**
 * Emit a to-do event for a node mutation — best-effort, never throws, no-op
 * without the subscription service. `node` is the post-mutation document
 * (or a summary carrying the fields the emitters read).
 */
function emitFor(
  wsId: string,
  node: Pick<TodoNode, 'nodeId' | 'text' | 'parentId' | 'state' | 'assignee' | 'channelId'> | null | undefined,
  emit: (svc: TodoSubscriptionService, wsId: string) => void,
): void {
  if (!node) return;
  const svc = subscriptions();
  if (!svc) return;
  try {
    emit(svc, wsId);
  } catch (err) {
    console.error('[todo] event emission failed:', err);
  }
}

/**
 * Run the scheduling cycle of the agent a task is assigned to, when it is an
 * agent (TODOAP-REQ-18). Fire and forget: the write that triggered it never
 * waits for or fails on scheduling.
 */
function scheduleFor(wsId: string, node: Pick<TodoNode, 'kind' | 'assignee'>): void {
  const a = assigneeOf(node);
  if (!a || a.kind !== 'agent') return;
  void autoplay()?.scheduleAgentTasks(wsId, a.id);
}

/**
 * The reviewer notification (TODORV — docs/specs/todo/reviewer.md): when a
 * task WITH a reviewer enters `review`, tell the reviewer structurally — no
 * hand-made subscription needed (the pattern Alice simulated becomes the
 * product). For an agent reviewer the notification goes to their most recent
 * conversation in the workspace: it lands as a system message and wakes the
 * agent (the self-wake guard in event-handler covers the executor-is-reviewer
 * case). A reviewer agent with no conversation yet still sees the task — the
 * get-tree reviewer filter and the reviewerIds subscription filter both
 * surface it. Human reviewers see it in their pending view (the UI's "mine"
 * filter includes review tasks they review). Fire-and-forget, never throws.
 */
async function notifyReviewer(
  db: Db,
  wsId: string,
  node: TodoNode,
  from: NodeState,
  actor: { kind: 'user' | 'agent' | 'system'; id?: string },
): Promise<void> {
  const reviewer = reviewerOf(node);
  if (!reviewer || reviewer.kind !== 'agent') return;
  // CCR-REQ-7: a Claude Code runner reviews in a terminal session of its own,
  // not in a conversation — there is none to inject into.
  const reviewerAgent = await db
    .collection('agents')
    .findOne({ agentId: reviewer.id }, { projection: { runner: 1 } });
  if (reviewerAgent?.runner === 'claude-code') {
    const runner = getMcaActionDeps().claudeCodeRunner;
    if (!runner) {
      console.warn(`[todo] CCR: reviewer ${reviewer.id} is a Claude Code runner but no runner is wired`);
      return;
    }
    const ws = await db.collection('workspaces').findOne({ workspaceId: wsId }, { projection: { ownerId: 1 } });
    if (typeof ws?.ownerId !== 'string' || ws.ownerId === '') return;
    runner.startReview(wsId, node, reviewer.id, ws.ownerId).catch((err) => {
      console.error(`[todo] CCR: review session for task ${node.nodeId} failed:`, err);
    });
    return;
  }
  const svc = subscriptions();
  if (!svc) return;
  try {
    const channel = await db.collection('channels').findOne(
      { workspaceId: wsId, agentId: reviewer.id, status: 'active' },
      { sort: { lastMessageAt: -1 }, projection: { _id: 0, channelId: 1 } },
    );
    if (!channel) {
      console.log(
        `[todo] TODORV: reviewer agent ${reviewer.id} has no conversation in workspace ${wsId} — ` +
          `task ${node.nodeId} in review is visible to them via the reviewer filters only`,
      );
      return;
    }
    const assignee = assigneeOf(node);
    svc.injectIntoChannel(
      channel.channelId as string,
      `Task "${node.text}" entered review and you are its reviewer. ` +
        `Read it with todo-list get-node (nodeId "${node.nodeId}") — it carries the delivered output — ` +
        `then accept it (set-state to "done") or send it back (set-state to "working" with a "reply" saying what is missing).`,
      {
        workspaceId: wsId,
        nodeId: node.nodeId,
        text: node.text,
        parentId: node.parentId,
        state: 'review',
        fromState: from,
        channelId: node.channelId ?? null,
        ...(assignee ? { assigneeKind: assignee.kind, assigneeId: assignee.id } : {}),
        reviewerKind: reviewer.kind,
        reviewerId: reviewer.id,
        ...actorFromLogActor(actor),
      },
      'task_completed',
    );
  } catch (err) {
    console.error('[todo] TODORV: reviewer notification failed:', err);
  }
}

/**
 * An unassigned task may have become eligible: run the cycle of every playing
 * runner of the workspace that picks up unassigned tasks (TODOAP-REQ-22).
 * Fire and forget, like scheduleFor.
 */
function scheduleUnassigned(wsId: string, node: Pick<TodoNode, 'kind' | 'assignee'>): void {
  if (kindOf(node) === 'group' || assigneeOf(node)) return;
  void autoplay()?.scheduleUnassignedPickers(wsId);
}

/**
 * The person an action acts for (`callerUserId`, filled by the thin client
 * from the execution context): must be the owner or an active member of the
 * workspace, else FORBIDDEN. Returns the userId and the workspace role.
 */
async function requireCaller(
  db: Db,
  wsId: string,
  callerUserId: string | undefined,
): Promise<{ userId: string; role: 'owner' | 'admin' | 'write' | 'read' }> {
  if (!callerUserId) return forbidden();
  const ws = await collection(db, COLLECTIONS.workspaces).findOne({ workspaceId: wsId }, { projection: { ownerId: 1 } });
  if (ws?.ownerId === callerUserId) return { userId: callerUserId, role: 'owner' };
  const m = await collection(db, COLLECTIONS.workspaceMembers)
    .findOne({ workspaceId: wsId, userId: callerUserId, status: { $ne: 'pending' } }, { projection: { role: 1 } });
  if (!m) return forbidden();
  const role = m.role === 'admin' || m.role === 'write' ? m.role : 'read';
  return { userId: callerUserId, role };
}

/**
 * Extensions → MIME types for a file delivered by `path` (name/mime not given).
 * Mirrors the map in http-file-handler.ts; unknown extensions fall back to
 * application/octet-stream.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** The workspace volume's VolumeService, injected by server-bootstrap (see getMcaActionDeps). */
function volumeService(): VolumeService {
  const { volumeService: vol } = getMcaActionDeps();
  if (!vol) {
    return fail(
      'UNAVAILABLE',
      'Reading a file from the workspace volume is not available in this deployment.',
      'Deliver the file as base64 `data` instead, or ask the operator to restart the backend with the volume service wired.',
      503,
    );
  }
  return vol;
}

/**
 * Read a `path`-delivered file from the calling workspace's volume and return
 * the pieces storeIO needs: base64 content, name and mime. The path must be
 * absolute and inside the volume's container mount ('/workspace/...') — the
 * same guard family as messaging send-file (resolveVolumeHostPath rejects
 * traversal and non-volume paths).
 */
async function readVolumeFile(
  db: Db,
  ctx: McaActionCtx,
  wsId: string,
  file: { path: string; name?: string; mime?: string },
): Promise<{ data: string; name: string; mime: string }> {
  const p = file.path;
  // The documented contract: an absolute path inside the workspace volume's
  // container mount. resolveVolumeHostPath would join any other path INTO the
  // volume (contained but confusing) — reject it with a clear error instead.
  if (!p.startsWith('/workspace/') && p !== '/workspace') {
    return fail(
      'INVALID_INPUT',
      `path must be an absolute path inside the workspace volume ("/workspace/..."), got "${p}".`,
      'Use a path like "/workspace/report.html".',
    );
  }
  const deps = getMcaActionDeps();
  let hostPath: string;
  try {
    hostPath = await resolveVolumeHostPath(p, wsId, db, volumeService(), deps.workspaceService ?? null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('INVALID_INPUT', `Cannot resolve path "${p}" in the workspace volume: ${message}`);
  }
  let size: number;
  try {
    size = (await stat(hostPath)).size;
  } catch {
    return fail('FILE_NOT_FOUND', `File not found in the workspace volume: "${p}".`, 'Write the file first (e.g. with the filesystem tools), then set-output with its path.', 404);
  }
  if (size > MAX_IO_FILE_BYTES) {
    return fail('FILE_TOO_LARGE', `File too large: ${size} bytes (max ${MAX_IO_FILE_BYTES}).`);
  }
  let content: Buffer;
  try {
    content = await readFile(hostPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('FILE_NOT_FOUND', `Could not read "${p}" from the workspace volume: ${message}`, undefined, 404);
  }
  const name = file.name?.trim() || basename(p);
  const mime = file.mime?.trim() || MIME_BY_EXT[extname(name).toLowerCase()] || 'application/octet-stream';
  return { data: content.toString('base64'), name, mime };
}

/**
 * Overwrite protection (roadmap incident, 28-oct): a set-input/set-output that
 * would REPLACE an existing io with a different one is rejected unless the
 * caller passes overwrite: true. Re-delivering the exact same thing (same
 * markdown text, same form field ids) is a no-op and stays allowed —
 * outputLogEntry already treats it as "nothing new". First delivery (no
 * previous io) never needs the flag.
 *
 * The comparison runs on the STORED shape, not the raw input: for a file we
 * cannot compare objectIds before uploading (every upload mints a new one), so
 * any file delivery over an existing io counts as a change and requires the
 * flag; identical markdown text and identical form field-id sets do not.
 */
function requireOverwrite(
  slot: 'input' | 'output',
  previous: NodeIO | null,
  next: NormalizedIO,
  opts: { overwrite?: boolean; state?: NodeState | null; savedAt?: number | null },
): void {
  if (!previous || opts.overwrite === true) return;
  if (previous.format === next.format) {
    if (next.format === 'markdown' && previous.format === 'markdown' && previous.markdown === next.markdown) return;
    if (next.format === 'form' && previous.format === 'form') {
      const ids = (io: { fields: FormField[] }) => [...new Set(io.fields.map((f) => f.id))].sort().join('\u0000');
      if (ids(previous) === ids(next)) return;
    }
    // file over file: a new upload always mints a new objectId → a change.
  }
  const what = previous.format === 'file' ? `file ${previous.name}` : previous.format;
  const delivered = slot === 'output' && (opts.state === 'review' || opts.state === 'done');
  // A cancelled task does not "deliver" (Pablo, 2026-10-30): its output logs
  // as a plain save, like any open task's.
  let when = delivered ? 'delivered' : 'saved';
  if (opts.savedAt) {
    const d = new Date(opts.savedAt);
    when += ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return fail(
    'OUTPUT_EXISTS',
    `This task already has an ${slot} (${what}, ${when}). Set overwrite: true to replace it, or clear it first with set-${slot} null.`,
    'Read the node with get-node, decide deliberately, then re-send with overwrite: true if you really want to replace it.',
  );
}

/**
 * Fill a file io's name/mime from its path (when the caller omitted them) so
 * the shape checks see the same values storeIO will store. Pure — no
 * filesystem access. A data-delivered file still needs explicit name and mime
 * (the pre-path contract); only a path can infer them.
 */
function normalizeFileIO(io: IOInput): NormalizedIO {
  if (io.format !== 'file') return io;
  // Fail fast on a malformed file io — before the overwrite guard, so a bad
  // shape never masquerades as a refusal to overwrite.
  if (!io.data && !io.path) {
    return fail('INVALID_INPUT', 'A file io needs either data (base64) or path (inside the workspace volume).');
  }
  if (io.data && io.path) {
    return fail('INVALID_INPUT', 'Provide either data or path for a file io, not both.');
  }
  if (io.data && (!io.name?.trim() || !io.mime?.trim())) {
    return fail('INVALID_INPUT', 'A file io sent as data needs name and mime (they are optional only with path).');
  }
  const name = io.name?.trim() || (io.path ? basename(io.path) : '');
  const mime = io.mime?.trim() || (io.path ? MIME_BY_EXT[extname(name).toLowerCase()] || 'application/octet-stream' : '');
  if (!name || !mime) {
    return fail('INVALID_INPUT', 'A file io needs either data (with name and mime) or path (inside the workspace volume).');
  }
  return { ...io, name, mime };
}

/**
 * Turn a caller NodeIO into the stored NodeIO. A file is uploaded to the
 * agent-apps object storage (the `file_object_put` implementation, namespaced
 * by the todo app id as installationId) and replaced by its reference.
 */
async function storeIO(
  db: Db,
  ctx: McaActionCtx,
  wsId: string,
  nodeId: string,
  slot: 'input' | 'output',
  io: NormalizedIO,
): Promise<NodeIO> {
  if (io.format === 'markdown') return { format: 'markdown', markdown: io.markdown };
  if (io.format === 'form') {
    const ids = new Set<string>();
    for (const field of io.fields) {
      if (ids.has(field.id)) fail('INVALID_INPUT', `Duplicate form field id "${field.id}".`);
      ids.add(field.id);
    }
    for (const key of Object.keys(io.values)) {
      if (!ids.has(key)) fail('INVALID_INPUT', `Form value "${key}" has no matching field.`);
    }
    return { format: 'form', fields: io.fields, values: io.values };
  }

  // A file arrives as base64 `data` or as a volume `path` the backend reads.
  if (!io.data && !io.path) {
    return fail('INVALID_INPUT', 'A file io needs either data (base64) or path (inside the workspace volume).');
  }
  if (io.data && io.path) {
    return fail('INVALID_INPUT', 'Provide either data or path for a file io, not both.');
  }
  const file = io.path
    ? await readVolumeFile(db, ctx, wsId, { path: io.path, name: io.name, mime: io.mime })
    : { data: io.data!, name: io.name, mime: io.mime };

  const size = Buffer.byteLength(file.data, 'base64');
  if (size > MAX_IO_FILE_BYTES) {
    fail('FILE_TOO_LARGE', `File too large: ${size} bytes (max ${MAX_IO_FILE_BYTES}).`);
  }
  const store = new CallbackHandlers({
    db,
    objectStoragePath: config.agentApps.objectStoragePath,
    maxObjectSize: MAX_IO_FILE_BYTES,
  });
  const put = await store.handle({
    type: 'file_object_put',
    installationId: ctx.appId as string,
    data: file.data,
    contentType: file.mime,
    metadata: { workspaceId: wsId, nodeId, slot, name: file.name },
  });
  if (!put.success || !('objectId' in put) || !('url' in put)) {
    const reason = 'error' in put && put.error ? put.error : 'unknown error';
    return fail('UPLOAD_FAILED', `Could not store the file: ${reason}`, undefined, 500);
  }
  return { format: 'file', objectId: put.objectId, url: put.url, name: file.name, mime: file.mime, size };
}

/** Short human description of a NodeIO for the log ("markdown", "form", "file report.pdf"). */
/** Extensions and mime types each expected file type accepts (TODOAP-REQ-15). */
const FILE_TYPE_MATCH: Record<Exclude<OutputFileType, 'other'>, { ext: string[]; mime: string[] }> = {
  pdf: { ext: ['pdf'], mime: ['application/pdf'] },
  docx: { ext: ['docx'], mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  xlsx: { ext: ['xlsx'], mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  csv: { ext: ['csv'], mime: ['text/csv'] },
  png: { ext: ['png'], mime: ['image/png'] },
  jpg: { ext: ['jpg', 'jpeg'], mime: ['image/jpeg'] },
  json: { ext: ['json'], mime: ['application/json'] },
  md: { ext: ['md', 'markdown'], mime: ['text/markdown'] },
  txt: { ext: ['txt'], mime: ['text/plain'] },
  html: { ext: ['html', 'htm'], mime: ['text/html'] },
};

/**
 * What differs between an output and the task's expected output, or null when
 * it matches: the format; for `file`, the file type (the name's extension or
 * the mime must be one the type accepts; `other` accepts any); for `form`, a
 * required field of the definition that is missing or a field not in it
 * (optional fields may be omitted).
 * @spec TODOAP-REQ-15
 */
function outputMismatch(expected: ExpectedOutput, output: NormalizedIO): string | null {
  if (output.format !== expected.format) {
    return `expected format "${expected.format}", got "${output.format}"`;
  }
  if (output.format === 'file' && expected.fileType && expected.fileType !== 'other') {
    const match = FILE_TYPE_MATCH[expected.fileType];
    const dot = output.name.lastIndexOf('.');
    const ext = dot >= 0 ? output.name.slice(dot + 1).toLowerCase() : '';
    const mime = output.mime.toLowerCase().split(';')[0].trim();
    if (!match.ext.includes(ext) && !match.mime.includes(mime)) {
      return `expected a ${expected.fileType} file, got "${output.name}" (${output.mime})`;
    }
  }
  if (output.format === 'form' && expected.fields) {
    const given = new Set(output.fields.map((f) => f.id));
    const defined = new Set(expected.fields.map((f) => f.id));
    const missing = expected.fields.filter((f) => f.required === true && !given.has(f.id)).map((f) => f.id);
    const extra = output.fields.filter((f) => !defined.has(f.id)).map((f) => f.id);
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required field(s) ${missing.map((id) => `"${id}"`).join(', ')}`);
    if (extra.length > 0) parts.push(`field(s) not in the definition ${extra.map((id) => `"${id}"`).join(', ')}`);
    if (parts.length > 0) return parts.join('; ');
  }
  return null;
}

/**
 * The log entry a set-output writes, or null for a save that only changes the
 * values of an existing form while the task is open. It is written only when
 * there was no output, the output is cleared, the format changes, a form's
 * set of field ids changes, a file's stored object changes, a markdown's text
 * changes, or the task is in review/done.
 * @spec TODOAP-REQ-17
 */
function outputLogEntry(previous: NodeIO | null, next: NodeIO | null, state: NodeState | null): string | null {
  if (!next) return 'Output cleared';
  const entry = `Output delivered · ${describeIO(next)}`;
  if (!previous || previous.format !== next.format || state === 'review' || state === 'done') return entry;
  if (previous.format === 'form' && next.format === 'form') {
    const ids = (io: { fields: FormField[] }) => [...new Set(io.fields.map((f) => f.id))].sort().join('\u0000');
    return ids(previous) !== ids(next) ? entry : null;
  }
  if (previous.format === 'file' && next.format === 'file') return previous.objectId !== next.objectId ? entry : null;
  if (previous.format === 'markdown' && next.format === 'markdown') return previous.markdown !== next.markdown ? entry : null;
  return entry;
}

function describeIO(io: NodeIO): string {
  return io.format === 'file' ? `file ${io.name}` : io.format;
}

/** Markdown task-list item: `- [ ] text`, `* [x] text`, `1. [ ] text`. */
const CHECKBOX_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/**
 * Toggle the `index`-th (0-based) markdown checkbox of `markdown`, skipping
 * fenced code blocks. Returns null when there is no such item.
 */
function toggleChecklistItem(
  markdown: string,
  index: number,
): { markdown: string; checked: boolean; text: string } | null {
  const lines = markdown.split('\n');
  let inFence = false;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_LINE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(CHECKBOX_LINE);
    if (!m) continue;
    if (seen++ !== index) continue;
    const checked = m[2] === ' ';
    lines[i] = `${m[1]}${checked ? 'x' : ' '}${m[3]}`;
    return { markdown: lines.join('\n'), checked, text: m[3].slice(1).trim() };
  }
  return null;
}

/** Owner or active member of the workspace (the owner is implicit, never a member row). */
async function isWorkspaceMember(db: Db, wsId: string, userId: string): Promise<boolean> {
  const ws = await db.collection('workspaces').findOne({ workspaceId: wsId }, { projection: { ownerId: 1 } });
  if (ws?.ownerId === userId) return true;
  const m = await db
    .collection('workspace_members')
    .findOne({ workspaceId: wsId, userId, status: { $ne: 'pending' } }, { projection: { _id: 1 } });
  return Boolean(m);
}

/**
 * Validate an assignee for the node's workspace and return its display name:
 *   - user: the workspace owner or an active member;
 *   - agent: an agent of the workspace, or a superagent (no workspace) whose
 *     owner is the owner / an active member of it (the per-user rule of
 *     services/channel-authz usableAgentFilter, for everyone in the workspace).
 * Anything else fails with INVALID_ASSIGNEE (existence of other workspaces'
 * agents/users is not revealed).
 */
async function resolveAssignee(db: Db, wsId: string, a: Assignee): Promise<string> {
  const invalid = (): never =>
    fail(
      'INVALID_ASSIGNEE',
      `${a.kind === 'agent' ? 'Agent' : 'User'} "${a.id}" cannot be assigned in this workspace.`,
      a.kind === 'agent'
        ? 'Use an agent of this workspace (or a personal agent of one of its members).'
        : 'Use the userId of the workspace owner or of an active member.',
    );
  if (a.kind === 'user') {
    if (!(await isWorkspaceMember(db, wsId, a.id))) return invalid();
    const u = await db.collection('users').findOne({ userId: a.id }, { projection: { profile: 1, email: 1 } });
    return (u?.profile?.displayName as string) || (u?.profile?.email as string) || a.id;
  }
  const agent = await db
    .collection('agents')
    .findOne({ agentId: a.id }, { projection: { workspaceId: 1, ownerId: 1, name: 1, fullName: 1 } });
  if (!agent) return invalid();
  const agentWs = agent.workspaceId;
  if (typeof agentWs === 'string' && agentWs !== '') {
    if (agentWs !== wsId) return invalid();
  } else if (typeof agent.ownerId !== 'string' || !(await isWorkspaceMember(db, wsId, agent.ownerId))) {
    return invalid();
  }
  return (agent.name as string) || (agent.fullName as string) || a.id;
}

/**
 * Renumber a day's plan to contiguous dayOrder 0..N-1, keeping the current
 * order (ties by tree position). Does NOT touch updatedAt.
 * Scope: { workspaceId, plannedFor }.
 */
async function renumberDay(db: Db, wsId: string, day: string): Promise<void> {
  const list = await nodes(db)
    .find({ workspaceId: wsId, plannedFor: day })
    .sort({ dayOrder: 1, position: 1 })
    .project<{ nodeId: string }>({ nodeId: 1 })
    .toArray();
  const ops = list.map((n, i) => ({
    updateOne: { filter: { workspaceId: wsId, nodeId: n.nodeId }, update: { $set: { dayOrder: i } } },
  }));
  if (ops.length > 0) await nodes(db).bulkWrite(ops);
}

/** A task as the day view lists it: the row fields plus its ancestors' titles. */
interface DayTask {
  nodeId: string;
  parentId: string | null;
  text: string;
  state: NodeState;
  blockedReason: string | null;
  progress: number | null;
  reportedProgress: number | null;
  plannedFor: string | null;
  dayOrder: number | null;
  plannedTime: string | null;
  hasOutput: boolean;
  assignee: Assignee | null;
  reviewer: Assignee | null;
  channelId: string | null;
  running: boolean;
  autoWakeCount: number;
  startFailCount: number;
  expectedOutput: ExpectedOutput | null;
  outputUpdatedAt: number | null;
  /** TODODEP — nodeIds this task waits on ([] when none). */
  dependencies: string[];
  /** TODODEP — the semáforo (board parity). */
  blockStatus: BlockStatus;
  /** TODODEP — direct blockers with their current state. */
  blockers: DependencyRef[];
  /** TODODEP — the tasks that wait on this one (the inverse). */
  dependents: DependencyRef[];
  /** Ancestor titles, root first ("Teros", "Launch"). */
  path: string[];
}

/**
 * Build the nested tree from the whole workspace (already loaded, sorted by
 * position). depth = -1: unlimited; 0: root level only (children omitted);
 * N: N levels below. With rootId, returns `[root]` or `[]` (no error).
 */
function buildFormattedTree(allNodes: TodoNode[], rootId: string | null, depth: number): FormattedNode[] {
  const childrenMap = new Map<string | null, TodoNode[]>();
  for (const n of allNodes) {
    const key = n.parentId;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(n);
  }
  const progress = effectiveProgressMap(allNodes);
  // TODODEP: the semáforo of every node (computed over the WHOLE workspace
  // load — scoping must not change who waits on whom) and the inverse edges.
  const byId = new Map(allNodes.map((n) => [n.nodeId, n]));
  const depStatus = dependencyStatusMap(allNodes);
  const dependents = dependentsMapOf(allNodes);

  function format(n: TodoNode): FormattedNode {
    const kids = childrenMap.get(n.nodeId) ?? [];
    return {
      nodeId: n.nodeId,
      parentId: n.parentId,
      text: n.text,
      description: n.description ?? '',
      kind: kindOf(n),
      state: stateOf(n),
      blockedReason: n.blockedReason ?? null,
      completed: n.completed,
      collapsed: n.collapsed,
      position: n.position,
      progress: progress.get(n.nodeId) ?? null,
      reportedProgress: reportedProgressOf(n),
      hasInput: Boolean(n.input),
      hasOutput: Boolean(n.output),
      ...planOf(n),
      assignee: assigneeOf(n),
      reviewer: reviewerOf(n),
      ...autoplayOf(n),
      ...dependencyFieldsOf(n, byId, depStatus, dependents),
      archived: archivedOf(n),
      archivedAt: n.archivedAt ?? null,
      completedAt: completedAtOf(n),
      childCount: kids.length,
      completedChildren: kids.filter((k) => stateOf(k) === 'done').length,
    };
  }

  function buildTree(parentId: string | null, currentDepth: number): FormattedNode[] {
    const children = childrenMap.get(parentId) ?? [];
    const canRecurse = depth === -1 || currentDepth < depth;
    return children.map((n) => {
      const base = format(n);
      if (canRecurse && base.childCount > 0) {
        const kids = buildTree(n.nodeId, currentDepth + 1);
        return { ...base, children: kids };
      }
      return base;
    });
  }

  if (rootId) {
    const rootNode = allNodes.find((n) => n.nodeId === rootId);
    if (!rootNode) return [];
    const base = format(rootNode);
    const canRecurse = depth === -1 || depth > 0;
    if (canRecurse && base.childCount > 0) {
      const tree = buildTree(rootId, 1);
      return [{ ...base, children: tree }];
    }
    return [base];
  }

  return buildTree(null, 0);
}

// =============================================================================
// Capability
// =============================================================================

export const todoCapability: McaActionCapability = {
  mcaId: MCA_ID,
  actions: {
    /**
     * Liveness of the action channel. Touches no tenant data, so it is the one
     * action that does not resolve the workspace (a container's health check
     * must not flip to not_ready over tenancy).
     */
    async ping() {
      return { ok: true };
    },

    /**
     * Former add-node. Scope: parent check { workspaceId, nodeId: parentId };
     * position = countDocuments({ workspaceId, parentId }) (non-atomic append,
     * as before); insertOne with workspaceId.
     * `kind` defaults to task, a task's `state` to pending. A group cannot go
     * inside a task, has no state, and `blocked` needs a reason (set-state).
     */
    async 'add-node'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(AddNodeSchema, body);
      const parentId = input.parentId ?? null;
      const kind: NodeKind = input.kind ?? 'task';
      if (kind === 'group' && input.state !== undefined) {
        return fail('INVALID_INPUT', 'A group has no state.', 'Omit "state" when kind is "group".');
      }
      if (kind === 'group' && input.expectedOutput !== undefined) {
        return fail('INVALID_INPUT', 'A group has no output.', 'Omit "expectedOutput" when kind is "group".');
      }
      if (input.state === 'blocked') {
        return fail(
          'REASON_REQUIRED',
          'A task cannot be created blocked.',
          'Create it, then call set-state with state "blocked" and a reason.',
        );
      }

      // Validate parent exists in this workspace — a wrong or truncated parentId
      // must fail loudly instead of silently creating an invisible orphan node.
      let parent: { text?: string; kind?: NodeKind } | null = null;
      if (parentId !== null) {
        parent = await nodes(db).findOne(
          { workspaceId: wsId, nodeId: parentId },
          { projection: { _id: 1, text: 1, kind: 1 } },
        );
        if (!parent) {
          return notFound(
            `Parent node not found: ${parentId}`,
            'The parentId does not exist in this workspace. Get valid IDs with get-tree or search-nodes — the ID may be truncated or belong to another workspace.',
          );
        }
        if (kind === 'group' && kindOf(parent) === 'task') return groupInTask();
      }

      // Determine position: append at end of siblings
      const siblingCount = await nodes(db).countDocuments({ workspaceId: wsId, parentId });

      const now = Date.now();
      const state: NodeState | null = kind === 'task' ? (input.state ?? 'planning') : null;
      const node: TodoNode = {
        nodeId: generateId('tn'),
        parentId,
        workspaceId: wsId,
        text: input.text,
        description: input.description ?? '',
        instructions: input.instructions ?? '',
        completed: state === 'done',
        collapsed: false,
        position: siblingCount,
        log: [],
        createdAt: now,
        updatedAt: now,
        kind,
        input: null,
        ...(state !== null
          ? { state, blockedReason: null, progress: state === 'done' ? 100 : null, output: null }
          : {}),
        ...(input.expectedOutput !== undefined ? { expectedOutput: input.expectedOutput } : {}),
      };
      await nodes(db).insertOne(node);

      // todo.task_created (todo/events spec — board parity with task_created).
      const createdActor = actorFromLogActor(await resolveActor(db, wsId, ctx, body));
      emitFor(wsId, node, (svc, ws) =>
        emitTaskCreated(svc, ws, node, parent?.text ?? null, createdActor),
      );

      return {
        node: {
          nodeId: node.nodeId,
          parentId: node.parentId,
          text: node.text,
          description: node.description,
          instructions: node.instructions,
          kind,
          state,
          blockedReason: null,
          reportedProgress: reportedProgressOf(node),
          expectedOutput: kind === 'task' ? (node.expectedOutput ?? null) : null,
          completed: node.completed,
          collapsed: node.collapsed,
          position: node.position,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
        },
        parentText: parent?.text ?? null,
      };
    },

    /**
     * Former get-node, plus kind/state/progress and the full input/output.
     * Scope: { workspaceId, nodeId }; the effective progress reads the
     * subtree level by level ({ workspaceId, parentId: { $in } }).
     */
    async 'get-node'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(NodeIdSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      const descendants = await loadDescendantCores(db, wsId, node.nodeId);
      const progress = effectiveProgressMap([node, ...descendants]).get(node.nodeId) ?? null;
      const state = stateOf(node);
      // TODODEP: blockers with their state, the inverse (dependents) and the semáforo.
      const depFields = await loadDependencyFields(db, wsId, node);
      return {
        node: {
          nodeId: node.nodeId,
          parentId: node.parentId,
          text: node.text,
          description: node.description,
          instructions: node.instructions,
          kind: kindOf(node),
          state,
          blockedReason: node.blockedReason ?? null,
          allowedTransitions: state ? STATE_TRANSITIONS[state] : [],
          progress,
          reportedProgress: reportedProgressOf(node),
          input: node.input ?? null,
          output: kindOf(node) === 'task' ? (node.output ?? null) : null,
          hasInput: Boolean(node.input),
          hasOutput: kindOf(node) === 'task' && Boolean(node.output),
          ...planOf(node),
          assignee: assigneeOf(node),
          assignedAt: assigneeOf(node) ? (node.assignedAt ?? null) : null,
          reviewer: reviewerOf(node),
          reviewedAt: reviewerOf(node) ? (node.reviewedAt ?? null) : null,
          ...autoplayOf(node),
          ...depFields,
          completed: node.completed,
          collapsed: node.collapsed,
          position: node.position,
          archived: archivedOf(node),
          archivedAt: node.archivedAt ?? null,
          completedAt: completedAtOf(node),
          log: node.log ?? [],
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
        },
      };
    },

    /**
     * Former get-tree. Scope: find({ workspaceId }).sort({ position: 1 }),
     * capped at MAX_WORKSPACE_NODES; projected to the tree fields (no
     * instructions, log or input/output bodies). Archived nodes (and the
     * subtrees under archived ancestors) are hidden unless includeArchived.
     */
    async 'get-tree'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(GetTreeSchema, body);
      const allNodes = await loadWorkspaceNodes(db, wsId, {
        sort: { position: 1 },
        projection: {
          _id: 0,
          nodeId: 1,
          parentId: 1,
          text: 1,
          description: 1,
          completed: 1,
          collapsed: 1,
          position: 1,
          kind: 1,
          state: 1,
          blockedReason: 1,
          progress: 1,
          'input.format': 1,
          'output.format': 1,
          plannedFor: 1,
          dayOrder: 1,
          plannedTime: 1,
          assignee: 1,
          reviewer: 1,
          channelId: 1,
          runner: 1,
          running: 1,
          autoWakeCount: 1,
          startFailCount: 1,
          expectedOutput: 1,
          outputUpdatedAt: 1,
          dependencies: 1,
          archived: 1,
          archivedAt: 1,
          completedAt: 1,
          updatedAt: 1,
        },
      });
      let scoped = allNodes;
      // Archive: a node is hidden when it or any ancestor is archived (the
      // cascade is computed at read time, over the whole load).
      if (!input.includeArchived) {
        const hidden = archiveHiddenIds(allNodes);
        scoped = scoped.filter((n) => !hidden.has(n.nodeId));
      }
      if (input.assignee) {
        const byId = new Map(allNodes.map((n) => [n.nodeId, n]));
        const keep = new Set<string>();
        for (const n of allNodes) {
          const a = assigneeOf(n);
          if (!a || a.kind !== input.assignee.kind || a.id !== input.assignee.id) continue;
          let cur: TodoNode | undefined = n;
          while (cur && !keep.has(cur.nodeId)) {
            keep.add(cur.nodeId);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
          }
        }
        scoped = scoped.filter((n) => keep.has(n.nodeId));
      }
      // Reviewer filter (TODORV): same keep-set shape as the assignee filter —
      // the matching tasks plus the path to them.
      if (input.reviewer) {
        const byId = new Map(allNodes.map((n) => [n.nodeId, n]));
        const keep = new Set<string>();
        for (const n of allNodes) {
          const r = reviewerOf(n);
          if (!r || r.kind !== input.reviewer.kind || r.id !== input.reviewer.id) continue;
          let cur: TodoNode | undefined = n;
          while (cur && !keep.has(cur.nodeId)) {
            keep.add(cur.nodeId);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
          }
        }
        scoped = scoped.filter((n) => keep.has(n.nodeId));
      }
      const tree = buildFormattedTree(scoped, input.nodeId ?? null, input.depth);
      return { tree };
    },

    /**
     * Former update-node. Scope: findOneAndUpdate({ workspaceId, nodeId }, { $set }, 'after').
     * `expectedOutput` ({ format, description?, fileType?, fields? }, null
     * clears it) is the output a task declares it delivers (TODOAP-REQ-14);
     * groups have none (NOT_A_TASK).
     */
    async 'update-node'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(UpdateNodeSchema, body);
      const $set: Record<string, unknown> = { updatedAt: Date.now() };
      if (input.text !== undefined) $set.text = input.text;
      if (input.description !== undefined) $set.description = input.description;
      if (input.instructions !== undefined) $set.instructions = input.instructions;
      const filter: Document = { workspaceId: wsId, nodeId: input.nodeId };
      if (input.expectedOutput !== undefined) {
        $set.expectedOutput = input.expectedOutput;
        const current = await nodes(db).findOne(filter, { projection: { _id: 0, kind: 1 } });
        if (!current) return nodeNotFound(input.nodeId);
        if (kindOf(current) === 'group') return notATask(input.nodeId, 'output');
        filter.kind = { $ne: 'group' };
      }
      const node = await nodes(db).findOneAndUpdate(filter, { $set }, { returnDocument: 'after' });
      if (!node) return nodeNotFound(input.nodeId);
      // todo.task_updated (todo/events spec — board parity with task_updated).
      const updateActor = actorFromLogActor(await resolveActor(db, wsId, ctx, body));
      const updatedFields = Object.keys(input).filter(
        (k) => k !== 'nodeId' && k !== 'callerUserId' && k !== 'callerAgentId' && k !== 'callerChannelId',
      );
      emitFor(wsId, node, (svc, ws) =>
        emitTaskUpdated(svc, ws, node, updateActor, updatedFields),
      );
      return {
        node: {
          nodeId: node.nodeId,
          text: node.text,
          description: node.description,
          instructions: node.instructions,
          expectedOutput: kindOf(node) === 'task' ? (node.expectedOutput ?? null) : null,
          updatedAt: node.updatedAt,
        },
      };
    },

    /**
     * Former toggle-complete. Scope: findOne({ workspaceId, nodeId });
     * updateMany({ workspaceId, nodeId: { $in: [node + descendants] } });
     * one log entry on the toggled node; re-read.
     *
     * With states it is the checkbox shortcut: a task that is not done goes to
     * `done` (progress 100, reason cleared) with every descendant task; a done
     * task goes back to `pending` with every done descendant (their automatic
     * 100% is cleared). It bypasses the transition table on purpose (the old
     * boolean toggle had no states). Groups are rejected.
     */
    async 'toggle-complete'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(NodeIdSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'completion');
      // A cancelled task toggles back to pending (reopen), never to done:
      // the checkbox is the restore path too (Pablo, 2026-10-30).
      const toggleFrom = stateOf(node) as NodeState;
      const newCompleted = toggleFrom !== 'done' && toggleFrom !== 'cancelled';
      const now = Date.now();

      // Toggle the node + cascade to all descendants (a task contains only tasks)
      const descendantIds = await collectSubtree(db, wsId, input.nodeId);
      const allIds = [input.nodeId, ...descendantIds];

      if (newCompleted) {
        await nodes(db).updateMany(
          { workspaceId: wsId, nodeId: { $in: allIds }, kind: { $ne: 'group' } },
          { $set: { state: 'done', completed: true, progress: 100, blockedReason: null, autoWakeCount: 0, startFailCount: 0, completedAt: now, updatedAt: now } },
        );
        // TODODEP release: every task that just reached done may unblock dependents.
        await scheduleDependentsOf(db, wsId, allIds);
      } else {
        const reopened = await nodes(db)
          .find({
            workspaceId: wsId,
            nodeId: { $in: allIds },
            kind: { $ne: 'group' },
            $or: [{ state: 'done' }, { state: 'cancelled' }, { state: { $exists: false }, completed: true }],
          })
          .project<{ nodeId: string }>({ nodeId: 1 })
          .toArray();
        const reopenedIds = reopened.map((n) => n.nodeId);
        await nodes(db).updateMany(
          { workspaceId: wsId, nodeId: { $in: reopenedIds } },
          { $set: { state: 'pending', completed: false, autoWakeCount: 0, startFailCount: 0, completedAt: null, updatedAt: now } },
        );
        // Leaving done clears the automatic 100 and keeps any other value.
        await nodes(db).updateMany(
          { workspaceId: wsId, nodeId: { $in: reopenedIds }, progress: 100 },
          { $set: { progress: null } },
        );
      }

      // Add log entry to the toggled node (exact wording the UI/tests expect)
      const suffix =
        descendantIds.length > 0
          ? ` (and ${descendantIds.length} descendant${descendantIds.length > 1 ? 's' : ''})`
          : '';
      const toggleActor = await resolveActor(db, wsId, ctx, body);
      await pushLogEntry(
        db,
        wsId,
        input.nodeId,
        newCompleted ? `Marked as completed${suffix}` : `Marked as not completed${suffix}`,
        toggleActor,
      );

      const updated = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!updated) return nodeNotFound(input.nodeId);
      // todo.task_completed / task_state_changed (todo/events spec): the
      // toggle is the "Complete" shortcut — completed when ticking, the
      // generic transition when reopening (done → pending).
      {
        const evActor = actorFromLogActor(toggleActor);
        if (newCompleted) {
          emitFor(wsId, updated, (svc, ws) =>
            emitTaskCompleted(svc, ws, updated, stateOf(node) ?? 'pending', 'done', evActor, outputRefOf(updated)),
          );
        } else {
          emitFor(wsId, updated, (svc, ws) =>
            emitTaskStateChanged(svc, ws, updated, toggleFrom, 'pending', evActor),
          );
        }
      }
      return {
        node: {
          nodeId: updated.nodeId,
          text: updated.text,
          description: updated.description,
          state: stateOf(updated),
          reportedProgress: reportedProgressOf(updated),
          completed: updated.completed,
          updatedAt: updated.updatedAt,
        },
      };
    },

    /** Former toggle-collapse. Scope: findOne then findOneAndUpdate({ workspaceId, nodeId }). */
    async 'toggle-collapse'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(NodeIdSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      const updated = await nodes(db).findOneAndUpdate(
        { workspaceId: wsId, nodeId: input.nodeId },
        { $set: { collapsed: !node.collapsed, updatedAt: Date.now() } },
        { returnDocument: 'after' },
      );
      if (!updated) return nodeNotFound(input.nodeId);
      return {
        node: {
          nodeId: updated.nodeId,
          text: updated.text,
          description: updated.description,
          completed: updated.completed,
          collapsed: updated.collapsed,
          updatedAt: updated.updatedAt,
        },
      };
    },

    /**
     * Former move-node. Scope: findOne({ workspaceId, nodeId }); circular
     * check via collectSubtree; parent check { workspaceId, nodeId: newParentId };
     * cross-parent: countDocuments({ workspaceId, parentId: new }) → clamp
     * [0, len], updateMany({ workspaceId, parentId: new, position: { $gte } }, $inc),
     * updateOne({ workspaceId, nodeId }, $set), reindexSiblings(old) without
     * updatedAt; same-parent: reorderSiblings with updatedAt on all siblings.
     * Moves to root (null) skip the circular and parent checks, as before.
     */
    async 'move-node'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(MoveNodeSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      const oldParentId = node.parentId ?? null;
      // Distinguish omitted (undefined) from explicit null:
      //   omitted  → keep current parent, only reorder among siblings
      //   null     → move to root (parentId = null)
      const newParentId = input.newParentId === undefined ? oldParentId : input.newParentId;

      // Circular check: newParent can't be the node itself or inside its subtree
      if (newParentId) {
        if (newParentId === input.nodeId) {
          return fail('CIRCULAR_MOVE', 'Cannot move a node into itself.');
        }
        const subtree = await collectSubtree(db, wsId, input.nodeId);
        if (subtree.includes(newParentId)) {
          return fail('CIRCULAR_MOVE', 'Cannot move a node into its own subtree.');
        }
        // Validate new parent exists in this workspace — prevents orphan nodes
        const parent = await nodes(db).findOne(
          { workspaceId: wsId, nodeId: newParentId },
          { projection: { _id: 1, kind: 1 } },
        );
        if (!parent) {
          return notFound(
            `Parent node not found: ${newParentId}`,
            'The newParentId does not exist in this workspace. Get valid IDs with get-tree or search-nodes — the ID may be truncated or belong to another workspace.',
          );
        }
        // A task contains only tasks (and a task's subtree holds no groups, so
        // checking the moved node itself is enough).
        if (kindOf(node) === 'group' && kindOf(parent) === 'task') return groupInTask();
      }

      const now = Date.now();

      if (oldParentId !== newParentId) {
        // Shift positions in the new parent's children to make room
        const newSiblingCount = await nodes(db).countDocuments({ workspaceId: wsId, parentId: newParentId ?? null });
        const clampedPos = Math.min(Math.max(0, input.newPosition), newSiblingCount);

        await nodes(db).updateMany(
          {
            workspaceId: wsId,
            parentId: newParentId ?? null,
            position: { $gte: clampedPos },
          },
          { $inc: { position: 1 } },
        );

        // Move the node
        await nodes(db).updateOne(
          { workspaceId: wsId, nodeId: input.nodeId },
          { $set: { parentId: newParentId, position: clampedPos, updatedAt: now } },
        );

        // Reindex old siblings
        await reindexSiblings(db, wsId, oldParentId);
      } else {
        // Same parent, just reorder
        await reorderSiblings(db, wsId, oldParentId, input.nodeId, input.newPosition);
      }

      const moved = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!moved) return nodeNotFound(input.nodeId);
      // todo.task_moved (todo/events spec — board parity with task_moved for
      // the tree's reparenting; state moves are task_state_changed & co).
      {
        const moveActor = await resolveActor(db, wsId, ctx, body);
        const newParentText = moved.parentId
          ? (await nodes(db).findOne({ workspaceId: wsId, nodeId: moved.parentId }, { projection: { _id: 0, text: 1 } }))?.text ?? null
          : null;
        emitFor(wsId, moved, (svc, ws) =>
          emitTaskMoved(svc, ws, moved, oldParentId, newParentText, moved.position ?? 0, actorFromLogActor(moveActor)),
        );
      }
      return {
        node: {
          nodeId: moved.nodeId,
          text: moved.text,
          description: moved.description,
          completed: moved.completed,
          parentId: moved.parentId,
          position: moved.position,
          updatedAt: moved.updatedAt,
        },
      };
    },

    /**
     * Former delete-node. Scope: findOne({ workspaceId, nodeId });
     * deleteMany({ workspaceId, nodeId: { $in: [subtree + node] } });
     * reindexSiblings(parentId).
     */
    async 'delete-node'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(NodeIdSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);

      // Collect all descendant IDs (recursive)
      const toDelete = await collectSubtree(db, wsId, input.nodeId);
      toDelete.push(input.nodeId);

      const result = await nodes(db).deleteMany({
        workspaceId: wsId,
        nodeId: { $in: toDelete },
      });

      // TODODEP cleanup: no task keeps waiting on a deleted node (zero orphans).
      await purgeDependencyReferences(db, wsId, toDelete);

      // Reindex sibling positions
      await reindexSiblings(db, wsId, node.parentId);

      if (result.deletedCount === 0) return nodeNotFound(input.nodeId);
      // todo.task_deleted (todo/events spec — board parity with task_archived:
      // deletion is the tree's removal).
      const deleteActor = actorFromLogActor(await resolveActor(db, wsId, ctx, body));
      emitFor(wsId, node, (svc, ws) =>
        emitTaskDeleted(svc, ws, node, toDelete.length - 1, deleteActor),
      );
      return {
        deleted: true as const,
        nodeId: input.nodeId,
        node: { text: node.text, description: node.description, completed: node.completed },
      };
    },

    /**
     * Former search-nodes. Scope: find({ workspaceId, text: { $regex: escaped, $options: 'i' } })
     * .sort({ updatedAt: -1 }).limit(50); breadcrumb paths from the (capped)
     * whole-workspace scan { workspaceId }. Archived nodes (and nodes under an
     * archived ancestor) are hidden unless includeArchived.
     */
    async 'search-nodes'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SearchNodesSchema, body);

      const matches = await nodes(db)
        .find({ workspaceId: wsId, text: { $regex: escapeRegex(input.query), $options: 'i' } })
        .sort({ updatedAt: -1 })
        .limit(50)
        .toArray();

      // Build path for each match (root path = own text)
      const allNodes = await loadWorkspaceNodes(db, wsId, { projection: { nodeId: 1, parentId: 1, text: 1, archived: 1 } });
      const nodeMap = new Map(allNodes.map((n) => [n.nodeId, n]));
      // Archive: hide archived matches and matches under an archived ancestor.
      const hidden = input.includeArchived ? new Set<string>() : archiveHiddenIds(allNodes);

      function buildPath(nodeId: string): string {
        const node = nodeMap.get(nodeId);
        if (!node || !node.parentId) return node?.text ?? '';
        const parentPath = buildPath(node.parentId);
        return parentPath ? `${parentPath} / ${node.text}` : node.text;
      }

      return {
        results: matches
          .filter((n) => !hidden.has(n.nodeId))
          .map((n) => ({
            nodeId: n.nodeId,
            text: n.text,
            description: n.description ?? '',
            kind: kindOf(n),
            state: stateOf(n),
            completed: n.completed,
            path: buildPath(n.nodeId),
            updatedAt: n.updatedAt,
          })),
      };
    },

    /**
     * Archive or unarchive one node (archive — this file's section). Archiving
     * sets `archived: true` + `archivedAt`, logs "archived" / "unarchived"
     * (TODOLG-REQ-1) and emits todo.task_updated; the frontend also refreshes
     * through the write-tool broadcast (todo_node_changed). ARCHIVING DOES NOT
     * CASCADE: only the named node is archived, and a node with non-archived
     * children is rejected (HAS_ACTIVE_CHILDREN) — archive the children first
     * or the whole branch bottom-up. Unarchiving a node whose parent is still
     * archived is allowed but pointless: it stays hidden until its ancestors
     * are unarchived too (reads cascade down). Unarchiving does not touch the
     * descendants. Groups can be archived like tasks. Idempotent: archiving an
     * archived node (or unarchiving an active one) is a no-op.
     * Scope: findOne + writeNode({ workspaceId, nodeId }).
     */
    async 'set-archived'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SetArchivedSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (archivedOf(node) === input.archived) return { node: nodeSummary(node) };

      if (input.archived) {
        const activeChild = await nodes(db).findOne(
          { workspaceId: wsId, parentId: input.nodeId, archived: { $ne: true } },
          { projection: { _id: 0, nodeId: 1, text: 1 } },
        );
        if (activeChild) {
          return fail(
            'HAS_ACTIVE_CHILDREN',
            `Cannot archive "${node.text}": it still has non-archived children (e.g. "${activeChild.text}").`,
            'Archive the children first (bottom-up), or delete them.',
          );
        }
      }

      const actor = await resolveActor(db, wsId, ctx, body);
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: input.archived ? { archived: true, archivedAt: Date.now() } : { archived: false, archivedAt: null },
        log: { text: input.archived ? 'archived' : 'unarchived', actor },
      });
      if (!updated) return nodeNotFound(input.nodeId);
      // todo.task_updated (todo/events spec): the archive flag changed.
      emitFor(wsId, updated, (svc, ws) =>
        emitTaskUpdated(svc, ws, updated, actorFromLogActor(actor), ['archived']),
      );
      return { node: nodeSummary(updated) };
    },

    /**
     * Bulk-archive finished work to keep the tree clean: every task whose
     * state is done (and cancelled, unless includeCancelled: false) that is
     * not archived yet. With olderThanDays, only tasks finished at least that
     * many days ago are archived (completedAt — stored on the done/cancelled
     * transitions, derived for legacy nodes from the log, else updatedAt);
     * younger finished tasks are skipped, so this powers the frontend
     * auto-archive setting ("archive finished tasks older than N days")
     * without touching fresh work. Each archived node is written exactly like
     * set-archived (archivedAt + "archived" log + task_updated event); nodes
     * with non-archived children are skipped (HAS_ACTIVE_CHILDREN is never
     * raised here — a bulk sweep must not fail midway). Returns the counts:
     * { archived, skipped }.
     * Scope: the capped whole-workspace scan { workspaceId } + one writeNode
     * per archived task.
     */
    async 'archive-finished'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(ArchiveFinishedSchema, body);
      const includeCancelled = input.includeCancelled !== false;
      const olderThan = input.olderThanDays !== undefined ? Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000 : null;

      const all = await loadWorkspaceNodes(db, wsId, {
        projection: {
          _id: 0,
          nodeId: 1,
          parentId: 1,
          text: 1,
          kind: 1,
          state: 1,
          completed: 1,
          log: 1,
          updatedAt: 1,
          archived: 1,
          completedAt: 1,
        },
      });
      // A node with an active (non-archived) child is skipped: archiving it
      // would orphan the child from every default view.
      const hasActiveChild = new Set(all.filter((n) => n.parentId && !archivedOf(n)).map((n) => n.parentId!));

      let archived = 0;
      let skipped = 0;
      const actor = await resolveActor(db, wsId, ctx, body);
      for (const node of all) {
        if (archivedOf(node) || kindOf(node) === 'group' || hasActiveChild.has(node.nodeId)) continue;
        const state = stateOf(node);
        if (state !== 'done' && !(includeCancelled && state === 'cancelled')) continue;
        const finishedAt = completedAtOf(node);
        if (olderThan !== null && (finishedAt === null || finishedAt > olderThan)) {
          skipped += 1;
          continue;
        }
        const updated = await writeNode(db, wsId, node.nodeId, {
          $set: { archived: true, archivedAt: Date.now() },
          log: { text: 'archived', actor },
        });
        if (updated) {
          archived += 1;
          emitFor(wsId, updated, (svc, ws) =>
            emitTaskUpdated(svc, ws, updated, actorFromLogActor(actor), ['archived']),
          );
        }
      }
      return { archived, skipped };
    },

    /**
     * Former add-log-entry. Scope: findOneAndUpdate({ workspaceId, nodeId }, { $push log, $set updatedAt }, 'after').
     * A log entry is reported progress: it resets the re-wake count (TODOAP-REQ-7).
     */
    async 'add-log-entry'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(AddLogEntrySchema, body);
      const logActor = await resolveActor(db, wsId, ctx, body);
      const node = await writeNode(db, wsId, input.nodeId, {
        $set: { autoWakeCount: 0, startFailCount: 0 },
        log: { text: input.text, actor: logActor },
      });
      if (!node) return nodeNotFound(input.nodeId);
      // todo.task_progress (todo/events spec — a log entry is the to-do list's
      // progress note; board parity with task_progress_note).
      emitFor(wsId, node, (svc, ws) =>
        emitTaskProgress(svc, ws, node, null, input.text, actorFromLogActor(logActor)),
      );
      return {
        node: {
          nodeId: node.nodeId,
          text: node.text,
          description: node.description,
          completed: node.completed,
          log: node.log ?? [],
          updatedAt: node.updatedAt,
        },
      };
    },

    /**
     * Move a task to another state along STATE_TRANSITIONS. `blocked` needs a
     * reason (stored as blockedReason, cleared on leaving); entering `review`
     * or `done` sets progress 100 and leaving them for an open state clears a
     * stored 100 (other values are kept). Setting the
     * current state is a no-op, except `blocked` with a new reason, which
     * updates the reason. Logs "from → to[: reason]". A task entering
     * `working` also pulls its pending ancestors into `working`, each with
     * log "Auto: child started working" (no automatic reverse in v1).
     * Autoplay (TODOAP): every transition resets the re-wake count and leaving
     * `working` clears `running` (writeStateTransition); `reply` (blocked or
     * review → working only) logs "Reply: <text>" (blocked) or "Sent back:
     * <text>" (review) and, when the task has a conversation, posts it there
     * as the caller's message ("Sent back from review: <text>" for review)
     * and wakes the agent at once only when it has no playing runner — with
     * one, the task is left stuck and the runner's cycle runs (slots
     * honoured, TODOAP-REQ-24); entering pending/review/done runs the
     * assignee agent's scheduling cycle.
     * Scope: findOne + findOneAndUpdate({ workspaceId, nodeId, state guard })
     * + the pending-ancestor walk when entering `working`.
     * @spec TODOAP-REQ-10
     * @spec TODOAP-REQ-21
     * @spec TODOAP-REQ-24
     */
    async 'set-state'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SetStateSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'state');
      const from = stateOf(node) as NodeState;
      const to = input.state;
      const reason = input.reason?.trim() || null;

      if (to === 'blocked' && !reason) {
        return fail(
          'REASON_REQUIRED',
          'A blocked task needs a reason.',
          'Pass "reason": what is missing or who the task is waiting for.',
        );
      }
      const reply = input.reply?.trim() || null;
      const sentBack = from === 'review';
      if (input.reply !== undefined && ((from !== 'blocked' && !sentBack) || to !== 'working' || !reply)) {
        return fail(
          'INVALID_INPUT',
          '"reply" answers a blocked task or sends a review task back: use it only with state "working" on a blocked or review task.',
          'Omit "reply", or move a blocked or review task to "working" with it.',
        );
      }

      if (from === to) {
        if (to !== 'blocked' || reason === node.blockedReason) {
          return { node: nodeSummary(node), transition: { from, to } };
        }
        const updated = await writeNode(db, wsId, input.nodeId, {
          $set: { blockedReason: reason },
          log: { text: `Blocked: ${reason}`, actor: await resolveActor(db, wsId, ctx, body) },
        });
        if (!updated) return nodeNotFound(input.nodeId);
        return { node: nodeSummary(updated), transition: { from, to } };
      }

      if (!STATE_TRANSITIONS[from].includes(to)) {
        return fail(
          'INVALID_TRANSITION',
          `Cannot move a task from "${from}" to "${to}".`,
          `Allowed from "${from}": ${STATE_TRANSITIONS[from].join(', ')}.`,
        );
      }

      // A reply answers a blocked task (TODOAP-REQ-10): logged as "Reply: <text>"
      // and, when the task has a conversation, posted there by the caller and
      // the agent woken with it. From review it is the send-back note
      // (TODOAP-REQ-21): logged as "Sent back: <text>" and posted as
      // "Sent back from review: <text>" so the agent knows why.
      const actor = await resolveActor(db, wsId, ctx, body);
      let delivery: { svc: TodoAutoplayService; userId: string } | null = null;
      if (reply) {
        if (node.channelId) {
          const svc = requireAutoplay();
          const caller = await requireCaller(db, wsId, input.callerUserId);
          delivery = { svc, userId: caller.userId };
        }
        await pushLogEntry(db, wsId, input.nodeId, sentBack ? `Sent back: ${reply}` : `Reply: ${reply}`, actor);
      }

      const updated = await writeStateTransition(db, wsId, node, to, { reason, actor });
      if (!updated) {
        return fail('CONFLICT', 'The task changed while updating its state.', 'Read it again and retry.', 409);
      }
      if (reply && delivery && updated.channelId) {
        const text = sentBack ? `Sent back from review: ${reply}` : reply;
        // Slots honoured (TODOAP-REQ-24): with a playing runner the task is
        // left stuck and the runner's cycle decides; otherwise it wakes now.
        const agent = assigneeOf(updated);
        await delivery.svc.deliverReply(updated.channelId, delivery.userId, text, {
          workspaceId: wsId,
          nodeId: updated.nodeId,
          agentId: agent?.kind === 'agent' ? agent.id : null,
        });
      }
      // To-do events (todo/events spec — board parity): granular topics for
      // the transitions users subscribe to ("avísame cuando termine"), the
      // generic state_changed for the rest. Fire-and-forget.
      {
        const evActor = actorFromLogActor(actor);
        if (to === 'working') {
          emitFor(wsId, updated, (svc, ws) => emitTaskStarted(svc, ws, updated, from, evActor));
        } else if (to === 'done' || to === 'review') {
          emitFor(wsId, updated, (svc, ws) =>
            emitTaskCompleted(svc, ws, updated, from, to, evActor, outputRefOf(updated)),
          );
        } else if (to === 'blocked') {
          emitFor(wsId, updated, (svc, ws) => emitTaskBlocked(svc, ws, updated, from, reason ?? '', evActor));
        } else {
          emitFor(wsId, updated, (svc, ws) => emitTaskStateChanged(svc, ws, updated, from, to, evActor, { reason: reason ?? undefined }));
        }
      }
      // Reviewer notification (TODORV): a task WITH a reviewer entering review
      // tells its reviewer structurally — the notification Alice simulated
      // with hand-made subscriptions becomes part of the model. Fire-and-forget.
      if (to === 'review') {
        void notifyReviewer(db, wsId, updated, from, actor);
      }
      // Scheduling trigger (TODOAP-REQ-18): a task back in pending is eligible
      // again; one in review/done frees its runner's slot.
      if (to === 'pending' || to === 'review' || to === 'done') scheduleFor(wsId, updated);
      // TODODEP release (Option A): done/cancelled may unblock dependents —
      // run their assignees' cycles so the waiting tasks start (≤ the 60 s
      // safety net when the trigger races).
      if (to === 'done' || to === 'cancelled') await scheduleDependentsOf(db, wsId, [updated.nodeId]);
      // An unassigned task back in pending may be picked up (TODOAP-REQ-22).
      if (to === 'pending') scheduleUnassigned(wsId, updated);
      return { node: nodeSummary(updated), transition: { from, to } };
    },

    /**
     * Convert a node between task and group, keeping its children.
     *   - to group: its parent must not be a task, and it must have no output
     *     (state, reason and progress are dropped);
     *   - to task: it must not contain groups; it starts `pending`.
     * Scope: findOne, children check { workspaceId, parentId, kind }, findOneAndUpdate.
     */
    async 'set-kind'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SetKindSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === input.kind) return { node: nodeSummary(node) };

      let updated: TodoNode | null;
      if (input.kind === 'group') {
        if (node.parentId !== null) {
          const parent = await nodes(db).findOne(
            { workspaceId: wsId, nodeId: node.parentId },
            { projection: { _id: 1, kind: 1 } },
          );
          if (parent && kindOf(parent) === 'task') return groupInTask();
        }
        if (node.output) {
          return fail(
            'HAS_OUTPUT',
            'This task has an output; a group cannot hold one.',
            'Clear it first with set-output and output null.',
          );
        }
        updated = await writeNode(db, wsId, input.nodeId, {
          $set: { kind: 'group', completed: false },
          $unset: ['state', 'blockedReason', 'progress', 'output', 'plannedFor', 'dayOrder', 'plannedTime', 'assignee', 'assignedAt', 'reviewer', 'reviewedAt', 'dependencies'],
          log: { text: 'Converted to group', actor: await resolveActor(db, wsId, ctx, body) },
        });
      } else {
        const childGroup = await nodes(db).findOne(
          { workspaceId: wsId, parentId: input.nodeId, kind: 'group' },
          { projection: { _id: 1 } },
        );
        if (childGroup) return groupInTask();
        updated = await writeNode(db, wsId, input.nodeId, {
          $set: {
            kind: 'task',
            state: 'pending',
            completed: false,
            blockedReason: null,
            progress: null,
            output: null,
          },
          log: { text: 'Converted to task', actor: await resolveActor(db, wsId, ctx, body) },
        });
      }
      if (!updated) return nodeNotFound(input.nodeId);
      return { node: nodeSummary(updated) };
    },

    /**
     * Report a task's progress (0–100 integer) or clear it (null → derived
     * from the children again). Allowed in every task state, review and done
     * included (Pablo, 2026-10-24); groups have no progress.
     * Scope: findOne + findOneAndUpdate({ workspaceId, nodeId }).
     */
    async 'set-progress'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SetProgressSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'progress');
      const progressActor = await resolveActor(db, wsId, ctx, body);
      const updated = await writeNode(db, wsId, input.nodeId, {
        // Reported progress resets the re-wake count (TODOAP-REQ-7).
        $set: { progress: input.progress, autoWakeCount: 0, startFailCount: 0 },
        log: {
          text: input.progress === null ? 'Progress cleared' : `Progress ${input.progress}%`,
          actor: progressActor,
        },
      });
      if (!updated) return nodeNotFound(input.nodeId);
      // todo.task_progress (todo/events spec — board parity with task_progress_note).
      emitFor(wsId, updated, (svc, ws) =>
        emitTaskProgress(svc, ws, updated, input.progress, undefined, actorFromLogActor(progressActor)),
      );
      return { node: nodeSummary(updated) };
    },

    /**
     * Set (or clear with null) the data a node starts from. Markdown and form
     * are stored on the node; a file arrives either as base64 `data` or as a
     * `path` inside the workspace volume (the backend reads and uploads it) and
     * is stored as an object storage reference. Groups may hold input.
     * Replacing an existing input that would actually change requires
     * overwrite: true (OUTPUT_EXISTS otherwise) — see requireOverwrite.
     * Scope: findOne + findOneAndUpdate({ workspaceId, nodeId }).
     */
    async 'set-input'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SetInputSchema, body);
      const node = await nodes(db).findOne(
        { workspaceId: wsId, nodeId: input.nodeId },
        { projection: { _id: 1, input: 1 } },
      );
      if (!node) return nodeNotFound(input.nodeId);
      const normalized = input.input ? normalizeFileIO(input.input) : null;
      if (normalized) requireOverwrite('input', node.input ?? null, normalized, { overwrite: input.overwrite });
      const stored = normalized ? await storeIO(db, ctx, wsId, input.nodeId, 'input', normalized) : null;
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: { input: stored },
        log: {
          text: stored ? `Input set · ${describeIO(stored)}` : 'Input cleared',
          actor: await resolveActor(db, wsId, ctx, body),
        },
      });
      if (!updated) return nodeNotFound(input.nodeId);
      return { node: { ...nodeSummary(updated), input: updated.input ?? null } };
    },

    /**
     * Deliver (or clear with null) a task's result. Same formats as set-input;
     * groups have no output. Logs "Output delivered · <format>".
     * When the task has an `expectedOutput`, the output must match it
     * (OUTPUT_MISMATCH, TODOAP-REQ-15) — checked before any file is stored. A
     * form is checked on its fields only, never its values: a human fills them
     * in over time (TODOAP-REQ-16).
     * Replacing an existing output that would actually change requires
     * overwrite: true (OUTPUT_EXISTS otherwise) — see requireOverwrite. The
     * incident: a truncated base64 upload fell back to markdown and silently
     * replaced a delivered HTML file (28-oct).
     * Every save stamps `outputUpdatedAt`; the log entry is written only when
     * the output means something new (outputLogEntry, TODOAP-REQ-17), so a
     * human filling a form in does not flood the log.
     * Scope: findOne + findOneAndUpdate({ workspaceId, nodeId }).
     */
    async 'set-output'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SetOutputSchema, body);
      const node = await nodes(db).findOne(
        { workspaceId: wsId, nodeId: input.nodeId },
        { projection: { _id: 1, kind: 1, state: 1, output: 1, outputUpdatedAt: 1, expectedOutput: 1 } },
      );
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'output');
      const normalized = input.output ? normalizeFileIO(input.output) : null;
      if (normalized && node.expectedOutput) {
        const mismatch = outputMismatch(node.expectedOutput, normalized);
        if (mismatch) {
          return fail(
            'OUTPUT_MISMATCH',
            `The output does not match the task's expected output: ${mismatch}.`,
            'Read the expectedOutput with get-node and deliver an output of that shape.',
          );
        }
      }
      if (normalized) {
        requireOverwrite('output', node.output ?? null, normalized, {
          overwrite: input.overwrite,
          state: stateOf(node),
          savedAt: node.outputUpdatedAt ?? null,
        });
      }
      const stored = normalized ? await storeIO(db, ctx, wsId, input.nodeId, 'output', normalized) : null;
      const outputLog = outputLogEntry(node.output ?? null, stored, stateOf(node));
      const outputActor = await resolveActor(db, wsId, ctx, body);
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: { output: stored, outputUpdatedAt: Date.now() },
        log: outputLog ? { text: outputLog, actor: outputActor } : undefined,
      });
      if (!updated) return nodeNotFound(input.nodeId);
      // todo.task_output_delivered (todo/events spec — the to-do list's own
      // event; a completed board task has no output concept).
      if (stored) {
        emitFor(wsId, updated, (svc, ws) => {
          const ref = outputRefOf(updated);
          emitTaskOutputDelivered(svc, ws, updated, { format: ref?.format ?? stored.format, name: ref?.name, url: ref?.url }, actorFromLogActor(outputActor));
        });
      }
      return { node: { ...nodeSummary(updated), output: updated.output ?? null } };
    },

    /**
     * Tick/untick the index-th (0-based) markdown checkbox (`- [ ]` / `- [x]`)
     * of the node's instructions, ignoring fenced code blocks.
     * Scope: findOne + findOneAndUpdate({ workspaceId, nodeId, instructions guard }).
     */
    async 'toggle-instruction-item'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(ToggleInstructionItemSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      const toggled = toggleChecklistItem(node.instructions ?? '', input.index);
      if (!toggled) {
        return fail(
          'ITEM_NOT_FOUND',
          `The instructions have no checklist item #${input.index}.`,
          'Items are the "- [ ]" / "- [x]" lines, counted from 0.',
        );
      }
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: { instructions: toggled.markdown },
        guard: { instructions: node.instructions },
      });
      if (!updated) {
        return fail('CONFLICT', 'The instructions changed while updating them.', 'Read the node again and retry.', 409);
      }
      return {
        node: {
          nodeId: updated.nodeId,
          parentId: updated.parentId,
          instructions: updated.instructions,
          updatedAt: updated.updatedAt,
        },
        item: { index: input.index, checked: toggled.checked, text: toggled.text },
      };
    },
    /**
     * Plan a task for a day, move it within or between days, set its time, or
     * take it off its day (`day: null`, which also clears the time).
     *   - `index` places it in the day's plan (clamped; omitted = end of the
     *     day, or its current slot when the day does not change); the target
     *     day is renumbered 0..N-1, and so is the day it left.
     *   - `time` 'HH:MM' sets the planned time, null clears it, omitted keeps it.
     *   - Logs "Planned for <day>[ at <time>]", "Planned time …" or "Removed
     *     from the day"; a pure reorder within the day logs nothing.
     * Groups are never planned (NOT_A_TASK).
     * Scope: findOne, find({ workspaceId, plannedFor }), findOneAndUpdate and
     * bulkWrite({ workspaceId, nodeId }).
     */
    async 'plan-node'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(PlanNodeSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'planned day');
      const from = node.plannedFor ?? null;
      const to = input.day;

      if (to === null) {
        if (from === null) return { node: nodeSummary(node), day: null, previousDay: null };
        const unplanActor = await resolveActor(db, wsId, ctx, body);
        const updated = await writeNode(db, wsId, input.nodeId, {
          $set: { plannedFor: null, dayOrder: null, plannedTime: null },
          log: { text: 'Removed from the day', actor: unplanActor },
        });
        if (!updated) return nodeNotFound(input.nodeId);
        await renumberDay(db, wsId, from);
        // todo.task_planned (todo/events spec — day cleared).
        emitFor(wsId, updated, (svc, ws) =>
          emitTaskPlanned(svc, ws, updated, null, null, actorFromLogActor(unplanActor)),
        );
        return { node: nodeSummary(updated), day: null, previousDay: from };
      }

      const others = await nodes(db)
        .find({ workspaceId: wsId, plannedFor: to, nodeId: { $ne: input.nodeId } })
        .sort({ dayOrder: 1, position: 1 })
        .project<{ nodeId: string }>({ nodeId: 1 })
        .toArray();
      const wanted =
        input.index !== undefined
          ? input.index
          : from === to && typeof node.dayOrder === 'number'
            ? node.dayOrder
            : others.length;
      const index = Math.min(Math.max(0, wanted), others.length);
      const previousTime = node.plannedTime ?? null;
      const time = input.time === undefined ? previousTime : input.time;

      let log: string | undefined;
      if (from !== to) log = `Planned for ${to}${time ? ` at ${time}` : ''}`;
      else if (time !== previousTime) log = time ? `Planned time ${time}` : 'Planned time cleared';

      const planActor = await resolveActor(db, wsId, ctx, body);
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: { plannedFor: to, dayOrder: index, plannedTime: time },
        log: log ? { text: log, actor: planActor } : undefined,
      });
      if (!updated) return nodeNotFound(input.nodeId);

      const ordered = others.map((o) => o.nodeId);
      ordered.splice(index, 0, input.nodeId);
      const ops = ordered
        .map((nodeId, i) => ({ nodeId, i }))
        .filter((o) => o.nodeId !== input.nodeId)
        .map((o) => ({
          updateOne: { filter: { workspaceId: wsId, nodeId: o.nodeId }, update: { $set: { dayOrder: o.i } } },
        }));
      if (ops.length > 0) await nodes(db).bulkWrite(ops);
      if (from !== null && from !== to) await renumberDay(db, wsId, from);
      // todo.task_planned (todo/events spec — day set/changed/time set).
      // A pure reorder within the same day (no log) emits nothing, matching
      // the log discipline.
      if (log) {
        emitFor(wsId, updated, (svc, ws) =>
          emitTaskPlanned(svc, ws, updated, to, time, actorFromLogActor(planActor)),
        );
      }
      // Scheduling trigger (TODOAP-REQ-18): a task planned for today or earlier
      // may now be eligible for its agent, or for a runner picking up
      // unassigned tasks (TODOAP-REQ-22).
      scheduleFor(wsId, updated);
      scheduleUnassigned(wsId, updated);
      return { node: nodeSummary(updated), day: to, previousDay: from };
    },

    /**
     * The "Por día" view of one day:
     *   - `tasks`: the tasks planned for `day`, in plan order (dayOrder);
     *   - `overdue`: open tasks planned before `today` (oldest first);
     *   - `unplanned`: open tasks with no day, in tree order.
     * `today` is the caller's calendar day (defaults to the UTC date). Each
     * entry carries state, effective progress, plan fields and `path` (the
     * ancestors' titles, root first). Archived nodes are hidden (an archived
     * task leaves every day list; its subtree is hidden with it).
     * Scope: the capped whole-workspace scan { workspaceId }.
     */
    async 'get-day'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(GetDaySchema, body);
      const today = input.today ?? utcToday();
      const all = await loadWorkspaceNodes(db, wsId, {
        sort: { position: 1 },
        projection: {
          _id: 0,
          nodeId: 1,
          parentId: 1,
          text: 1,
          completed: 1,
          position: 1,
          kind: 1,
          state: 1,
          blockedReason: 1,
          progress: 1,
          'output.format': 1,
          plannedFor: 1,
          dayOrder: 1,
          plannedTime: 1,
          assignee: 1,
          reviewer: 1,
          channelId: 1,
          runner: 1,
          running: 1,
          autoWakeCount: 1,
          startFailCount: 1,
          expectedOutput: 1,
          outputUpdatedAt: 1,
          dependencies: 1,
          archived: 1,
          archivedAt: 1,
          completedAt: 1,
          updatedAt: 1,
        },
      });
      // Archive: a node is hidden when it or any ancestor is archived — the
      // tree walk below skips hidden nodes, so an archived task leaves every
      // day list (tasks/overdue/unplanned) together with its subtree.
      const hidden = archiveHiddenIds(all);
      const progress = effectiveProgressMap(all);
      const byId = new Map(all.map((n) => [n.nodeId, n]));
      // TODODEP: semáforo + inverse edges for the day's rows.
      const depStatus = dependencyStatusMap(all);
      const dependents = dependentsMapOf(all);
      const childrenMap = new Map<string | null, TodoNode[]>();
      for (const n of all) {
        const key = n.parentId ?? null;
        if (!childrenMap.has(key)) childrenMap.set(key, []);
        childrenMap.get(key)!.push(n);
      }

      function pathOf(n: TodoNode): string[] {
        const out: string[] = [];
        const seen = new Set<string>();
        let p = n.parentId ? byId.get(n.parentId) : undefined;
        while (p && !seen.has(p.nodeId)) {
          seen.add(p.nodeId);
          out.unshift(p.text);
          p = p.parentId ? byId.get(p.parentId) : undefined;
        }
        return out;
      }

      function toDayTask(n: TodoNode): DayTask {
        return {
          nodeId: n.nodeId,
          parentId: n.parentId,
          text: n.text,
          state: stateOf(n) as NodeState,
          blockedReason: n.blockedReason ?? null,
          progress: progress.get(n.nodeId) ?? null,
          reportedProgress: reportedProgressOf(n),
          ...planOf(n),
          hasOutput: Boolean(n.output),
          assignee: assigneeOf(n),
          reviewer: reviewerOf(n),
          ...autoplayOf(n),
          ...dependencyFieldsOf(n, byId, depStatus, dependents),
          path: pathOf(n),
        };
      }

      // Tree order (depth first by position) for stable listings.
      const ordered: TodoNode[] = [];
      const visit = (parentId: string | null, guard: Set<string>) => {
        for (const kid of childrenMap.get(parentId) ?? []) {
          if (guard.has(kid.nodeId)) continue;
          if (hidden.has(kid.nodeId)) continue; // Archive: hidden subtree
          guard.add(kid.nodeId);
          ordered.push(kid);
          visit(kid.nodeId, guard);
        }
      };
      visit(null, new Set());
      const treeIndex = new Map(ordered.map((n, i) => [n.nodeId, i]));
      const tasks = ordered.filter((n) => kindOf(n) === 'task');
      // Open for the day plan: neither done nor cancelled (a cancelled task
      // left the plan when it was cancelled; legacy rows with a stale
      // plannedFor are filtered here too). Pablo, 2026-10-30.
      const isOpen = (n: TodoNode) => {
        const s = stateOf(n);
        return s !== 'done' && s !== 'cancelled';
      };
      const byPlan = (a: TodoNode, b: TodoNode) =>
        (a.dayOrder ?? 0) - (b.dayOrder ?? 0) || (treeIndex.get(a.nodeId)! - treeIndex.get(b.nodeId)!);

      return {
        day: input.day,
        today,
        // The day's own list keeps done rows (they were planned and finished);
        // cancelled rows are excluded — cancelling removes the task from the
        // plan (writeStateTransition clears plannedFor), and a legacy row
        // with a stale plannedFor is dropped here too.
        tasks: tasks
          .filter((n) => n.plannedFor === input.day && stateOf(n) !== 'cancelled')
          .sort(byPlan)
          .map(toDayTask),
        overdue: tasks
          .filter((n) => typeof n.plannedFor === 'string' && n.plannedFor !== '' && n.plannedFor < today && isOpen(n))
          .sort((a, b) => (a.plannedFor! < b.plannedFor! ? -1 : a.plannedFor! > b.plannedFor! ? 1 : byPlan(a, b)))
          .map(toDayTask),
        unplanned: tasks.filter((n) => !n.plannedFor && isOpen(n)).map(toDayTask),
      };
    },
    /**
     * Assign a task to an agent or a person of its workspace, or unassign it
     * (`assignee: null`). Stores `assignedAt` (the autoplay queue order) and
     * runs the agent's scheduling cycle (TODOAP-REQ-18), and logs "Assigned to <name>" / "Unassigned".
     * Re-assigning to the same assignee is a no-op. Groups: NOT_A_TASK.
     * Scope: findOne / findOneAndUpdate({ workspaceId, nodeId }); the
     * assignee is checked against this workspace (resolveAssignee).
     */
    async 'assign-node'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(AssignNodeSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'assignee');
      const current = assigneeOf(node);
      const next = input.assignee;
      if (!next) {
        if (!current) return { node: nodeSummary(node) };
        const unassignActor = await resolveActor(db, wsId, ctx, body);
        const updated = await writeNode(db, wsId, input.nodeId, {
          $set: { assignee: null, assignedAt: null },
          log: { text: 'Unassigned', actor: unassignActor },
        });
        if (!updated) return nodeNotFound(input.nodeId);
        // todo.task_unassigned (todo/events spec — board parity with task_assigned).
        emitFor(wsId, updated, (svc, ws) =>
          emitTaskUnassigned(svc, ws, updated, current.id, actorFromLogActor(unassignActor)),
        );
        // Scheduling trigger (TODOAP-REQ-22): runners picking up unassigned tasks.
        scheduleUnassigned(wsId, updated);
        return { node: nodeSummary(updated) };
      }
      if (current && current.kind === next.kind && current.id === next.id) return { node: nodeSummary(node) };
      const name = await resolveAssignee(db, wsId, next);
      const assignActor = await resolveActor(db, wsId, ctx, body);
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: { assignee: { kind: next.kind, id: next.id }, assignedAt: Date.now() },
        log: { text: `Assigned to ${name}`, actor: assignActor },
      });
      if (!updated) return nodeNotFound(input.nodeId);
      // todo.task_assigned (todo/events spec — board parity with task_assigned).
      emitFor(wsId, updated, (svc, ws) =>
        emitTaskAssigned(svc, ws, updated, actorFromLogActor(assignActor)),
      );
      // Scheduling trigger (TODOAP-REQ-18): the new agent may pick it up.
      scheduleFor(wsId, updated);
      return { node: nodeSummary(updated) };
    },

    /**
     * Set the reviewer of a task (TODORV — docs/specs/todo/reviewer.md): the
     * agent or workspace member who reviews it when it enters `review`, or
     * clear it (`reviewer: null`, back to manual validation — nobody evaluates). Empty by
     * default: a task without a reviewer behaves exactly as before. No
     * autoplay trigger — reviewing is not execution; the reviewer is notified
     * when the task enters `review` (see set-state), not on assignment.
     * Re-setting the same reviewer is a no-op. Groups: NOT_A_TASK.
     * Scope: findOne / findOneAndUpdate({ workspaceId, nodeId }); the reviewer
     * is checked against this workspace (resolveAssignee).
     */
    async 'set-reviewer'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SetReviewerSchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'reviewer');
      const current = reviewerOf(node);
      const next = input.reviewer;
      if (!next) {
        if (!current) return { node: nodeSummary(node) };
        const clearActor = await resolveActor(db, wsId, ctx, body);
        const updated = await writeNode(db, wsId, input.nodeId, {
          $set: { reviewer: null, reviewedAt: null },
          log: { text: 'Reviewer removed', actor: clearActor },
        });
        if (!updated) return nodeNotFound(input.nodeId);
        return { node: nodeSummary(updated) };
      }
      if (current && current.kind === next.kind && current.id === next.id) return { node: nodeSummary(node) };
      const name = await resolveAssignee(db, wsId, next);
      const setActor = await resolveActor(db, wsId, ctx, body);
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: { reviewer: { kind: next.kind, id: next.id }, reviewedAt: Date.now() },
        log: { text: `Reviewer set to ${name}`, actor: setActor },
      });
      if (!updated) return nodeNotFound(input.nodeId);
      return { node: nodeSummary(updated) };
    },

    // ─── Dependencies (TODODEP — Option A "ver y respetar", Pablo 2-nov) ─────────────────────────────

    /**
     * Make a task wait on another task of the same workspace: `nodeId` is not
     * started by the autoplay while `blockerNodeId` is unresolved, and the
     * day/tree rows show it with the waiting semáforo. A dependency releases
     * when the blocker reaches done or cancelled (review does NOT — board
     * parity). Groups can neither wait nor block (NOT_A_TASK); the blocker
     * must be a task of this workspace (NOT_FOUND — another workspace's node
     * is not revealed); cycles — self, direct or transitive — are rejected
     * with CIRCULAR_DEPENDENCY. Adding an existing dependency is a no-op
     * (added: false). Logs "Depends on <title>" and emits todo.dependency_added.
     * Scope: findOne × 2 + the reachability walk { workspaceId, nodeId }.
     */
    async 'add-dependency'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(AddDependencySchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'dependencies');
      const blocker = await nodes(db).findOne(
        { workspaceId: wsId, nodeId: input.blockerNodeId },
        { projection: { _id: 0, nodeId: 1, text: 1, kind: 1, state: 1, completed: 1 } },
      );
      if (!blocker) {
        return notFound(
          `Node "${input.blockerNodeId}" not found.`,
          'The blocker must be a task of the same workspace. Get valid IDs with get-tree or search-nodes.',
        );
      }
      if (kindOf(blocker) === 'group') {
        return fail(
          'NOT_A_TASK',
          `Node "${input.blockerNodeId}" is a group; a group cannot block a task.`,
          'Use a task node as the blocker.',
        );
      }
      const deps = dependenciesOf(node);
      const ref = () => ({ nodeId: blocker.nodeId, text: blocker.text, state: stateOf(blocker) });
      if (deps.includes(input.blockerNodeId)) {
        return { node: nodeSummary(node), dependency: ref(), added: false as const };
      }
      if (await wouldCreateCycle(db, wsId, input.nodeId, input.blockerNodeId)) {
        return fail(
          'CIRCULAR_DEPENDENCY',
          `Making "${node.text}" wait on "${blocker.text}" would create a circular dependency: "${blocker.text}" already depends (directly or transitively) on "${node.text}".`,
          'Remove the dependency that points back the other way first, or pick a different blocker.',
        );
      }
      const actor = await resolveActor(db, wsId, ctx, body);
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: { dependencies: [...deps, input.blockerNodeId] },
        log: { text: `Depends on ${blocker.text}`, actor },
      });
      if (!updated) return nodeNotFound(input.nodeId);
      // todo.dependency_added (todo/events spec — board parity).
      emitFor(wsId, updated, (svc, ws) =>
        emitTaskDependencyAdded(svc, ws, updated, ref(), actorFromLogActor(actor)),
      );
      return { node: nodeSummary(updated), dependency: ref(), added: true as const };
    },

    /**
     * Remove a dependency: `nodeId` stops waiting on `blockerNodeId`.
     * Removing one that is not there is a no-op (removed: false). Logs
     * "Dependency removed: <title>", emits todo.dependency_removed and runs
     * the scheduling triggers — the task may be eligible now (like set-state
     * into pending). Groups have no dependencies (NOT_A_TASK).
     * Scope: findOne × 2 + findOneAndUpdate({ workspaceId, nodeId }).
     */
    async 'remove-dependency'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(RemoveDependencySchema, body);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'dependencies');
      const deps = dependenciesOf(node);
      if (!deps.includes(input.blockerNodeId)) {
        return { node: nodeSummary(node), dependency: null, removed: false as const };
      }
      const blocker = await nodes(db).findOne(
        { workspaceId: wsId, nodeId: input.blockerNodeId },
        { projection: { _id: 0, nodeId: 1, text: 1, kind: 1, state: 1, completed: 1 } },
      );
      const blockerText = blocker?.text ?? input.blockerNodeId;
      const removedRef = {
        nodeId: input.blockerNodeId,
        text: blockerText,
        state: blocker ? stateOf(blocker) : null,
      };
      const actor = await resolveActor(db, wsId, ctx, body);
      const updated = await writeNode(db, wsId, input.nodeId, {
        $set: { dependencies: deps.filter((id) => id !== input.blockerNodeId) },
        log: { text: `Dependency removed: ${blockerText}`, actor },
      });
      if (!updated) return nodeNotFound(input.nodeId);
      // todo.dependency_removed (todo/events spec).
      emitFor(wsId, updated, (svc, ws) =>
        emitTaskDependencyRemoved(svc, ws, updated, removedRef, actorFromLogActor(actor)),
      );
      // Scheduling trigger: the task may be eligible now.
      scheduleFor(wsId, updated);
      scheduleUnassigned(wsId, updated);
      return { node: nodeSummary(updated), dependency: removedRef, removed: true as const };
    },

    // ─── Autoplay (docs/specs/todo/autoplay/spec.md) ─────────────────────────

    /**
     * The workspace's runners and global state: { globalPlaying, runners:
     * [{ agentId, name, avatarUrl, slots, playEnabled, activeSlots }] },
     * activeSlots = the agent's running tasks. globalPlaying is the
     * workspace's autoplay play/pause (TODOAP-REQ-30). Every member may list
     * them (read included).
     * Scope: todo_autoplay_runners / todo_autoplay_state / todo_nodes { workspaceId }.
     * @spec TODOAP-REQ-2
     * @spec TODOAP-REQ-30
     */
    async 'get-autoplay'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      validateInput(CallerSchema, body);
      const svc = requireAutoplay();
      return {
        globalPlaying: await svc.getGlobalPlay(wsId),
        runningCount: await svc.runningCount(wsId),
        runners: await svc.listRunners(wsId),
      };
    },

    /**
     * Set an agent's slots (creates the runner). 0 slots also turns play off.
     * owner/admin/write only; the agent must belong to the workspace
     * (INVALID_ASSIGNEE). Broadcasts todo_autoplay_changed to every member.
     * @spec TODOAP-REQ-1
     * @spec TODOAP-REQ-2
     */
    async 'set-agent-slots'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(SetAgentSlotsSchema, body);
      const svc = requireAutoplay();
      await requireRunnerWriter(db, wsId, input.callerUserId);
      await resolveAssignee(db, wsId, { kind: 'agent', id: input.agentId });
      const runner = await svc.setAgentSlots(wsId, input.agentId, input.slots);
      // todo.agent_slots_changed (todo/events spec — board parity).
      {
        const sub = subscriptions();
        if (sub) {
          try {
            emitAgentSlotsChanged(sub, wsId, input.agentId, input.slots, actorFromLogActor(await resolveActor(db, wsId, ctx, body)));
          } catch (err) {
            console.error('[todo] event emission failed (agent_slots_changed):', err);
          }
        }
      }
      return { runner };
    },

    /**
     * Turn an agent's play on/off (creates the runner). Enabling with 0 slots
     * fails with INVALID_STATE. owner/admin/write only; the agent must belong
     * to the workspace. Broadcasts todo_autoplay_changed to every member.
     * @spec TODOAP-REQ-1
     * @spec TODOAP-REQ-2
     */
    async 'set-agent-play'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(SetAgentPlaySchema, body);
      const svc = requireAutoplay();
      await requireRunnerWriter(db, wsId, input.callerUserId);
      await resolveAssignee(db, wsId, { kind: 'agent', id: input.agentId });
      const runner = await svc.setAgentPlay(wsId, input.agentId, input.enabled);
      // todo.agent_play_changed (todo/events spec — board parity).
      {
        const sub = subscriptions();
        if (sub) {
          try {
            emitAgentPlayChanged(sub, wsId, input.agentId, input.enabled, actorFromLogActor(await resolveActor(db, wsId, ctx, body)));
          } catch (err) {
            console.error('[todo] event emission failed (agent_play_changed):', err);
          }
        }
      }
      return { runner };
    },

    /**
     * Set the workspace's global autoplay play/pause (TODOAP-REQ-30): the
     * panel's Play/Pause control. Playing starts ONLY the enabled runners
     * (playEnabled true, slots > 0) — a disabled runner is excluded from the
     * global control. Pausing stops every scheduler path but never interrupts
     * running turns. owner/admin/write only. Broadcasts todo_autoplay_changed
     * (globalPlaying) to every member.
     * Scope: todo_autoplay_state { workspaceId } / todo_autoplay_runners { workspaceId }.
     * @spec TODOAP-REQ-30
     */
    async 'set-global-play'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(SetGlobalPlaySchema, body);
      const svc = requireAutoplay();
      await requireRunnerWriter(db, wsId, input.callerUserId);
      const globalPlaying = await svc.setGlobalPlay(wsId, input.playing);
      // todo.global_play_changed (todo/events spec).
      {
        const sub = subscriptions();
        if (sub) {
          try {
            emitGlobalPlayChanged(sub, wsId, input.playing, actorFromLogActor(await resolveActor(db, wsId, ctx, body)));
          } catch (err) {
            console.error('[todo] event emission failed (global_play_changed):', err);
          }
        }
      }
      return { globalPlaying };
    },

    /**
     * The workspace's global STOP (TODOAP-REQ-31): pause the autoplay AND
     * abort every in-flight turn of the workspace's todo tasks — the
     * equivalent of going to each task's conversation and pressing stop. The
     * tasks stay `working` with no live turn; nothing restarts until the
     * global play. owner/admin/write only. Broadcasts todo_autoplay_changed
     * (globalPlaying false) through the pause; returns how many turns were
     * aborted.
     * Scope: todo_autoplay_state / todo_nodes { workspaceId }.
     * @spec TODOAP-REQ-31
     */
    async 'stop-autoplay'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(CallerSchema, body);
      const svc = requireAutoplay();
      await requireRunnerWriter(db, wsId, input.callerUserId);
      const aborted = await svc.stopGlobal(wsId);
      // todo.global_play_changed (todo/events spec) — the stop pauses first.
      {
        const sub = subscriptions();
        if (sub) {
          try {
            emitGlobalPlayChanged(sub, wsId, false, actorFromLogActor(await resolveActor(db, wsId, ctx, body)));
          } catch (err) {
            console.error('[todo] event emission failed (global_play_changed):', err);
          }
        }
      }
      return { globalPlaying: false, aborted };
    },

    /**
     * Set an agent's scope (creates the runner): `scopeNodeId` is a group of
     * the workspace (else INVALID_INPUT) or null for the whole tree;
     * `pickUnassigned` makes the runner also pick up unassigned eligible
     * tasks under it. owner/admin/write only; the agent must belong to the
     * workspace. Broadcasts todo_autoplay_changed to every member and runs
     * the cycle when the runner is playing.
     * Scope: todo_autoplay_runners / todo_nodes { workspaceId }.
     * @spec TODOAP-REQ-22
     */
    async 'set-agent-scope'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(SetAgentScopeSchema, body);
      const svc = requireAutoplay();
      await requireRunnerWriter(db, wsId, input.callerUserId);
      await resolveAssignee(db, wsId, { kind: 'agent', id: input.agentId });
      return { runner: await svc.setAgentScope(wsId, input.agentId, input.scopeNodeId, input.pickUnassigned) };
    },

    /**
     * Remove a runner. Running turns are not interrupted. owner/admin/write
     * only. Broadcasts todo_autoplay_changed (removed) to every member.
     * @spec TODOAP-REQ-2
     */
    async 'remove-agent'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(AgentIdSchema, body);
      const svc = requireAutoplay();
      await requireRunnerWriter(db, wsId, input.callerUserId);
      await svc.removeRelationship(wsId, input.agentId);
      return { removed: true as const, agentId: input.agentId };
    },

    /**
     * Manual start: a task assigned to an agent, in `pending` or in `working`
     * without a conversation, starts now as the scheduler would start it,
     * whatever its planned day and the runner's play/slots. The caller is the
     * billing user. Human/unassigned task: NOT_AGENT_TASK; other states:
     * INVALID_STATE (409); a start that could not create or link the
     * conversation is rolled back and fails with START_FAILED (500).
     * @spec TODOAP-REQ-9
     */
    async 'start-node'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(StartNodeSchema, body);
      const svc = requireAutoplay();
      const caller = await requireCaller(db, wsId, input.callerUserId);
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'assignee');
      const a = assigneeOf(node);
      if (!a || a.kind !== 'agent') {
        return fail(
          'NOT_AGENT_TASK',
          `Task "${input.nodeId}" is not assigned to an agent.`,
          'Assign it to an agent with assign-node first.',
        );
      }
      const state = stateOf(node);
      if (!(state === 'pending' || (state === 'working' && !node.channelId))) {
        return fail(
          'INVALID_STATE',
          `Task "${input.nodeId}" cannot be started from "${state}"${node.channelId ? ' with a conversation' : ''}.`,
          'Only a pending task, or a working one without a conversation, can be started.',
          409,
        );
      }
      const started = await svc.startTask(wsId, node, caller.userId);
      if (!started) {
        return fail('START_FAILED', 'The task could not be started.', 'Check the log of the task and retry.', 500);
      }
      return { node: nodeSummary(started), channelId: started.channelId ?? null };
    },

    /**
     * Open the task's work context (CCR-REQ-8): reveal the runner's terminal
     * in the Terminal window, or — when the session is gone (destroyed, host
     * lost) — recreate it with `claude --resume <sessionId>` so Claude Code
     * recovers its full memory of the task. The runner must be wired and the
     * task must have a runner record; the caller is the billing user.
     * @spec CCR-REQ-8
     */
    async 'open-runner-terminal'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(OpenRunnerTerminalSchema, body);
      const caller = await requireCaller(db, wsId, input.callerUserId);
      const runner = getMcaActionDeps().claudeCodeRunner;
      if (!runner) {
        return fail(
          'UNAVAILABLE',
          'The Claude Code runner is not wired in this deployment.',
          'Runner terminals need the terminal host; this backend runs without it.',
          503,
        );
      }
      const node = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
      if (!node) return nodeNotFound(input.nodeId);
      if (kindOf(node) === 'group') return notATask(input.nodeId, 'runner');
      if (!node.runner) {
        return fail(
          'NOT_RUNNER_TASK',
          `Task "${input.nodeId}" has no runner session.`,
          'Only tasks worked by a runner (claude-code) carry a terminal to open.',
          409,
        );
      }
      const a = assigneeOf(node);
      if (!a || a.kind !== 'agent') {
        return fail('NOT_RUNNER_TASK', `Task "${input.nodeId}" has no agent assignee.`, 'Assign it to a runner agent first.', 409);
      }
      try {
        const opened = await runner.reopenTerminal(wsId, node, a.id, caller.userId);
        const fresh = await nodes(db).findOne({ workspaceId: wsId, nodeId: input.nodeId });
        return { terminalId: opened.terminalId, resumed: opened.resumed, node: nodeSummary(fresh ?? node) };
      } catch (err) {
        console.error(`[todo] open-runner-terminal ${input.nodeId} failed:`, err);
        return fail('START_FAILED', 'The terminal could not be opened.', 'Check the backend log and retry.', 500);
      }
    },

    /**
     * Subscribe the calling conversation (or an explicit channelId) to this
     * workspace's to-do events (todo/events spec — board parity with
     * subscribe_to_board). Upsert: a second subscribe for the same
     * (workspace, channel) REPLACES the previous filter (same subscriptionId).
     * The channel must belong to the workspace's tree owner/member path: the
     * caller must be an owner/member of the workspace (requireCaller) and the
     * channel must exist. Returns { subscription, created }.
     */
    async 'subscribe-to-todo'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(SubscribeSchema, body);
      const svc = subscriptions();
      if (!svc) return fail('UNAVAILABLE', 'To-do event subscriptions are not available.', undefined, 503);

      // The conversation that receives the events: the explicit channelId, or
      // the calling agent's channel. One of the two must be present.
      const channelId = input.channelId ?? input.callerChannelId;
      if (!channelId) {
        return fail(
          'INVALID_INPUT',
          'A channelId is required to subscribe.',
          'Pass channelId, or call this from an agent conversation (its channel is used).',
        );
      }
      // The channel must exist (and the caller must be a workspace member —
      // requireCaller below). Board parity: events are delivered INTO this
      // channel and can wake its agent.
      const channel = await collection(db, COLLECTIONS.channels).findOne(
        { channelId },
        { projection: { _id: 1, workspaceId: 1, agentId: 1 } },
      );
      if (!channel) {
        return notFound(
          `Channel not found: ${channelId}`,
          'The channelId does not exist. An agent conversation channel is the usual target.',
        );
      }

      // Caller must be a member of the workspace (any role — a read member may
      // subscribe, mirroring the board where any workspace member can).
      const caller = await requireCaller(db, wsId, input.callerUserId ?? ctx.userId);
      const agentId = input.callerAgentId ?? (typeof channel.agentId === 'string' ? channel.agentId : undefined) ?? caller.userId;

      const { subscription, created } = await svc.subscribeWithStatus(wsId, channelId, agentId, input.filter ?? {});
      return {
        subscription: {
          subscriptionId: subscription.subscriptionId,
          workspaceId: subscription.workspaceId,
          channelId: subscription.channelId,
          agentId: subscription.agentId,
          filter: subscription.filter,
          createdAt: subscription.createdAt,
          updatedAt: subscription.updatedAt,
        },
        created,
        message: created
          ? `Subscribed to the to-do events of this workspace. Events that pass the filter are delivered to this conversation (and wake its agent unless wakeUpOn narrows it).`
          : `Updated the existing subscription — the previous filter was REPLACED by this one (same subscription, same conversation).`,
      };
    },

    /**
     * Cancel the calling conversation's (or an explicit channelId's)
     * subscription to this workspace's to-do events. Idempotent: a missing
     * subscription returns { unsubscribed: true } unchanged.
     */
    async 'unsubscribe-from-todo'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(UnsubscribeSchema, body);
      const svc = subscriptions();
      if (!svc) return fail('UNAVAILABLE', 'To-do event subscriptions are not available.', undefined, 503);
      const channelId = input.channelId ?? input.callerChannelId;
      if (!channelId) {
        return fail(
          'INVALID_INPUT',
          'A channelId is required to unsubscribe.',
          'Pass channelId, or call this from an agent conversation (its channel is used).',
        );
      }
      const deleted = await svc.unsubscribe(wsId, channelId);
      return { unsubscribed: true as const, channelId, deleted };
    },

    /**
     * The calling conversation's (or an explicit channelId's) to-do
     * subscriptions: { subscriptions: [...] }.
     */
    async 'list-todo-subscriptions'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      await ensureTodoIndexes(db);
      const input = validateInput(ListSubscriptionsSchema, body);
      const svc = subscriptions();
      if (!svc) return fail('UNAVAILABLE', 'To-do event subscriptions are not available.', undefined, 503);
      const channelId = input.channelId ?? input.callerChannelId;
      if (!channelId) {
        return fail(
          'INVALID_INPUT',
          'A channelId is required to list subscriptions.',
          'Pass channelId, or call this from an agent conversation (its channel is used).',
        );
      }
      const all = await svc.listByChannel(channelId);
      const subs = all.filter((s) => s.workspaceId === wsId);
      return {
        subscriptions: subs.map((s) => ({
          subscriptionId: s.subscriptionId,
          workspaceId: s.workspaceId,
          channelId: s.channelId,
          agentId: s.agentId,
          filter: s.filter,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      };
    },

    /**
     * Public link to a task's markdown or file io: { shareId, publicUrl } —
     * the caller's existing share of that node + io, else a new one. A form
     * or missing io: INVALID_STATE (409). owner/admin/write only.
     * Logic in handlers/domains/todo-share.
     * @spec TODOOV-REQ-4
     */
    async 'share-io'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(IoShareSchema, body);
      const userId = await requireShareWriter(db, wsId, input.callerUserId);
      return shareIo(db, wsId, userId, { nodeId: input.nodeId, io: input.io });
    },

    /**
     * The caller's share of a task's io: { shareId, publicUrl } or null.
     * owner/admin/write only.
     * @spec TODOOV-REQ-4
     */
    async 'get-io-share'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(IoShareSchema, body);
      const userId = await requireShareWriter(db, wsId, input.callerUserId);
      return getIoShare(db, wsId, userId, { nodeId: input.nodeId, io: input.io });
    },

    /**
     * Revoke a task io share: { ok: true }. Only its owner (FORBIDDEN);
     * owner/admin/write only.
     * @spec TODOOV-REQ-4
     */
    async 'unshare-io'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(UnshareIoSchema, body);
      const userId = await requireShareWriter(db, wsId, input.callerUserId);
      return unshareIo(db, wsId, userId, { shareId: input.shareId });
    },
  },
};

/** Io shares are for owner/admin/write members; a read member is FORBIDDEN (TODOOV-REQ-4). */
async function requireShareWriter(db: Db, wsId: string, callerUserId: string | undefined): Promise<string> {
  const caller = await requireCaller(db, wsId, callerUserId);
  if (caller.role === 'read') {
    fail('FORBIDDEN', 'Read members cannot share task outputs.', undefined, 403);
  }
  return caller.userId;
}

/** Runner changes are for owner/admin/write members; read members only list (TODOAP-REQ-2). */
async function requireRunnerWriter(db: Db, wsId: string, callerUserId: string | undefined): Promise<void> {
  const caller = await requireCaller(db, wsId, callerUserId);
  if (caller.role === 'read') {
    fail('FORBIDDEN', 'Read members cannot change autoplay runners.', undefined, 403);
  }
}
