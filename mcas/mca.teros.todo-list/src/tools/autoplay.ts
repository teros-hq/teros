/**
 * Todo List MCA — autoplay tools (docs/specs/todo/autoplay/spec.md, TODOAP).
 *
 * Runners (get-autoplay, set-agent-slots, set-agent-play, set-agent-scope,
 * remove-agent) and
 * the manual start (start-node). Thin client like every other tool: each
 * handler forwards to the backend action of the same name (`todo/<tool>`).
 *
 * Actions that act FOR a person (runner changes, start-node, a reply to a
 * blocked task) need to know who: `withCaller` adds `callerUserId` from the
 * tool's execution context — the user the backend executes the tool for —
 * and overrides any value in the args, so neither an agent nor a window can
 * choose it. When an agent calls, the execution context also carries its
 * `agentId` and `channelId`, forwarded as `callerAgentId` / `callerChannelId`.
 * Every tool that can write a log entry sends them too, so the log names who
 * acted — the agent, not the billing user (TODOLG-REQ-1).
 */

import type { ToolConfig, ToolContext } from '@teros/mca-sdk';
import { invoke, structured } from '../client';

/**
 * The tool args plus the execution context's user as `callerUserId` and, when
 * an agent is the one calling, its `callerAgentId` and `callerChannelId` (never
 * taken from the args).
 * @spec TODOAP-REQ-2
 * @spec TODOLG-REQ-1
 */
export function withCaller(context: ToolContext, args: Record<string, unknown> = {}): Record<string, unknown> {
  const { callerUserId: _u, callerAgentId: _a, callerChannelId: _c, ...rest } = args;
  const out: Record<string, unknown> = { ...rest };
  const { userId, agentId, channelId } = context.execution ?? ({} as Partial<ToolContext['execution']>);
  if (userId) out.callerUserId = userId;
  if (agentId) out.callerAgentId = agentId;
  if (agentId && channelId) out.callerChannelId = channelId;
  return out;
}

const RUNNER_SHAPE =
  '{ agentId, name, avatarUrl, slots, playEnabled, activeSlots, scopeNodeId, scopePath, pickUnassigned, scopeMissing }';

/** @spec TODOAP-REQ-2 */
export const getAutoplay: ToolConfig = {
  description:
    `List the Tasks autoplay runners of this workspace and its global state: the agents that pick up their own tasks (pending and planned for today or earlier) with a number of parallel slots. activeSlots is how many of the agent's tasks are running now; globalPlaying is the workspace's autoplay play/pause (TODOAP-REQ-30); runningCount is how many todo tasks of the workspace have a live turn — the STOP control's visibility (TODOAP-REQ-31). Returns: { globalPlaying: boolean, runningCount: number, runners: [${RUNNER_SHAPE}] }.`,
  parameters: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.2.0', stability: 'stable' },
  handler: async (_args, context) => structured(await invoke(context, 'get-autoplay', withCaller(context))),
};

/** @spec TODOAP-REQ-2 */
export const setAgentSlots: ToolConfig = {
  description:
    `Set how many tasks an agent of this workspace runs in parallel (makes it a runner if it is not one). 0 slots also pauses it. The agent must belong to the workspace (INVALID_ASSIGNEE). Read members cannot change runners (FORBIDDEN). Returns: { runner: ${RUNNER_SHAPE} }.`,
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID.' },
      slots: { type: 'integer', minimum: 0, description: 'Parallel executions (0 = listed but cannot run).' },
    },
    required: ['agentId', 'slots'],
  },
  // safeWriteHint: the user's own To Do — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'set-agent-slots', withCaller(context, args))),
};

/** @spec TODOAP-REQ-2 */
export const setAgentPlay: ToolConfig = {
  description:
    `Turn autoplay on or off for an agent (makes it a runner if it is not one). With play on, Teros starts the agent's pending tasks planned for today or earlier, honouring its slots. Enabling with 0 slots fails with INVALID_STATE. Pausing never interrupts a running turn. Read members cannot change runners (FORBIDDEN). Returns: { runner: ${RUNNER_SHAPE} }.`,
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID.' },
      enabled: { type: 'boolean', description: 'true = play, false = pause.' },
    },
    required: ['agentId', 'enabled'],
  },
  // safeWriteHint: the user's own To Do — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'set-agent-play', withCaller(context, args))),
};

/** @spec TODOAP-REQ-30 */
export const setGlobalPlay: ToolConfig = {
  description:
    'Set the workspace\'s global autoplay play/pause — the Tasks panel\'s Play/Pause control. Playing starts ONLY the enabled runners (playEnabled true with slots); a disabled runner is excluded from the global control. Pausing stops every scheduler path but never interrupts running turns. Read members cannot change it (FORBIDDEN). Returns: { globalPlaying: boolean }.',
  parameters: {
    type: 'object',
    properties: {
      playing: { type: 'boolean', description: 'true = the workspace\'s autoplay plays, false = paused.' },
    },
    required: ['playing'],
  },
  // safeWriteHint: the user's own To Do — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'set-global-play', withCaller(context, args))),
};

/** @spec TODOAP-REQ-31 */
export const stopAutoplay: ToolConfig = {
  description:
    'The workspace\'s global STOP: pause the autoplay AND abort every in-flight turn of the workspace\'s todo tasks — the equivalent of going to each task\'s conversation and pressing stop. The tasks stay working with no live turn; nothing restarts until the global play. Read members cannot stop (FORBIDDEN). Returns: { globalPlaying: false, aborted: number of turns aborted }.',
  parameters: {
    type: 'object',
    properties: {},
  },
  // safeWriteHint: the user's own To Do — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'stop-autoplay', withCaller(context, args))),
};

/** @spec TODOAP-REQ-22 */
export const setAgentScope: ToolConfig = {
  description:
    `Set an agent runner's scope (makes it a runner if it is not one). With pickUnassigned true, the agent also picks up tasks with no assignee that are pending and planned for today or earlier, inside the scope group (any depth; the whole tree when scopeNodeId is null), after its own tasks; each one is assigned to the agent before it starts. Tasks assigned to the agent are picked wherever they are. scopeNodeId must be a group of this workspace (INVALID_INPUT). Read members cannot change runners (FORBIDDEN). Returns: { runner: ${RUNNER_SHAPE} }.`,
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID.' },
      scopeNodeId: { type: ['string', 'null'], description: 'Group node ID that bounds the unassigned pickup, or null for the whole tree.' },
      pickUnassigned: { type: 'boolean', description: 'true = also pick up unassigned planned tasks inside the scope.' },
    },
    required: ['agentId', 'scopeNodeId', 'pickUnassigned'],
  },
  // safeWriteHint: the user's own To Do — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'set-agent-scope', withCaller(context, args))),
};

/** @spec TODOAP-REQ-2 */
export const removeAgent: ToolConfig = {
  description:
    'Remove an agent from the autoplay runners. Its running turns are not interrupted and its tasks keep their conversations. Read members cannot change runners (FORBIDDEN). Returns: { removed: true, agentId }.',
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID.' },
    },
    required: ['agentId'],
  },
  // safeWriteHint: the user's own To Do — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'remove-agent', withCaller(context, args))),
};

/** @spec TODOAP-REQ-9 */
export const startNode: ToolConfig = {
  description:
    'Start a task now: for a task assigned to an agent that is pending (or working without a conversation), whatever its planned day and the runner\'s play/slots. Moves it to working, opens (or reuses) its conversation with the agent and sends the agent the task. Not assigned to an agent: NOT_AGENT_TASK; any other state: INVALID_STATE. Returns: { node: { nodeId, state, channelId, running, ... }, channelId }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
    },
    required: ['nodeId'],
  },
  // safeWriteHint: the user's own To Do — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'start-node', withCaller(context, args))),
};

/** @spec CCR-REQ-8 */
export const openRunnerTerminal: ToolConfig = {
  description:
    'Open the task\'s work context (CCR-REQ-8): reveal the runner\'s terminal in the Terminal window, or recreate it with `claude --resume <sessionId>` when the session is gone — Claude Code recovers its full memory of the task. Idempotent: an alive terminal is only revealed. No runner record: NOT_RUNNER_TASK (409); runner not wired: UNAVAILABLE (503). Returns: { terminalId, resumed, node }.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Task node ID.' },
    },
    required: ['nodeId'],
  },
  // safeWriteHint: reveals/recreates the user's own runner terminal — reversible, private, non-notifying.
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => structured(await invoke(context, 'open-runner-terminal', withCaller(context, args))),
};
