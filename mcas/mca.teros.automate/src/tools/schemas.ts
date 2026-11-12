/**
 * Zod schemas of the trigger / action inputs, shared by create-automation and
 * update-automation (kept apart from create.ts to avoid a circular import).
 */

import { z } from 'zod';

export const TriggerInputSchema = z.discriminatedUnion('type', [
  // Natural language is the PRIMARY input ("cada lunes a las 9"); raw cron is
  // the advanced mode. Exactly one of schedule | cron.
  z.object({
    type: z.literal('schedule'),
    schedule: z.string().min(1).optional(),
    cron: z.string().min(1).optional(),
    timezone: z.string().optional(),
    locale: z.enum(['en', 'es']).optional(),
  }),
  z.object({ type: z.literal('once'), at: z.string().min(1), timezone: z.string().optional(), locale: z.enum(['en', 'es']).optional() }),
  z.object({ type: z.literal('webhook') }),
  z.object({ type: z.literal('event'), topic: z.string().min(1).max(200), filters: z.array(z.record(z.unknown())).optional() }),
]);

export const ActionInputSchema = z.discriminatedUnion('type', [
  // To-do list equivalent of create-task: creates a task node in the Tasks
  // tree, optionally inside a parent group, with assignee / state / planned
  // day+time. Get parent group IDs with the todo-list app's get-tree tool.
  z.object({
    type: z.literal('create-todo-item'),
    parentId: z.string().min(1).optional(),
    assignee: z.object({ kind: z.enum(['agent', 'user']), id: z.string().min(1) }).optional(),
    state: z.enum(['planning', 'pending', 'working', 'review', 'done']).optional(),
    plannedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    plannedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    textTemplate: z.string().min(1).max(2000),
    descriptionTemplate: z.string().max(2000).optional(),
    instructionsTemplate: z.string().max(10000).optional(),
  }),
  z.object({
    type: z.literal('create-task'),
    projectId: z.string().min(1),
    agentId: z.string().optional(),
    columnId: z.string().optional(),
    titleTemplate: z.string().min(1).max(500),
    instructionsTemplate: z.string().min(1).max(4000),
    descriptionTemplate: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal('channel-event'),
    channelId: z.string().optional(),
    agentId: z.string().optional(),
    messageTemplate: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal('start-flow'),
    flowId: z.string().min(1),
    projectId: z.string().min(1),
    inputMapping: z.record(z.string()).optional(),
  }),
]);

export type TriggerInput = z.infer<typeof TriggerInputSchema>;
export type ActionInput = z.infer<typeof ActionInputSchema>;
