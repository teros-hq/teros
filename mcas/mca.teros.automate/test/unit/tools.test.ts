/**
 * Tools against a fake bridge: every tool must (1) require workspace
 * context, (2) call the right backend action with the acting identity and
 * the right payload, (3) normalize the output. No backend, no Mongo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ToolContext } from '@teros/mca-sdk';
import { setBridge } from '../../src/lib';
import {
  bulkCancel,
  cancelReminder,
  createAutomation,
  templateFields,
  createRecurringTask,
  createWebhook,
  deleteAutomation,
  disableAutomation,
  enableAutomation,
  getAutomation,
  listAutomations,
  listEventTopics,
  listExecutions,
  getQuota,
  listUpcoming,
  listWebhookCalls,
  parseTimeExpressionTool,
  regenerateWebhookUrl,
  scheduleReminder,
  snoozeReminder,
  testWebhook,
  updateAutomation,
} from '../../src/tools';

const USER = 'user_aaaaaaaaaaaaaaaa';
const WS = 'work_aaaaaaaaaaaaaaaa';
const AGENT = 'agent_aaaaaaaaaaaaaaaa';
const CHANNEL = 'ch_aaaaaaaaaaaaaaaa';
const ID = 'starter_0123456789abcdef';

type Call = { action: string; params: Record<string, unknown>; actor: Record<string, unknown> };
let calls: Call[] = [];
let responses: Record<string, unknown> = {};

const ctx = (over: Partial<ToolContext['execution']> = {}): ToolContext =>
  ({
    execution: { userId: USER, appId: 'app_x', workspaceId: WS, agentId: AGENT, channelId: CHANNEL, ...over },
    backend: null,
    signal: new AbortController().signal,
  }) as unknown as ToolContext;

const starter = (over: Record<string, unknown> = {}) => ({
  starterId: ID,
  name: 'Daily digest',
  type: 'scheduler',
  enabled: true,
  workspaceId: WS,
  createdBy: USER,
  createdAt: '2026-10-14T08:00:00.000Z',
  trigger: { type: 'scheduler', cronExpression: '0 9 * * 1-5', timezone: 'Europe/Madrid', nextRunAt: new Date(Date.now() + 3_600_000).toISOString(), totalExecutions: 3 },
  action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'Digest time' },
  channelName: 'General',
  agentName: 'Nira',
  avgDailyRuns7d: 1,
  ...over,
});

const unwrap = (r: unknown) => (r as { structuredContent: Record<string, any> }).structuredContent;

beforeEach(() => {
  calls = [];
  responses = {};
  setBridge(async (action, params, actor) => {
    calls.push({ action, params, actor });
    if (action in responses) return responses[action];
    throw new Error(`no fake response for ${action}`);
  });
});

afterEach(() => setBridge(undefined));

describe('context', () => {
  it('fails loud without workspace', async () => {
    await expect(listAutomations.handler({}, ctx({ workspaceId: undefined }))).rejects.toThrow('NO_WORKSPACE_CONTEXT');
    await expect(getAutomation.handler({ automationId: ID }, ctx({ userId: '' }))).rejects.toThrow('NO_USER_CONTEXT');
  });

  it('every call carries workspaceId and the acting identity', async () => {
    responses['automate.list'] = { starters: [] };
    await listAutomations.handler({}, ctx());
    expect(calls[0].params.workspaceId).toBe(WS);
    expect(calls[0].actor).toEqual({ userId: USER, agentId: AGENT, channelId: CHANNEL });
  });
});

describe('query tools', () => {
  it('list-automations maps filters and normalizes starters', async () => {
    responses['automate.list'] = { starters: [starter()], nextCursor: 'c1' };
    const out = unwrap(await listAutomations.handler({ trigger: 'schedule', status: 'active', search: 'digest', limit: 10 }, ctx()));
    expect(calls[0].action).toBe('automate.list');
    expect(calls[0].params).toMatchObject({ trigger: 'scheduler', status: 'active', search: 'digest', limit: 10 });
    expect(out.count).toBe(1);
    expect(out.nextCursor).toBe('c1');
    const a = out.items[0];
    expect(a.automationId).toBe(ID);
    expect(a.trigger).toMatchObject({ kind: 'schedule', cronExpression: '0 9 * * 1-5', cronDescription: 'Every weekday at 9:00', timezone: 'Europe/Madrid' });
    expect(a.trigger.nextRunHuman).toMatch(/in|hour|minute/);
    expect(a.action).toMatchObject({ kind: 'channel-event', channelId: CHANNEL, channelName: 'General', agentName: 'Nira', messageTemplate: 'Digest time' });
    expect(a.stats.totalExecutions).toBe(3);
    // never leaks a token
    expect(JSON.stringify(a)).not.toContain('tokenHash');
  });

  it('get-automation, list-executions, list-webhook-calls', async () => {
    responses['automate.get'] = { starter: starter({ type: 'webhook', trigger: { type: 'webhook', tokenHash: 'deadbeef', callCount: 4 } }) };
    const got = unwrap(await getAutomation.handler({ automationId: ID }, ctx()));
    expect(got.automation.trigger).toEqual({ kind: 'webhook', callCount: 4, lastCallAt: undefined });
    expect(JSON.stringify(got)).not.toContain('deadbeef');

    responses['automate.list-executions'] = {
      executions: [{ executionId: 'autoexec_1', source: 'scheduler', ok: false, error: 'boom', createdAt: '2026-10-14T07:00:00.000Z' }],
      nextCursor: undefined,
    };
    const ex = unwrap(await listExecutions.handler({ automationId: ID, limit: 5 }, ctx()));
    expect(calls.at(-1)!.params).toMatchObject({ starterId: ID, limit: 5 });
    expect(ex.items[0]).toMatchObject({ source: 'schedule', ok: false, error: 'boom' });

    responses['automate.list-calls'] = { calls: [{ callId: 'c', createdAt: '2026-10-14T07:00:00.000Z', createdTask: true, taskId: 'task_1', payload: { a: 1 } }] };
    const wc = unwrap(await listWebhookCalls.handler({ automationId: ID }, ctx()));
    expect(wc.items[0]).toMatchObject({ outcome: 'created', taskId: 'task_1' });
  });

  it('list-upcoming keeps timed, active automations inside the window, sorted', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const far = new Date(Date.now() + 30 * 86_400_000).toISOString();
    responses['automate.list'] = {
      starters: [
        starter({ starterId: 'starter_0000000000000001', trigger: { type: 'scheduler', cronExpression: '0 9 * * *', nextRunAt: later } }),
        starter({ starterId: 'starter_0000000000000002', type: 'once', trigger: { type: 'once', at: soon, nextRunAt: soon } }),
        starter({ starterId: 'starter_0000000000000003', trigger: { type: 'scheduler', cronExpression: '0 9 1 * *', nextRunAt: far } }),
        starter({ starterId: 'starter_0000000000000004', type: 'webhook', trigger: { type: 'webhook', tokenHash: 'x' } }),
      ],
    };
    const out = unwrap(await listUpcoming.handler({ days: 7 }, ctx()));
    expect(calls[0].params.status).toBe('active');
    expect(out.items.map((a: any) => a.automationId)).toEqual(['starter_0000000000000002', 'starter_0000000000000001']);
  });

  it('list-event-topics filters by app and search', async () => {
    responses['app.list-event-topics'] = {
      topics: [
        { topic: 'telegram.message.received', appId: 'app_tg', mcaId: 'mca.telegram', appName: 'Telegram' },
        { topic: 'board.task_moved', appId: 'app_b', mcaId: 'mca.teros.board-manager', appName: 'Boards' },
      ],
    };
    expect(unwrap(await listEventTopics.handler({ search: 'board' }, ctx())).topics).toHaveLength(1);
    expect(unwrap(await listEventTopics.handler({ appId: 'app_tg' }, ctx())).topics[0].topic).toBe('telegram.message.received');
  });

  it('parse-time-expression distinguishes cron from once and never calls the backend', async () => {
    const cron = unwrap(await parseTimeExpressionTool.handler({ expression: '0 9 * * 1-5', timezone: 'UTC' }, ctx()));
    expect(cron.kind).toBe('cron');
    expect(cron.cronDescription).toBe('Every weekday at 9:00');
    expect(cron.next).toHaveLength(3);

    const once = unwrap(await parseTimeExpressionTool.handler({ expression: 'in 2 hours', timezone: 'UTC' }, ctx()));
    expect(once.kind).toBe('once');
    expect(Date.parse(once.at)).toBeGreaterThan(Date.now() + 3_500_000);
    expect(calls).toHaveLength(0);
  });
});

describe('create tools', () => {
  it('create-automation: schedule → create-task with defaults and idempotencyKey', async () => {
    responses['automate.create-starter'] = { starter: starter() };
    const out = unwrap(
      await createAutomation.handler(
        {
          name: 'Nightly',
          trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'Europe/Madrid' },
          action: { type: 'create-task', projectId: 'proj_1', titleTemplate: 'Night {{payload.x}}', instructionsTemplate: 'Do the night run' },
          idempotencyKey: 'k1',
        },
        ctx(),
      ),
    );
    expect(calls[0].action).toBe('automate.create-starter');
    expect(calls[0].params).toMatchObject({
      name: 'Nightly',
      trigger: { type: 'scheduler', cronExpression: '0 2 * * *', timezone: 'Europe/Madrid' },
      action: { type: 'create-task', projectId: 'proj_1', agentId: AGENT, targetColumnId: '', titleTemplate: 'Night {{payload.x}}', instructionsTemplate: 'Do the night run' },
      idempotencyKey: 'k1',
    });
    expect(out.action).toBe('created');
    expect(out.webhookUrl).toBeUndefined();
  });

  it('create-automation: schedule → create-todo-item passes group/assignee/state/plan through', async () => {
    responses['automate.create-starter'] = { starter: starter() };
    await createAutomation.handler(
      {
        name: 'Lead follow-up',
        trigger: { type: 'schedule', schedule: 'weekdays a las 8', timezone: 'Europe/Madrid' },
        action: {
          type: 'create-todo-item',
          parentId: 'group_1',
          assignee: { kind: 'agent', id: AGENT },
          state: 'pending',
          plannedDay: '2026-11-02',
          plannedTime: '09:00',
          textTemplate: 'Seguimiento: {{payload.fromName}}',
          descriptionTemplate: 'Creado por la automatización Lead follow-up',
          instructionsTemplate: 'Revisar el lead y responder.',
        },
        idempotencyKey: 'k-todo',
      },
      ctx(),
    );
    expect(calls[0].action).toBe('automate.create-starter');
    expect(calls[0].params.trigger).toMatchObject({ type: 'scheduler', cronExpression: '0 8 * * 1-5', timezone: 'Europe/Madrid' });
    expect(calls[0].params.action).toEqual({
      type: 'create-todo-item',
      parentId: 'group_1',
      assignee: { kind: 'agent', id: AGENT },
      state: 'pending',
      plannedDay: '2026-11-02',
      plannedTime: '09:00',
      textTemplate: 'Seguimiento: {{payload.fromName}}',
      descriptionTemplate: 'Creado por la automatización Lead follow-up',
      instructionsTemplate: 'Revisar el lead y responder.',
    });
    expect(calls[0].params.idempotencyKey).toBe('k-todo');
  });

  it('create-automation: create-todo-item minimal shape omits unset optionals', async () => {
    responses['automate.create-starter'] = { starter: starter() };
    await createAutomation.handler(
      {
        name: 'Inbox sweeper',
        trigger: { type: 'webhook' },
        action: { type: 'create-todo-item', textTemplate: 'Triage: {{payload.title}}' },
      },
      ctx(),
    );
    expect(calls[0].params.action).toEqual({ type: 'create-todo-item', textTemplate: 'Triage: {{payload.title}}' });
  });

  it('create-automation: create-todo-item rejects a bad template and a bad state before the backend', async () => {
    await expect(
      createAutomation.handler(
        { name: 'X', trigger: { type: 'webhook' }, action: { type: 'create-todo-item', textTemplate: '{{#if x}}bad{{/if}}' } },
        ctx(),
      ),
    ).rejects.toThrow();
    await expect(
      createAutomation.handler(
        { name: 'X', trigger: { type: 'webhook' }, action: { type: 'create-todo-item', textTemplate: 'ok', state: 'blocked' } },
        ctx(),
      ),
    ).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it('create-automation: once with natural language, event with filters, webhook returns the URL once', async () => {
    responses['automate.create-starter'] = { starter: starter({ type: 'once', trigger: { type: 'once', at: '2026-10-15T07:00:00.000Z' } }) };
    await createAutomation.handler(
      { name: 'R', trigger: { type: 'once', at: 'tomorrow at 9am', timezone: 'UTC' }, action: { type: 'channel-event', messageTemplate: 'hi' } },
      ctx(),
    );
    const t = calls[0].params.trigger as any;
    expect(t.type).toBe('once');
    expect(Date.parse(t.at)).toBeGreaterThan(Date.now());
    expect((calls[0].params.action as any)).toMatchObject({ type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'hi' });

    responses['app.list-event-topics'] = {
      topics: [{ topic: 'board.task_moved', appId: 'app_b', mcaId: 'mca.teros.board-manager', appName: 'Board', payload: { taskId: 'string', taskTitle: 'string', toColumnName: 'string' } }],
    };
    const ev = unwrap(
      await createAutomation.handler(
        { name: 'E', trigger: { type: 'event', topic: 'board.task_moved', filters: [{ toColumnName: 'Done' }] }, action: { type: 'start-flow', flowId: 'flow_1', projectId: 'proj_1' } },
        ctx(),
      ),
    );
    expect(calls[1].params.trigger).toEqual({ type: 'event', eventPattern: 'board.task_moved', filters: [{ toColumnName: 'Done' }] });
    // Event triggers come back with the catalog of the topic so the agent knows the real fields
    expect(ev.payloadFields).toEqual({ 'board.task_moved': { taskId: 'string', taskTitle: 'string', toColumnName: 'string' } });
    expect(ev.warnings).toBeUndefined();

    responses['automate.create-starter'] = { starter: starter({ type: 'webhook', trigger: { type: 'webhook', tokenHash: 'h' } }), url: 'https://t/api/v1/webhooks/abc' };
    const out = unwrap(await createAutomation.handler({ name: 'W', trigger: { type: 'webhook' }, action: { type: 'create-task', projectId: 'proj_1', titleTemplate: '{{title}}', instructionsTemplate: 'Triage' } }, ctx()));
    expect(out.webhookUrl).toBe('https://t/api/v1/webhooks/abc');
  });

  it('create-automation warns when filters or templates use fields the event does not carry', async () => {
    responses['automate.create-starter'] = { starter: starter({ type: 'event', trigger: { type: 'event', eventPattern: 'telegram.message.received' } }) };
    responses['app.list-event-topics'] = {
      topics: [
        { topic: 'telegram.message.received', appId: 'app_tg', mcaId: 'mca.telegram', appName: 'Telegram', payload: { chatId: 'string', fromId: 'string', fromName: 'string', text: 'string' } },
        { topic: 'telegram.message.sent', appId: 'app_tg', mcaId: 'mca.telegram', appName: 'Telegram', payload: { chatId: 'string', text: 'string' } },
      ],
    };
    const out = unwrap(
      await createAutomation.handler(
        {
          name: 'TG',
          trigger: { type: 'event', topic: 'telegram.message.received', filters: [{ senderName: 'Ada' }] },
          action: { type: 'create-task', projectId: 'proj_1', titleTemplate: 'From {{payload.fromName}}: {{payload.message}}', instructionsTemplate: 'Reply' },
        },
        ctx(),
      ),
    );
    expect(Object.keys(out.payloadFields)).toEqual(['telegram.message.received']);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('senderName, message');
    expect(out.warnings[0]).toContain('fromName');

    // Wildcard pattern: fields of every matching topic are returned; unknown topic → a warning, never a failure
    const wild = unwrap(await createAutomation.handler({ name: 'All TG', trigger: { type: 'event', topic: 'telegram.message.*' }, action: { type: 'channel-event', messageTemplate: 'Ping {{topic}}' } }, ctx()));
    expect(Object.keys(wild.payloadFields).sort()).toEqual(['telegram.message.received', 'telegram.message.sent']);
    const none = unwrap(await createAutomation.handler({ name: 'Ghost', trigger: { type: 'event', topic: 'slack.message' }, action: { type: 'channel-event', messageTemplate: 'Ping {{topic}}' } }, ctx()));
    expect(none.warnings[0]).toContain('No installed app declares a topic matching "slack.message"');
  });

  it('create-automation rejects templates outside the grammar before calling the backend', async () => {
    await expect(
      createAutomation.handler(
        { name: 'x', trigger: { type: 'webhook' }, action: { type: 'create-task', projectId: 'proj_1', titleTemplate: '{{#if a}}{{a}}{{/if}}', instructionsTemplate: 'y' } },
        ctx(),
      ),
    ).rejects.toThrow('unsupported block syntax');
    expect(calls).toHaveLength(0);
  });

  it('templateFields reads the top-level payload field of every placeholder', () => {
    expect(templateFields('{{payload.fromName}} said {{ text }} in {{topic}} ({{payload.chat.title}})')).toEqual(['fromName', 'text', 'chat']);
    expect(templateFields(undefined)).toEqual([]);
  });

  it('create-automation rejects an invalid cron and a past once before calling the backend', async () => {
    await expect(
      createAutomation.handler({ name: 'x', trigger: { type: 'schedule', cron: '99 99 * * *' }, action: { type: 'channel-event', messageTemplate: 'Ping {{topic}}' } }, ctx()),
    ).rejects.toThrow('INVALID_CRON');
    await expect(
      createAutomation.handler({ name: 'x', trigger: { type: 'once', at: '2020-01-01T00:00:00Z' }, action: { type: 'channel-event', messageTemplate: 'Ping {{topic}}' } }, ctx()),
    ).rejects.toThrow('PAST_TIME_NOT_ALLOWED');
    expect(calls).toHaveLength(0);
  });

  it('schedule-reminder and create-recurring-task default to the current channel and agent', async () => {
    responses['automate.create-starter'] = { starter: starter() };
    await scheduleReminder.handler({ time: 'in 30 minutes', message: 'Call Marianne back' }, ctx());
    expect(calls[0].params).toMatchObject({
      name: 'Call Marianne back',
      trigger: { type: 'once' },
      action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'Call Marianne back' },
    });
    await createRecurringTask.handler({ cron: '0 9 * * 1-5', message: 'Standup', timezone: 'Europe/Madrid' }, ctx());
    expect(calls[1].params).toMatchObject({ trigger: { type: 'scheduler', cronExpression: '0 9 * * 1-5', timezone: 'Europe/Madrid' } });
    // No channel in context and none given → explicit error, no backend call.
    await expect(scheduleReminder.handler({ time: 'in 1 hour', message: 'x' }, ctx({ channelId: undefined }))).rejects.toThrow('channelId is required');
    // Two creations + the quota lookup the schedule triggers (no fake response → warning silently skipped).
    expect(calls.filter((c) => c.action === 'automate.create-starter')).toHaveLength(2);
    expect(calls.filter((c) => c.action === 'automate.quota')).toHaveLength(1);
  });

  it('a schedule that outruns the daily quota comes back with a warning; one that fits does not', async () => {
    responses['automate.create-starter'] = { starter: starter({ trigger: { type: 'scheduler', cronExpression: '* * * * *' } }) };
    responses['automate.quota'] = { limit: 5, used: 0, remaining: 5, exhausted: false, planId: 'plan_seed', planName: 'Seed', resetsAt: '2026-10-16T00:00:00.000Z', topStarters: [] };
    const noisy = unwrap(await createRecurringTask.handler({ cron: '* * * * *', message: 'tick' }, ctx()));
    expect(noisy.warning).toContain('1440 times a day');
    expect(noisy.warning).toContain('Seed plan allows 5');
    const viaCreate = unwrap(await createAutomation.handler({ name: 'x', trigger: { type: 'schedule', cron: '*/5 * * * *' }, action: { type: 'channel-event', messageTemplate: 'tick' } }, ctx()));
    expect(viaCreate.warning).toContain('288 times a day');
    const fine = unwrap(await createRecurringTask.handler({ cron: '0 9 * * 1-5', message: 'Standup' }, ctx()));
    expect(fine.warning).toBeUndefined();
    // Unlimited plan → never warns.
    responses['automate.quota'] = { ...(responses['automate.quota'] as object), limit: 0, remaining: null };
    const unlimited = unwrap(await createRecurringTask.handler({ cron: '* * * * *', message: 'tick' }, ctx()));
    expect(unlimited.warning).toBeUndefined();
  });

  it('create-webhook requires the URL back unless the key matched an existing one', async () => {
    responses['automate.create-starter'] = { starter: starter({ type: 'webhook', trigger: { type: 'webhook', tokenHash: 'h' } }), url: 'https://t/w/1' };
    const out = unwrap(await createWebhook.handler({ name: 'GH', action: { type: 'create-task', projectId: 'proj_1', titleTemplate: '{{title}}', instructionsTemplate: 'Triage' } }, ctx()));
    expect(out.webhookUrl).toBe('https://t/w/1');
    responses['automate.create-starter'] = { starter: starter({ type: 'webhook', trigger: { type: 'webhook', tokenHash: 'h' } }), existing: true };
    const again = unwrap(await createWebhook.handler({ name: 'GH', action: { type: 'create-task', projectId: 'proj_1', titleTemplate: '{{title}}', instructionsTemplate: 'Triage' }, idempotencyKey: 'gh' }, ctx()));
    expect(again.action).toBe('existing');
    expect(again.webhookUrl).toBeUndefined();
  });
});

describe('modify tools', () => {
  it('update / enable / disable / regenerate / test / delete map to their actions', async () => {
    responses['automate.update-starter'] = { starter: starter({ name: 'Renamed' }), url: 'https://t/w/2' };
    const up = unwrap(await updateAutomation.handler({ automationId: ID, name: 'Renamed', trigger: { type: 'webhook' } }, ctx()));
    expect(calls[0].params).toMatchObject({ starterId: ID, name: 'Renamed', trigger: { type: 'webhook' } });
    expect(up.webhookUrl).toBe('https://t/w/2');
    await expect(updateAutomation.handler({ automationId: ID }, ctx())).rejects.toThrow('Nothing to update');

    responses['automate.set-enabled'] = { starter: starter({ enabled: false }) };
    expect(unwrap(await disableAutomation.handler({ automationId: ID }, ctx())).action).toBe('disabled');
    expect(calls.at(-1)!.params).toEqual({ workspaceId: WS, starterId: ID, enabled: false });
    responses['automate.set-enabled'] = { starter: starter() };
    expect(unwrap(await enableAutomation.handler({ automationId: ID }, ctx())).action).toBe('enabled');

    responses['automate.regenerate-url'] = { url: 'https://t/w/3' };
    expect(unwrap(await regenerateWebhookUrl.handler({ automationId: ID }, ctx())).webhookUrl).toBe('https://t/w/3');

    responses['automate.test-webhook'] = { outcome: 'created', taskId: 'task_9' };
    expect(unwrap(await testWebhook.handler({ automationId: ID, payload: { a: 1 } }, ctx()))).toMatchObject({ outcome: 'created', taskId: 'task_9' });
    expect(calls.at(-1)!.params).toMatchObject({ starterId: ID, payload: { a: 1 } });

    responses['automate.delete'] = { deleted: true };
    expect(unwrap(await deleteAutomation.handler({ automationId: ID }, ctx())).action).toBe('deleted');
  });

  it('snooze re-arms a reminder from its current time; cancel is idempotent', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    responses['automate.get'] = { starter: starter({ type: 'once', trigger: { type: 'once', at, nextRunAt: at, timezone: 'UTC' } }) };
    responses['automate.update-starter'] = { starter: starter({ type: 'once', trigger: { type: 'once', at } }) };
    const out = unwrap(await snoozeReminder.handler({ automationId: ID, delay: '2h' }, ctx()));
    expect(out.action).toBe('snoozed');
    const patch = calls.at(-1)!.params as any;
    expect(patch.enabled).toBe(true);
    expect(Date.parse(patch.trigger.at)).toBe(Date.parse(at) + 7_200_000);

    responses['automate.get'] = { starter: starter({ type: 'once', trigger: { type: 'once', at, firedAt: at } }) };
    expect(unwrap(await cancelReminder.handler({ automationId: ID }, ctx())).action).toBe('noop');
    responses['automate.get'] = { starter: starter({ type: 'once', trigger: { type: 'once', at } }) };
    responses['automate.delete'] = { deleted: true };
    expect(unwrap(await cancelReminder.handler({ automationId: ID }, ctx())).action).toBe('cancelled');
    responses['automate.get'] = { starter: starter() };
    await expect(cancelReminder.handler({ automationId: ID }, ctx())).rejects.toThrow('Only once automations');
  });

  it('bulk-cancel by ids and by channel/before', async () => {
    responses['automate.delete'] = { deleted: true };
    const byIds = unwrap(await bulkCancel.handler({ automationIds: ['starter_0000000000000001', 'starter_0000000000000002'] }, ctx()));
    expect(byIds.deletedCount).toBe(2);

    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString();
    responses['automate.list'] = {
      starters: [
        starter({ starterId: 'starter_0000000000000003', type: 'once', trigger: { type: 'once', at: soon, nextRunAt: soon } }),
        starter({ starterId: 'starter_0000000000000004', type: 'once', trigger: { type: 'once', at: later, nextRunAt: later } }),
        starter({ starterId: 'starter_0000000000000005', action: { type: 'channel-event', channelId: 'ch_bbbbbbbbbbbbbbbb', agentId: AGENT } }),
      ],
    };
    const byFilter = unwrap(await bulkCancel.handler({ channelId: CHANNEL, before: new Date(Date.now() + 86_400_000).toISOString() }, ctx()));
    expect(byFilter.deleted).toEqual(['starter_0000000000000003']);
    await expect(bulkCancel.handler({}, ctx())).rejects.toThrow('Pass automationIds');
  });
});

describe('daily quota', () => {
  it('get-quota returns the budget with a one-line summary', async () => {
    responses['automate.quota'] = { limit: 20, used: 7, remaining: 13, exhausted: false, planId: 'plan_starter', planName: 'Starter', resetsAt: '2026-10-16T00:00:00.000Z', topStarters: [{ starterId: ID, name: 'Daily digest', workspaceId: WS, count: 7 }] };
    const out = unwrap(await getQuota.handler({}, ctx()));
    expect(calls[0].action).toBe('automate.quota');
    expect(out.unlimited).toBe(false);
    expect(out.summary).toBe('7 of 20 Automate runs used today (Starter plan, 13 left, resets at 00:00 UTC).');
    expect(out.topStarters[0].name).toBe('Daily digest');
    responses['automate.quota'] = { limit: 0, used: 0, remaining: null, exhausted: false, planId: 'plan_enterprise', planName: 'Enterprise', resetsAt: '2026-10-16T00:00:00.000Z', topStarters: [] };
    const unlimited = unwrap(await getQuota.handler({}, ctx()));
    expect(unlimited.unlimited).toBe(true);
    expect(unlimited.summary).toContain('No daily limit');
  });

  it('list-executions marks refused rows as skipped and says by what', async () => {
    responses['automate.list-executions'] = {
      executions: [
        { executionId: 'e1', source: 'scheduler', ok: true, createdAt: '2026-10-15T09:00:00.000Z' },
        { executionId: 'e2', source: 'scheduler', ok: false, refused: true, error: 'quota-automate_daily_limit: 5/5 used', createdAt: '2026-10-15T09:01:00.000Z' },
        { executionId: 'e3', source: 'webhook', ok: false, refused: true, error: 'billing-hours_exhausted', createdAt: '2026-10-15T09:02:00.000Z' },
        { executionId: 'e4', source: 'event', ok: false, error: 'EMPTY_TITLE', createdAt: '2026-10-15T09:03:00.000Z' },
      ],
    };
    const out = unwrap(await listExecutions.handler({ automationId: ID }, ctx()));
    expect(out.skipped).toBe(2);
    expect(out.items.map((i: any) => [i.skipped, i.skippedBy])).toEqual([
      [false, undefined],
      [true, 'daily-quota'],
      [true, 'billing'],
      [false, undefined],
    ]);
  });
});
