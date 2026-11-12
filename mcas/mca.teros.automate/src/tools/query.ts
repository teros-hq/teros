/**
 * Read-only tools: list / get / history / calls / upcoming / event catalog /
 * time parsing / health.
 */

import { z } from 'zod';
import { TEMPLATE_SYNTAX } from '@teros/shared';
import {
  AutomateError,
  type Automation,
  type BackendStarter,
  callBackend,
  describeCronExpression,
  formatAutomation,
  formatNextRun,
  isWsConnected,
  parseTimeExpression,
  previewCronOccurrences,
  previewOccurrences,
  isValidCronExpression,
  assertValidTimezone,
  parseScheduleExpression,
  describeScheduleCron,
} from '../lib';
import {
  type AutomateTool,
  IdSchema,
  QUOTA_ERROR_PREFIX,
  fetchAutomation,
  fetchQuota,
  requireWorkspace,
  resolveTimezone,
  structured,
  toToolError,
  validateInput,
} from './_shared';

const TRIGGER_KINDS = ['schedule', 'once', 'webhook', 'event'] as const;
const ACTION_KINDS = ['create-task', 'channel-event', 'start-flow'] as const;

// ---------------------------------------------------------------------------
// -health-check
// ---------------------------------------------------------------------------

export const healthCheck: AutomateTool = {
  description: 'Internal health check. Verifies the connection to the Teros backend.',
  parameters: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async () => {
    const connected = isWsConnected();
    return structured({ status: connected ? 'healthy' : 'degraded', backend: connected ? 'connected' : 'disconnected', checkedAt: new Date().toISOString() });
  },
};

// ---------------------------------------------------------------------------
// list-automations
// ---------------------------------------------------------------------------

const ListSchema = z.object({
  trigger: z.enum(TRIGGER_KINDS).optional(),
  action: z.enum(ACTION_KINDS).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  timezone: z.string().optional(),
});

export const listAutomations: AutomateTool = {
  description:
    'List the automations of the workspace: name, trigger (schedule / once / webhook / event), action (create-task / channel-event / start-flow), status, next run and 7-day stats. Filter by trigger, action, status or a name search; paginate with limit + cursor.',
  parameters: {
    type: 'object',
    properties: {
      trigger: { type: 'string', enum: [...TRIGGER_KINDS], description: 'Only this trigger kind.' },
      action: { type: 'string', enum: [...ACTION_KINDS], description: 'Only this action kind.' },
      status: { type: 'string', enum: ['active', 'disabled'], description: 'Only active or only disabled automations.' },
      search: { type: 'string', description: 'Case-insensitive substring of the name.' },
      limit: { type: 'number', description: 'Page size (1-200, default: all).' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
      timezone: { type: 'string', description: 'IANA timezone for the human-readable times (default: env).' },
    },
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(ListSchema, args);
      const timezone = resolveTimezone(input.timezone);
      if (input.timezone) assertValidTimezone(timezone);
      const res = await callBackend<{ starters: BackendStarter[]; nextCursor?: string }>(context, 'automate.list', {
        trigger: input.trigger === 'schedule' ? 'scheduler' : input.trigger,
        action: input.action,
        status: input.status,
        search: input.search,
        limit: input.limit,
        cursor: input.cursor,
      });
      const items = res.starters.map((s) => formatAutomation(s, timezone));
      return structured({ items, count: items.length, nextCursor: res.nextCursor });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// get-automation
// ---------------------------------------------------------------------------

const GetSchema = z.object({ automationId: IdSchema, timezone: z.string().optional() });

export const getAutomation: AutomateTool = {
  description: 'Get one automation by id: full trigger and action configuration, resolved target names and stats. Webhook tokens are never returned.',
  parameters: {
    type: 'object',
    properties: {
      automationId: { type: 'string', description: 'Automation id (starter_…).' },
      timezone: { type: 'string', description: 'IANA timezone for human-readable times.' },
    },
    required: ['automationId'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(GetSchema, args);
      const automation = await fetchAutomation(context, input.automationId, resolveTimezone(input.timezone));
      return structured({ automation });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// list-executions
// ---------------------------------------------------------------------------

const ExecutionsSchema = z.object({
  automationId: IdSchema,
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const listExecutions: AutomateTool = {
  description:
    'Execution history of an automation, newest first: what fired it (schedule / once / webhook / event), whether it succeeded, the task or flow run it produced, the error if any. ' +
    'Rows with skipped:true never ran: a guard refused them. error starting with "quota-automate_daily_limit" means the user had used up their plan\'s Automate runs for that UTC day (see get-quota: explain the limit, the reset at 00:00 UTC, and the ways out — space the schedule out, disable a noisy automation, or upgrade the plan); error starting with "billing-" means their agent-hours or payment blocked it.',
  parameters: {
    type: 'object',
    properties: {
      automationId: { type: 'string', description: 'Automation id (starter_…).' },
      limit: { type: 'number', description: 'Page size (1-200, default 50).' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
    },
    required: ['automationId'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(ExecutionsSchema, args);
      const res = await callBackend<{
        executions: Array<{ executionId: string; source: string; topic?: string; ok: boolean; taskId?: string; executionRefId?: string; error?: string; refused?: boolean; createdAt: string }>;
        nextCursor?: string;
      }>(context, 'automate.list-executions', { starterId: input.automationId, limit: input.limit, cursor: input.cursor });
      const items = res.executions.map((e) => ({
        executionId: e.executionId,
        source: e.source === 'scheduler' ? 'schedule' : e.source,
        topic: e.topic,
        ok: e.ok,
        skipped: e.refused === true,
        skippedBy: e.refused ? (e.error?.startsWith(QUOTA_ERROR_PREFIX) ? ('daily-quota' as const) : ('billing' as const)) : undefined,
        taskId: e.taskId,
        flowExecutionId: e.executionRefId,
        error: e.error,
        at: e.createdAt,
        agoHuman: formatNextRun(Date.parse(e.createdAt), resolveTimezone()),
      }));
      const skipped = items.filter((i) => i.skipped).length;
      return structured({ items, count: items.length, skipped, nextCursor: res.nextCursor });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// get-quota
// ---------------------------------------------------------------------------

export const getQuota: AutomateTool = {
  description:
    'The user\'s daily Automate budget: how many runs their plan allows per UTC day (all automations and trigger kinds together — schedules, reminders, webhooks and events), how many ran today, how many are left, when it resets (00:00 UTC) and which automations ran most. ' +
    'Use it before creating a frequent schedule, and whenever an automation "did not fire": if used >= limit the runs are being skipped until the reset. Ways out: space the schedule out, disable a noisy automation, or upgrade the plan (Profile → Plan). limit 0 means unlimited.',
  parameters: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (_args, context) => {
    try {
      requireWorkspace(context);
      const quota = await fetchQuota(context);
      const unlimited = quota.limit <= 0;
      return structured({
        ...quota,
        unlimited,
        resetsAtHuman: unlimited ? undefined : formatNextRun(Date.parse(quota.resetsAt), resolveTimezone()),
        summary: unlimited
          ? `No daily limit on Automate runs (${quota.planName} plan).`
          : `${quota.used} of ${quota.limit} Automate runs used today (${quota.planName} plan, ${quota.remaining} left, resets at 00:00 UTC).`,
      });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// list-webhook-calls
// ---------------------------------------------------------------------------

const CallsSchema = z.object({ automationId: IdSchema, limit: z.number().int().min(1).max(50).optional() });

export const listWebhookCalls: AutomateTool = {
  description: 'Recent payloads received by a webhook automation, newest first (max 50): when, discriminator, whether a task was created or updated, the payload.',
  parameters: {
    type: 'object',
    properties: {
      automationId: { type: 'string', description: 'Webhook automation id (starter_…).' },
      limit: { type: 'number', description: 'Max calls (1-50, default 50).' },
    },
    required: ['automationId'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(CallsSchema, args);
      const res = await callBackend<{
        calls: Array<{ callId: string; createdAt: string; discriminator?: string; taskId?: string; createdTask: boolean; payload?: unknown }>;
      }>(context, 'automate.list-calls', { starterId: input.automationId });
      const items = res.calls.slice(0, input.limit ?? 50).map((c) => ({
        callId: c.callId,
        at: c.createdAt,
        discriminator: c.discriminator,
        taskId: c.taskId,
        outcome: c.createdTask ? 'created' : c.taskId ? 'updated' : 'executed',
        payload: c.payload,
      }));
      return structured({ items, count: items.length });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// list-upcoming
// ---------------------------------------------------------------------------

const UpcomingSchema = z.object({
  days: z.number().int().min(1).max(90).optional(),
  channelId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  timezone: z.string().optional(),
});

export const listUpcoming: AutomateTool = {
  description: 'What will fire next: active schedule and once automations ordered by next run, within a window (default 7 days). Optionally only those that message a given channel.',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'Window in days (1-90, default 7).' },
      channelId: { type: 'string', description: 'Only automations whose action targets this channel.' },
      limit: { type: 'number', description: 'Max items (default 50).' },
      timezone: { type: 'string', description: 'IANA timezone for human-readable times.' },
    },
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(UpcomingSchema, args);
      const timezone = resolveTimezone(input.timezone);
      const until = Date.now() + (input.days ?? 7) * 86_400_000;
      const res = await callBackend<{ starters: BackendStarter[] }>(context, 'automate.list', { status: 'active' });
      const items: Automation[] = res.starters
        .filter((s) => s.type === 'scheduler' || s.type === 'once')
        .map((s) => formatAutomation(s, timezone))
        .filter((a) => a.trigger.nextRunAt && Date.parse(a.trigger.nextRunAt) <= until)
        .filter((a) => !input.channelId || a.action.channelId === input.channelId)
        .sort((a, b) => Date.parse(a.trigger.nextRunAt!) - Date.parse(b.trigger.nextRunAt!))
        .slice(0, input.limit ?? 50);
      return structured({ items, count: items.length, windowDays: input.days ?? 7 });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// list-event-topics
// ---------------------------------------------------------------------------

const TopicsSchema = z.object({ appId: z.string().optional(), search: z.string().max(100).optional() });

export const listEventTopics: AutomateTool = {
  description: 'The event catalog of the workspace: every topic the installed apps declare they emit (Telegram messages, board task changes, …) with the payload fields usable in filters and templates, plus templateSyntax — the exact template grammar. Call it before creating an event automation.',
  parameters: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'Only topics of this installed app.' },
      search: { type: 'string', description: 'Substring of the topic or app name.' },
    },
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(TopicsSchema, args);
      const res = await callBackend<{
        topics: Array<{ topic: string; description?: string; payload?: Record<string, string>; appId: string; mcaId: string; appName: string }>;
        templateSyntax?: string;
      }>(context, 'app.list-event-topics', {});
      const q = input.search?.toLowerCase();
      const topics = res.topics.filter(
        (t) => (!input.appId || t.appId === input.appId) && (!q || t.topic.toLowerCase().includes(q) || t.appName.toLowerCase().includes(q)),
      );
      return structured({ topics, count: topics.length, templateSyntax: res.templateSyntax ?? TEMPLATE_SYNTAX });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
/** Parse a recurring NL schedule, or null when it is not one (one-shot NL falls through). */
function tryParseSchedule(expression: string): { cron: string; description: string } | null {
  try {
    return parseScheduleExpression(expression);
  } catch {
    return null;
  }
}

// parse-time-expression
// ---------------------------------------------------------------------------

const ParseSchema = z.object({
  expression: z.string().min(1).max(200),
  timezone: z.string().optional(),
  locale: z.enum(['en', 'es']).optional(),
  previewCount: z.number().int().min(1).max(10).optional(),
  reference: z.string().optional(),
});

export const parseTimeExpressionTool: AutomateTool = {
  description:
    'Preview a time expression without creating anything. Accepts natural language — recurring ("cada lunes a las 9", "weekdays a las 8", "every 2 hours" → cron + human description) or one-shot ("tomorrow at 9am", "in 2 hours", "mañana a las 9") — ISO 8601, or a 5-field cron. Returns kind (once | cron), the resolved time / cron description and the next occurrences. Use this to tell the user when an automation will run, in plain language.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Natural language, ISO 8601, or 5-field cron.' },
      timezone: { type: 'string', description: 'IANA timezone (default: env).' },
      locale: { type: 'string', enum: ['en', 'es'], description: 'Natural-language locale (default en).' },
      previewCount: { type: 'number', description: 'How many occurrences to preview (1-10, default 3).' },
      reference: { type: 'string', description: 'ISO reference instant for relative expressions (default now).' },
    },
    required: ['expression'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args) => {
    try {
      const input = validateInput(ParseSchema, args);
      const timezone = resolveTimezone(input.timezone);
      assertValidTimezone(timezone);
      const count = input.previewCount ?? 3;
      const reference = input.reference ? new Date(input.reference) : new Date();
      if (Number.isNaN(reference.getTime())) throw new AutomateError('INVALID_INPUT', 'reference must be an ISO date-time');

      if (isValidCronExpression(input.expression)) {
        const next = previewCronOccurrences(input.expression, timezone, count);
        return structured({
          kind: 'cron' as const,
          cronExpression: input.expression.trim(),
          cronDescription: describeCronExpression(input.expression),
          scheduleHuman: describeScheduleCron(input.expression, input.locale ?? 'en'),
          timezone,
          next: next.map((ts) => ({ at: new Date(ts).toISOString(), human: formatNextRun(ts, timezone, reference.getTime()) })),
        });
      }

      // Recurring natural language ("cada lunes a las 9") → cron + preview.
      // One-shot natural language falls through to parseTimeExpression below.
      const schedule = tryParseSchedule(input.expression);
      if (schedule) {
        const next = previewCronOccurrences(schedule.cron, timezone, count);
        return structured({
          kind: 'cron' as const,
          cronExpression: schedule.cron,
          translatedFrom: input.expression.trim(),
          cronDescription: schedule.description,
          scheduleHuman: describeScheduleCron(schedule.cron, input.locale ?? 'en'),
          timezone,
          next: next.map((ts) => ({ at: new Date(ts).toISOString(), human: formatNextRun(ts, timezone, reference.getTime()) })),
        });
      }

      const parsed = parseTimeExpression(input.expression, { timezone, locale: input.locale, reference, allowPast: true });
      const next = previewOccurrences(input.expression, { timezone, locale: input.locale, reference, allowPast: true }, count);
      return structured({
        kind: 'once' as const,
        at: parsed.date.toISOString(),
        human: formatNextRun(parsed.timestamp, timezone, reference.getTime()),
        confidence: parsed.confidence,
        detectedText: parsed.detectedText,
        timezone,
        inPast: parsed.timestamp < reference.getTime(),
        next: next.map((p) => ({ at: p.date.toISOString(), human: formatNextRun(p.timestamp, timezone, reference.getTime()) })),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
