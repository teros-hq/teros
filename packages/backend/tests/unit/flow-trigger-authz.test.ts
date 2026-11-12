/**
 * flow.* trigger actions authorize the caller on the flow's own workspace.
 *
 * flow.register-webhook / cancel-webhook / get-webhook-url and
 * flow.register-event / cancel-event / list-event-triggers took a flowId (and a
 * projectId) from the client, and their services read and rewrote `flows` by
 * flowId alone. Any authenticated user could read another workspace's webhook
 * path — whose token runs the flow via POST /webhooks/flow/<token> — rotate it
 * (with their own secret), cancel its triggers, or point a trigger at a
 * project of another workspace.
 *
 * Db mocked (flows, projects, workspaces, workspace_members); the services are
 * stubs, and every denial asserts the service was never reached.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import {
  createCancelWebhookHandler,
  createGetWebhookUrlHandler,
  createRegisterWebhookHandler,
} from '../../src/handlers/domains/board/flow-webhook';
import {
  createCancelEventHandler,
  createListEventTriggersHandler,
  createRegisterEventHandler,
} from '../../src/handlers/domains/board/flow-event';

const OWNER = 'user_owner';
const READER = 'user_reader';
const STRANGER = 'user_stranger';

const docs: Record<string, any[]> = {
  flows: [{ flowId: 'flow_a', workspaceId: 'work_a' }],
  projects: [
    { projectId: 'proj_a', workspaceId: 'work_a', status: 'active' },
    { projectId: 'proj_b', workspaceId: 'work_b', status: 'active' },
  ],
  workspaces: [
    { workspaceId: 'work_a', ownerId: OWNER, status: 'active' },
    { workspaceId: 'work_b', ownerId: STRANGER, status: 'active' },
  ],
  workspace_members: [{ workspaceId: 'work_a', userId: READER, status: 'active' }],
};

const db = {
  collection: (name: string) => ({
    findOne: async (filter: Record<string, unknown>) =>
      (docs[name] ?? []).find((d) => Object.entries(filter).every(([k, v]) => d[k] === v)) ?? null,
  }),
} as any;

function services() {
  const webhook = {
    registerWebhook: mock(async () => ({ token: 't0k', webhookPath: '/webhooks/flow/t0k' })),
    cancelWebhook: mock(async () => true),
    getWebhookUrl: mock(async () => '/webhooks/flow/t0k'),
  } as any;
  const event = {
    registerEvent: mock(async () => ({ triggerId: 'trg_1' })),
    cancelEvent: mock(async () => true),
    getTriggersForFlow: mock(async () => []),
  } as any;
  return { webhook, event };
}

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;

describe('flow webhook actions', () => {
  it('a stranger cannot read, rotate or cancel the webhook of a flow in another workspace', async () => {
    const { webhook } = services();
    await expect(createGetWebhookUrlHandler(webhook, db)(ctx(STRANGER), { flowId: 'flow_a' })).rejects.toMatchObject({
      code: 'FLOW_NOT_FOUND',
    });
    await expect(
      createRegisterWebhookHandler(webhook, db)(ctx(STRANGER), { flowId: 'flow_a', projectId: 'proj_b', secret: 's' }),
    ).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' });
    await expect(createCancelWebhookHandler(webhook, db)(ctx(STRANGER), { flowId: 'flow_a' })).rejects.toMatchObject({
      code: 'FLOW_NOT_FOUND',
    });
    expect(webhook.getWebhookUrl).not.toHaveBeenCalled();
    expect(webhook.registerWebhook).not.toHaveBeenCalled();
    expect(webhook.cancelWebhook).not.toHaveBeenCalled();
  });

  it('a read-only member cannot see the webhook token either', async () => {
    const { webhook } = services();
    await expect(createGetWebhookUrlHandler(webhook, db)(ctx(READER), { flowId: 'flow_a' })).rejects.toMatchObject({
      code: 'FLOW_NOT_FOUND',
    });
    expect(webhook.getWebhookUrl).not.toHaveBeenCalled();
  });

  it('an unknown flow looks the same as a denied one', async () => {
    const { webhook } = services();
    await expect(createGetWebhookUrlHandler(webhook, db)(ctx(OWNER), { flowId: 'flow_nope' })).rejects.toMatchObject({
      code: 'FLOW_NOT_FOUND',
    });
  });

  it('the owner cannot target a project of another workspace', async () => {
    const { webhook } = services();
    await expect(
      createRegisterWebhookHandler(webhook, db)(ctx(OWNER), { flowId: 'flow_a', projectId: 'proj_b' }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(webhook.registerWebhook).not.toHaveBeenCalled();
  });

  it('the owner manages the webhook of their own flow', async () => {
    const { webhook } = services();
    const reg = await createRegisterWebhookHandler(webhook, db)(ctx(OWNER), { flowId: 'flow_a', projectId: 'proj_a' });
    expect(reg).toMatchObject({ action: 'registered', flowId: 'flow_a' });
    const url = await createGetWebhookUrlHandler(webhook, db)(ctx(OWNER), { flowId: 'flow_a' });
    expect(url).toMatchObject({ hasWebhook: true });
    const cancel = await createCancelWebhookHandler(webhook, db)(ctx(OWNER), { flowId: 'flow_a' });
    expect(cancel).toMatchObject({ action: 'cancelled' });
  });
});

describe('flow event actions', () => {
  it('a stranger cannot register, cancel or list event triggers of a flow in another workspace', async () => {
    const { event } = services();
    await expect(
      createRegisterEventHandler(event, db)(ctx(STRANGER), { flowId: 'flow_a', projectId: 'proj_b', topic: 't' }),
    ).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' });
    await expect(createCancelEventHandler(event, db)(ctx(STRANGER), { flowId: 'flow_a' })).rejects.toMatchObject({
      code: 'FLOW_NOT_FOUND',
    });
    await expect(createListEventTriggersHandler(event, db)(ctx(STRANGER), { flowId: 'flow_a' })).rejects.toMatchObject({
      code: 'FLOW_NOT_FOUND',
    });
    expect(event.registerEvent).not.toHaveBeenCalled();
    expect(event.cancelEvent).not.toHaveBeenCalled();
    expect(event.getTriggersForFlow).not.toHaveBeenCalled();
  });

  it('a read-only member may list but not change event triggers', async () => {
    const { event } = services();
    await expect(createListEventTriggersHandler(event, db)(ctx(READER), { flowId: 'flow_a' })).resolves.toBeDefined();
    await expect(createCancelEventHandler(event, db)(ctx(READER), { flowId: 'flow_a' })).rejects.toMatchObject({
      code: 'FLOW_NOT_FOUND',
    });
    expect(event.cancelEvent).not.toHaveBeenCalled();
  });

  it('the owner registers an event trigger on a project of the flow workspace', async () => {
    const { event } = services();
    const res = await createRegisterEventHandler(event, db)(ctx(OWNER), {
      flowId: 'flow_a',
      projectId: 'proj_a',
      topic: 'board.task.created',
    });
    expect(res).toMatchObject({ action: 'registered', triggerId: 'trg_1' });
    await expect(
      createRegisterEventHandler(event, db)(ctx(OWNER), { flowId: 'flow_a', projectId: 'proj_b', topic: 't' }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});
