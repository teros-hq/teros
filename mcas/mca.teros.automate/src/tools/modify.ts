/**
 * Mutation tools on existing automations: update, enable / disable, snooze,
 * regenerate webhook URL, test webhook, delete, cancel reminder, bulk cancel.
 */

import { z } from 'zod';
import { AutomateError, type BackendStarter, callBackend, formatAutomation, parseDelayExpression } from '../lib';
import {
  type AutomateTool,
  IdSchema,
  fetchAutomation,
  requireWorkspace,
  resolveTimezone,
  setEnabled,
  structured,
  toToolError,
  validateInput,
} from './_shared';
import { toBackendAction, toBackendTrigger } from './create';
import { ActionInputSchema, TriggerInputSchema } from './schemas';

// ---------------------------------------------------------------------------
// update-automation
// ---------------------------------------------------------------------------

const UpdateSchema = z.object({
  automationId: IdSchema,
  name: z.string().min(1).max(120).optional(),
  trigger: z.record(z.unknown()).optional(),
  action: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export const updateAutomation: AutomateTool = {
  description:
    'Change an automation: name, trigger, action and/or enabled. Trigger and action use the same shapes as create-automation and replace the previous ones; runtime state (counters, webhook token) is kept. Switching the trigger to webhook returns a new URL once.',
  parameters: {
    type: 'object',
    properties: {
      automationId: { type: 'string', description: 'Automation id (starter_…).' },
      name: { type: 'string' },
      trigger: { type: 'object', description: 'New trigger (see create-automation).' },
      action: { type: 'object', description: 'New action (see create-automation).' },
      enabled: { type: 'boolean' },
    },
    required: ['automationId'],
  },
  annotations: { readOnlyHint: false, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(UpdateSchema, args);
      const timezone = resolveTimezone();
      const patch: Record<string, unknown> = { starterId: input.automationId };
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.trigger) patch.trigger = toBackendTrigger(validateInput(TriggerInputSchema, input.trigger), timezone);
      if (input.action) patch.action = toBackendAction(validateInput(ActionInputSchema, input.action), context);
      if (Object.keys(patch).length === 1) {
        throw new AutomateError('INVALID_INPUT', 'Nothing to update.', 'Pass name, trigger, action or enabled.');
      }
      const res = await callBackend<{ starter: BackendStarter; url?: string }>(context, 'automate.update-starter', patch);
      return structured({
        action: 'updated' as const,
        automation: formatAutomation(res.starter, timezone),
        ...(res.url ? { webhookUrl: res.url } : {}),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// enable-automation / disable-automation
// ---------------------------------------------------------------------------

const IdOnlySchema = z.object({ automationId: IdSchema });

export const enableAutomation: AutomateTool = {
  description: 'Enable (resume) an automation. Idempotent. A disabled schedule re-arms at its next cron slot.',
  parameters: { type: 'object', properties: { automationId: { type: 'string', description: 'Automation id (starter_…).' } }, required: ['automationId'] },
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(IdOnlySchema, args);
      const automation = await setEnabled(context, input.automationId, true, resolveTimezone());
      return structured({ action: 'enabled' as const, automation });
    } catch (error) {
      toToolError(error);
    }
  },
};

export const disableAutomation: AutomateTool = {
  description: 'Disable (pause) an automation without deleting it. Idempotent. It keeps its configuration and history.',
  parameters: { type: 'object', properties: { automationId: { type: 'string', description: 'Automation id (starter_…).' } }, required: ['automationId'] },
  annotations: { readOnlyHint: false, safeWriteHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(IdOnlySchema, args);
      const automation = await setEnabled(context, input.automationId, false, resolveTimezone());
      return structured({ action: 'disabled' as const, automation });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// snooze-reminder
// ---------------------------------------------------------------------------

const SnoozeSchema = z.object({ automationId: IdSchema, delay: z.string().min(1).max(20) });

export const snoozeReminder: AutomateTool = {
  description: 'Postpone a once automation (reminder) by a delay — "30m", "2h", "1d" — on top of its current time. Re-arms it if it already fired.',
  parameters: {
    type: 'object',
    properties: {
      automationId: { type: 'string', description: 'Reminder id (starter_…).' },
      delay: { type: 'string', description: '"30m", "2h", "1d" (s/m/h/d).' },
    },
    required: ['automationId', 'delay'],
  },
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(SnoozeSchema, args);
      const timezone = resolveTimezone();
      const current = await fetchAutomation(context, input.automationId, timezone);
      if (current.trigger.kind !== 'once' || !current.trigger.at) {
        throw new AutomateError('INVALID_INPUT', 'Only once automations (reminders) can be snoozed.', 'Use update-automation to change a schedule.');
      }
      const base = Math.max(Date.parse(current.trigger.at), Date.now());
      const at = new Date(base + parseDelayExpression(input.delay)).toISOString();
      const res = await callBackend<{ starter: BackendStarter }>(context, 'automate.update-starter', {
        starterId: input.automationId,
        enabled: true,
        trigger: { type: 'once', at, timezone: current.trigger.timezone },
      });
      return structured({ action: 'snoozed' as const, automation: formatAutomation(res.starter, timezone) });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// regenerate-webhook-url
// ---------------------------------------------------------------------------

export const regenerateWebhookUrl: AutomateTool = {
  description: 'Rotate the secret URL of a webhook automation. The old URL stops working immediately; the new one is returned once.',
  parameters: { type: 'object', properties: { automationId: { type: 'string', description: 'Webhook automation id (starter_…).' } }, required: ['automationId'] },
  annotations: { readOnlyHint: false, destructiveHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(IdOnlySchema, args);
      const res = await callBackend<{ url: string }>(context, 'automate.regenerate-url', { starterId: input.automationId });
      return structured({ action: 'regenerated' as const, automationId: input.automationId, webhookUrl: res.url });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// test-webhook
// ---------------------------------------------------------------------------

const TestSchema = z.object({ automationId: IdSchema, payload: z.record(z.unknown()) });

export const testWebhook: AutomateTool = {
  description: 'Fire a webhook automation with a test payload, exactly as an external POST would (dedupe, audit, stats). The action really runs.',
  parameters: {
    type: 'object',
    properties: {
      automationId: { type: 'string', description: 'Webhook automation id (starter_…).' },
      payload: { type: 'object', description: 'JSON object the action receives as {{payload}}.' },
    },
    required: ['automationId', 'payload'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(TestSchema, args);
      const res = await callBackend<{ taskId?: string; executionId?: string; outcome: 'created' | 'updated' }>(
        context,
        'automate.test-webhook',
        { starterId: input.automationId, payload: input.payload },
      );
      return structured({ action: 'tested' as const, automationId: input.automationId, outcome: res.outcome, taskId: res.taskId, flowExecutionId: res.executionId });
    } catch (error) {
      toToolError(error);
    }
  },
};

// ---------------------------------------------------------------------------
// delete-automation / cancel-reminder / bulk-cancel
// ---------------------------------------------------------------------------

export const deleteAutomation: AutomateTool = {
  description: 'Permanently delete an automation. It stops firing immediately; tasks, messages and flow runs it already produced are kept. Irreversible.',
  parameters: { type: 'object', properties: { automationId: { type: 'string', description: 'Automation id (starter_…).' } }, required: ['automationId'] },
  annotations: { readOnlyHint: false, destructiveHint: true, irreversible: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(IdOnlySchema, args);
      await callBackend(context, 'automate.delete', { starterId: input.automationId });
      return structured({ action: 'deleted' as const, automationId: input.automationId });
    } catch (error) {
      toToolError(error);
    }
  },
};

export const cancelReminder: AutomateTool = {
  description: 'Cancel a pending reminder (once automation). Idempotent: an already fired or missing reminder returns noop.',
  parameters: { type: 'object', properties: { automationId: { type: 'string', description: 'Reminder id (starter_…).' } }, required: ['automationId'] },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(IdOnlySchema, args);
      let current;
      try {
        current = await fetchAutomation(context, input.automationId, resolveTimezone());
      } catch (err) {
        if (err instanceof AutomateError && err.code === 'NOT_FOUND') {
          return structured({ action: 'noop' as const, automationId: input.automationId, reason: 'not found' });
        }
        throw err;
      }
      if (current.trigger.kind !== 'once') {
        throw new AutomateError('INVALID_INPUT', 'Only once automations (reminders) can be cancelled this way.', 'Use delete-automation or disable-automation.');
      }
      if (current.trigger.firedAt) {
        return structured({ action: 'noop' as const, automationId: input.automationId, reason: 'already fired' });
      }
      await callBackend(context, 'automate.delete', { starterId: input.automationId });
      return structured({ action: 'cancelled' as const, automationId: input.automationId });
    } catch (error) {
      toToolError(error);
    }
  },
};

const BulkSchema = z
  .object({
    automationIds: z.array(IdSchema).max(100).optional(),
    channelId: z.string().optional(),
    trigger: z.enum(['schedule', 'once', 'webhook', 'event']).optional(),
    before: z.string().optional(),
  })
  .refine((v) => (v.automationIds && v.automationIds.length > 0) || v.channelId || v.before, {
    message: 'Pass automationIds, channelId or before.',
  });

export const bulkCancel: AutomateTool = {
  description:
    'Delete several automations at once: by ids, or every automation that targets a channel, optionally only a trigger kind and only those whose next run is before an ISO date. Max 100 per call. Irreversible.',
  parameters: {
    type: 'object',
    properties: {
      automationIds: { type: 'array', items: { type: 'string' }, description: 'Explicit ids (max 100).' },
      channelId: { type: 'string', description: 'Every automation whose action targets this channel.' },
      trigger: { type: 'string', enum: ['schedule', 'once', 'webhook', 'event'], description: 'Restrict to one trigger kind.' },
      before: { type: 'string', description: 'ISO date: only automations whose next run is before it.' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: true, irreversible: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      requireWorkspace(context);
      const input = validateInput(BulkSchema, args);
      const timezone = resolveTimezone();
      let targets: string[] = input.automationIds ?? [];
      if (targets.length === 0) {
        const res = await callBackend<{ starters: BackendStarter[] }>(context, 'automate.list', {
          trigger: input.trigger === 'schedule' ? 'scheduler' : input.trigger,
        });
        const beforeMs = input.before ? Date.parse(input.before) : undefined;
        if (input.before && Number.isNaN(beforeMs)) throw new AutomateError('INVALID_INPUT', 'before must be an ISO date');
        targets = res.starters
          .map((s) => formatAutomation(s, timezone))
          .filter((a) => !input.channelId || a.action.channelId === input.channelId)
          .filter((a) => beforeMs === undefined || (a.trigger.nextRunAt !== undefined && Date.parse(a.trigger.nextRunAt) < beforeMs))
          .slice(0, 100)
          .map((a) => a.automationId);
      }
      const deleted: string[] = [];
      const failed: Array<{ automationId: string; error: string }> = [];
      for (const id of targets) {
        try {
          await callBackend(context, 'automate.delete', { starterId: id });
          deleted.push(id);
        } catch (err) {
          failed.push({ automationId: id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return structured({ action: 'bulk-cancelled' as const, deleted, deletedCount: deleted.length, failed });
    } catch (error) {
      toToolError(error);
    }
  },
};
