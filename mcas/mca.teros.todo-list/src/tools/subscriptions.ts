/**
 * Todo List MCA — event subscription tools (todo/events spec, board parity).
 *
 * The to-do list's equivalent of the board's subscribe-to-board /
 * unsubscribe-from-board / list-board-subscriptions: an agent subscribes its
 * conversation to the workspace's to-do events ("avísame cuando la tarea X
 * termine") and is woken when one fires. The same todo.* topics are published
 * on the MCA event bus, so Automate event triggers can use them too.
 *
 * Every handler forwards to the backend action of the same name through
 * `withCaller` (the calling agent's channel is the default subscription
 * target — `callerChannelId`).
 */

import type { ToolConfig } from '@teros/mca-sdk';
import { invoke, structured } from '../client';
import { withCaller } from './autoplay';

/** The 15 todo event types (TodoEventType), for the filter schemas. */
const EVENT_TYPES = [
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
];

const STATES = ['planning', 'pending', 'working', 'blocked', 'review', 'done', 'cancelled'];

/** JSON schema of the subscription filter (TodoSubscriptionFilter). */
const FILTER_SCHEMA = {
  type: 'object',
  description:
    'Optional filter to narrow delivered events. Multiple fields are AND-ed; multiple values within a field are OR-ed. Empty = all events of the workspace.',
  properties: {
    nodeIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only events for these specific tasks (node IDs) — "avísame cuando ESTA tarea acabe".',
    },
    assigneeIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only events where the task is assigned to one of these agents/users (ids).',
    },
    states: {
      type: 'array',
      items: { type: 'string', enum: STATES },
      description: 'Only events where the task\'s NEW state is one of these (planning, pending, working, blocked, review, done, cancelled).',
    },
    groupNodeIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only events for tasks inside these groups\' subtrees (group node IDs).',
    },
    eventTypes: {
      type: 'array',
      items: { type: 'string', enum: EVENT_TYPES },
      description: `Only these event types. Valid: ${EVENT_TYPES.join(', ')}.`,
    },
    wakeUpOn: {
      type: 'array',
      items: { type: 'string', enum: EVENT_TYPES },
      description:
        'Event types that wake the agent (trigger a response turn). Default: ALL event types wake the agent (only a wakeUpOn list narrows it). An agent is never woken by an event it caused itself (self-wake guard).',
    },
  },
};

export const subscribeToTodo: ToolConfig = {
  description:
    'DEPRECATED (v1.4.4): use the reserved tool `todo_list__subscribe` instead — one event per subscription with declarative filters (e.g. event "task_completed", filter { nodeId }); the subscription lives in the backend and survives respawns. This tool still works (kept for existing conversations) but will be removed. ' +
    'Subscribe this conversation to the to-do events of the workspace (task started, completed, blocked, assigned, planned, output delivered, progress, autoplay changes). Events that pass the filter are delivered here as they happen and wake the agent. Key use: filter.nodeIds + eventTypes ["task_completed"] = "avísame cuando ESTA tarea termine". The same events exist as todo.* topics for Automate. Upsert: subscribing again REPLACES the previous filter. Returns: { subscription: { subscriptionId, workspaceId, channelId, agentId, filter, createdAt, updatedAt }, created, message }.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description:
          'Conversation that receives the events. Defaults to the calling agent\'s conversation — omit it when subscribing from the conversation that wants the events.',
      },
      filter: FILTER_SCHEMA,
    },
  },
  // safeWriteHint: subscribes the caller's own conversation; reversible with
  // unsubscribe-from-todo; private (no external effect).
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => structured(await invoke(context, 'subscribe-to-todo', withCaller(context, args))),
};

export const unsubscribeFromTodo: ToolConfig = {
  description:
    'Cancel this conversation\'s subscription to the workspace\'s to-do events. Idempotent — a subscription that does not exist returns { unsubscribed: true } unchanged. Returns: { unsubscribed: true, channelId, deleted }.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'Conversation whose subscription to cancel. Defaults to the calling agent\'s conversation.',
      },
    },
  },
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => structured(await invoke(context, 'unsubscribe-from-todo', withCaller(context, args))),
};

export const listTodoSubscriptions: ToolConfig = {
  description:
    'List this conversation\'s to-do event subscriptions in the workspace: { subscriptions: [{ subscriptionId, workspaceId, channelId, agentId, filter, createdAt, updatedAt }] }. Defaults to the calling agent\'s conversation.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'Conversation whose subscriptions to list. Defaults to the calling agent\'s conversation.',
      },
    },
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => structured(await invoke(context, 'list-todo-subscriptions', withCaller(context, args))),
};
