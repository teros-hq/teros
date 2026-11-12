/**
 * Creation tools: the generic create-automation plus three conversational
 * shortcuts (reminder, recurring task, webhook). All of them end in one
 * `automate.create-starter` call; natural-language times are resolved here.
 */

import { z } from 'zod';
import { templateFields as sharedTemplateFields, validateTemplate } from '@teros/shared';
import { AutomateError, assertValidCron, assertValidTimezone, callBackend, parseScheduleExpression, parseTimeExpression } from '../lib';
import {
  type AutomateTool,
  CHANNEL_ID_REGEX,
  createStarter,
  cronQuotaWarning,
  defaultAgentId,
  defaultChannelId,
  requireWorkspace,
  resolveTimezone,
  structured,
  toToolError,
  validateInput,
} from './_shared';

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

import { ActionInputSchema as ActionSchema, TriggerInputSchema as TriggerSchema, type ActionInput, type TriggerInput } from './schemas';

const TRIGGER_JSON_SCHEMA = {
  type: 'object',
  description:
    'When it fires. {type:"schedule", schedule, timezone?, locale?} (natural language, PRIMARY: "cada lunes a las 9", "weekdays a las 8", "cada 2 horas", "el primer día de mes") | {type:"schedule", cron, timezone?} (advanced: 5-field cron) | {type:"once", at, timezone?, locale?} (natural language or ISO; fires once) | {type:"webhook"} (a secret URL is generated) | {type:"event", topic, filters?} (topic from list-event-topics; filters = array of {field: value} objects, OR-ed).',
  properties: {
    type: { type: 'string', enum: ['schedule', 'once', 'webhook', 'event'] },
    schedule: { type: 'string', description: 'schedule (PRIMARY): natural language, e.g. "cada lunes a las 9", "weekdays a las 8", "cada 15 minutos", "el primer día de mes", "todos los días a las 9:30".' },
    cron: { type: 'string', description: 'schedule (advanced): 5-field cron "min hour day month weekday".' },
    at: { type: 'string', description: 'once: "tomorrow at 9am", "in 2 hours", or ISO 8601.' },
    timezone: { type: 'string', description: 'IANA timezone for schedule / once (default: env).' },
    locale: { type: 'string', enum: ['en', 'es'], description: 'once: natural-language locale.' },
    topic: { type: 'string', description: 'event: topic pattern, e.g. "telegram.message.received" or "board.*". Call list-event-topics first: it lists the real topics and their payload fields.' },
    filters: { type: 'array', items: { type: 'object' }, description: 'event: payload filters ({field: value}, fields from list-event-topics), OR across objects, AND within one.' },
  },
  required: ['type'],
} as const;

const ACTION_JSON_SCHEMA = {
  type: 'object',
  description:
    'What happens. {type:"create-todo-item", parentId?, assignee?, state?, plannedDay?, plannedTime?, textTemplate, descriptionTemplate?, instructionsTemplate?} (creates a task in the to-do list / Tasks tree — parent group optional, assignee {kind:"agent"|"user", id}, plannedDay "YYYY-MM-DD") | {type:"create-task", projectId, agentId?, columnId?, titleTemplate, instructionsTemplate, descriptionTemplate?} (creates a task on a project board) | {type:"channel-event", channelId?, agentId?, messageTemplate} (defaults: current channel and agent) | {type:"start-flow", flowId, projectId, inputMapping?}. Templates: {{field}} / {{payload.field}} / {{topic}} / {{payload}} (JSON) / {{a || b || "literal"}} (first non-empty wins); nothing else ({{#if}} etc. is rejected). Required templates (title/instructions/message/text) must not render empty; the trigger payload becomes the task input artifact.',
  properties: {
    type: { type: 'string', enum: ['create-todo-item', 'create-task', 'channel-event', 'start-flow'] },
    parentId: { type: 'string', description: 'create-todo-item: parent group node ID (omit for root). Get IDs with the todo-list get-tree tool.' },
    assignee: { type: 'object', description: 'create-todo-item: { kind: "agent" | "user", id } — who does the task.' },
    state: { type: 'string', enum: ['planning', 'pending', 'working', 'review', 'done'], description: 'create-todo-item: initial state (default pending; blocked not allowed).' },
    plannedDay: { type: 'string', description: 'create-todo-item: "YYYY-MM-DD" — the day the task is planned for.' },
    plannedTime: { type: 'string', description: 'create-todo-item: "HH:MM" — planned time (requires plannedDay).' },
    textTemplate: { type: 'string', description: 'create-todo-item (required): task title, e.g. "Responder a {{payload.fromName}}". Must not render empty.' },
    projectId: { type: 'string' },
    agentId: { type: 'string', description: 'Defaults to the agent running the tool.' },
    columnId: { type: 'string', description: 'create-task: board column (default: To Do).' },
    titleTemplate: { type: 'string', description: 'create-task (required): task title, e.g. "Lead: {{fromName || fromId}}". Must not render empty.' },
    instructionsTemplate: { type: 'string', description: 'create-task (required): what the agent has to do. Must not render empty. The payload is also available to the agent as the task input artifact.' },
    descriptionTemplate: { type: 'string', description: 'create-task (optional): one-line human summary; empty render → no description.' },
    channelId: { type: 'string', description: 'channel-event: defaults to the current channel.' },
    messageTemplate: { type: 'string', description: 'channel-event (required): what the agent receives. Must not render empty.' },
    flowId: { type: 'string' },
    inputMapping: { type: 'object', description: 'start-flow: flow input → dot-path into the payload.' },
  },
  required: ['type'],
} as const;

// ---------------------------------------------------------------------------
// Mapping to the backend shapes
// ---------------------------------------------------------------------------

export function toBackendTrigger(t: TriggerInput, fallbackTimezone: string): Record<string, unknown> {
  if (t.type === 'schedule') {
    const timezone = t.timezone ?? fallbackTimezone;
    assertValidTimezone(timezone);
    // Natural language is the primary path; raw cron is the advanced mode.
    // Both end as a canonical 5-field cronExpression for the backend.
    if (!t.schedule && !t.cron) {
      throw new AutomateError(
        'INVALID_INPUT',
        'A schedule trigger needs either "schedule" (natural language, e.g. "cada lunes a las 9") or "cron" (advanced, 5 fields).',
      );
    }
    const cron = t.cron ? t.cron.trim() : parseScheduleExpression(t.schedule as string).cron;
    assertValidCron(cron);
    return { type: 'scheduler', cronExpression: cron, timezone };
  }
  if (t.type === 'once') {
    const timezone = t.timezone ?? fallbackTimezone;
    assertValidTimezone(timezone);
    const parsed = parseTimeExpression(t.at, { timezone, locale: t.locale });
    return { type: 'once', at: parsed.date.toISOString(), timezone };
  }
  if (t.type === 'webhook') return { type: 'webhook' };
  return { type: 'event', eventPattern: t.topic.trim(), filters: t.filters };
}

/** Reject anything outside the shared template grammar before it reaches the backend. */
function assertTemplate(template: string | undefined, field: string): void {
  if (template === undefined) return;
  const v = validateTemplate(template);
  if (!v.ok) {
    throw new AutomateError('INVALID_INPUT', `${field}: ${v.error}`, 'Use {{field}}, {{payload.field}}, {{topic}}, {{payload}} or {{a || b || "literal"}}; call list-event-topics for the fields and the full syntax.');
  }
}

export function toBackendAction(a: ActionInput, context: Parameters<typeof defaultChannelId>[0]): Record<string, unknown> {
  if (a.type === 'create-todo-item') {
    assertTemplate(a.textTemplate, 'textTemplate');
    assertTemplate(a.descriptionTemplate, 'descriptionTemplate');
    assertTemplate(a.instructionsTemplate, 'instructionsTemplate');
    return {
      type: 'create-todo-item',
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(a.assignee ? { assignee: a.assignee } : {}),
      ...(a.state ? { state: a.state } : {}),
      ...(a.plannedDay ? { plannedDay: a.plannedDay } : {}),
      ...(a.plannedTime ? { plannedTime: a.plannedTime } : {}),
      textTemplate: a.textTemplate,
      ...(a.descriptionTemplate ? { descriptionTemplate: a.descriptionTemplate } : {}),
      ...(a.instructionsTemplate ? { instructionsTemplate: a.instructionsTemplate } : {}),
    };
  }
  if (a.type === 'create-task') {
    assertTemplate(a.titleTemplate, 'titleTemplate');
    assertTemplate(a.instructionsTemplate, 'instructionsTemplate');
    assertTemplate(a.descriptionTemplate, 'descriptionTemplate');
    return {
      type: 'create-task',
      projectId: a.projectId,
      agentId: defaultAgentId(context, a.agentId),
      targetColumnId: a.columnId ?? '',
      titleTemplate: a.titleTemplate,
      instructionsTemplate: a.instructionsTemplate,
      ...(a.descriptionTemplate ? { descriptionTemplate: a.descriptionTemplate } : {}),
    };
  }
  if (a.type === 'channel-event') {
    assertTemplate(a.messageTemplate, 'messageTemplate');
    return {
      type: 'channel-event',
      channelId: defaultChannelId(context, a.channelId),
      agentId: defaultAgentId(context, a.agentId),
      eventTemplate: a.messageTemplate,
    };
  }
  return { type: 'start-flow', flowId: a.flowId, projectId: a.projectId, inputMapping: a.inputMapping };
}

// ---------------------------------------------------------------------------
// create-automation
// ---------------------------------------------------------------------------

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  trigger: TriggerSchema,
  action: ActionSchema,
  enabled: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

/** `{{payload.foo.bar}}` / `{{foo}}` → `foo` (the top-level payload field a template reads). */
export function templateFields(template: string | undefined): string[] {
  return sharedTemplateFields(template);
}

function topicMatches(pattern: string, topic: string): boolean {
  if (!pattern.includes('*')) return pattern === topic;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(topic);
}

/**
 * For event triggers: look the topic up in the workspace catalog and tell the
 * agent which payload fields exist, plus which filter keys / template
 * placeholders it used that the catalog does not declare (they would never
 * match). Never fails the creation — the catalog is advisory.
 */
async function describeEventTopic(
  context: Parameters<typeof callBackend>[0],
  trigger: { eventPattern: string; filters?: Array<Record<string, unknown>> },
  action: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const res = await callBackend<{ topics: Array<{ topic: string; payload?: Record<string, string>; appName: string }> }>(context, 'app.list-event-topics', {});
    const matched = res.topics.filter((t: { topic: string }) => topicMatches(trigger.eventPattern, t.topic));
    if (matched.length === 0) {
      return { warnings: [`No installed app declares a topic matching "${trigger.eventPattern}". Check list-event-topics; the automation will only fire if such an event is ever emitted.`] };
    }
    const declared = new Set(matched.flatMap((t) => Object.keys(t.payload ?? {})));
    const used = new Set<string>([
      ...(trigger.filters ?? []).flatMap((f) => Object.keys(f)),
      ...templateFields(action.titleTemplate as string | undefined),
      ...templateFields(action.instructionsTemplate as string | undefined),
      ...templateFields(action.descriptionTemplate as string | undefined),
      ...templateFields(action.eventTemplate as string | undefined),
      ...templateFields(action.textTemplate as string | undefined),
      ...Object.values((action.inputMapping as Record<string, string> | undefined) ?? {}).map((p) => (p === '.' ? '' : p.split('.')[0])).filter(Boolean),
    ]);
    const unknown = [...used].filter((f) => !declared.has(f));
    const payloadFields: Record<string, Record<string, string>> = {};
    for (const t of matched) payloadFields[t.topic] = t.payload ?? {};
    return {
      payloadFields,
      ...(unknown.length > 0
        ? { warnings: [`These filter/template fields are not in the payload of ${matched.map((t) => t.topic).join(', ')}: ${unknown.join(', ')}. Declared fields: ${[...declared].join(', ')}.`] }
        : {}),
    };
  } catch {
    return {};
  }
}

export const createAutomation: AutomateTool = {
  description:
    'Create an automation: one trigger (schedule, once, webhook or event) coupled with one action (create a task, message a channel, start a flow). Returns the automation and, for webhooks, the secret URL — shown only once. For event triggers it also returns the payload fields of the topic and warns about filters/templates that use fields the event does not carry. Use idempotencyKey to make retries safe.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name shown in the Automate window.' },
      trigger: TRIGGER_JSON_SCHEMA,
      action: ACTION_JSON_SCHEMA,
      enabled: { type: 'boolean', description: 'Default true.' },
      idempotencyKey: { type: 'string', description: 'Same key twice → the first automation is returned, nothing duplicated.' },
    },
    required: ['name', 'trigger', 'action'],
  },
  annotations: { readOnlyHint: false, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(CreateSchema, args);
      const timezone = resolveTimezone();
      const trigger = toBackendTrigger(input.trigger, timezone);
      const action = toBackendAction(input.action, context);
      const result = await createStarter(
        context,
        {
          name: input.name.trim(),
          trigger,
          action,
          enabled: input.enabled,
          idempotencyKey: input.idempotencyKey,
        },
        timezone,
      );
      const catalog =
        trigger.type === 'event'
          ? await describeEventTopic(context, trigger as { eventPattern: string; filters?: Array<Record<string, unknown>> }, action)
          : {};
      const warning = trigger.type === 'scheduler' ? await cronQuotaWarning(context, String(trigger.cronExpression)) : undefined;
      return structured({
        action: result.existing ? ('existing' as const) : ('created' as const),
        automation: result.automation,
        ...(result.webhookUrl ? { webhookUrl: result.webhookUrl } : {}),
        ...catalog,
        ...(warning ? { warning } : {}),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// schedule-reminder (once → channel-event)
// ---------------------------------------------------------------------------

const ReminderSchema = z.object({
  time: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  channelId: z.string().regex(CHANNEL_ID_REGEX).optional(),
  timezone: z.string().optional(),
  locale: z.enum(['en', 'es']).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const scheduleReminder: AutomateTool = {
  description:
    'Remind at a given time: the message is delivered once to the channel (default: this conversation) and the agent acts on it. time: natural language ("tomorrow at 9am", "in 2 hours", "el lunes a las 10") or ISO 8601.',
  parameters: {
    type: 'object',
    properties: {
      time: { type: 'string', description: 'Natural language or ISO 8601, in the future.' },
      message: { type: 'string', description: 'What the agent receives when it fires (max 4000 chars).' },
      channelId: { type: 'string', description: 'Target channel (default: the current one).' },
      timezone: { type: 'string', description: 'IANA timezone the time is expressed in (default: env).' },
      locale: { type: 'string', enum: ['en', 'es'], description: 'Natural-language locale (default en).' },
      idempotencyKey: { type: 'string', description: 'Retry-safe key.' },
    },
    required: ['time', 'message'],
  },
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(ReminderSchema, args);
      const timezone = resolveTimezone(input.timezone);
      const result = await createStarter(
        context,
        {
          name: input.message.length > 60 ? `${input.message.slice(0, 57)}…` : input.message,
          trigger: toBackendTrigger({ type: 'once', at: input.time, timezone, locale: input.locale }, timezone),
          action: toBackendAction({ type: 'channel-event', channelId: input.channelId, messageTemplate: input.message }, context),
          idempotencyKey: input.idempotencyKey,
        },
        timezone,
      );
      return structured({ action: result.existing ? ('existing' as const) : ('created' as const), automation: result.automation });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// create-recurring-task (schedule → channel-event)
// ---------------------------------------------------------------------------

const RecurringSchema = z.object({
  schedule: z.string().min(1).optional(),
  cron: z.string().min(1).optional(),
  message: z.string().min(1).max(4000),
  channelId: z.string().regex(CHANNEL_ID_REGEX).optional(),
  timezone: z.string().optional(),
  locale: z.enum(['en', 'es']).optional(),
  name: z.string().max(120).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const createRecurringTask: AutomateTool = {
  description:
    'Deliver a message to a channel on a recurring schedule (default channel: this conversation); the agent acts on it each time. schedule: natural language, PRIMARY ("cada lunes a las 9", "weekdays a las 8", "cada 2 horas"); cron: 5 fields "min hour day month weekday" (advanced).',
  parameters: {
    type: 'object',
    properties: {
      schedule: { type: 'string', description: 'Natural language (PRIMARY): "cada lunes a las 9", "weekdays a las 8", "cada 15 minutos", "el primer día de mes".' },
      cron: { type: 'string', description: 'Advanced: 5-field cron expression.' },
      locale: { type: 'string', enum: ['en', 'es'], description: 'Natural-language locale (default en).' },
      message: { type: 'string', description: 'What the agent receives on each run (max 4000 chars).' },
      channelId: { type: 'string', description: 'Target channel (default: the current one).' },
      timezone: { type: 'string', description: 'IANA timezone of the cron (default: env).' },
      name: { type: 'string', description: 'Name in the Automate window (default: the message).' },
      idempotencyKey: { type: 'string', description: 'Retry-safe key.' },
    },
    required: ['cron', 'message'],
  },
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(RecurringSchema, args);
      if (!input.schedule && !input.cron) {
        throw new AutomateError('INVALID_INPUT', 'Pass "schedule" (natural language) or "cron" (advanced).');
      }
      const timezone = resolveTimezone(input.timezone);
      const parsed = input.cron
        ? { cron: input.cron.trim() }
        : parseScheduleExpression(input.schedule as string);
      const result = await createStarter(
        context,
        {
          name: input.name?.trim() || (input.message.length > 60 ? `${input.message.slice(0, 57)}…` : input.message),
          trigger: toBackendTrigger({ type: 'schedule', cron: parsed.cron, timezone }, timezone),
          action: toBackendAction({ type: 'channel-event', channelId: input.channelId, messageTemplate: input.message }, context),
          idempotencyKey: input.idempotencyKey,
        },
        timezone,
      );
      const warning = await cronQuotaWarning(context, parsed.cron);
      return structured({
        action: result.existing ? ('existing' as const) : ('created' as const),
        automation: result.automation,
        ...(warning ? { warning } : {}),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// create-webhook (webhook → any action)
// ---------------------------------------------------------------------------

const WebhookSchema = z.object({
  name: z.string().min(1).max(120),
  action: ActionSchema,
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const createWebhook: AutomateTool = {
  description:
    'Create a webhook: a secret URL external systems POST JSON to; each call runs the action (create a task — with discriminator dedupe —, message a channel, or start a flow). The URL is returned once.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name, e.g. "GitHub issues → tasks".' },
      action: ACTION_JSON_SCHEMA,
      idempotencyKey: { type: 'string', description: 'Retry-safe key.' },
    },
    required: ['name', 'action'],
  },
  annotations: { readOnlyHint: false, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(WebhookSchema, args);
      const timezone = resolveTimezone();
      const result = await createStarter(
        context,
        {
          name: input.name.trim(),
          trigger: { type: 'webhook' },
          action: toBackendAction(input.action, context),
          idempotencyKey: input.idempotencyKey,
        },
        timezone,
      );
      if (!result.existing && !result.webhookUrl) {
        throw new AutomateError('BACKEND_ERROR', 'The backend did not return the webhook URL.');
      }
      return structured({
        action: result.existing ? ('existing' as const) : ('created' as const),
        automation: result.automation,
        ...(result.webhookUrl ? { webhookUrl: result.webhookUrl } : {}),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
