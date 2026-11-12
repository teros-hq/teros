/**
 * To Do Autoplay — agents pick up their planned tasks.
 * See: docs/specs/todo/autoplay/spec.md (TODOAP).
 *
 * The board autoplay (services/autoplay-service.ts) transplanted to the To Do
 * tree, method by method: per (workspace, agent) runners with slots and play,
 * a scheduling cycle that re-wakes stuck tasks, starts orphaned working ones
 * and starts eligible ones, the auto-wake cap, a 60 s safety-net scheduler and
 * the zombie running-flag clean-up. Differences with the board are the tree's
 * own rules:
 *   - eligible = a task in `pending`, assigned to the agent and planned for
 *     today or an earlier day (server local date);
 *   - orphaned = a task in `working`, assigned to the agent, with NO linked
 *     conversation (worked by hand, or sent back from review / unblocked
 *     without one): started with a fresh conversation, whatever its day
 *     (TODOAP-REQ-27), after stuck tasks and before pending ones;
 *   - starting moves the task to `working` through the same state write as
 *     set-state (todo.ts writeStateTransition), so pending ancestors escalate;
 *   - a start that cannot create/link the conversation is rolled back with the
 *     error's text in the log, and after `startFailCap` (default 2) consecutive
 *     failed starts the task is BLOCKED with the error as the reason
 *     (TODOAP-REQ-32) — a failed start never becomes a silent retry loop;
 *   - every server-side node write is broadcast as `todo_node_changed` to
 *     every member of the workspace (`todo:${userId}`).
 *
 * Runner scope (TODOAP-REQ-22): a runner with `pickUnassigned` also picks up
 * unassigned eligible tasks under its scope group (the whole tree when
 * `scopeNodeId` is null), after its own tasks, claiming each one atomically.
 *
 * Core function: scheduleAgentTasks(workspaceId, agentId)
 * Triggered by (TODOAP-REQ-18):
 *   1. todo set-agent-play (enabled) / set-agent-slots (slots > 0 while playing)
 *   2. todo assign-node (to an agent), plan-node, set-state into pending/review/done
 *   3. Periodic scheduler (every 60 s safety net, after the zombie clean-up)
 * The end of an agent turn does NOT trigger it, exactly like the board: a task
 * left `working` is re-woken by the next cycle (stuck tasks first), so a
 * one-slot runner stays on the same task until it finishes or is auto-blocked.
 *
 * Dependency gate (TODODEP — Option A "ver y respetar", Pablo 2-nov): a
 * candidate with an unresolved dependency — any blocker not done/cancelled —
 * is NOT started (startableTasks, both the own and the unassigned pickup);
 * it stays `pending` with its visible wait (the semáforo + "Espera a" the
 * reads carry) and a later cycle picks it up once the blocker releases
 * (set-state/toggle-complete run the dependents' cycles; the 60 s safety net
 * is the backstop, so the release-to-start lag stays ≤ 1 min). In-flight work
 * is never interrupted: stuck re-wakes and orphaned working starts are not
 * gated — only new starts are.
 *
 * One-working-per-runner (Pablo, 2026-10-30 — TODOAP-REQ-28): `working` means
 * "someone is on it NOW or is about to resume it", never "someone was on it at
 * some point". When the cycle runs, the working candidates beyond the free
 * slots (stuck + orphaned, in queue order) are demoted to `pending` — the
 * agent resumes the first one and the rest go back to the queue, so at most
 * `slots` working tasks per agent exist, each with a live turn behind it. The
 * demotion is a plain state write that keeps the day, position, conversation,
 * input/output and log (the task is re-picked by the normal flow). A candidate
 * whose turn is running is never a candidate (it holds a slot), and a task
 * whose channel is gone keeps its `channelId` (the next start reuses it).
 * The periodic cycle also sweeps idle working tasks (TODOAP-REQ-29): a task
 * `working` with no live turn whose node was last updated more than
 * `idleTimeoutMs` ago goes back to `pending` — the "agent never came back"
 * case (autoplay paused, agent reassigned) that pickup-time demotion alone
 * cannot fix.
 *
 * Global play/pause (Pablo, 2026-10-30 — TODOAP-REQ-30): two levels, kept
 * apart on purpose. The workspace's autoplay is globally `playing` (default,
 * no doc) or `paused` (todo_autoplay_state); each runner keeps its own
 * `playEnabled` (config) and `slots`. A runner only works iff
 * global=playing ∧ runner=playEnabled ∧ slots≥1. The global pause stops
 * every scheduler path (cycle, periodic safety net, unassigned pickup) but
 * never interrupts running turns; the global play starts ONLY the enabled
 * runners — a disabled runner is excluded from the global control, which is
 * the whole point of separating config from play/pause.
 */

import type { ClaudeCodeRunner } from './terminal/claude-code-runner';
import type { Db, Document } from 'mongodb';
// The capability registry before todo.ts: todo.ts imports from the registry,
// and the registry reads todoCapability at load time, so loading todo.ts first
// would hand the registry an uninitialised capability.
import '../mca-actions';
import { McaActionError } from '../mca-actions/errors';
import {
  nodeSummary,
  startableTasks,
  writeNode,
  writeStateTransition,
  type NodeIO,
  type NodeState,
  type OutputFileType,
  type OutputFormat,
  type TodoNode,
} from '../mca-actions/todo';
import { SYSTEM_ACTOR } from '../mca-actions/todo-log';
import { actorFromLogActor, emitTaskBlocked, emitTaskStarted, emitTaskStateChanged } from './todo-event-emitters';
import { getMcaActionDeps } from '../mca-actions';
import { COLLECTIONS, collection, ensureIndexesFor } from '../db';
import { buildAvatarUrl } from '../lib/avatar-url';
import type { AgentUsageTriggerKind, TodoAutoplayState } from '../types/database';
import { SYSTEM_SENDER } from './board-service';
import type { ChannelManager } from './channel-manager';
import { getChannelWorkerRegistry } from './channel-worker-host';
import type { PubSubService } from './pubsub-service';

/**
 * Callback to send a message to an agent and trigger a response (the
 * canonical AgentWakeUpCallback of event-handler.ts, which is what is wired).
 */
export type TodoWakeUpCallback = (
  channelId: string,
  agentId: string,
  text: string,
  triggerKind?: AgentUsageTriggerKind,
) => Promise<void>;

/** A runner as stored in `todo_autoplay_runners`. */
export interface TodoAutoplayRunner {
  workspaceId: string;
  agentId: string;
  slots: number;
  playEnabled: boolean;
  /** Scope group of the unassigned pickup; null/absent = whole tree (TODOAP-REQ-22). */
  scopeNodeId?: string | null;
  /** Pick up unassigned eligible tasks under the scope; absent = false (TODOAP-REQ-22). */
  pickUnassigned?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A runner as get-autoplay and the runner actions answer it (TODOAP-REQ-2). */
export interface TodoRunnerView {
  agentId: string;
  name: string;
  avatarUrl: string | null;
  slots: number;
  playEnabled: boolean;
  activeSlots: number;
  /** @spec TODOAP-REQ-22 — the scope group, null = whole tree. */
  scopeNodeId: string | null;
  /** @spec TODOAP-REQ-22 — ancestor titles up to and including the scope group, joined by ` › `; null = whole tree (or scope missing). */
  scopePath: string | null;
  /** @spec TODOAP-REQ-22 */
  pickUnassigned: boolean;
  /** @spec TODOAP-REQ-22 — the scope group no longer exists (deleted or turned into a task). */
  scopeMissing: boolean;
}

/** Path separator of `scopePath` (TODOAP-REQ-22). */
const PATH_SEPARATOR = ' › ';

/** The tool prefix an agent sees for the todo-list app (TODOAP-REQ-6). */
const TOOL = 'todo-list_';

// ============================================================================
// MESSAGES
// ============================================================================

/** What the kick-off message needs beyond the node: its ancestors' titles, root first. */
export interface TodoInitialMessageContext {
  path: string[];
  /** Tool name prefix in the message (default `todo-list_`; the Claude Code runner passes its MCP prefix, CCR-REQ-2). */
  toolPrefix?: string;
}

function describeInput(input: NodeIO | null | undefined): string[] {
  if (!input) return ['This task has no input.'];
  if (input.format === 'markdown') return [input.markdown];
  if (input.format === 'form') {
    return [
      'A form. Its data (fields and values) as JSON:',
      '```json',
      JSON.stringify({ fields: input.fields, values: input.values }, null, 2),
      '```',
    ];
  }
  return [
    `A file: **${input.name}** (${input.mime}, ${input.size} bytes).`,
    `Fetch it through \`${TOOL}get-node\`: the node's \`input\` carries its \`url\`.`,
  ];
}

const OUTPUT_SHAPES: Record<OutputFormat, string> = {
  markdown: '{ format: "markdown", markdown }',
  form: '{ format: "form", fields, values }',
  // Prefer path when the file already exists in the workspace volume — the
  // backend reads and uploads it, so no base64 is generated inside the tool
  // call (large base64 payloads truncate mid-generation — roadmap incident).
  file: '{ format: "file", path: "/workspace/..." } (file in the workspace volume — the backend reads and uploads it) or { format: "file", name, mime, data: base64 } (in-memory files only)',
};

/** Human names of the expected file types (TODOAP-REQ-14). */
const FILE_TYPE_NAMES: Record<OutputFileType, string> = {
  pdf: 'PDF (.pdf)',
  docx: 'Word document (.docx)',
  xlsx: 'Excel spreadsheet (.xlsx)',
  csv: 'CSV (.csv)',
  png: 'PNG image (.png)',
  jpg: 'JPEG image (.jpg)',
  json: 'JSON (.json)',
  md: 'Markdown file (.md)',
  txt: 'plain text (.txt)',
  html: 'HTML page (.html)',
  other: 'any file type',
};

/**
 * The "Expected output" section, rendered from the task's `expectedOutput`:
 * format and description, the field list of a form (`name · type ·
 * required`), the exact type of a file, how to deliver it, and the
 * "instructions win" line; without a definition, the markdown default.
 * @spec TODOAP-REQ-6, TODOAP-REQ-14
 */
function describeExpectedOutput(node: TodoNode, tool: string = TOOL): string[] {
  const instructionsWin = 'If the instructions state a different format, the instructions win.';
  // Pablo's rule (2026-10-30): the output is the final document itself, never a
  // pointer to it. Applies to every agent on every task start.
  const finalDocument =
    'The output IS the final document itself — never a document that references or links to it: an HTML deliverable is the actual `.html` file, a report is the full report content. Only when no final document is requested (code changes, fixes, audits) is a concise summary with references the right output.';
  const expected = node.expectedOutput;
  if (!expected) {
    return [
      'No expected output defined: deliver markdown unless the instructions say otherwise.',
      `Deliver it with \`${tool}set-output\` (nodeId \`${node.nodeId}\`, output ${OUTPUT_SHAPES.markdown}).`,
      finalDocument,
      instructionsWin,
    ];
  }
  const lines = [`**Format:** ${expected.format}`];
  if (expected.description?.trim()) lines.push(`**Description:** ${expected.description.trim()}`);
  if (expected.format === 'file' && expected.fileType) {
    lines.push(`**File type:** ${FILE_TYPE_NAMES[expected.fileType]}`);
  }
  if (expected.format === 'form' && expected.fields?.length) {
    lines.push('**Fields** (name · type · required):');
    for (const f of expected.fields) {
      lines.push(`- \`${f.id}\` · ${f.type} · ${f.required === true ? 'required' : 'optional'}`);
    }
  }
  lines.push(
    `Deliver it with \`${tool}set-output\` (nodeId \`${node.nodeId}\`, output ${OUTPUT_SHAPES[expected.format]}); an output that does not match this definition is rejected.`,
    finalDocument,
    instructionsWin,
  );
  return lines;
}

/**
 * The kick-off message an agent receives when one of its To Do tasks starts:
 * headline, task (title, id, path, planned day/time), description,
 * instructions, input, expected output and how to work. Every tool it names
 * uses the app's real prefix (`todo-list_`) and exists in the todo-list
 * tools.json. A task that was already `working` (an orphaned start,
 * TODOAP-REQ-27) gets one extra line pointing at its log, where a send-back
 * note or an unblock reply lives when the task has no conversation.
 * @spec TODOAP-REQ-6
 * @spec TODOAP-REQ-27
 */
export function buildTodoInitialMessage(node: TodoNode, ctx: TodoInitialMessageContext): string {
  const T = ctx.toolPrefix ?? TOOL;
  const planned = node.plannedFor
    ? `${node.plannedFor}${node.plannedTime ? ` at ${node.plannedTime}` : ''}`
    : null;
  return [
    `You have been assigned a task. Execute it autonomously.`,
    ``,
    `## Task: ${node.text}`,
    `**Id:** \`${node.nodeId}\``,
    `**Path:** ${ctx.path.length > 0 ? ctx.path.join(' › ') : '(root)'}`,
    ...(planned ? [`**Planned:** ${planned}`] : []),
    ``,
    `## Description`,
    node.description?.trim() || 'No description provided.',
    ``,
    `## Instructions`,
    node.instructions?.trim() || 'No instructions provided.',
    ``,
    `## Input`,
    ...describeInput(node.input),
    ``,
    `## Expected output`,
    ...describeExpectedOutput(node, T),
    ``,
    `## How to work`,
    `- Read the task at any time with \`${T}get-node\` (nodeId \`${node.nodeId}\`).`,
    ...(node.state === 'working'
      ? [
          `- This task was already in progress without a conversation. Read its log with \`${T}get-node\` — a send-back note or an unblock reply from the operator may be waiting there.`,
        ]
      : []),
    `- Treat the instruction checklist as your plan. After finishing each item, tick it with \`${T}toggle-instruction-item\` and set the progress with \`${T}set-progress\` to the share of items done (3 of 7 items → 43 %), with a note in plain language through \`${T}add-log-entry\`.`,
    `- If there is no checklist, the operator appreciates being kept informed of progress — update the percentage with \`${T}set-progress\` from your own plan after each significant step, with a note through \`${T}add-log-entry\`.`,
    `- When you finish, deliver the output with \`${T}set-output\`, then set the state to \`review\` with \`${T}set-state\`.`,
    `- If you are stuck or need something from the operator, set the state to \`blocked\` with \`${T}set-state\` and your question as the reason. The operator's answer arrives in this conversation.`,
    `- Never send to review what you could not finish. When something you need is missing — a tool permission denied in this headless conversation, access you lack, a decision or data only the operator has — set the state to \`blocked\` with \`${T}set-state\` and a reason that names exactly what is needed (for example: "Permission needed: assign the task to a user"), instead of \`review\` with a note. \`review\` means the deliverable is complete.`,
    `- If you hit the execution limit (tool calls blocked), add a progress note with \`${T}add-log-entry\` summarising what is done and what remains — this resets your execution counter so you can continue working.`,
    `- Never delegate: do not hand this task to another agent or use any delegation tool. Do all the work in this conversation.`,
  ].join('\n');
}

/** @spec TODOAP-REQ-7 */
export function buildTodoRewakeMessage(node: Pick<TodoNode, 'text'>): string {
  return `Task "${node.text}" is still in progress. Continue where you left off. The operator appreciates being kept informed of progress — update the percentage with set-progress after each significant step. If you are blocked or need help, set the state to blocked with your question. If something you need is missing (a denied permission, access, a decision), set the state to blocked with the exact need as the reason — never send to review what you could not finish. If you hit the execution limit, add a progress note summarising what is done and what remains — this resets your execution counter so you can continue.`;
}

/** The reason a task is blocked with when it reaches the auto-wake cap (TODOAP-REQ-7). */
export function exhaustedReason(cap: number): string {
  return `Stopped after ${cap} automatic wake-ups without finishing. Reply to continue.`;
}

/** The reason a task is blocked with when its start failed `cap` times in a row (TODOAP-REQ-32). */
export function startFailedReason(cap: number, error: string): string {
  return `Autoplay start failed ${cap} times: ${error}. Unblock the task to retry.`;
}

/** The text of a start failure for the log: the error's message, one line, bounded. */
function startErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' · ');
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

/**
 * Today's calendar day on the server, 'YYYY-MM-DD' (the format plannedFor uses).
 * @spec TODOAP-REQ-3
 */
export function todoToday(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * Queue order — the window's top-to-bottom order, used for every ranking the
 * scheduler makes (eligible, unassigned pickups, stuck): `plannedFor` asc
 * (missing last), `dayOrder` asc (nulls last), tree `position` asc, then
 * `nodeId` asc as a stable tie-break.
 * @spec TODOAP-REQ-25
 */
function byQueueOrder(a: TodoNode, b: TodoNode): number {
  const pa = a.plannedFor || null;
  const pb = b.plannedFor || null;
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa < pb ? -1 : 1;
  }
  const da = typeof a.dayOrder === 'number' ? a.dayOrder : Number.POSITIVE_INFINITY;
  const db = typeof b.dayOrder === 'number' ? b.dayOrder : Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  const qa = typeof a.position === 'number' ? a.position : Number.POSITIVE_INFINITY;
  const qb = typeof b.position === 'number' ? b.position : Number.POSITIVE_INFINITY;
  if (qa !== qb) return qa < qb ? -1 : 1;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/** Filter of the unassigned tasks of a workspace (assignee absent or null). */
function unassignedTasks(workspaceId: string): Document {
  return { workspaceId, kind: { $ne: 'group' }, assignee: null };
}

/** Filter of the tasks assigned to an agent in a workspace. */
function agentTasks(workspaceId: string, agentId: string): Document {
  return { workspaceId, kind: { $ne: 'group' }, 'assignee.kind': 'agent', 'assignee.id': agentId };
}

// ============================================================================
// TODO AUTOPLAY SERVICE
// ============================================================================

/** @spec TODOAP-REQ-18 */
export class TodoAutoplayService {
  private db: Db;
  private pubSubService: PubSubService;
  private channelManager: ChannelManager;
  private wakeUpCallback: TodoWakeUpCallback | null = null;
  private readonly autoWakeCap: number;
  /** How long a `working` task with no live turn may stay idle before the sweep demotes it (TODOAP-REQ-29). */
  private readonly idleTimeoutMs: number;
  /** Consecutive failed starts before a task is blocked instead of rolled back (TODOAP-REQ-32). */
  private readonly startFailCap: number;

  // Periodic scheduler state
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Db,
    pubSubService: PubSubService,
    channelManager: ChannelManager,
    autoWakeCap = 5,
    idleTimeoutMs = 4 * 60 * 60 * 1000,
    startFailCap = 2,
  ) {
    this.db = db;
    this.pubSubService = pubSubService;
    this.channelManager = channelManager;
    this.autoWakeCap = autoWakeCap;
    this.idleTimeoutMs = idleTimeoutMs;
    this.startFailCap = startFailCap;
  }

  /** Wire the wake-up callback after construction (lazy init pattern). */
  setWakeUpCallback(cb: TodoWakeUpCallback): void {
    this.wakeUpCallback = cb;
  }
  /** Claude Code runner (CCR-REQ-2): works the tasks of `runner: 'claude-code'` agents. */
  private claudeCodeRunner: ClaudeCodeRunner | null = null;
  setClaudeCodeRunner(runner: ClaudeCodeRunner): void {
    this.claudeCodeRunner = runner;
  }

  private runners() {
    return collection<TodoAutoplayRunner>(this.db, COLLECTIONS.todoAutoplayRunners);
  }

  private nodes() {
    return collection<TodoNode>(this.db, COLLECTIONS.todoNodes);
  }

  private state() {
    return collection<TodoAutoplayState>(this.db, COLLECTIONS.todoAutoplayState);
  }

  // ==========================================================================
  // GLOBAL PLAY/PAUSE (TODOAP-REQ-30)
  // ==========================================================================

  /**
   * The workspace's global autoplay state. A missing doc means `playing` —
   * the default, so workspaces that never touched the global control behave
   * exactly as before. Only a deliberate pause writes the doc; resuming
   * deletes it.
   * @spec TODOAP-REQ-30
   */
  async getGlobalPlay(workspaceId: string): Promise<boolean> {
    const doc = await this.state().findOne(
      { workspaceId },
      { projection: { _id: 0, playing: 1 } },
    );
    return doc?.playing !== false;
  }

  /**
   * Set the workspace's global autoplay play/pause. Pausing never interrupts
   * running turns (same rule as a runner's own pause); it only stops the
   * scheduler from starting/re-waking anything. Broadcasts
   * `todo_autoplay_changed` with the global payload to every member; playing
   * runs the cycle for every enabled runner with slots.
   * @spec TODOAP-REQ-30
   */
  async setGlobalPlay(workspaceId: string, playing: boolean): Promise<boolean> {
    if (playing) {
      // Back to the default: no doc = playing.
      await this.state().deleteOne({ workspaceId, playing: false });
    } else {
      await this.state().updateOne(
        { workspaceId },
        { $set: { playing: false, updatedAt: new Date() } },
        { upsert: true },
      );
    }
    await this.broadcastToMembers(workspaceId, {
      type: 'todo_autoplay_changed',
      workspaceId,
      globalPlaying: playing,
    });
    if (playing) await this.scheduleAllEnabled(workspaceId);
    return playing;
  }

  /**
   * Run the scheduling cycle for every enabled runner with slots of the
   * workspace (the global play's "start working"): a disabled runner
   * (playEnabled false) is excluded — the point of the two-level model.
   * @spec TODOAP-REQ-30
   */
  async scheduleAllEnabled(workspaceId: string): Promise<void> {
    try {
      const enabled = await this.runners()
        .find({ workspaceId, playEnabled: true, slots: { $gt: 0 } })
        .sort({ createdAt: 1 })
        .toArray();
      for (const rel of enabled) await this.scheduleAgentTasks(workspaceId, rel.agentId);
    } catch (err) {
      console.error(`[TodoAutoplayService] scheduleAllEnabled error in workspace ${workspaceId}:`, err);
    }
  }

  /**
   * The workspace's global STOP (TODOAP-REQ-31): pause the autoplay AND abort
   * every in-flight turn of the workspace's todo tasks — the equivalent of
   * going to each task's conversation and pressing stop. Soft abort: the
   * worker's current item is rejected, the turn's finally clears the task's
   * `running` flag, and the task stays `working` with no live turn — a
   * coherent state nothing restarts until the global play. Channels with no
   * active worker are skipped (nothing to abort). Returns how many turns were
   * aborted.
   * @spec TODOAP-REQ-31
   */
  async stopGlobal(workspaceId: string): Promise<number> {
    await this.setGlobalPlay(workspaceId, false);
    const running = await this.nodes()
      .find(
        { workspaceId, kind: { $ne: 'group' }, running: true, channelId: { $type: 'string', $ne: '' } },
        { projection: { _id: 0, channelId: 1 } },
      )
      .toArray();
    let aborted = 0;
    for (const node of running) {
      const worker = getChannelWorkerRegistry().get(node.channelId!);
      if (!worker) continue; // no live turn — nothing to abort
      try {
        await worker.abort({ kind: 'soft' });
        aborted++;
      } catch (err) {
        console.error(`[TodoAutoplayService] stopGlobal abort failed for channel ${node.channelId}:`, err);
      }
    }
    return aborted;
  }

  /**
   * How many todo tasks of the workspace have a live turn (`running` true) —
   * the STOP button's visibility condition (TODOAP-REQ-31: visible only when
   * something is in flight).
   * @spec TODOAP-REQ-31
   */
  async runningCount(workspaceId: string): Promise<number> {
    return this.nodes().countDocuments({ workspaceId, kind: { $ne: 'group' }, running: true });
  }

  // ==========================================================================
  // BROADCASTS (every member of the workspace)
  // ==========================================================================

  /** Send a payload on `todo:${userId}` to the owner and every active member of the workspace. */
  async broadcastToMembers(workspaceId: string, payload: Record<string, unknown>): Promise<void> {
    const ws = await collection(this.db, COLLECTIONS.workspaces).findOne(
      { workspaceId },
      { projection: { ownerId: 1 } },
    );
    const members = await collection(this.db, COLLECTIONS.workspaceMembers)
      .find({ workspaceId, status: { $ne: 'pending' } }, { projection: { userId: 1 } })
      .toArray();
    const userIds = new Set<string>();
    if (typeof ws?.ownerId === 'string') userIds.add(ws.ownerId);
    for (const m of members) if (typeof m.userId === 'string') userIds.add(m.userId);
    for (const userId of userIds) {
      this.pubSubService.broadcastToTopic(`todo:${userId}`, payload);
    }
  }

  /**
   * `todo_node_changed` for a server-side node write (start, running flag,
   * re-wake, exhaustion), same shape as the tool-path broadcast.
   * @spec TODOAP-REQ-8
   */
  async broadcastNodeChanged(workspaceId: string, node: TodoNode, action: string): Promise<void> {
    await this.broadcastToMembers(workspaceId, {
      type: 'todo_node_changed',
      action,
      nodeId: node.nodeId,
      parentId: node.parentId,
      node: nodeSummary(node),
      timestamp: Date.now(),
    });
  }

  // ==========================================================================
  // RUNNERS (TODOAP-REQ-1, TODOAP-REQ-2)
  // ==========================================================================

  async getRunner(workspaceId: string, agentId: string): Promise<TodoAutoplayRunner | null> {
    return this.runners().findOne({ workspaceId, agentId });
  }

  private async upsertRunner(
    workspaceId: string,
    agentId: string,
    update: Partial<Pick<TodoAutoplayRunner, 'slots' | 'playEnabled' | 'scopeNodeId' | 'pickUnassigned'>>,
  ): Promise<TodoAutoplayRunner> {
    const now = new Date();
    const onInsert: Document = { createdAt: now };
    if (update.slots === undefined) onInsert.slots = 0;
    if (update.playEnabled === undefined) onInsert.playEnabled = false;
    const result = await this.runners().findOneAndUpdate(
      { workspaceId, agentId },
      { $set: { ...update, updatedAt: now }, $setOnInsert: onInsert },
      { upsert: true, returnDocument: 'after' },
    );
    return result ?? ((await this.getRunner(workspaceId, agentId)) as TodoAutoplayRunner);
  }

  /** Count of the agent's tasks in the workspace with `running = true`. */
  async countActive(workspaceId: string, agentId: string): Promise<number> {
    return this.nodes().countDocuments({ ...agentTasks(workspaceId, agentId), running: true });
  }

  private async toView(rel: TodoAutoplayRunner): Promise<TodoRunnerView> {
    const agent = await collection(this.db, COLLECTIONS.agents).findOne(
      { agentId: rel.agentId },
      { projection: { name: 1, fullName: 1, avatarUrl: 1, coreId: 1 } },
    );
    // Same resolution as the workspace member list (TODOAP-REQ-2): the agent's
    // own avatar, else its core's, made absolute by buildAvatarUrl.
    let avatar = (agent?.avatarUrl as string | undefined) || undefined;
    if (!avatar && typeof agent?.coreId === 'string') {
      const core = await this.db
        .collection('agent_cores')
        .findOne({ coreId: agent.coreId }, { projection: { avatarUrl: 1 } });
      avatar = (core?.avatarUrl as string | undefined) || undefined;
    }
    return {
      agentId: rel.agentId,
      name: (agent?.name as string) || (agent?.fullName as string) || rel.agentId,
      avatarUrl: buildAvatarUrl(avatar) ?? null,
      slots: rel.slots,
      playEnabled: rel.playEnabled,
      activeSlots: await this.countActive(rel.workspaceId, rel.agentId),
      ...(await this.scopeOf(rel)),
    };
  }

  /**
   * The scope fields of a runner view: the scope group's path (its ancestors'
   * titles and its own, joined by ` › `), or `scopeMissing` when the group no
   * longer exists or is no longer a group.
   * @spec TODOAP-REQ-22
   */
  private async scopeOf(
    rel: TodoAutoplayRunner,
  ): Promise<Pick<TodoRunnerView, 'scopeNodeId' | 'scopePath' | 'pickUnassigned' | 'scopeMissing'>> {
    const scopeNodeId = rel.scopeNodeId ?? null;
    const pickUnassigned = rel.pickUnassigned === true;
    if (scopeNodeId === null) return { scopeNodeId, scopePath: null, pickUnassigned, scopeMissing: false };
    const scope = await this.scopeGroup(rel.workspaceId, scopeNodeId);
    if (!scope) return { scopeNodeId, scopePath: null, pickUnassigned, scopeMissing: true };
    const path = [...(await this.pathOf(rel.workspaceId, scope)), scope.text];
    return { scopeNodeId, scopePath: path.join(PATH_SEPARATOR), pickUnassigned, scopeMissing: false };
  }

  /** The node `nodeId` of the workspace when it is a group, else null. */
  private async scopeGroup(workspaceId: string, nodeId: string): Promise<TodoNode | null> {
    return this.nodes().findOne({ workspaceId, nodeId, kind: 'group' });
  }

  /** The workspace's runners, oldest first (get-autoplay). */
  async listRunners(workspaceId: string): Promise<TodoRunnerView[]> {
    const rels = await this.runners().find({ workspaceId }).sort({ createdAt: 1 }).toArray();
    return Promise.all(rels.map((rel) => this.toView(rel)));
  }

  private async emitRunnerChanged(workspaceId: string, view: TodoRunnerView, removed = false): Promise<void> {
    await this.broadcastToMembers(workspaceId, {
      type: 'todo_autoplay_changed',
      workspaceId,
      agentId: view.agentId,
      slots: view.slots,
      playEnabled: view.playEnabled,
      activeSlots: view.activeSlots,
      scopeNodeId: view.scopeNodeId,
      scopePath: view.scopePath,
      pickUnassigned: view.pickUnassigned,
      scopeMissing: view.scopeMissing,
      ...(removed ? { removed: true } : {}),
    });
  }

  /**
   * Set a runner's slots (creating it). Slots 0 on a playing runner also
   * turns play off. Broadcasts the change; slots > 0 while playing runs the
   * scheduling cycle.
   */
  async setAgentSlots(workspaceId: string, agentId: string, slots: number): Promise<TodoRunnerView> {
    if (!Number.isInteger(slots) || slots < 0) {
      throw new McaActionError('INVALID_INPUT', 'slots must be an integer >= 0');
    }
    const existing = await this.getRunner(workspaceId, agentId);
    const update: Partial<Pick<TodoAutoplayRunner, 'slots' | 'playEnabled'>> = { slots };
    if (slots === 0 && existing?.playEnabled) update.playEnabled = false;
    const rel = await this.upsertRunner(workspaceId, agentId, update);
    const view = await this.toView(rel);
    await this.emitRunnerChanged(workspaceId, view);
    if (rel.playEnabled && rel.slots > 0) void this.scheduleAgentTasks(workspaceId, agentId);
    return view;
  }

  /**
   * Turn a runner's play on/off (creating it). Enabling with 0 slots fails
   * with INVALID_STATE. Broadcasts the change; enabling runs the cycle.
   */
  async setAgentPlay(workspaceId: string, agentId: string, enabled: boolean): Promise<TodoRunnerView> {
    if (enabled) {
      const existing = await this.getRunner(workspaceId, agentId);
      if ((existing?.slots ?? 0) === 0) {
        throw new McaActionError(
          'INVALID_STATE',
          'Cannot enable play with 0 slots.',
          409,
          'Give the runner at least one slot first (set-agent-slots).',
        );
      }
    }
    const rel = await this.upsertRunner(workspaceId, agentId, { playEnabled: enabled });
    const view = await this.toView(rel);
    await this.emitRunnerChanged(workspaceId, view);
    if (enabled) void this.scheduleAgentTasks(workspaceId, agentId);
    return view;
  }

  /**
   * Set a runner's scope (creating it): `scopeNodeId` must be a group of the
   * workspace (else INVALID_INPUT) or null for the whole tree. Broadcasts the
   * change; a playing runner runs the cycle.
   * @spec TODOAP-REQ-22
   */
  async setAgentScope(
    workspaceId: string,
    agentId: string,
    scopeNodeId: string | null,
    pickUnassigned: boolean,
  ): Promise<TodoRunnerView> {
    if (scopeNodeId !== null && !(await this.scopeGroup(workspaceId, scopeNodeId))) {
      throw new McaActionError(
        'INVALID_INPUT',
        `Node "${scopeNodeId}" is not a group of this workspace.`,
        400,
        'Use the nodeId of a group, or null for the whole tree.',
      );
    }
    const rel = await this.upsertRunner(workspaceId, agentId, { scopeNodeId, pickUnassigned });
    const view = await this.toView(rel);
    await this.emitRunnerChanged(workspaceId, view);
    if (rel.playEnabled && rel.slots > 0) void this.scheduleAgentTasks(workspaceId, agentId);
    return view;
  }

  /**
   * An unassigned task became eligible: run the cycle for every playing
   * runner of the workspace that picks up unassigned tasks. Fire and forget.
   * @spec TODOAP-REQ-22
   */
  async scheduleUnassignedPickers(workspaceId: string): Promise<void> {
    try {
      // Global play/pause (TODOAP-REQ-30): paused stops the pickup too.
      if (!(await this.getGlobalPlay(workspaceId))) return;
      const pickers = await this.runners()
        .find({ workspaceId, playEnabled: true, slots: { $gt: 0 }, pickUnassigned: true })
        .sort({ createdAt: 1 })
        .toArray();
      for (const rel of pickers) await this.scheduleAgentTasks(workspaceId, rel.agentId);
    } catch (err) {
      console.error(`[TodoAutoplayService] scheduleUnassignedPickers error in workspace ${workspaceId}:`, err);
    }
  }

  /** Remove a runner (running turns are not interrupted) and broadcast it. */
  async removeRelationship(workspaceId: string, agentId: string): Promise<void> {
    await this.runners().deleteOne({ workspaceId, agentId });
    await this.emitRunnerChanged(
      workspaceId,
      {
        agentId,
        name: agentId,
        avatarUrl: null,
        slots: 0,
        playEnabled: false,
        activeSlots: await this.countActive(workspaceId, agentId),
        scopeNodeId: null,
        scopePath: null,
        pickUnassigned: false,
        scopeMissing: false,
      },
      true,
    );
  }

  // ==========================================================================
  // CORE SCHEDULING (TODOAP-REQ-3, TODOAP-REQ-18)
  // ==========================================================================

  /**
   * Main scheduling function. Called whenever a slot may have freed up or a
   * new eligible task appeared. Safe to call fire-and-forget; errors are
   * logged, never propagated.
   */
  async scheduleAgentTasks(workspaceId: string, agentId: string): Promise<void> {
    try {
      await this._scheduleAgentTasksInternal(workspaceId, agentId);
    } catch (err) {
      console.error(
        `[TodoAutoplayService] scheduleAgentTasks error for agent ${agentId} in workspace ${workspaceId}:`,
        err,
      );
    }
  }

  private async _scheduleAgentTasksInternal(workspaceId: string, agentId: string): Promise<void> {
    // 0. Global play/pause (TODOAP-REQ-30): paused stops every runner.
    if (!(await this.getGlobalPlay(workspaceId))) return;

    // 1. Runner
    const rel = await this.getRunner(workspaceId, agentId);
    if (!rel || !rel.playEnabled || rel.slots <= 0) return;

    // 2–3. Available slots
    const activeSlots = await this.countActive(workspaceId, agentId);
    const availableSlots = rel.slots - activeSlots;

    // 4. Stuck tasks (re-wake): working, with a conversation, no turn running.
    const stuck = await this.nodes()
      .find({ ...agentTasks(workspaceId, agentId), state: 'working', channelId: { $type: 'string' }, running: false })
      .toArray();
    stuck.sort(byQueueOrder); // TODOAP-REQ-25: never the database's natural order

    // 5. Orphaned working tasks (start, TODOAP-REQ-27): working, assigned to the
    // runner, with NO conversation (worked by hand in a chat, or sent back from
    // review / unblocked without one). Whatever their planned day — finish what
    // was started before picking anything new, like the stuck ones.
    const orphaned = await this.nodes()
      .find({
        ...agentTasks(workspaceId, agentId),
        state: 'working',
        channelId: { $not: { $type: 'string' } },
        running: { $ne: true },
      })
      .toArray();
    orphaned.sort(byQueueOrder);

    // One-working-per-runner (TODOAP-REQ-28) — the pickup-time demotion. A
    // pickup only happens when a slot is free; with every slot held by a live
    // turn there is no pickup, and the working candidates are next in line to
    // be resumed (a task whose turn just ended, a fresh reply or send-back —
    // REQ-24 leaves those stuck for the next cycle, and demoting them would
    // strip the operator's reply of its stuck-first priority). So:
    //   - availableSlots <= 0 → no pickup, nothing demoted, the candidates
    //     stay `working` as "about to be resumed";
    //   - availableSlots > 0 → the first candidates (stuck, then orphaned, in
    //     queue order) get the slots; the working candidates BEYOND the free
    //     slots are demoted to `pending` — `working` must never lie about who
    //     is on it. The demotion keeps the day, position, conversation,
    //     input/output and log (an unplanned task is planned for today, or it
    //     would be invisible to the pickup); the task is re-picked by the
    //     normal flow. A task whose turn is running was never a candidate (it
    //     holds a slot), so a live conversation is never demoted.
    if (availableSlots <= 0) return;
    const leftoverWorking = [...stuck, ...orphaned].slice(availableSlots);
    for (const node of leftoverWorking) {
      await this._demoteToPending(workspaceId, node);
    }

    // 6. Eligible tasks: pending, planned for today or earlier, and — TODODEP
    // — with every dependency resolved (a blocker not done/cancelled keeps
    // the task waiting; the reason is logged, never a silent skip).
    const today = todoToday();
    const eligibleRaw = await this.nodes()
      .find({ ...agentTasks(workspaceId, agentId), state: 'pending', plannedFor: { $gt: '', $lte: today } })
      .toArray();
    const { startable: eligible, waiting } = await startableTasks(this.db, workspaceId, eligibleRaw);
    for (const w of waiting) {
      console.log(
        `[TodoAutoplayService] Task ${w.node.nodeId} ("${w.node.text}") not started — ${w.reason}`,
      );
    }
    eligible.sort(byQueueOrder);

    // Stuck tasks first (re-wake), then orphaned working ones (start), then
    // eligible tasks (start new).
    const toProcess: Array<{ node: TodoNode; isRewake: boolean }> = [
      ...stuck.map((node) => ({ node, isRewake: true })),
      ...orphaned.map((node) => ({ node, isRewake: false })),
      ...eligible.map((node) => ({ node, isRewake: false })),
    ].slice(0, availableSlots);

    for (const { node, isRewake } of toProcess) {
      if (isRewake) await this._rewakeTask(workspaceId, node, agentId);
      else await this._startForRunner(workspaceId, node);
    }

    // 7. Unassigned tasks under the scope (TODOAP-REQ-22), after the own ones.
    const left = availableSlots - toProcess.length;
    if (left > 0 && rel.pickUnassigned === true) {
      const unassigned = await this._unassignedEligible(workspaceId, rel.scopeNodeId ?? null, today);
      let started = 0;
      for (const node of unassigned) {
        if (started >= left) break;
        if (await this._startForRunner(workspaceId, node, agentId)) started++;
      }
    }
  }

  /**
   * The unassigned eligible tasks under a scope group (any depth; the whole
   * tree when null), in queue order. Empty when the scope group no longer
   * exists (the pickup is suspended). One query for the candidates, plus
   * the scope check and one read of the workspace's tree when scoped.
   * @spec TODOAP-REQ-22
   */
  private async _unassignedEligible(workspaceId: string, scopeNodeId: string | null, today: string): Promise<TodoNode[]> {
    if (scopeNodeId !== null && !(await this.scopeGroup(workspaceId, scopeNodeId))) return [];
    let candidatesRaw = await this.nodes()
      .find({ ...unassignedTasks(workspaceId), state: 'pending', plannedFor: { $gt: '', $lte: today } })
      .toArray();
    // TODODEP gate: unresolved dependencies keep the task waiting (reason logged).
    const gated = await startableTasks(this.db, workspaceId, candidatesRaw);
    for (const w of gated.waiting) {
      console.log(
        `[TodoAutoplayService] Unassigned task ${w.node.nodeId} ("${w.node.text}") not picked up — ${w.reason}`,
      );
    }
    let candidates = gated.startable;
    if (scopeNodeId !== null && candidates.length > 0) {
      const tree = await this.nodes()
        .find({ workspaceId }, { projection: { _id: 0, nodeId: 1, parentId: 1 } })
        .toArray();
      const children = new Map<string, string[]>();
      for (const n of tree) {
        if (!n.parentId) continue;
        const list = children.get(n.parentId) ?? [];
        list.push(n.nodeId);
        children.set(n.parentId, list);
      }
      const inside = new Set<string>();
      const stack = [...(children.get(scopeNodeId) ?? [])];
      while (stack.length > 0) {
        const id = stack.pop() as string;
        if (inside.has(id)) continue;
        inside.add(id);
        stack.push(...(children.get(id) ?? []));
      }
      candidates = candidates.filter((n) => inside.has(n.nodeId));
    }
    return candidates.sort(byQueueOrder);
  }

  // ==========================================================================
  // RE-WAKE AND THE AUTO-WAKE CAP (TODOAP-REQ-7)
  // ==========================================================================

  private async _rewakeTask(workspaceId: string, node: TodoNode, agentId: string): Promise<void> {
    if (!this.wakeUpCallback) {
      console.warn('[TodoAutoplayService] Re-wake skipped: wakeUpCallback not set');
      return;
    }
    try {
      const count = node.autoWakeCount ?? 0;
      if (count >= this.autoWakeCap) {
        await this._blockStuckTask(workspaceId, node);
        return;
      }
      // Count this re-wake BEFORE dispatching, so a crash mid-turn still
      // advances the counter (fail toward blocking a stuck task, not looping).
      const updated = await this.nodes().findOneAndUpdate(
        { workspaceId, nodeId: node.nodeId },
        { $inc: { autoWakeCount: 1 }, $set: { updatedAt: Date.now() } },
        { returnDocument: 'after' },
      );
      if (!updated) return;
      await this.broadcastNodeChanged(workspaceId, updated, 'autoplay-rewake');

      const channelId = node.channelId as string;
      this.wakeUpCallback(channelId, agentId, buildTodoRewakeMessage(node), 'autorun').catch((err) => {
        console.error('[TodoAutoplayService] Re-wake wakeUpCallback error:', err);
      });
      console.log(
        `[TodoAutoplayService] Re-woke task ${node.nodeId} via channel ${channelId} (wake ${count + 1}/${this.autoWakeCap})`,
      );
    } catch (err) {
      console.error(`[TodoAutoplayService] Re-wake error for task ${node.nodeId}:`, err);
    }
  }

  /** Cap reached: move the task to `blocked` with the exhaustion reason (running false). */
  private async _blockStuckTask(workspaceId: string, node: TodoNode): Promise<void> {
    const updated = await writeStateTransition(this.db, workspaceId, node, 'blocked', {
      reason: exhaustedReason(this.autoWakeCap),
      actor: SYSTEM_ACTOR,
    });
    if (!updated) return; // raced with a concurrent change
    console.log(
      `[TodoAutoplayService] Auto-blocked task ${node.nodeId} after ${this.autoWakeCap} wakes without progress`,
    );
    await this.broadcastNodeChanged(workspaceId, updated, 'set-state');
  }

  /**
   * Demote a leftover working candidate to `pending` (TODOAP-REQ-28): the
   * cycle could not give the task a slot, so `working` would lie — nobody is
   * on it and nobody is about to resume it. A plain state write (NOT
   * writeStateTransition: no ancestor escalation on the way down, and the
   * re-wake count must survive so a task that already churned re-wakes keeps
   * its history) that keeps the day, position, conversation, input/output and
   * log; the task is re-picked by the normal flow. An unplanned task is
   * planned for today — the pickup only takes tasks planned for today or
   * earlier, so leaving it unplanned would park it in `pending` forever (a
   * regression of the REQ-27 intent: never leave a working task behind).
   * The optimistic guard is the shape the cycle selected it by (`working`, no
   * live turn), so a task that changed under us (a manual start, a state
   * change) is left alone. The `todo.task_state_changed` event fires with the
   * reason, and the node is broadcast like every server-side write.
   * @spec TODOAP-REQ-28
   */
  private async _demoteToPending(workspaceId: string, node: TodoNode): Promise<void> {
    const guard: Document = {
      state: 'working',
      running: { $ne: true },
      ...(typeof node.channelId === 'string' ? { channelId: node.channelId } : { channelId: { $not: { $type: 'string' } } }),
    };
    const updated = await writeNode(this.db, workspaceId, node.nodeId, {
      $set: {
        state: 'pending',
        completed: false,
        blockedReason: null,
        ...(node.plannedFor ? {} : { plannedFor: todoToday() }),
      },
      guard,
      log: { text: 'Autoplay: back to pending — no free slot for this working task', actor: SYSTEM_ACTOR },
    });
    if (!updated) return; // raced with a concurrent change — leave it alone
    console.log(
      `[TodoAutoplayService] Demoted leftover working task ${node.nodeId} to pending (no free slot)`,
    );
    await this.broadcastNodeChanged(workspaceId, updated, 'set-state');
    {
      const svc = getMcaActionDeps().todoSubscriptions;
      if (svc) {
        try {
          emitTaskStateChanged(svc, workspaceId, updated, 'working', 'pending', actorFromLogActor(SYSTEM_ACTOR), {
            reason: 'autoplay: no free slot for this working task',
          });
        } catch (err) {
          console.error(`[TodoAutoplayService] task_state_changed emission failed for ${node.nodeId}:`, err);
        }
      }
    }
  }

  // ==========================================================================
  // STARTING A TASK (TODOAP-REQ-5, TODOAP-NFR-2)
  // ==========================================================================

  /**
   * Scheduler start: the workspace owner is the billing user; without one, the
   * task is left untouched. With `claimFor` (an unassigned task, TODOAP-REQ-22)
   * the task is first assigned to that agent in one update conditioned on it
   * still having no assignee; a task already taken is skipped silently.
   * Returns whether the task was started.
   */
  private async _startForRunner(workspaceId: string, node: TodoNode, claimFor?: string): Promise<boolean> {
    const ws = await collection(this.db, COLLECTIONS.workspaces).findOne(
      { workspaceId },
      { projection: { ownerId: 1 } },
    );
    const ownerUserId = typeof ws?.ownerId === 'string' && ws.ownerId !== '' ? ws.ownerId : null;
    if (!ownerUserId) {
      console.error(
        `[TodoAutoplayService] Cannot start task ${node.nodeId}: workspace ${workspaceId} has no ownerId — skipping to avoid unattributed billing`,
      );
      return false;
    }
    let toStart: TodoNode | null = node;
    if (claimFor) {
      toStart = await this._claimUnassigned(workspaceId, node, claimFor);
      if (!toStart) return false;
    }
    return (await this.startTask(workspaceId, toStart, ownerUserId)) !== null;
  }

  /**
   * Assign an unassigned pending task to `agentId` atomically (the filter
   * requires no assignee), with the log "Autoplay: picked up by <agent>".
   * Null when another runner (or a person) took it first.
   * @spec TODOAP-REQ-22
   */
  private async _claimUnassigned(workspaceId: string, node: TodoNode, agentId: string): Promise<TodoNode | null> {
    const agent = await collection(this.db, COLLECTIONS.agents).findOne(
      { agentId },
      { projection: { name: 1, fullName: 1 } },
    );
    const agentName = (agent?.name as string) || (agent?.fullName as string) || agentId;
    return writeNode(this.db, workspaceId, node.nodeId, {
      $set: { assignee: { kind: 'agent', id: agentId }, assignedAt: Date.now() },
      guard: { assignee: null, state: 'pending' },
      // The agent takes the task: the pickup is the agent's (TODOLG-REQ-1).
      log: { text: `Autoplay: picked up by ${agentName}`, actor: { kind: 'agent', id: agentId } },
    });
  }

  /**
   * Start a task for its assignee agent, billing `billingUserId`:
   *   (b) move it to `working` (escalating pending ancestors) with the log
   *       "Autoplay: started by <agent>" and reset the re-wake count;
   *   (c) create a headless conversation owned by the billing user, named
   *       after the task, and link it ("Linked conversation"), or reuse the
   *       linked one;
   *   (d) save the kick-off message from the Teros sender and wake the agent
   *       with it ('autorun');
   *   (e) broadcast the node to every member.
   * If (c) fails the state write is rolled back ("Autoplay: start failed
   * (attempt n/cap): <error>" — the real error text) and null is returned; the
   * cap-th consecutive failure (TODOAP-REQ-32) blocks the task instead of
   * rolling it back. Null also when the task changed under us.
   * @spec TODOAP-REQ-5
   * @spec TODOAP-NFR-2
   */
  async startTask(workspaceId: string, node: TodoNode, billingUserId: string): Promise<TodoNode | null> {
    const agentId = node.assignee?.kind === 'agent' ? node.assignee.id : null;
    if (!agentId) return null;
    const agent = await collection(this.db, COLLECTIONS.agents).findOne(
      { agentId },
      { projection: { name: 1, fullName: 1, runner: 1 } },
    );
    const agentName = (agent?.name as string) || (agent?.fullName as string) || agentId;
    const previousState = (node.state ?? 'pending') as NodeState;

    // (b) the state write. Both branches guard on `channelId` being unset when
    // the task was already `working` (an orphaned start, TODOAP-REQ-27), so a
    // race between two cycles — or a cycle and a manual start-node — loses
    // cleanly instead of opening a second conversation.
    const startLog = `Autoplay: started by ${agentName}`;
    const working =
      previousState === 'working'
        ? await writeNode(this.db, workspaceId, node.nodeId, {
            $set: { autoWakeCount: 0, startFailCount: 0 },
            guard: { state: 'working', channelId: { $not: { $type: 'string' } } },
            log: { text: startLog, actor: SYSTEM_ACTOR },
          })
        : await writeStateTransition(this.db, workspaceId, node, 'working', { log: startLog, actor: SYSTEM_ACTOR });
    if (!working) return null;
    // A failed open (conversation or Claude Code session) rolls the state
    // write back — only while the task still has no conversation, so a start
    // that lost a race to one that DID link a conversation leaves it alone
    // (TODOAP-REQ-27). The failure is counted (TODOAP-REQ-32): the log entry
    // carries the underlying error's text, and the cap-th consecutive failure
    // blocks the task instead of rolling it back — a failed start must never
    // become a silent per-minute retry loop.
    const rollBack = async (error: string): Promise<void> => {
      // The working write above reset the counter: the PRE-start node carries
      // the accumulated count of consecutive failures (TODOAP-REQ-32).
      const count = typeof node.startFailCount === 'number' ? node.startFailCount : 0;
      const attempt = count + 1;
      if (attempt >= this.startFailCap) {
        // The cap-th failure leaves its note too (the real error, like every
        // attempt), then the block transition carries the summary reason.
        await writeNode(this.db, workspaceId, node.nodeId, {
          guard: { state: 'working', channelId: { $not: { $type: 'string' } } },
          log: {
            text: `Autoplay: start failed (attempt ${attempt}/${this.startFailCap}): ${error}`,
            actor: SYSTEM_ACTOR,
          },
        });
        await this._blockStartFailedTask(workspaceId, working, error);
        return;
      }
      const rolledBack = await writeNode(this.db, workspaceId, node.nodeId, {
        $set: {
          ...(previousState === 'working'
            ? {}
            : { state: previousState, completed: previousState === 'done', blockedReason: null }),
          startFailCount: attempt,
        },
        guard: { state: 'working', channelId: { $not: { $type: 'string' } } },
        log: {
          text: `Autoplay: start failed (attempt ${attempt}/${this.startFailCap}): ${error}`,
          actor: SYSTEM_ACTOR,
        },
      });
      if (rolledBack) await this.broadcastNodeChanged(workspaceId, rolledBack, 'start-node');
    };
    // Claude Code runner (CCR-REQ-2): no conversation — a Claude Code session
    // in the workspace's terminal host works the task and the runner keeps
    // the task in step with it. The billing user is the owner, as for a turn.
    if ((agent as { runner?: string } | null)?.runner === 'claude-code') {
      if (!this.claudeCodeRunner) {
        console.error(
          `[TodoAutoplayService] task ${node.nodeId}: agent ${agentId} is a Claude Code runner but no runner is wired`,
        );
        await rollBack(`agent ${agentId} is a Claude Code runner but no runner is wired`);
        return null;
      }
      try {
        const started = await this.claudeCodeRunner.startTask(workspaceId, working, agentId, billingUserId);
        await this.broadcastNodeChanged(workspaceId, started, 'start-node');
        return started;
      } catch (err) {
        console.error(`[TodoAutoplayService] Claude Code runner: start failed for task ${node.nodeId}:`, err);
        await rollBack(startErrorText(err));
        return null;
      }
    }

    // (c) the conversation
    let linked: TodoNode | null = working;
    if (!working.channelId) {
      try {
        const channel = await this.channelManager.createChannel(
          billingUserId,
          agentId,
          { name: node.text },
          { workspaceId, headless: true },
        );
        linked = await writeNode(this.db, workspaceId, node.nodeId, {
          $set: { channelId: channel.channelId },
          guard: { channelId: { $not: { $type: 'string' } } },
          log: { text: 'Linked conversation', actor: SYSTEM_ACTOR },
        });
        if (!linked) throw new Error(`task ${node.nodeId} disappeared while linking its conversation`);
      } catch (err) {
        console.error(`[TodoAutoplayService] Autoplay: start failed for task ${node.nodeId}:`, err);
        await rollBack(startErrorText(err));
        return null;
      }
    }
    const channelId = linked.channelId as string;

    // (d) the kick-off message
    const message = buildTodoInitialMessage(linked, { path: await this.pathOf(workspaceId, linked) });
    await this.channelManager.saveMessage({
      messageId: this.channelManager.createMessageId(),
      channelId,
      role: 'user' as const,
      userId: billingUserId,
      sender: SYSTEM_SENDER,
      content: { type: 'text' as const, text: message },
      timestamp: new Date().toISOString(),
    } as Parameters<ChannelManager['saveMessage']>[0]);
    if (this.wakeUpCallback) {
      this.wakeUpCallback(channelId, agentId, message, 'autorun').catch((err) => {
        console.error(`[TodoAutoplayService] wakeUpCallback error for task ${node.nodeId}:`, err);
      });
    } else {
      console.warn(`[TodoAutoplayService] wakeUpCallback not set — task ${node.nodeId} started but agent not notified`);
    }

    // (e) the broadcast
    await this.broadcastNodeChanged(workspaceId, linked, 'start-node');
    // todo.task_started (todo/events spec): the autoplay start is a start like
    // any other — subscribed conversations and Automate hear it. The actor is
    // the system (the scheduler), so no self-wake guard applies.
    {
      const svc = getMcaActionDeps().todoSubscriptions;
      if (svc) {
        try {
          emitTaskStarted(svc, workspaceId, linked, previousState, {});
        } catch (err) {
          console.error(`[TodoAutoplayService] task_started emission failed for ${node.nodeId}:`, err);
        }
      }
    }
    console.log(`[TodoAutoplayService] Started task ${node.nodeId} for agent ${agentId} via channel ${channelId}`);
    return linked;
  }

  /**
   * Start-failure cap reached (TODOAP-REQ-32): the task moves to `blocked`
   * with the error as the reason — visible in the panel, in the log and to
   * every `todo.task_blocked` subscriber — instead of re-queueing a start
   * that just failed. The transition write resets the counters; the retry is
   * manual (unblock, start-node, a reply), never the cycle.
   * @spec TODOAP-REQ-32
   */
  private async _blockStartFailedTask(workspaceId: string, node: TodoNode, error: string): Promise<void> {
    const reason = startFailedReason(this.startFailCap, error);
    const updated = await writeStateTransition(this.db, workspaceId, node, 'blocked', {
      reason,
      actor: SYSTEM_ACTOR,
    });
    if (!updated) return; // raced with a concurrent change — leave it alone
    console.error(
      `[TodoAutoplayService] Blocked task ${node.nodeId} after ${this.startFailCap} failed starts: ${error}`,
    );
    await this.broadcastNodeChanged(workspaceId, updated, 'set-state');
    {
      const svc = getMcaActionDeps().todoSubscriptions;
      if (svc) {
        try {
          emitTaskBlocked(svc, workspaceId, updated, 'working', reason, actorFromLogActor(SYSTEM_ACTOR));
        } catch (err) {
          console.error(`[TodoAutoplayService] task_blocked emission failed for ${node.nodeId}:`, err);
        }
      }
    }
  }

  /** Ancestor titles of a node, root first. One query per ancestor. */
  private async pathOf(workspaceId: string, node: TodoNode): Promise<string[]> {
    const path: string[] = [];
    const seen = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = await this.nodes().findOne(
        { workspaceId, nodeId: parentId },
        { projection: { _id: 0, text: 1, parentId: 1 } },
      );
      if (!parent) break;
      path.unshift(parent.text);
      parentId = parent.parentId;
    }
    return path;
  }

  // ==========================================================================
  // REPLY TO A BLOCKED TASK (TODOAP-REQ-10)
  // ==========================================================================

  /**
   * Post the operator's reply (or send-back note, already composed by the
   * caller) in the task's conversation as the caller's message. Who wakes
   * the agent (TODOAP-REQ-24): when `task` names an agent with a playing
   * runner (`playEnabled`, `slots > 0`) in the task's workspace, nothing is
   * woken here — the task is already stuck (`working`, `running` false,
   * `autoWakeCount` 0 from the transition) and that runner's cycle runs at
   * once, re-waking it only if a slot is free. Otherwise the conversation's
   * agent is woken at once with the message ('user_message').
   * @spec TODOAP-REQ-10
   * @spec TODOAP-REQ-21
   * @spec TODOAP-REQ-24
   */
  async deliverReply(
    channelId: string,
    userId: string,
    text: string,
    task?: { workspaceId: string; nodeId: string; agentId: string | null },
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(channelId);
    if (!channel) throw new McaActionError('NOT_FOUND', `Conversation "${channelId}" not found.`, 404);
    const sender = await this.channelManager.getUserSender(userId);
    await this.channelManager.saveMessage({
      messageId: this.channelManager.createMessageId(),
      channelId,
      role: 'user' as const,
      userId,
      ...(sender ? { sender } : {}),
      content: { type: 'text' as const, text },
      timestamp: new Date().toISOString(),
    } as Parameters<ChannelManager['saveMessage']>[0]);
    if (task?.agentId) {
      const rel = await this.getRunner(task.workspaceId, task.agentId);
      // A runner only holds the reply when a cycle will actually re-wake it:
      // enabled with slots AND the workspace's autoplay globally playing
      // (TODOAP-REQ-30). Globally paused, no cycle runs — wake the agent at
      // once with the reply instead of leaving it stuck unheard.
      if (rel && rel.playEnabled && rel.slots > 0 && (await this.getGlobalPlay(task.workspaceId))) {
        console.log(
          `[TodoAutoplayService] Reply saved for task ${task.nodeId}; left stuck for runner ${task.agentId} (slots honoured)`,
        );
        await this.scheduleAgentTasks(task.workspaceId, task.agentId);
        return;
      }
    }
    if (!this.wakeUpCallback) {
      console.warn(`[TodoAutoplayService] wakeUpCallback not set — reply saved in ${channelId} but agent not notified`);
      return;
    }
    this.wakeUpCallback(channelId, channel.agentId as string, text, 'user_message').catch((err) => {
      console.error(`[TodoAutoplayService] reply wakeUpCallback error for channel ${channelId}:`, err);
    });
    console.log(
      `[TodoAutoplayService] Reply saved${task ? ` for task ${task.nodeId}` : ''}; woke agent ${channel.agentId} at once (no playing runner)`,
    );
  }

  // ==========================================================================
  // PERIODIC SCHEDULER (60 s safety net)
  // ==========================================================================

  /** Start the periodic scheduler. Safe to call multiple times; only starts once. */
  startPeriodicScheduler(): void {
    if (this.schedulerInterval) return;
    this.schedulerInterval = setInterval(async () => {
      try {
        await this._runPeriodicSchedule();
      } catch (err) {
        console.error('[TodoAutoplayService] Periodic scheduler error:', err);
      }
    }, 60_000);
    console.log('[TodoAutoplayService] Periodic scheduler started (60s interval)');
  }

  stopPeriodicScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      console.log('[TodoAutoplayService] Periodic scheduler stopped');
    }
  }

  /** The periodic cycle body, for tests (the interval calls the same method). */
  async _runPeriodicScheduleForTest(): Promise<void> {
    await this._runPeriodicSchedule();
  }

  private async _runPeriodicSchedule(): Promise<void> {
    // Zombie running flags first: they hold slots no turn is using.
    await this._cleanupZombieTasks();

    // Idle working sweep (TODOAP-REQ-29) — BEFORE the active-runner check and
    // regardless of it: the "agent never came back" case is exactly a runner
    // that is NOT playing (or an agent with no runner at all), so gating the
    // sweep on active runners would skip the very cases it exists for.
    await this._sweepIdleWorkingTasks();

    const active = await this.runners().find({ playEnabled: true, slots: { $gt: 0 } }).toArray();
    if (active.length === 0) return;

    // Global play/pause (TODOAP-REQ-30): skip the workspaces that are paused.
    // One read per workspace with active runners — the paused ones stop here.
    const playing: Record<string, boolean> = {};
    for (const rel of active) {
      if (playing[rel.workspaceId] === undefined) {
        playing[rel.workspaceId] = await this.getGlobalPlay(rel.workspaceId);
      }
      if (!playing[rel.workspaceId]) continue;
      await this.scheduleAgentTasks(rel.workspaceId, rel.agentId);
    }
  }

  // ==========================================================================
  // IDLE WORKING SWEEP (TODOAP-REQ-29)
  // ==========================================================================

  /**
   * Demote to `pending` every AGENT task in `working` with no live turn whose
   * node was last updated more than `idleTimeoutMs` ago (default 4 h). This
   * is the safety net for the agent that never comes back: with play paused
   * or the agent gone, no scheduling cycle of that agent runs, so the
   * pickup-time demotion (TODOAP-REQ-28) never fires and the task would stay
   * `working` forever, lying about who is on it.
   *
   * Scope, deliberately narrow:
   *   - AGENT tasks only — a human's `working` means "they took it and we all
   *     know"; they manage it by hand (Pablo, 2026-10-30).
   *   - No live turn: `running` is not true AND the linked conversation (when
   *     one exists) is not running either — the zombie clean-up has already
   *     reset stale `running` flags by the time this runs, so a task still
   *     marked running with a live channel is a real live turn and is left
   *     alone.
   *   - `updatedAt` older than the timeout: any write to the node (progress,
   *     log, output, state) refreshes it, so activity anywhere on the task
   *     keeps it `working`.
   * The write is the same as the pickup-time demotion (`_demoteToPending`),
   * with the idle reason in the log, so the task keeps its day, position,
   * conversation, input/output and log and is re-picked by the normal flow.
   * @spec TODOAP-REQ-29
   */
  private async _sweepIdleWorkingTasks(): Promise<void> {
    try {
      const cutoff = Date.now() - this.idleTimeoutMs;
      const candidates = await this.nodes()
        .find({
          kind: { $ne: 'group' },
          state: 'working',
          'assignee.kind': 'agent',
          running: { $ne: true },
          updatedAt: { $lt: cutoff },
        })
        .project<Pick<TodoNode, 'nodeId' | 'workspaceId' | 'channelId' | 'plannedFor'>>({
          _id: 0,
          nodeId: 1,
          workspaceId: 1,
          channelId: 1,
          plannedFor: 1,
        })
        .toArray();
      if (candidates.length === 0) return;

      // A candidate whose linked conversation is still running has a live
      // turn despite the stale node flag — leave it alone.
      const withChannel = candidates.filter((c) => typeof c.channelId === 'string');
      let liveChannels = new Set<string>();
      if (withChannel.length > 0) {
        const running = await collection(this.db, COLLECTIONS.channels)
          .find({ channelId: { $in: withChannel.map((c) => c.channelId) }, running: true })
          .project<{ channelId: string }>({ channelId: 1 })
          .toArray();
        liveChannels = new Set(running.map((c) => c.channelId));
      }

      for (const node of candidates) {
        if (typeof node.channelId === 'string' && liveChannels.has(node.channelId)) continue;
        const guard: Document = {
          state: 'working',
          running: { $ne: true },
          ...(typeof node.channelId === 'string'
            ? { channelId: node.channelId }
            : { channelId: { $not: { $type: 'string' } } }),
        };
        const updated = await writeNode(this.db, node.workspaceId, node.nodeId, {
          $set: {
            state: 'pending',
            completed: false,
            blockedReason: null,
            ...(node.plannedFor ? {} : { plannedFor: todoToday() }),
          },
          guard,
          log: { text: 'Autoplay: back to pending — working without activity for too long', actor: SYSTEM_ACTOR },
        });
        if (!updated) continue; // raced with a concurrent change
        console.log(
          `[TodoAutoplayService] Swept idle working task ${node.nodeId} to pending (no activity since ${new Date(cutoff).toISOString()})`,
        );
        await this.broadcastNodeChanged(node.workspaceId, updated, 'set-state');
        const svc = getMcaActionDeps().todoSubscriptions;
        if (svc) {
          try {
            emitTaskStateChanged(svc, node.workspaceId, updated, 'working', 'pending', actorFromLogActor(SYSTEM_ACTOR), {
              reason: 'autoplay: working without activity for too long',
            });
          } catch (err) {
            console.error(`[TodoAutoplayService] task_state_changed emission failed for ${node.nodeId}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('[TodoAutoplayService] Idle working sweep error:', err);
    }
  }

  // ==========================================================================
  // ZOMBIE RUNNING FLAGS (TODOAP-REQ-8)
  // ==========================================================================

  /**
   * Reset `running` on tasks whose linked conversation is not running (the
   * turn's finally never ran: crash, restart mid-turn), with the log entry
   * "Autoplay: running flag reset", and broadcast each one.
   * @spec TODOAP-REQ-8
   */
  private async _cleanupZombieTasks(): Promise<void> {
    try {
      // Claude Code tasks have no conversation: their flag is a zombie when no
      // watch of this process follows the session (restart mid-turn).
      const ccr = await this.nodes()
        .find({ running: true, channelId: { $not: { $type: 'string' } } })
        .project<Pick<TodoNode, 'nodeId' | 'workspaceId'>>({ _id: 0, nodeId: 1, workspaceId: 1 })
        .toArray();
      for (const z of ccr) {
        if (!this.claudeCodeRunner || this.claudeCodeRunner.hasWatch(z.nodeId)) continue;
        const updated = await writeNode(this.db, z.workspaceId, z.nodeId, {
          $set: { running: false },
          guard: { running: true },
          log: { text: 'Autoplay: running flag reset', actor: SYSTEM_ACTOR },
        });
        if (updated) await this.broadcastNodeChanged(z.workspaceId, updated, 'set-running');
      }

      const candidates = await this.nodes()
        .find({ running: true, channelId: { $type: 'string' } })
        .project<Pick<TodoNode, 'nodeId' | 'workspaceId' | 'channelId'>>({
          _id: 0,
          nodeId: 1,
          workspaceId: 1,
          channelId: 1,
        })
        .toArray();
      if (candidates.length === 0) return;

      const runningChannels = await collection(this.db, COLLECTIONS.channels)
        .find({ channelId: { $in: candidates.map((c) => c.channelId) }, running: true })
        .project<{ channelId: string }>({ channelId: 1 })
        .toArray();
      const runningSet = new Set(runningChannels.map((c) => c.channelId));

      for (const zombie of candidates.filter((c) => !runningSet.has(c.channelId as string))) {
        const updated = await writeNode(this.db, zombie.workspaceId, zombie.nodeId, {
          $set: { running: false },
          guard: { running: true },
          log: { text: 'Autoplay: running flag reset', actor: SYSTEM_ACTOR },
        });
        if (!updated) continue;
        console.log(
          `[TodoAutoplayService] Reset zombie task ${zombie.nodeId} — channel ${zombie.channelId} is not running`,
        );
        await this.broadcastNodeChanged(zombie.workspaceId, updated, 'set-running');
      }
    } catch (err) {
      console.error('[TodoAutoplayService] Zombie task cleanup error:', err);
    }
  }

  // ==========================================================================
  // INDEXES
  // ==========================================================================

  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry.
    await ensureIndexesFor(this.db, [
      COLLECTIONS.todoAutoplayRunners,
      COLLECTIONS.todoAutoplayState,
      COLLECTIONS.todoNodes,
    ]);
  }
}
