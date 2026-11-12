/**
 * Todo List MCA — tool definitions (thin client).
 *
 * Every handler forwards its args to the backend action of the same name
 * (`todo/<tool>`) and wraps the answer in the structured envelope. Names,
 * descriptions, parameters and annotations are byte-identical to the former
 * direct-Mongo tools (tools.json is generated from them).
 */

import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { emitEvent, invoke, structured } from './client';
import type { NodeIO, NodeState } from './lib/types';
import { getAutoplay, openRunnerTerminal, removeAgent, setAgentPlay, setAgentScope, setAgentSlots, setGlobalPlay, startNode, stopAutoplay, withCaller } from './tools/autoplay';
import { listTodoSubscriptions, subscribeToTodo, unsubscribeFromTodo } from './tools/subscriptions';

// =============================================================================
// RESULT SHAPES (the subset of the backend answers the handlers read)
// =============================================================================

interface NodeRef {
  nodeId: string;
  parentId: string | null;
  text: string;
  completed: boolean;
  position: number;
  state?: NodeState | null;
  blockedReason?: string | null;
  reportedProgress?: number | null;
  output?: NodeIO | null;
  /** TODODEP - nodeIds this task waits on ([] when none). */
  dependencies?: string[];
}

type AddNodeResult = { node: NodeRef; parentText: string | null };
type NodeResult = { node: NodeRef };
type DeleteNodeResult = { deleted: true; nodeId: string; node: { text: string } };
type SetStateResult = { node: NodeRef; transition: { from: NodeState; to: NodeState } };

/** The task states, in lifecycle order (`cancelled` last: it is an exit, not a stage). */
const STATES: NodeState[] = ['planning', 'pending', 'working', 'blocked', 'review', 'done', 'cancelled'];

/** JSON schema of a NodeIO as the caller sends it (set-input / set-output). */
const NODE_IO_SCHEMA = {
  type: ['object', 'null'],
  description:
    'One of: { format: "markdown", markdown } · { format: "form", fields: [{ id, type: text|textarea|number|select|radio|checkbox|date|time|datetime, label, options? }], values: { [fieldId]: value } } · { format: "file", path: "/workspace/..." (absolute path inside the workspace volume — the backend reads and uploads the file; name/mime optional, inferred from the filename) } · { format: "file", name, mime, data: base64 (max 10 MB, no data: prefix) — for in-memory files }. null clears it. Prefer path for any file that already exists in the workspace volume.',
  properties: {
    format: { type: 'string', enum: ['markdown', 'form', 'file'] },
    markdown: { type: 'string', description: 'format=markdown: the content. Max 50000 chars.' },
    fields: { type: 'array', items: { type: 'object' }, description: 'format=form: the form fields (max 50).' },
    values: { type: 'object', description: 'format=form: values keyed by field id.' },
    name: { type: 'string', description: 'format=file: file name. Optional with path (inferred from the filename); required with data.' },
    mime: { type: 'string', description: 'format=file: MIME type. Optional with path (inferred from the extension); required with data.' },
    data: { type: 'string', description: 'format=file: base64 content (max 10 MB decoded). In-memory files only — use path when the file exists in the workspace volume.' },
    path: { type: 'string', description: 'format=file: absolute path inside the workspace volume, e.g. "/workspace/report.html". The backend reads the file and uploads it — never generate base64 for a file that already exists on the volume.' },
  },
};

/**
 * JSON schema of a task's expected output definition (add-node / update-node).
 * @spec TODOAP-REQ-14
 */
const EXPECTED_OUTPUT_SCHEMA = {
  type: ['object', 'null'],
  description:
    'Output the task must deliver: { format: "markdown"|"form"|"file", description?, fileType? (file only: pdf|docx|xlsx|csv|png|jpg|json|md|txt|html|other), fields? (form only: 1–40 fields [{ id, type: text|textarea|number|select|radio|checkbox|date|time|datetime, label, required?, options? }]) }. null clears it. set-output rejects an output that does not match it (OUTPUT_MISMATCH). Not for groups.',
  properties: {
    format: { type: 'string', enum: ['markdown', 'form', 'file'], description: 'Format of the output.' },
    description: { type: 'string', description: 'What the output must contain. Max 500 chars.' },
    fileType: {
      type: 'string',
      enum: ['pdf', 'docx', 'xlsx', 'csv', 'png', 'jpg', 'json', 'md', 'txt', 'html', 'other'],
      description: 'format=file only: the exact file type (other = any file).',
    },
    fields: {
      type: 'array',
      items: { type: 'object' },
      description: 'format=form only: the fields the output form must have (1–40). A form output must carry every required field and no field outside this list.',
    },
  },
  required: ['format'],
};

// =============================================================================
// HEALTH CHECK
// =============================================================================

const STARTED_AT = Date.now();

export const healthCheck: ToolConfig = {
  description: 'Internal health check. Verifies MongoDB connectivity.',
  parameters: { type: 'object', properties: {} },
  annotations: { version: '2.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion('2.0.0')
      .setUptime(Math.floor((Date.now() - STARTED_AT) / 1000));

    try {
      await invoke(context, 'ping');
    } catch (error) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', `Backend actions unreachable: ${(error as Error).message}`, {
        type: 'auto_retry',
        description: 'Backend temporarily unreachable.',
      });
    }

    return builder.build();
  },
};

// =============================================================================
// NODE CRUD
// =============================================================================

export const addNode: ToolConfig = {
  description:
    'Add a new node to the tree. If parentId is omitted or null, adds as a root-level node. If parentId is provided, it must be an existing node ID — a wrong or truncated parentId returns "Parent node not found" and no node is created. kind "task" (default) is completable and has a state (default "planning" — an idea not yet ready; pass "pending" when the task is ready to start); kind "group" is a non-completable container (Home, Work…) with no state. A task cannot contain groups (GROUP_IN_TASK). Returns: { node: { nodeId, parentId, text, description, instructions, kind, state, blockedReason, reportedProgress, completed, collapsed, position, createdAt, updatedAt }, parentText: string | null } — node.nodeId is the complete ID of the created node.',
  parameters: {
    type: 'object',
    properties: {
      parentId: {
        type: 'string',
        description: 'Parent node ID to nest under — must exist (error if not found). Omit or null for a root-level node.',
      },
      text: { type: 'string', description: 'The node title. Max 2000 chars.' },
      description: { type: 'string', description: 'Short description under the title. Max 2000 chars.' },
      instructions: { type: 'string', description: 'Detailed markdown instructions for what to do with this task. Max 10000 chars.' },
      kind: { type: 'string', enum: ['task', 'group'], description: 'task (default, completable) or group (container without state). A group cannot go inside a task.' },
      state: {
        type: 'string',
        enum: ['planning', 'pending', 'working', 'review', 'done'],
        description: 'Initial state of a task (default planning — an idea not yet ready; pass pending when the task is ready to start). Not for groups. To block a task use set-state with a reason.',
      },
      expectedOutput: EXPECTED_OUTPUT_SCHEMA,
    },
    required: ['text'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '2.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const result = await invoke<AddNodeResult>(context, 'add-node', withCaller(context, args));
    emitEvent(context, 'node.added', { nodeId: result.node.nodeId, parentId: result.node.parentId, text: result.node.text });
    return structured(result);
  },
};

export const getNode: ToolConfig = {
  description:
    'Get full detail of a single node, including instructions and the complete log. Use this when you need the full content of a task (get-tree only returns lightweight fields). Returns: { node: { nodeId, parentId, text, description, instructions, kind, state, blockedReason, allowedTransitions, progress, reportedProgress, input, output, hasInput, hasOutput, expectedOutput, completed, collapsed, position, log: [{ timestamp, text, actor }], createdAt, updatedAt } }. actor is who wrote the log entry ({ kind: user|agent|system, id? }), missing on older entries. progress is the effective % (reported, else 100 for review/done, else derived from the children); input/output are { format: markdown|form|file, ... } or null (a file carries objectId, url, name, mime, size); expectedOutput is the output the task must deliver ({ format, description?, fileType?, fields? }) or null.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to retrieve.' },
    },
    required: ['nodeId'],
  },
  annotations: { readOnlyHint: true, version: '2.1.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => structured(await invoke(context, 'get-node', args)),
};

export const getTree: ToolConfig = {
  description:
    'Get the tree of nodes for the current user as a nested hierarchy (Workflowy-style). Archived nodes are hidden by default (pass includeArchived: true to see them, subtrees under archived ancestors included). Returns: { tree: [{ nodeId, parentId, text, description, kind, state, blockedReason, completed, collapsed, position, progress, reportedProgress, hasInput, hasOutput, archived, archivedAt, completedAt, childCount, completedChildren, children?: [...] }] } — kind is task|group (groups have state null), progress is the effective % (reported, else 100 for review/done, else derived from the children), completedAt is when the task reached done/cancelled (null while open). Pass nodeId to get only the subtree rooted at that node. Pass depth=0 to get only root-level nodes without children (lazy loading — each node still reports childCount/completedChildren so the UI can show expand arrows). depth=-1 (default) returns the full nested tree. depth=N returns N levels of children. Tree nodes do NOT include instructions or log — use get-node for full detail.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Optional: get only the subtree rooted at this node.' },
      depth: {
        type: 'number',
        description: 'Tree depth to return. -1 = full tree (default), 0 = root level only (no children), N = N levels of children. Use 0 for lazy loading to keep responses small.',
        default: -1,
      },
      includeArchived: { type: 'boolean', description: 'Include archived nodes and their subtrees (default false — they are hidden).' },
    },
  },
  annotations: { readOnlyHint: true, version: '2.3.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => structured(await invoke(context, 'get-tree', args ?? {})),
};

export const updateNode: ToolConfig = {
  description:
    'Update the text, description, instructions and/or expected output definition of a node. Omitted fields are unchanged. Returns: { node: { nodeId, text, description, instructions, expectedOutput, updatedAt } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to update.' },
      text: { type: 'string', description: 'New node title. Max 2000 chars.' },
      description: { type: 'string', description: 'New short description. Max 2000 chars. Pass empty string to clear.' },
      instructions: { type: 'string', description: 'New detailed markdown instructions. Max 10000 chars. Pass empty string to clear.' },
      expectedOutput: EXPECTED_OUTPUT_SCHEMA,
    },
    required: ['nodeId'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '2.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'update-node', withCaller(context, args));
    const updatedFields = ['text', 'description', 'instructions', 'expectedOutput'].filter((f) => args?.[f] !== undefined);
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: updatedFields });
    return structured(result);
  },
};

export const toggleComplete: ToolConfig = {
  description:
    'Toggle the completed state of a task: a task that is not done becomes done (100%), a done task goes back to pending. Cascades to all descendants — marking a parent complete also marks all children complete, and vice versa. Adds a log entry automatically. Groups cannot be completed (NOT_A_TASK). For any other state change use set-state. Returns: { node: { nodeId, state, reportedProgress, completed, updatedAt } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to toggle completion on.' },
    },
    required: ['nodeId'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '2.1.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'toggle-complete', withCaller(context, args));
    emitEvent(context, 'node.completed', { nodeId: result.node.nodeId, completed: result.node.completed });
    return structured(result);
  },
};

export const toggleCollapse: ToolConfig = {
  description:
    'Toggle the collapsed/expanded state of a node (hide/show children in Workflowy). Returns: { node: { nodeId, collapsed, updatedAt } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to toggle collapse on.' },
    },
    required: ['nodeId'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => structured(await invoke(context, 'toggle-collapse', args)),
};

export const moveNode: ToolConfig = {
  description:
    'Move a node to a different parent and/or position within the tree. newParentId must be an existing node ID — a wrong or truncated ID returns "Parent node not found" and nothing is moved. Omit newParentId to keep the current parent and only reorder among siblings; set it explicitly to null to move to root level. newPosition is the 0-based index among siblings. Detects circular moves (cannot move a node into itself or its own subtree). Returns: { node: { nodeId, parentId, position, updatedAt } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to move.' },
      newParentId: {
        type: 'string',
        description: 'New parent node ID — must exist (error if not found). Omit to keep the current parent (reorder only). Set explicitly to null to move to root (top-level).',
      },
      newPosition: {
        type: 'number',
        description: '0-based position among the new siblings (default 0).',
      },
    },
    required: ['nodeId'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    // The node.moved event carries the previous parent, which the move result
    // does not include; read it first (the former handler also read the node
    // before moving it). A missing node fails here with the same NOT_FOUND.
    const before = await invoke<NodeResult>(context, 'get-node', { nodeId: args?.nodeId });
    const oldParentId = before.node.parentId ?? null;
    // `args` is forwarded as-is so an OMITTED newParentId (keep parent) and an
    // explicit null (move to root) reach the backend unchanged.
    const result = await invoke<NodeResult>(context, 'move-node', withCaller(context, args));
    emitEvent(context, 'node.moved', {
      nodeId: result.node.nodeId,
      newParentId: result.node.parentId,
      oldParentId,
      position: result.node.position,
    });
    return structured(result);
  },
};

export const deleteNode: ToolConfig = {
  description:
    'Delete a node and ALL its descendants (entire subtree). Irreversible. Returns: { deleted: true, node: { text, description, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to delete. All children will be removed recursively.' },
    },
    required: ['nodeId'],
  },
  // safeWriteHint: the user's own personal list — reversible (trivially recreatable),
  // private, non-notifying. destructiveHint only drives the UI badge, not the seed.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args, context) => {
    const result = await invoke<DeleteNodeResult>(context, 'delete-node', withCaller(context, args));
    emitEvent(context, 'node.deleted', { nodeId: result.nodeId, text: result.node.text });
    return structured(result);
  },
};

export const searchNodes: ToolConfig = {
  description:
    'Search nodes by text across all of the user\'s nodes. Case-insensitive. Archived nodes are hidden by default (pass includeArchived: true to find archived work too). Returns: { results: [{ nodeId, text, description, completed, path, updatedAt }] } where path is a breadcrumb like "Parent / Child / Match". Max 50 results.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text (case-insensitive). Min 1 char, max 500.' },
      includeArchived: { type: 'boolean', description: 'Include archived nodes in the results (default false — they are hidden).' },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true, version: '2.1.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => structured(await invoke(context, 'search-nodes', args)),
};

// =============================================================================
// ARCHIVE — finished work leaves the default views (get-tree, get-day,
// search-nodes) but stays recoverable. A node is hidden when it or any
// ancestor is archived; set-archived does NOT cascade down.
// =============================================================================

export const setArchived: ToolConfig = {
  description:
    'Archive or unarchive one node to keep the tree clean: archived nodes disappear from get-tree, get-day and search-nodes (pass includeArchived: true to see them) and are recoverable (archived: false). Does NOT cascade: only this node is archived, and a node with non-archived children fails with HAS_ACTIVE_CHILDREN — archive children first (bottom-up). Unarchiving does not touch the descendants; a node under an archived parent stays hidden until the ancestors are unarchived too. Groups can be archived. Adds a log entry "archived"/"unarchived". Idempotent. Returns: { node: { nodeId, archived, archivedAt, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to archive (or unarchive).' },
      archived: { type: 'boolean', description: 'true = archive (hide from the default views), false = unarchive (bring back).' },
    },
    required: ['nodeId', 'archived'],
  },
  // safeWriteHint: reversible by design (that is the point of an archive),
  // private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'set-archived', withCaller(context, args));
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: ['archived'] });
    return structured(result);
  },
};

export const archiveFinished: ToolConfig = {
  description:
    'Bulk-archive finished work to keep the tree clean: every task in state done (and cancelled unless includeCancelled: false) that is not archived yet. olderThanDays (optional) only archives tasks FINISHED at least that many days ago — use it for the auto-archive habit ("archive finished tasks older than 7 days"); without it, every finished task is archived. Tasks with non-archived children are skipped, not failed. Returns: { archived, skipped } counts.',
  parameters: {
    type: 'object',
    properties: {
      includeCancelled: { type: 'boolean', description: 'Also archive cancelled tasks (default true).' },
      olderThanDays: { type: 'integer', minimum: 1, maximum: 3650, description: 'Only archive tasks finished at least this many days ago (by completedAt). Omit to archive every finished task.' },
    },
  },
  // safeWriteHint: reversible (unarchive), private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<{ archived: number; skipped: number }>(context, 'archive-finished', withCaller(context, args));
    emitEvent(context, 'node.archivedBatch', { archived: result.archived, skipped: result.skipped });
    return structured(result);
  },
};

// =============================================================================
// LOG
// =============================================================================

export const addLogEntry: ToolConfig = {
  description:
    'Add a chronological log entry to a node. Used to track progress, notes, and history over time. Returns: { node: { nodeId, log: [{ timestamp, text }], updatedAt } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to add the log entry to.' },
      text: { type: 'string', description: 'The log entry text. Max 2000 chars.' },
    },
    required: ['nodeId', 'text'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '2.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'add-log-entry', withCaller(context, args))),
};

// =============================================================================
// STATES, GROUPS, PROGRESS, INPUT / OUTPUT
// =============================================================================

export const setState: ToolConfig = {
  description:
    'Move a task to another state: planning (idea, not defined yet) · pending (defined, ready to start) · working (started) · blocked (cannot continue — reason required) · review (work finished, awaiting a check) · done · cancelled (this task is no longer happening — from any open state). Allowed moves: planning→pending|cancelled; pending→working|done|planning|cancelled; working→review|blocked|pending|done|cancelled; blocked→working|planning|cancelled; review→done|working|cancelled; done→working (reopen — give a reason); cancelled→pending (reopen). Anything else fails with INVALID_TRANSITION. Entering review or done sets progress to 100; leaving them for an open state clears a 100 (any other value is kept). Cancelling removes the task from the day plan and clears its progress; a cancelled task is ignored by autoplay and does not count for its parent\'s derived progress. Groups have no state (NOT_A_TASK). Adds a log entry "from → to". Returns: { node: { nodeId, parentId, text, kind, state, blockedReason, reportedProgress, completed, hasInput, hasOutput, updatedAt, ... }, transition: { from, to } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
      state: { type: 'string', enum: STATES, description: 'Target state.' },
      reason: {
        type: 'string',
        description: 'Why. Required for blocked (what is missing / who it waits for — shown to the user). Recommended when reopening a done task. Max 2000 chars.',
      },
      reply: {
        type: 'string',
        description: 'Only for blocked → working (the answer to the blocked question, logged as "Reply: <text>") or review → working (why the task is sent back, logged as "Sent back: <text>"). When the task has a conversation it is posted there (a send-back as "Sent back from review: <text>") and its agent continues. Max 2000 chars.',
      },
    },
    required: ['nodeId', 'state'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const result = await invoke<SetStateResult>(context, 'set-state', withCaller(context, args));
    if (result.transition.from !== result.transition.to) {
      emitEvent(context, 'node.state', {
        nodeId: result.node.nodeId,
        from: result.transition.from,
        to: result.transition.to,
        blockedReason: result.node.blockedReason ?? null,
      });
    }
    return structured(result);
  },
};

export const setKind: ToolConfig = {
  description:
    'Convert a node between task and group, keeping its children. A group is a non-completable container (no state, progress or output); a task can be completed and contains only tasks. To group: fails with GROUP_IN_TASK if its parent is a task and HAS_OUTPUT if it has an output. To task: fails with GROUP_IN_TASK if it contains groups; it starts pending. Adds a log entry. Returns: { node: { nodeId, parentId, text, kind, state, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to convert.' },
      kind: { type: 'string', enum: ['task', 'group'], description: 'Target kind.' },
    },
    required: ['nodeId', 'kind'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'set-kind', withCaller(context, args));
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: ['kind'] });
    return structured(result);
  },
};

export const setProgress: ToolConfig = {
  description:
    'Report how far a task is, as an integer percentage 0–100, or null to clear it (the progress is then 100 for a task in review/done, else derived from its children). Editable in every state, review and done included; groups have no progress (NOT_A_TASK). Adds a log entry. Returns: { node: { nodeId, reportedProgress, state, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
      progress: { type: ['integer', 'null'], minimum: 0, maximum: 100, description: 'Percentage 0–100, or null to clear.' },
    },
    required: ['nodeId', 'progress'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'set-progress', withCaller(context, args));
    emitEvent(context, 'node.progress', { nodeId: result.node.nodeId, progress: result.node.reportedProgress ?? null });
    return structured(result);
  },
};

export const setInput: ToolConfig = {
  description:
    'Set the input of a node — the data the task starts from — or clear it with null. Markdown and forms are stored on the node; a file arrives either as base64 data or as a path inside the workspace volume (the backend reads and uploads it) and is stored as { format: "file", objectId, url, name, mime, size }. Groups may hold input. Replacing an existing input that would actually change requires overwrite: true (OUTPUT_EXISTS otherwise); re-delivering the same thing is a no-op. Adds a log entry. Returns: { node: { nodeId, hasInput, input, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID.' },
      input: NODE_IO_SCHEMA,
      overwrite: { type: 'boolean', description: 'Set true to replace an existing input. Required when the node already has an input and the new one would change it.' },
    },
    required: ['nodeId', 'input'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'set-input', withCaller(context, args));
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: ['input'] });
    return structured(result);
  },
};

export const setOutput: ToolConfig = {
  description:
    'Deliver the output of a task — its result (a summary in markdown, a filled form, or a file such as an invoice) — or clear it with null. A file arrives either as base64 data or as a path inside the workspace volume (the backend reads and uploads it) and is stored as { format: "file", objectId, url, name, mime, size }. Groups have no output (NOT_A_TASK). Adds a log entry "Output delivered · <format>". When the task has an expectedOutput (see get-node), the output must match it — same format, the expected file type, every required form field and no field outside the definition — or it fails with OUTPUT_MISMATCH. Replacing an existing output that would actually change requires overwrite: true (OUTPUT_EXISTS otherwise); re-delivering the same thing is a no-op. Delivering does not change the state: use set-state (e.g. working → review) as well. Returns: { node: { nodeId, hasOutput, output, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
      output: NODE_IO_SCHEMA,
      overwrite: { type: 'boolean', description: 'Set true to replace an existing output. Required when the task already has an output and the new one would change it (e.g. a different file or different markdown).' },
    },
    required: ['nodeId', 'output'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'set-output', withCaller(context, args));
    emitEvent(context, 'node.output', { nodeId: result.node.nodeId, format: result.node.output?.format ?? null });
    return structured(result);
  },
};

export const toggleInstructionItem: ToolConfig = {
  description:
    'Tick or untick one checklist item of a node\'s instructions — the index-th (0-based) markdown checkbox line ("- [ ] step" / "- [x] step"), counting top to bottom and ignoring code blocks. Fails with ITEM_NOT_FOUND past the last item. Returns: { node: { nodeId, parentId, instructions, updatedAt }, item: { index, checked, text } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID.' },
      index: { type: 'integer', minimum: 0, description: '0-based index of the checkbox among all checkboxes of the instructions.' },
    },
    required: ['nodeId', 'index'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const result = await invoke<{ node: { nodeId: string }; item: { text: string } }>(context, 'toggle-instruction-item', withCaller(context, args));
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.item.text, fields: ['instructions'] });
    return structured(result);
  },
};

// =============================================================================
// DAY PLANNING
// =============================================================================

export const planNode: ToolConfig = {
  description:
    'Plan a task for a calendar day ("Por día"), reorder it within its day, set its time, or take it off its day. day is "YYYY-MM-DD" in the user\'s calendar, or null to remove it from its day (also clears the time). index places it in the day\'s plan (0 = first; omitted = end of the day, or its current slot when the day does not change); the day is renumbered 0..N-1. time "HH:MM" sets the planned time, null clears it, omitted keeps it. Groups are never planned (NOT_A_TASK). Logs "Planned for <day>", "Planned time …" or "Removed from the day". Returns: { node: { nodeId, plannedFor, dayOrder, plannedTime, state, ... }, day, previousDay }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
      day: { type: ['string', 'null'], description: 'Day "YYYY-MM-DD", or null to remove the task from its day.' },
      index: { type: 'integer', minimum: 0, description: 'Position in the day\'s plan (0-based). Optional.' },
      time: { type: ['string', 'null'], description: 'Planned time "HH:MM" (24 h), or null to clear it. Optional.' },
    },
    required: ['nodeId', 'day'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'plan-node', withCaller(context, args));
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: ['plannedFor'] });
    return structured(result);
  },
};

export const getDay: ToolConfig = {
  description:
    'Get one day of the plan: the tasks planned for day in plan order, the overdue tasks (open tasks planned before today, oldest first) and the unplanned open tasks (no day, tree order). Pass today as the user\'s current calendar day "YYYY-MM-DD" (defaults to the UTC date). Returns: { day, today, tasks: [...], overdue: [...], unplanned: [...] } where each task is { nodeId, parentId, text, state, blockedReason, progress, reportedProgress, plannedFor, dayOrder, plannedTime, hasOutput, path: [ancestor titles, root first] }.',
  parameters: {
    type: 'object',
    properties: {
      day: { type: 'string', description: 'Day "YYYY-MM-DD".' },
      today: { type: 'string', description: 'The user\'s current day "YYYY-MM-DD" (decides what is overdue). Optional.' },
    },
    required: ['day'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => structured(await invoke(context, 'get-day', args)),
};

// =============================================================================
// ASSIGNMENT
// =============================================================================

export const assignNode: ToolConfig = {
  description:
    'Assign a task to an agent or a person of the workspace ("who does what"), or unassign it with null. assignee is { kind: "agent" | "user", id } — an agentId usable in this workspace or the userId of a workspace member (owner included); anything else fails with INVALID_ASSIGNEE. Groups cannot be assigned (NOT_A_TASK). Stores assignedAt and logs "Assigned to <name>" / "Unassigned". Assigning does not start the task. Returns: { node: { nodeId, assignee, assignedAt, state, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
      assignee: {
        type: ['object', 'null'],
        description: 'Who does it, or null to unassign.',
        properties: {
          kind: { type: 'string', enum: ['agent', 'user'], description: 'An agent or a human member.' },
          id: { type: 'string', description: 'agentId or userId.' },
        },
        required: ['kind', 'id'],
      },
    },
    required: ['nodeId', 'assignee'],
  },
  // safeWriteHint: the user's own personal list — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'assign-node', withCaller(context, args));
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: ['assignee'] });
    return structured(result);
  },
};

// =============================================================================
// REVIEWER (docs/specs/todo/reviewer.md, TODORV)
// =============================================================================

export const setReviewer: ToolConfig = {
  description:
    'Set the reviewer of a task — who reviews it when it enters review — or clear it with null (back to manual validation — nobody evaluates, the default). reviewer is { kind: "agent" | "user", id } — an agentId usable in this workspace or the userId of a workspace member; anything else fails with INVALID_ASSIGNEE. Groups cannot be reviewed (NOT_A_TASK). Empty by default: a task without a reviewer behaves exactly as before. When a task WITH a reviewer enters review, the reviewer is notified automatically and the task shows in their view — no subscription needed. Logs "Reviewer set to <name>" / "Reviewer removed". Returns: { node: { nodeId, reviewer, reviewedAt, state, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
      reviewer: {
        type: ['object', 'null'],
        description: 'Who reviews it, or null to clear (manual validation — nobody evaluates).',
        properties: {
          kind: { type: 'string', enum: ['agent', 'user'], description: 'An agent or a human member.' },
          id: { type: 'string', description: 'agentId or userId.' },
        },
        required: ['kind', 'id'],
      },
    },
    required: ['nodeId', 'reviewer'],
  },
  // safeWriteHint: reversible, private, non-notifying on assignment itself.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<NodeResult>(context, 'set-reviewer', withCaller(context, args));
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: ['reviewer'] });
    return structured(result);
  },
};

// =============================================================================
// DEPENDENCIES (TODODEP - Option A "ver y respetar", Pablo 2-nov): a task
// waits on another task of the same workspace; done/cancelled releases
// (review does NOT - board parity); cycles are rejected server-side.
// =============================================================================

export const addDependency: ToolConfig = {
  description:
    'Make a task wait on another task of the same workspace (any group - never cross-workspace): while the blocker is unresolved the task is NOT started by the autoplay, and the day/tree rows show it with the waiting semaforo. A dependency releases when the blocker reaches done or cancelled - review does NOT release (board parity). Groups can neither wait nor block (NOT_A_TASK); a blocker from another workspace is not found; self, direct and transitive cycles fail with CIRCULAR_DEPENDENCY. Adding an existing dependency is a no-op (added: false). Logs "Depends on <title>". Returns: { node: { nodeId, dependencies, ... }, dependency: { nodeId, text, state }, added: boolean }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID - the task that waits.' },
      blockerNodeId: { type: 'string', description: 'Task node ID - the task it waits on (the blocker).' },
    },
    required: ['nodeId', 'blockerNodeId'],
  },
  // safeWriteHint: reversible (remove-dependency), private to the workspace.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<{ node: NodeRef; dependency: { nodeId: string; text: string; state: string | null }; added: boolean }>(
      context,
      'add-dependency',
      args,
    );
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: ['dependencies'] });
    return structured(result);
  },
};

export const removeDependency: ToolConfig = {
  description:
    'Remove a dependency: the task stops waiting on the blocker and becomes autoplay-eligible again at once (the scheduling triggers run). Removing one that is not there is a no-op (removed: false). Groups have no dependencies (NOT_A_TASK). Logs "Dependency removed: <title>". Returns: { node: { nodeId, dependencies, ... }, dependency: { nodeId, text, state } | null, removed: boolean }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID - the task that waits.' },
      blockerNodeId: { type: 'string', description: 'Task node ID - the blocker it stops waiting on.' },
    },
    required: ['nodeId', 'blockerNodeId'],
  },
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const result = await invoke<{ node: NodeRef; dependency: { nodeId: string; text: string; state: string | null } | null; removed: boolean }>(
      context,
      'remove-dependency',
      args,
    );
    emitEvent(context, 'node.updated', { nodeId: result.node.nodeId, text: result.node.text, fields: ['dependencies'] });
    return structured(result);
  },
};

// =============================================================================
// IO SHARES (docs/specs/todo/output-window.md, TODOOV): public links to a
// task's output or input. A share belongs to the person who creates it, so
// the execution context's user goes as callerUserId (withCaller).
// =============================================================================

const IO_PARAM = { type: 'string', enum: ['output', 'input'], description: 'Which io of the task: output or input.' };

/** @spec TODOOV-REQ-4 */
const shareIo: ToolConfig = {
  description:
    'Create a public link to a task\'s output or input (or return the one you already created for it). Anyone with the link sees the task\'s CURRENT io without signing in: markdown as a web page titled with the task text, a file as the file itself. A form io or a task without that io fails with INVALID_STATE. Read members cannot share (FORBIDDEN). Returns: { shareId, publicUrl }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
      io: IO_PARAM,
    },
    required: ['nodeId', 'io'],
  },
  // NOT a safe write: it publishes the task's io to anyone with the link, so an
  // agent must ask first (seeds 'ask').
  annotations: { readOnlyHint: false, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'share-io', withCaller(context, args))),
};

/** @spec TODOOV-REQ-4 */
const getIoShare: ToolConfig = {
  description:
    'Get the public link you created for a task\'s output or input, if any. Read members cannot use it (FORBIDDEN). Returns: { shareId, publicUrl } or null.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
      io: IO_PARAM,
    },
    required: ['nodeId', 'io'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'get-io-share', withCaller(context, args))),
};

/** @spec TODOOV-REQ-4 */
const unshareIo: ToolConfig = {
  description:
    'Revoke a public link to a task\'s output or input; the link answers 404 from then on. Only the user who created it can revoke it (FORBIDDEN). Returns: { ok: true }.',
  parameters: {
    type: 'object',
    properties: {
      shareId: { type: 'string', description: 'Share ID returned by share-io.' },
    },
    required: ['shareId'],
  },
  // NOT a safe write: it changes what a public link serves, so an agent must
  // ask first (seeds 'ask'), like share-io.
  annotations: { readOnlyHint: false, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'unshare-io', withCaller(context, args))),
};

// =============================================================================
// REGISTRY (registration order = former server.tool() order)
// =============================================================================

export const TOOLS: Record<string, ToolConfig> = {
  '-health-check': healthCheck,
  'add-node': addNode,
  'get-node': getNode,
  'get-tree': getTree,
  'update-node': updateNode,
  'toggle-complete': toggleComplete,
  'toggle-collapse': toggleCollapse,
  'move-node': moveNode,
  'delete-node': deleteNode,
  'search-nodes': searchNodes,
  'set-archived': setArchived,
  'archive-finished': archiveFinished,
  'add-log-entry': addLogEntry,
  'set-state': setState,
  'set-kind': setKind,
  'set-progress': setProgress,
  'set-input': setInput,
  'set-output': setOutput,
  'toggle-instruction-item': toggleInstructionItem,
  'plan-node': planNode,
  'get-day': getDay,
  'assign-node': assignNode,
  'set-reviewer': setReviewer,
  'add-dependency': addDependency,
  'remove-dependency': removeDependency,
  'get-autoplay': getAutoplay,
  'set-agent-slots': setAgentSlots,
  'set-agent-play': setAgentPlay,
  'set-global-play': setGlobalPlay,
  'stop-autoplay': stopAutoplay,
  'set-agent-scope': setAgentScope,
  'remove-agent': removeAgent,
  'start-node': startNode,
  'open-runner-terminal': openRunnerTerminal,
  'subscribe-to-todo': subscribeToTodo,
  'unsubscribe-from-todo': unsubscribeFromTodo,
  'list-todo-subscriptions': listTodoSubscriptions,
  'share-io': shareIo,
  'get-io-share': getIoShare,
  'unshare-io': unshareIo,
};
